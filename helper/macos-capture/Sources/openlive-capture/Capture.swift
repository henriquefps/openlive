// SPDX-License-Identifier: AGPL-3.0-only

import CaptureProtocol
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit
import VideoToolbox

/// Where the session's messages go: the helper's socket, or the bench's counters.
protocol FrameSink: AnyObject {
    func send(_ message: Message)
    /// True while the writer is behind: new frames are then dropped before encoding (a raw
    /// frame, never an encoded one, which would break decoding until the next IDR).
    var congested: Bool { get }
}

/// One capture: a display or a window through ScreenCaptureKit at the top layer's size and
/// rate, scaled on the GPU (VTPixelTransferSession) for the lower layers, each layer encoded by
/// its own LayerEncoder. A static screen makes ScreenCaptureKit deliver nothing, so the last
/// frame is encoded again after 250 ms without one (a 4 fps floor), and at once for a key frame
/// request: a viewer joining a still screen still gets its IDR right away.
///
/// The privacy curtain works as on Linux: every layer encodes a black frame
/// instead of the screen and the app audio is muted, so the encoders, the tracks and the
/// viewers stay connected. The capture goes on (the last real frame is kept for the IDR when
/// the curtain lifts), but no thumbnail is taken while it is down.
final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let config: Config
    private let sink: FrameSink
    private let queue = DispatchQueue(label: "openlive.capture", qos: .userInteractive)
    private let thumbQueue = DispatchQueue(label: "openlive.thumbnail", qos: .utility)
    private var stream: SCStream?
    private(set) var encoders: [LayerEncoder] = []
    private var scalers: [Int: Scaler] = [:]
    private var audio: AudioCapture?
    private var timers: [DispatchSourceTimer] = []
    private let cpu = CPUMeter()
    private lazy var ciContext = CIContext(options: [.useSoftwareRenderer: false])

    // Capture state, on queue.
    private var lastBuffer: CVPixelBuffer?
    private var lastFrameNanos: UInt64 = 0
    private var captured = 0, idle = 0, repeated = 0, dropped = 0
    private var delaySum = 0.0, delayCount = 0
    private var windowState = "shown"
    private var stopped = false
    private var curtain = false
    private var black: CVPixelBuffer?

    /// Bench hooks: every forced key frame's delay, every second's stats.
    var onForcedKeyframe: ((String, TimeInterval) -> Void)?
    var onStats: ((Stats) -> Void)?

    init(config: Config, sink: FrameSink) {
        self.config = config
        self.sink = sink
    }

    func start() async throws -> Started {
        guard let top = config.layers.first else { throw CaptureError.usage("no layers") }
        if !CGPreflightScreenCaptureAccess() {
            // Shows the system prompt once; the helper reports the error and the steps.
            CGRequestScreenCaptureAccess()
            throw CaptureError.permission
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw CaptureError.permission
        }
        let filter = try makeFilter(content)

        for (i, l) in config.layers.enumerated() {
            let enc = try LayerEncoder(index: UInt8(i), config: l, gopSeconds: config.gopSeconds)
            enc.output = { [weak self] header, au in
                self?.sink.send(header.message(au))
            }
            enc.forcedKeyframe = { [weak self] delay in
                self?.onForcedKeyframe?(l.rid, delay)
            }
            encoders.append(enc)
            if i > 0, l.width != top.width || l.height != top.height {
                scalers[i] = try Scaler(width: l.width, height: l.height)
            }
        }

        let sc = SCStreamConfiguration()
        sc.width = top.width
        sc.height = top.height
        // Faster than the top layer: on a display whose refresh is not a multiple of the
        // layer's rate (175 Hz), capturing at exactly 1/fps lands on every third tick (58 fps
        // for 60); the encoders pick their frames from the faster capture (LayerEncoder.due).
        sc.minimumFrameInterval = CMTime(value: 2, timescale: CMTimeScale(top.fps * 3))
        sc.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        sc.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        sc.showsCursor = config.cursor
        sc.queueDepth = 6
        sc.scalesToFit = true
        if #available(macOS 14.0, *) {
            sc.preservesAspectRatio = true
        }
        sc.backgroundColor = CGColor.black
        sc.capturesAudio = false
        let s = SCStream(filter: filter, configuration: sc, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s

        var audioApp: AppInfo?
        if let ac = config.audio {
            let a = AudioCapture(config: ac, sink: sink)
            do {
                audioApp = try await a.start(content: content)
                audio = a
            } catch {
                // The video goes on without audio, as on Linux.
                log("\(error)")
                sink.send(.json(.error, ErrorPayload(code: "audio", message: "\(error)", fatal: false)))
            }
        }
        startTimers()
        return Started(width: top.width, height: top.height, encoder: encoders.first?.encoderName ?? "videotoolbox", audioApp: audioApp)
    }

    private func makeFilter(_ content: SCShareableContent) throws -> SCContentFilter {
        switch config.source.kind {
        case "display":
            guard let d = content.displays.first(where: { $0.displayID == config.source.id }) else {
                throw CaptureError.sourceNotFound("display \(config.source.id)")
            }
            return SCContentFilter(display: d, excludingApplications: [], exceptingWindows: [])
        case "window":
            guard let w = content.windows.first(where: { $0.windowID == config.source.id }) else {
                throw CaptureError.sourceNotFound("window \(config.source.id)")
            }
            return SCContentFilter(desktopIndependentWindow: w)
        default:
            throw CaptureError.usage("unknown source kind \(config.source.kind)")
        }
    }

    private func timer(every interval: TimeInterval, on q: DispatchQueue? = nil, _ fn: @escaping () -> Void) {
        let t = DispatchSource.makeTimerSource(queue: q ?? queue)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(5))
        t.setEventHandler(handler: fn)
        t.resume()
        timers.append(t)
    }

    private func startTimers() {
        timer(every: 0.05) { [weak self] in self?.repeatIfStill() }
        timer(every: 1) { [weak self] in self?.sendStats() }
        if let th = config.thumbnail, th.everyMs > 0 {
            timer(every: Double(th.everyMs) / 1000) { [weak self] in self?.thumbnail(width: th.width) }
        }
        if config.source.kind == "window" {
            timer(every: 1, on: .global(qos: .utility)) { [weak self] in self?.checkWindow() }
        }
    }

    // MARK: Frames

    func stream(_: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, !stopped else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let info = attachments.first,
              let raw = info[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw)
        else { return }
        guard status == .complete else {
            if status == .idle { idle += 1 }
            return
        }
        guard let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
        let now = hostNanos()
        if let display = info[.displayTime] as? UInt64 {
            let d = Double(Int64(now) - Int64(machToNanos(display))) / 1e6
            if d >= 0, d < 1000 {
                delaySum += d
                delayCount += 1
            }
        }
        captured += 1
        lastBuffer = buffer
        lastFrameNanos = now
        encodeAll(buffer, pts: CMSampleBufferGetPresentationTimeStamp(sample), only: nil)
    }

    private func encodeAll(_ screen: CVPixelBuffer, pts: CMTime, only: Int?) {
        if sink.congested {
            dropped += 1
            return
        }
        var buffer = screen
        if curtain {
            guard let b = blackFrame() else { return }
            buffer = b
        }
        for (i, enc) in encoders.enumerated() where only == nil || only == i {
            guard only != nil || enc.due(pts) else { continue }
            if let scaler = scalers[i] {
                guard let scaled = scaler.scale(buffer) else { continue }
                enc.encode(scaled, pts: pts)
            } else {
                enc.encode(buffer, pts: pts)
            }
        }
    }

    /// A black NV12 frame of the capture's size (video range: Y 16, CbCr 128).
    private func blackFrame() -> CVPixelBuffer? {
        if let black { return black }
        guard let top = config.layers.first else { return nil }
        let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        var b: CVPixelBuffer?
        guard CVPixelBufferCreate(nil, top.width, top.height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs as CFDictionary, &b) == kCVReturnSuccess,
              let b
        else { return nil }
        CVPixelBufferLockBaseAddress(b, [])
        for (plane, value) in [(0, 16), (1, 128)] {
            if let base = CVPixelBufferGetBaseAddressOfPlane(b, plane) {
                memset(base, Int32(value), CVPixelBufferGetBytesPerRowOfPlane(b, plane) * CVPixelBufferGetHeightOfPlane(b, plane))
            }
        }
        CVPixelBufferUnlockBaseAddress(b, [])
        CVBufferSetAttachment(b, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        black = b
        return b
    }

    private func hostPTS() -> CMTime {
        CMClockGetTime(CMClockGetHostTimeClock())
    }

    private func repeatIfStill() {
        guard !stopped, let buffer = lastBuffer, hostNanos() - lastFrameNanos > 250_000_000 else { return }
        repeated += 1
        lastFrameNanos = hostNanos()
        encodeAll(buffer, pts: hostPTS(), only: nil)
    }

    // MARK: Control

    func control(_ c: Control) {
        queue.async { [self] in
            switch c {
            case let .keyframe(layer):
                guard Int(layer) < encoders.count else { return }
                let enc = encoders[Int(layer)]
                enc.requestKeyframe()
                // A still screen sends no frame to put the IDR on: encode the last one now.
                let interval = UInt64(2e9 / Double(max(1, enc.fps)))
                if let buffer = lastBuffer, hostNanos() - lastFrameNanos > interval {
                    repeated += 1
                    encodeAll(buffer, pts: hostPTS(), only: Int(layer))
                }
            case let .bitrate(layer, kbps):
                if Int(layer) < encoders.count { encoders[Int(layer)].setBitrate(Int(kbps)) }
            case let .fps(layer, fps):
                if Int(layer) < encoders.count { encoders[Int(layer)].setFPS(Int(fps)) }
            case let .curtain(on):
                guard on != curtain else { return }
                curtain = on
                audio?.muted = on
                log("privacy curtain \(on ? "on" : "off")")
                // Black at once on a still screen; when it lifts, the helper asks every layer for
                // a key frame, which puts the screen back right away.
                if on, let buffer = lastBuffer {
                    repeated += 1
                    lastFrameNanos = hostNanos()
                    encodeAll(buffer, pts: hostPTS(), only: nil)
                }
            case .stop:
                break
            }
        }
    }

    func stop() async {
        queue.sync { stopped = true }
        timers.forEach { $0.cancel() }
        timers.removeAll()
        try? await stream?.stopCapture()
        stream = nil
        await audio?.stop()
        encoders.forEach { $0.flush() }
    }

    // MARK: Stats, thumbnails, window state

    private func sendStats() {
        let st = Stats(captured: captured, idle: idle, repeated: repeated, dropped: dropped,
                       captureDelayMsAvg: delayCount > 0 ? delaySum / Double(delayCount) : 0,
                       cpuPercent: cpu.sample(), layers: encoders.map { $0.takeStats() },
                       audioPackets: audio?.takePackets() ?? 0)
        captured = 0
        idle = 0
        repeated = 0
        dropped = 0
        delaySum = 0
        delayCount = 0
        sink.send(.json(.stats, st))
        onStats?(st)
    }

    /// A small JPEG of the capture for the stream card.
    private func thumbnail(width: Int) {
        guard !curtain, let buffer = lastBuffer else { return }
        thumbQueue.async { [self] in
            let image = CIImage(cvPixelBuffer: buffer)
            let scale = Double(width) / image.extent.width
            let small = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            guard let jpeg = ciContext.jpegRepresentation(of: small, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                          options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7])
            else { return }
            sink.send(Message(.thumbnail, jpeg))
        }
    }

    /// A shared window that closes ends the stream; a minimized or hidden one pauses it.
    private func checkWindow() {
        Task { [self] in
            guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else { return }
            let w = content.windows.first(where: { $0.windowID == config.source.id })
            let state = w == nil ? "ended" : (w!.isOnScreen ? "shown" : "hidden")
            queue.async { [self] in
                guard state != windowState, !stopped else { return }
                windowState = state
                let size = w.map { (Int($0.frame.width), Int($0.frame.height)) }
                sink.send(.json(.event, Event(event: state, width: size?.0, height: size?.1)))
            }
        }
    }

    func stream(_: SCStream, didStopWithError error: Error) {
        log("capture stopped: \(error)")
        queue.async { [self] in
            guard !stopped else { return }
            sink.send(.json(.event, Event(event: "ended")))
        }
    }
}

/// Scales NV12 frames on the GPU into a pool of the layer's size.
final class Scaler {
    private let session: VTPixelTransferSession
    private let pool: CVPixelBufferPool

    init(width: Int, height: Int) throws {
        var s: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &s) == noErr, let s else {
            throw CaptureError.encoder("VTPixelTransferSessionCreate")
        }
        VTSessionSetProperty(s, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox)
        VTSessionSetProperty(s, key: kVTPixelTransferPropertyKey_DestinationYCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        session = s
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var p: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &p) == kCVReturnSuccess, let p else {
            throw CaptureError.encoder("CVPixelBufferPoolCreate \(width)x\(height)")
        }
        pool = p
    }

    deinit {
        VTPixelTransferSessionInvalidate(session)
    }

    func scale(_ src: CVPixelBuffer) -> CVPixelBuffer? {
        var dst: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &dst) == kCVReturnSuccess, let dst else { return nil }
        guard VTPixelTransferSessionTransferImage(session, from: src, to: dst) == noErr else { return nil }
        return dst
    }
}
