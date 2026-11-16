// Ported from nowly-lab/ai-silent-meeting-bot (apps/desktop/meeting/native), simplified for meeting-voice-mcp.
import Foundation
import CoreAudio

func validInputUID(_ uid: String) -> Bool {
    !uid.isEmpty && uid.utf8.count <= 512 && !uid.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
}
struct InputDevice {
    let id: AudioDeviceID
    let uid: String
    let name: String
}
func inputString(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value), "Read input identity")
    guard let value else { throw CaptureError("Input identity is missing") }
    return value.takeRetainedValue() as String
}
func inputDevices() throws -> [InputDevice] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "Read input devices")
    guard size <= 65536 else { throw CaptureError("Audio device inventory is too large") }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids), "Read input devices")
    var devices: [InputDevice] = []
    for id in ids {
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0,
              let uid = try? inputString(id, kAudioDevicePropertyDeviceUID), validInputUID(uid),
              let rawName = try? inputString(id, kAudioObjectPropertyName) else { continue }
        let name = String(rawName.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(200))
        guard !name.isEmpty, !devices.contains(where: { $0.uid == uid }) else { continue }
        devices.append(InputDevice(id: id, uid: uid, name: name))
        if devices.count == 128 { break }
    }
    return devices
}
func defaultInputID() throws -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id), "Resolve default input")
    return id
}
func resolveInput(_ uid: String?, devices: [InputDevice]) throws -> InputDevice {
    if let uid {
        guard validInputUID(uid), let device = devices.first(where: { $0.uid == uid }) else { throw CaptureError("Selected microphone is unavailable. Reconnect it or select another input.") }
        return device
    }
    let id = try defaultInputID()
    guard let device = devices.first(where: { $0.id == id }) else { throw CaptureError("The macOS selected microphone is unavailable.") }
    return device
}
