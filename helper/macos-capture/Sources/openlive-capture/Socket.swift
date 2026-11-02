// SPDX-License-Identifier: AGPL-3.0-only

import CaptureProtocol
import Darwin
import Foundation

/// The helper's end of the protocol: a Unix stream socket the helper made (a socketpair end
/// passed as a file descriptor, or a path to connect to). Writes go through one serial queue;
/// what is queued but not yet written is the backlog that marks the sink congested.
final class SocketSink: FrameSink {
    static let congestedBytes = 8 << 20

    private let fd: Int32
    private let queue = DispatchQueue(label: "openlive.writer", qos: .userInteractive)
    private let lock = NSLock()
    private var pending = 0
    private var closed = false
    var onClosed: (() -> Void)?

    init(fd: Int32) {
        self.fd = fd
    }

    static func connect(path: String) throws -> SocketSink {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CaptureError.usage("socket: \(errno)") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw CaptureError.usage("socket path too long") }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard rc == 0 else { throw CaptureError.usage("connect \(path): \(String(cString: strerror(errno)))") }
        return SocketSink(fd: fd)
    }

    var congested: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending > SocketSink.congestedBytes
    }

    func send(_ message: Message) {
        let data = message.encoded()
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        pending += data.count
        lock.unlock()
        queue.async { [self] in
            let ok = writeAll(data)
            lock.lock()
            pending -= data.count
            let first = !ok && !closed
            if !ok { closed = true }
            lock.unlock()
            if first { onClosed?() }
        }
    }

    /// Waits for everything queued so far to be written.
    func flush() {
        queue.sync {}
    }

    private func writeAll(_ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return true }
            var off = 0
            while off < raw.count {
                let n = write(fd, base + off, raw.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                off += n
            }
            return true
        }
    }

    /// Reads the helper's messages on a thread of its own until the socket closes.
    func readMessages(_ handle: @escaping (Message) -> Void, closed: @escaping () -> Void) {
        let fd = self.fd
        Thread {
            var reader = MessageReader()
            var buf = [UInt8](repeating: 0, count: 65536)
            loop: while true {
                let n = read(fd, &buf, buf.count)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { break }
                reader.feed(Data(buf[0..<n]))
                do {
                    while let m = try reader.next() {
                        handle(m)
                    }
                } catch {
                    log("bad message from the helper: \(error)")
                    break loop
                }
            }
            closed()
        }.start()
    }
}
