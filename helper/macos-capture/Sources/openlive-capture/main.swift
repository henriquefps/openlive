// SPDX-License-Identifier: AGPL-3.0-only

// openlive-capture: the macOS sidecar of the Openlive helper (README.md).
//
//	openlive-capture list                         displays, windows and apps (JSON)
//	openlive-capture thumbnail --source display:1 [--max 320x180]   a JPEG on stdout
//	openlive-capture doctor                       permission and encoders (JSON)
//	openlive-capture capture --fd 3 | --socket PATH   serve one capture to the helper
//	openlive-capture agent --fd 3                 the menu bar item, notifications and shortcuts (Agent.swift)
//	openlive-capture bench [--source display:main|window:<id>] [--layers spec] [--duration 20] [--animate 1280x720]
//	openlive-capture version

import AppKit
import CaptureProtocol
import CoreGraphics
import Foundation

let usage = """
Usage: openlive-capture <list|thumbnail|doctor|capture|agent|bench|version> [flags]

  list                                   displays, windows and apps, as JSON
  thumbnail --source KIND:ID [--max WxH] a JPEG of a source on stdout (macOS 14+)
  doctor                                 Screen Recording permission and VideoToolbox encoders, as JSON
  capture --fd N | --socket PATH         serve one capture to the helper (the helper starts this)
  agent --fd N | --socket PATH           the helper's menu bar item, notifications and shortcuts (the helper starts this)
  bench [flags]                          capture and encode without a helper, print a report:
        --source display:main|display:ID|window:ID   (default display:main)
        --layers rid:WxH@fps:kbps,...      (default the 1080p60 preset's f,h,q)
        --vbv-ms 250 --duration 20 --warmup 2 --keyframe-every 1
        --animate WxH[:particles]          show a moving test window while measuring (default 1000 particles/s)
        --no-cursor --audio-pid PID
        --llrc off                         the normal rate control instead of the low-latency one
        --in-flight 3                      frames each encoder may have in flight
  version
"""

struct Args {
    var values: [String: String] = [:]
    var flags: Set<String> = []

    init(_ args: ArraySlice<String>) throws {
        var it = args.makeIterator()
        while let a = it.next() {
            guard a.hasPrefix("--") else { throw CaptureError.usage("unexpected argument \(a)\n\n\(usage)") }
            let key = String(a.dropFirst(2))
            if ["no-cursor", "help"].contains(key) {
                flags.insert(key)
            } else if let v = it.next() {
                values[key] = v
            } else {
                throw CaptureError.usage("--\(key) needs a value")
            }
        }
    }

    func int(_ key: String, _ def: Int) throws -> Int {
        guard let v = values[key] else { return def }
        guard let n = Int(v) else { throw CaptureError.usage("--\(key): not a number: \(v)") }
        return n
    }
}

func parseSource(_ s: String) throws -> SourceRef {
    let parts = s.split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2, ["display", "window"].contains(parts[0]) else { throw CaptureError.usage("source \(s): want display:ID or window:ID") }
    if parts[0] == "display", parts[1] == "main" { return SourceRef(kind: "display", id: CGMainDisplayID()) }
    guard let id = UInt32(parts[1]) else { throw CaptureError.usage("source \(s): bad id") }
    return SourceRef(kind: parts[0], id: id)
}

/// parseAnimate reads --animate WxH[:particles].
func parseAnimate(_ s: String) throws -> (Int, Int, Int?) {
    let parts = s.split(separator: ":", maxSplits: 1).map(String.init)
    let (w, h) = try parseSize(parts[0])
    guard parts.count == 2 else { return (w, h, nil) }
    guard let n = Int(parts[1]), n >= 0 else { throw CaptureError.usage("--animate \(s): want WxH[:particles]") }
    return (w, h, n)
}

func parseSize(_ s: String) throws -> (Int, Int) {
    let p = s.split(separator: "x")
    guard p.count == 2, let w = Int(p[0]), let h = Int(p[1]), w > 0, h > 0 else { throw CaptureError.usage("size \(s): want WxH") }
    return (w, h)
}

func fail(_ error: Error) -> Never {
    log("\(error)")
    exit(error is CaptureError && (error as! CaptureError).code == "usage" ? 2 : 1)
}

/// Runs body on the main actor with AppKit's run loop going, then exits.
func runMain(_ body: @escaping @MainActor () async throws -> Void) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
        do {
            try await body()
            exit(0)
        } catch {
            fail(error)
        }
    }
    app.run()
    exit(0)
}

