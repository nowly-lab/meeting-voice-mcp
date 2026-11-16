// Ported from nowly-lab/ai-silent-meeting-bot (apps/desktop/meeting/native/AudioCapture.swift), simplified:
// default microphone only (no device selection), and a system audio failure never stops the microphone.
//
// Protocol (stdout, one JSON object per line):
//   {"event":"ready","sources":[...]}                       capture started
//   {"event":"audio","source":"mic"|"system","timestampMs":n,"pcm":"<base64 16 kHz s16le mono>"}
//   {"event":"denied","side":"mic"|"system","message":...}  that source could not start or stopped
//   {"event":"error","message":...}                         fatal; the helper exits
//   {"event":"stopped"}
// stdin: a line {"command":"stop"} or EOF stops capture.
import Foundation
import AVFoundation
import CoreAudio
import AudioUnit
import Darwin

private let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
struct CaptureError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
func check(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw CaptureError("\(operation) failed (CoreAudio \(status)). Check System Settings > Privacy & Security > Screen & System Audio Recording.") }
}
func microphoneStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "not-determined"
    }
}
func defaultOutput() throws -> AudioObjectID {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var device: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device), "Resolve default output")
    guard device != kAudioObjectUnknown else { throw CaptureError("No default audio output device is available") }
    return device
}
@available(macOS 14.6, *)
func makeTap() throws -> (AudioObjectID, AudioObjectID, CATapDescription) {
    let device = try defaultOutput()
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid), "Read default output UID")
    guard let uid else { throw CaptureError("Default output UID is missing") }
    let description = CATapDescription(processes: [], deviceUID: uid.takeRetainedValue() as String, stream: 0)
    description.isExclusive = true
    description.isPrivate = true
    description.muteBehavior = .unmuted
    var tap: AudioObjectID = 0
    try check(AudioHardwareCreateProcessTap(description, &tap), "Create system audio tap")
    return (tap, device, description)
}

// Callbacks only copy bounded packets and enqueue; conversion, encoding and stdout run on the writer queue.
final class PacketWriter {
    let queue = DispatchQueue(label: "meeting-voice.audio.writer")
    let slots = DispatchSemaphore(value: 64)
    let admission = CaptureAdmission()
    var converters: [String: AVAudioConverter] = [:]
    var failed = false
    var origins: [String: Double] = [:]
    var writtenFrames: [String: Int] = [:]
    var fatal: ((String) -> Void)?
    init() { queue.suspend() }
    func activate() { queue.resume() }
    func reportFatal(_ message: String) {
        guard admission.stop() else { return }
        DispatchQueue.main.async { self.fatal?(message) }
    }
    func enqueue(_ input: AVAudioPCMBuffer, source: String, hostTime: UInt64) {
        guard let elapsed = admission.elapsedTicks(for: hostTime) else { return }
        guard slots.wait(timeout: .now()) == .success else {
            reportFatal("Audio queue overflow; recording stopped to avoid silent audio loss.")
            return
        }
        guard let copy = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: input.frameLength) else {
            slots.signal(); reportFatal("Unable to allocate audio packet"); return
        }
        copy.frameLength = input.frameLength
        let from = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<from.count {
            guard let src = from[index].mData, let dst = to[index].mData else { continue }
            memcpy(dst, src, Int(from[index].mDataByteSize))
        }
        let stamp = Double(AudioConvertHostTimeToNanos(elapsed)) / 1_000_000
        queue.async {
            defer { self.slots.signal() }
            guard !self.failed else { return }
            do { try self.convert(copy, source: source, timestamp: stamp) }
            catch { self.failed = true; self.reportFatal(String(describing: error)) }
        }
    }
    func convert(_ input: AVAudioPCMBuffer, source: String, timestamp: Double) throws {
        let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        // Process taps stop delivering buffers while nothing plays; re-anchor after a gap so resumed audio is not backdated.
        if let origin = origins[source] {
            let nextTimestamp = origin + Double(writtenFrames[source] ?? 0) / 16
            if timestamp > nextTimestamp + 100 {
                converters[source] = nil
                writtenFrames[source] = 0
            }
        }
        if let converter = converters[source], !converter.inputFormat.isEqual(input.format) {
            converters[source] = nil
            writtenFrames[source] = 0
        }
        if converters[source] == nil {
            converters[source] = AVAudioConverter(from: input.format, to: outputFormat)
            origins[source] = timestamp
        }
        guard let converter = converters[source] else { throw CaptureError("Unsupported \(source) audio format") }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16000 / input.format.sampleRate)) + 128
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { throw CaptureError("Audio conversion allocation failed") }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true; state.pointee = .haveData; return input
        }
        if status == .error { throw error ?? CaptureError("Audio resampling failed") as NSError }
        writePCM(output, source: source)
    }
    func writePCM(_ output: AVAudioPCMBuffer, source: String) {
        guard output.frameLength > 0, let samples = output.floatChannelData?[0] else { return }
        let timestamp = (origins[source] ?? 0) + Double(writtenFrames[source] ?? 0) / 16
        writtenFrames[source, default: 0] += Int(output.frameLength)
        var pcm = Data(capacity: Int(output.frameLength) * 2)
        for index in 0..<Int(output.frameLength) {
            let sample = samples[index].isFinite ? max(-1, min(1, samples[index])) : 0
            var integer = Int16(max(-32768, min(32767, Int(sample * 32768)))).littleEndian
            withUnsafeBytes(of: &integer) { pcm.append(contentsOf: $0) }
        }
        emit(["event": "audio", "source": source, "timestampMs": timestamp, "pcm": pcm.base64EncodedString()])
    }
    func drain() throws {
        guard !failed else { return }
        for (source, converter) in converters {
            var complete = false
            for _ in 0..<8 {
                let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 4096)!
                var error: NSError?
                let status = converter.convert(to: output, error: &error) { _, state in
                    state.pointee = .endOfStream; return nil
                }
                if status == .error { throw error ?? CaptureError("Audio drain failed") as NSError }
                writePCM(output, source: source)
                if status == .endOfStream { complete = true; break }
            }
            if !complete { throw CaptureError("Audio resampler failed to drain") }
        }
    }
}

