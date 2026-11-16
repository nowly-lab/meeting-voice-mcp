import Foundation

// Setup can wait on TCC while device callbacks are already running. A short
// locked epoch read gates callbacks before they consume any queue capacity.
final class CaptureAdmission {
    private let lock = NSLock()
    private var epoch: UInt64?

    func begin(at hostTime: UInt64) {
        lock.lock()
        epoch = hostTime
        lock.unlock()
    }

    func elapsedTicks(for hostTime: UInt64) -> UInt64? {
        lock.lock()
        let start = epoch
        lock.unlock()
        guard let start, hostTime >= start else { return nil }
        return hostTime - start
    }

    @discardableResult
    func stop() -> Bool {
        lock.lock()
        let wasAdmitting = epoch != nil
        epoch = nil
        lock.unlock()
        return wasAdmitting
    }
}