/// capture: hello, then the helper's config starts the session; controls follow until stop
/// or the socket closes (the helper is gone), which stops the capture and exits.
func serve(sink: SocketSink, animate: (Int, Int, Int?)?) -> Never {
    signal(SIGPIPE, SIG_IGN)
    sink.onClosed = { exit(0) }
    let v = ProcessInfo.processInfo.operatingSystemVersion
    sink.send(.json(.hello, Hello(protocolVersion: protocolVersion, version: sidecarVersion, os: "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)")))
    var session: CaptureSession?
    let lock = NSLock()
    func finish(_ code: Int32) {
        Task {
            let s = lock.withLock { session }
            await s?.stop()
            sink.flush()
            exit(code)
        }
    }
    sink.readMessages({ m in
        if m.type == MessageType.config.rawValue {
            lock.lock()
            let running = session != nil
            lock.unlock()
            guard !running else { return }
            do {
                let config = try m.decode(Config.self)
                let s = CaptureSession(config: config, sink: sink)
                lock.lock()
                session = s
                lock.unlock()
                Task {
                    do {
                        let started = try await s.start()
                        sink.send(.json(.started, started))
                    } catch {
                        let ce = error as? CaptureError
                        sink.send(.json(.error, ErrorPayload(code: ce?.code ?? "capture", message: "\(error)", fatal: true)))
                        finish(1)
                    }
                }
            } catch {
                sink.send(.json(.error, ErrorPayload(code: "protocol", message: "bad config: \(error)", fatal: true)))
                finish(1)
            }
            return
        }
        do {
            guard let c = try Control(m) else { return }
            if c == .stop {
                finish(0)
                return
            }
            lock.lock()
            let s = session
            lock.unlock()
            s?.control(c)
        } catch {
            log("bad control message: \(error)")
        }
    }, closed: { finish(0) })
    runMain {
        if let (w, h, n) = animate { _ = AnimationWindow(width: w, height: h, particles: n ?? 1000) }
        // Run until stop or the socket closes.
        while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
    }
}

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    FileHandle.standardError.write(Data((usage + "\n").utf8))
    exit(2)
}
do {
    let args = try Args(argv.dropFirst(2))
    switch argv[1] {
    case "version", "--version":
        print(sidecarVersion)
    case "list":
        runMain { printJSON(try await listSources()) }
    case "thumbnail":
        let src = try parseSource(args.values["source"] ?? "display:main")
        let (w, h) = try parseSize(args.values["max"] ?? "320x180")
        runMain { FileHandle.standardOutput.write(try await thumbnail(source: src, maxWidth: w, maxHeight: h)) }
    case "doctor":
        printJSON(doctor())
    case "capture":
        let animate = try args.values["animate"].map(parseAnimate)
        if let fd = args.values["fd"] {
            guard let n = Int32(fd) else { throw CaptureError.usage("--fd: not a number") }
            serve(sink: SocketSink(fd: n), animate: animate)
        } else if let path = args.values["socket"] {
            serve(sink: try SocketSink.connect(path: path), animate: animate)
        }
        throw CaptureError.usage("capture needs --fd or --socket")
    case "agent":
        if let fd = args.values["fd"] {
            guard let n = Int32(fd) else { throw CaptureError.usage("--fd: not a number") }
            serveAgent(sink: SocketSink(fd: n))
        } else if let path = args.values["socket"] {
            serveAgent(sink: try SocketSink.connect(path: path))
        }
        throw CaptureError.usage("agent needs --fd or --socket")
    case "bench":
        let vbv = try args.int("vbv-ms", 250)
        LayerEncoder.maxInFlight = try args.int("in-flight", 3)
        lowLatencyRateControl = args.values["llrc"] != "off"
        let layers = try parseLayers(args.values["layers"] ?? "f:1920x1080@60:8000,h:1280x720@60:3500,q:854x480@30:1000", vbvMs: vbv)
        let duration = try args.int("duration", 20)
        let warmup = try args.int("warmup", 2)
        let every = Double(args.values["keyframe-every"] ?? "1") ?? 1
        let animate = try args.values["animate"].map(parseAnimate)
        let particles = try args.int("particles", animate.flatMap { $0.2 } ?? 1000)
        let audio = try args.values["audio-pid"].map { v -> AudioConfig in
            guard let pid = Int32(v) else { throw CaptureError.usage("--audio-pid: not a number") }
            return AudioConfig(pid: pid)
        }
        let srcSpec = args.values["source"] ?? "display:main"
        runMain {
            var src = try parseSource(srcSpec == "window:animate" ? "display:main" : srcSpec)
            var anim: AnimationWindow?
            if let (w, h, _) = animate {
                anim = AnimationWindow(width: w, height: h, particles: particles)
                try await Task.sleep(nanoseconds: 500_000_000)
                if srcSpec == "window:animate" { src = SourceRef(kind: "window", id: anim!.windowID) }
            }
            let config = Config(source: src, layers: layers, gopSeconds: 10, cursor: !args.flags.contains("no-cursor"), audio: audio)
            try await runBench(config: config, duration: duration, keyframeEvery: every, warmup: warmup)
            anim?.close()
        }
    case "help", "-h", "--help":
        print(usage)
    default:
        throw CaptureError.usage("unknown command \(argv[1])\n\n\(usage)")
    }
} catch {
    fail(error)
}