@available(macOS 14.6, *)
final class CaptureSession {
    let writer = PacketWriter()
    var engine = AVAudioEngine()
    var micInstalled = false
    var configurationObserver: NSObjectProtocol?
    let sources: [String]
    var running: [String] = []
    var tap: AudioObjectID = 0
    var aggregate: AudioObjectID = 0
    var io: AudioDeviceIOProcID?
    var output: AudioObjectID = 0
    var outputListener: AudioObjectPropertyListenerBlock?
    var finishing = false
    var writerActive = false
    init(sources: [String]) { self.sources = sources; writer.fatal = { [weak self] message in self?.finish(error: message) } }
    func start() throws {
        if sources.contains("mic") {
            do {
                guard microphoneStatus() == "authorized" || microphoneStatus() == "not-determined" else { throw CaptureError("Microphone permission is \(microphoneStatus()).") }
                try installMicrophone()
                running.append("mic")
            } catch { emit(["event": "denied", "side": "mic", "message": String(describing: error)]) }
        }
        if sources.contains("system") {
            do { try startSystem(); running.append("system") }
            catch { stopSystem(); emit(["event": "denied", "side": "system", "message": String(describing: error)]) }
        }
        guard !running.isEmpty else { throw CaptureError("No audio source could start.") }
        writer.admission.begin(at: mach_absolute_time())
        emit(["event": "ready", "sources": running])
        writerActive = true; writer.activate()
    }
    func stopMicrophone() {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer); configurationObserver = nil }
        if micInstalled { engine.inputNode.removeTap(onBus: 0); micInstalled = false }
        engine.stop()
    }
    func installMicrophone() throws {
        let candidate = AVAudioEngine()
        let devices = try inputDevices()
        let device = try resolveInput(nil, devices: devices)
        guard let unit = candidate.inputNode.audioUnit else { throw CaptureError("Microphone audio unit is unavailable") }
        var id = device.id
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)), "Bind microphone")
        let format = candidate.inputNode.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError("The microphone has no usable audio format") }
        engine = candidate
        candidate.inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, time in
            self?.writer.enqueue(buffer, source: "mic", hostTime: time.isHostTimeValid ? time.hostTime : mach_absolute_time())
        }
        micInstalled = true
        do { try candidate.start() } catch { stopMicrophone(); throw error }
        // A configuration change stops the engine (headset plugged in, format change). Binding the device
        // itself also posts changes while the engine keeps running, so rebuild only when it really stopped.
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: candidate, queue: nil) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                guard let self, !self.finishing, !self.engine.isRunning else { return }
                self.stopMicrophone()
                do { try self.installMicrophone() }
                catch { emit(["event": "denied", "side": "mic", "message": String(describing: error)]) }
            }
        }
    }
    func startSystem() throws {
        let result = try makeTap(); tap = result.0; output = result.1
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd), "Read system tap format")
        guard let format = AVAudioFormat(streamDescription: &asbd), asbd.mBytesPerFrame > 0 else { throw CaptureError("Invalid system audio stream format") }
        let specification: [String: Any] = [
            kAudioAggregateDeviceNameKey: "meeting-voice-mcp capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: result.2.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]]
        ]
        try check(AudioHardwareCreateAggregateDevice(specification as CFDictionary, &aggregate), "Create private audio aggregate")
        try check(AudioDeviceCreateIOProcIDWithBlock(&io, aggregate, nil) { [weak self] _, input, time, _, _ in
            guard let self else { return }
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard let first = buffers.first else { return }
            let frames = AVAudioFrameCount(first.mDataByteSize / asbd.mBytesPerFrame)
            guard frames > 0, let packet = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input) else { return }
            packet.frameLength = frames
            self.writer.enqueue(packet, source: "system", hostTime: time.pointee.mHostTime)
        }, "Create system audio IO callback")
        var defaultAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, !self.finishing else { return }
            do { if try defaultOutput() != self.output { self.stopSystem(); try self.startSystem() } }
            catch { self.stopSystem(); emit(["event": "denied", "side": "system", "message": String(describing: error)]) }
        }
        outputListener = listener
        try check(AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultAddress, DispatchQueue.main, listener), "Watch default output")
        try check(AudioDeviceStart(aggregate, io), "Start system audio")
    }
    func stopSystem() {
        if aggregate != 0, let io { AudioDeviceStop(aggregate, io); AudioDeviceDestroyIOProcID(aggregate, io) }
        io = nil
        if let listener = outputListener {
            var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main, listener)
        }
        outputListener = nil
        if aggregate != 0 { AudioHardwareDestroyAggregateDevice(aggregate); aggregate = 0 }
        if tap != 0 { AudioHardwareDestroyProcessTap(tap); tap = 0 }
        output = 0
    }
    func finish(error: String? = nil) {
        guard !finishing else { return }; finishing = true
        writer.admission.stop()
        stopMicrophone()
        stopSystem()
        if !writerActive { writer.failed = true; writer.activate(); writerActive = true }
        var finalError = error
        writer.queue.sync {
            do { try writer.drain() } catch { if finalError == nil { finalError = String(describing: error) } }
            if let error = finalError { emit(["event": "error", "message": error]) }
            emit(["event": "stopped"])
        }
        exit(finalError == nil ? 0 : 1)
    }
}

@main
enum AudioCaptureMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        func fail(_ message: String) -> Never { emit(["event": "error", "message": message]); exit(1) }
        if arguments == ["--permissions"] {
            emit(["event": "permissions", "microphone": microphoneStatus()])
            exit(0)
        }
        if arguments == ["--request-microphone"] {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                emit(["event": "permissions", "microphone": microphoneStatus()]); exit(0)
            }
            dispatchMain()
        }
        guard arguments.count == 2, arguments[0] == "--capture" else { fail("Usage: --permissions | --request-microphone | --capture mic,system") }
        let sources = arguments[1].split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        guard !sources.isEmpty, sources.allSatisfy({ ["mic", "system"].contains($0) }), Set(sources).count == sources.count else { fail("Capture sources must be mic, system, or mic,system") }
        guard #available(macOS 14.6, *) else { fail("The capture helper requires macOS 14.6 or newer") }
        let session = CaptureSession(sources: sources)
        do { try session.start() } catch { session.finish(error: String(describing: error)) }
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine() {
                if line.contains("\"stop\"") { break }
            }
            DispatchQueue.main.async { session.finish() }
        }
        dispatchMain()
    }
}
