// SPDX-License-Identifier: AGPL-3.0-only

import AppKit
import CaptureProtocol
import Foundation
import QuartzCore

/// The bench's sink: counts what the encoders produce instead of sending it.
final class BenchSink: FrameSink {
    private let lock = NSLock()
    private var encodeMs: [Int: [Double]] = [:]
    private var keyframeBytes: [Int: [Int]] = [:]
    private var audio = 0
    var recording = false
    var congested: Bool { false }

    func send(_ message: Message) {
        guard recording else { return }
        switch MessageType(rawValue: message.type) {
        case .video:
            guard let (h, data) = try? message.payload.videoHeader() else { return }
            lock.lock()
            encodeMs[Int(h.layer), default: []].append(Double(h.encodeMicros) / 1000)
            if h.keyframe { keyframeBytes[Int(h.layer), default: []].append(data.count) }
            lock.unlock()
        case .audio:
            lock.lock()
            audio += 1
            lock.unlock()
        default:
            break
        }
    }

    func snapshot() -> ([Int: [Double]], [Int: [Int]], Int) {
        lock.lock()
        defer { lock.unlock() }
        return (encodeMs, keyframeBytes, audio)
    }
}

struct BenchLayer: Codable {
    var rid: String
    var size: String
    var fpsAvg: Double
    var droppedPerSecond: Double
    var busyPerSecond: Double
    var kbpsAvg: Double
    var encodeMsP50: Double
    var encodeMsP95: Double
    var encodeMsMax: Double
    var keyframes: Int
    var keyframeBytesAvg: Int
    var forcedKeyframeMsP50: Double
    var forcedKeyframeMsP95: Double
    var forcedKeyframeMsMax: Double
    var forcedKeyframeCount: Int
}

struct BenchReport: Codable {
    var source: String
    var encoder: String
    var seconds: Int
    var captureFpsAvg: Double
    var captureFpsMin: Int
    var idlePerSecond: Double
    var repeatedPerSecond: Double
    var captureDelayMsAvg: Double
    var cpuPercentAvg: Double
    var audioPacketsPerSecond: Double
    var layers: [BenchLayer]
}

/// Parses "f:1920x1080@60:8000,h:1280x720@60:3500" (rid:WxH@fps:kbps).
func parseLayers(_ spec: String, vbvMs: Int) throws -> [LayerConfig] {
    try spec.split(separator: ",").map { part in
        let f = part.split(separator: ":")
        guard f.count == 3 else { throw CaptureError.usage("layer \(part): want rid:WxH@fps:kbps") }
        let sizeFPS = f[1].split(separator: "@")
        let wh = sizeFPS.first?.split(separator: "x") ?? []
        guard sizeFPS.count == 2, wh.count == 2, let w = Int(wh[0]), let h = Int(wh[1]), let fps = Int(sizeFPS[1]), let kbps = Int(f[2]) else {
            throw CaptureError.usage("layer \(part): want rid:WxH@fps:kbps")
        }
        return LayerConfig(rid: String(f[0]), width: w, height: h, fps: fps, kbps: kbps, vbvMs: vbvMs)
    }
}

/// Runs a capture for duration seconds, forcing a key frame on every layer every keyframeEvery
/// seconds, and prints the report (the macOS capture measurement).
@MainActor
func runBench(config: Config, duration: Int, keyframeEvery: Double, warmup: Int) async throws {
    let sink = BenchSink()
    let session = CaptureSession(config: config, sink: sink)
    var perSecond: [Stats] = []
    var forced: [String: [Double]] = [:]
    let lock = NSLock()
    session.onStats = { st in
        lock.lock()
        perSecond.append(st)
        lock.unlock()
    }
    session.onForcedKeyframe = { rid, delay in
        lock.lock()
        forced[rid, default: []].append(delay * 1000)
        lock.unlock()
    }
    let started = try await session.start()
    log("bench: \(started.width)x\(started.height) with \(started.encoder); warm-up \(warmup) s, then \(duration) s")
    try await Task.sleep(nanoseconds: UInt64(warmup) * 1_000_000_000)
    lock.withLock { perSecond.removeAll() }
    sink.recording = true
    let end = Date().addingTimeInterval(Double(duration))
    while Date() < end {
        try await Task.sleep(nanoseconds: UInt64(keyframeEvery * 1e9))
        for i in 0..<config.layers.count {
            session.control(.keyframe(layer: UInt8(i)))
        }
    }
    sink.recording = false
    await session.stop()
    let (seconds, forcedMs) = lock.withLock { (perSecond, forced) }
    let (encodeMs, keyBytes, audio) = sink.snapshot()
    let n = Double(max(1, seconds.count))
    var layers: [BenchLayer] = []
    for (i, l) in config.layers.enumerated() {
        let ls = seconds.compactMap { $0.layers.indices.contains(i) ? $0.layers[i] : nil }
        let f = forcedMs[l.rid] ?? []
        let enc = encodeMs[i] ?? []
        let kb = keyBytes[i] ?? []
        layers.append(BenchLayer(
            rid: l.rid, size: "\(l.width)x\(l.height)@\(l.fps)",
            fpsAvg: Double(ls.reduce(0) { $0 + $1.frames }) / n,
            droppedPerSecond: Double(ls.reduce(0) { $0 + $1.dropped }) / n,
            busyPerSecond: Double(ls.reduce(0) { $0 + $1.busy }) / n,
            kbpsAvg: Double(ls.reduce(0) { $0 + $1.bytes }) * 8 / 1000 / n,
            encodeMsP50: percentile(enc, 0.5), encodeMsP95: percentile(enc, 0.95), encodeMsMax: enc.max() ?? 0,
            keyframes: ls.reduce(0) { $0 + $1.keyframes }, keyframeBytesAvg: kb.isEmpty ? 0 : kb.reduce(0, +) / kb.count,
            forcedKeyframeMsP50: percentile(f, 0.5), forcedKeyframeMsP95: percentile(f, 0.95), forcedKeyframeMsMax: f.max() ?? 0,
            forcedKeyframeCount: f.count))
    }
    let report = BenchReport(
        source: "\(config.source.kind) \(config.source.id)", encoder: started.encoder, seconds: seconds.count,
        captureFpsAvg: Double(seconds.reduce(0) { $0 + $1.captured }) / n,
        captureFpsMin: seconds.map(\.captured).min() ?? 0,
        idlePerSecond: Double(seconds.reduce(0) { $0 + $1.idle }) / n,
        repeatedPerSecond: Double(seconds.reduce(0) { $0 + $1.repeated }) / n,
        captureDelayMsAvg: seconds.map(\.captureDelayMsAvg).reduce(0, +) / n,
        cpuPercentAvg: seconds.map(\.cpuPercent).reduce(0, +) / n,
        audioPacketsPerSecond: Double(audio) / n,
        layers: layers)
    printJSON(report)
}

/// A moving test picture in a window of its own (--animate): bars that cross the window at
/// different speeds, a spinning square and a millisecond clock, all redrawn every display
/// refresh, so ScreenCaptureKit has a changed frame at every refresh. Core Animation runs the
/// motion in the window server; only the clock's text is set from here.
@MainActor
final class AnimationWindow {
    private let window: NSWindow
    private let clock = CATextLayer()
    private var timer: Timer?

    init(width: Int, height: Int, particles: Int = 1000) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let screen = NSScreen.main?.frame ?? .zero
        let rect = NSRect(x: screen.minX + 40, y: screen.maxY - CGFloat(height) - 80, width: CGFloat(width), height: CGFloat(height))
        window = NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Openlive capture test"
        window.level = .floating
        window.backgroundColor = .black
        let view = NSView(frame: NSRect(origin: .zero, size: rect.size))
        view.wantsLayer = true
        let root = view.layer!
        root.backgroundColor = CGColor(gray: 0.1, alpha: 1)
        let colors: [CGColor] = [.init(red: 1, green: 0.2, blue: 0.2, alpha: 1), .init(red: 0.2, green: 1, blue: 0.3, alpha: 1),
                                 .init(red: 0.2, green: 0.4, blue: 1, alpha: 1), .init(red: 1, green: 0.9, blue: 0.2, alpha: 1)]
        let barH = rect.height / 8
        for i in 0..<8 {
            let bar = CALayer()
            bar.backgroundColor = colors[i % colors.count]
            bar.frame = CGRect(x: 0, y: CGFloat(i) * barH, width: rect.width / 5, height: barH - 4)
            let a = CABasicAnimation(keyPath: "position.x")
            a.fromValue = -rect.width / 10
            a.toValue = rect.width + rect.width / 10
            a.duration = 1.0 + Double(i) * 0.37
            a.repeatCount = .infinity
            bar.add(a, forKey: "move")
            root.addSublayer(bar)
        }
        // Many small fast particles: detail that changes everywhere, which the encoder has to
        // spend bits on (the bars alone compress to almost nothing).
        let emitter = CAEmitterLayer()
        emitter.emitterPosition = CGPoint(x: rect.width / 2, y: rect.height / 2)
        emitter.emitterSize = CGSize(width: rect.width, height: rect.height)
        emitter.emitterShape = .rectangle
        let cell = CAEmitterCell()
        cell.contents = Self.dot()
        cell.birthRate = Float(particles)
        cell.lifetime = 1.5
        cell.velocity = 600
        cell.velocityRange = 400
        cell.emissionRange = .pi * 2
        cell.scale = 0.6
        cell.scaleRange = 0.5
        cell.color = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
        cell.redRange = 1
        cell.greenRange = 1
        cell.blueRange = 1
        emitter.emitterCells = [cell]
        root.addSublayer(emitter)
        let square = CALayer()
        square.backgroundColor = CGColor(gray: 1, alpha: 0.85)
        square.frame = CGRect(x: rect.width / 2 - 80, y: rect.height / 2 - 80, width: 160, height: 160)
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0
        spin.toValue = Double.pi * 2
        spin.duration = 2
        spin.repeatCount = .infinity
        square.add(spin, forKey: "spin")
        root.addSublayer(square)
        clock.fontSize = 48
        clock.foregroundColor = .white
        clock.backgroundColor = CGColor(gray: 0, alpha: 0.7)
        clock.font = NSFont.monospacedDigitSystemFont(ofSize: 48, weight: .bold)
        clock.frame = CGRect(x: 20, y: rect.height - 80, width: 360, height: 60)
        clock.contentsScale = 2
        root.addSublayer(clock)
        window.contentView = view
        window.orderFrontRegardless()
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss.SSS"
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick(fmt) }
        }
    }

    private static func dot() -> CGImage? {
        let ctx = CGContext(data: nil, width: 12, height: 12, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        ctx?.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx?.fill(CGRect(x: 0, y: 0, width: 12, height: 12))
        return ctx?.makeImage()
    }

    private func tick(_ fmt: DateFormatter) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        clock.string = fmt.string(from: Date())
        CATransaction.commit()
    }

    var windowID: UInt32 { UInt32(window.windowNumber) }

    func close() {
        timer?.invalidate()
        window.close()
    }
}
