// SPDX-License-Identifier: AGPL-3.0-only

import CaptureProtocol
import CoreMedia
import Foundation
import VideoToolbox

/// One simulcast layer's H.264 encoder (VideoToolbox, hardware only).
///
/// The encoder rules, as VideoToolbox spells them: low-latency rate
/// control (the encoder specification), real time, no frame reordering (no B-frames), no frame
/// delay, constrained baseline, an average bitrate with a data-rate limit over the VBV window
/// (no window ever carries more than the bitrate allows, which bounds an IDR the way the VBV
/// does on Linux), the long GOP as a fallback and a key frame on demand. A bitrate change
/// applies in place; VideoToolbox emits no IDR for it, so the limit follows the new bitrate
/// with the same window.
/// Bench knob (--llrc off): the normal rate control instead of the low-latency one, to compare.
/// It never drops a frame, but overshoots the bitrate and pipelines ~2 frames (README.md).
nonisolated(unsafe) var lowLatencyRateControl = true

final class LayerEncoder {
    let index: UInt8
    let config: LayerConfig
    private let session: VTCompressionSession
    private let lock = NSLock()
    private var forceNext = false
    private(set) var kbps: Int
    private(set) var fps: Int
    /// When the next frame is due (host clock, seconds), for the fps decimation.
    private var nextDue: Double?
    /// Called on VideoToolbox's thread with each access unit.
    var output: ((VideoHeader, Data) -> Void)?
    /// Called when a forced key frame comes out, with the time since the request.
    var forcedKeyframe: ((TimeInterval) -> Void)?
    private var forcedAt: [UInt64] = []

    // Stats for the current second.
    private var frames = 0, keyframes = 0, bytes = 0, dropped = 0, busy = 0
    private var inFlight = 0
    nonisolated(unsafe) static var maxInFlight = 3
    private let queue: DispatchQueue
    private var encodeSum = 0.0, encodeMax = 0.0

    init(index: UInt8, config: LayerConfig, gopSeconds: Double) throws {
        self.index = index
        self.config = config
        kbps = config.kbps
        fps = config.fps
        queue = DispatchQueue(label: "openlive.encode.\(config.rid)", qos: .userInteractive)
        // ConstantBitRate is refused with low-latency rate control (-12900 on an M4 Pro), and
        // MaxAllowedFrameQP 51 did not stop its frame drops; the average bitrate plus the
        // data-rate limit is what holds.
        var spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
        ]
        if !lowLatencyRateControl { spec[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = false }
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(config.width), height: Int32(config.height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let s else {
            throw CaptureError.encoder("VTCompressionSessionCreate \(config.width)x\(config.height): \(status)")
        }
        session = s
        let gopFrames = max(1, Int(gopSeconds * Double(config.fps)))
        let props: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, true),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, false),
            (kVTCompressionPropertyKey_MaxFrameDelayCount, 0),
            (kVTCompressionPropertyKey_ExpectedFrameRate, config.fps),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, gopFrames),
            (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, gopSeconds),
            (kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, true),
        ]
        // Low-latency rate control has no frame delay to set and is always tuned for speed: it
        // answers -12900 (property not supported) for these two, as expected.
        let optional: Set<String> = [kVTCompressionPropertyKey_MaxFrameDelayCount as String,
                                     kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality as String]
        for (key, value) in props {
            let st = VTSessionSetProperty(s, key: key, value: value as CFTypeRef)
            if st != noErr, !optional.contains(key as String) {
                log("encoder \(config.rid): \(key) not set: \(st)")
            }
        }
        try applyBitrate(config.kbps)
        VTCompressionSessionPrepareToEncodeFrames(s)
    }

    deinit {
        VTCompressionSessionInvalidate(session)
    }

    var encoderName: String {
        var value: CFTypeRef?
        _ = withUnsafeMutablePointer(to: &value) {
            VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_EncoderID, allocator: nil, valueOut: UnsafeMutableRawPointer($0))
        }
        return (value as? String) ?? "videotoolbox"
    }

    private func applyBitrate(_ kbps: Int) throws {
        let st1 = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (kbps * 1000) as CFNumber)
        var st2 = noErr
        if config.vbvMs > 0 {
            let window = Double(max(20, config.vbvMs)) / 1000
            let limit = [Double(kbps) * 1000 / 8 * window, window] as CFArray
            st2 = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limit)
        }
        if st1 != noErr {
            throw CaptureError.encoder("layer \(config.rid): bitrate \(kbps) kbit/s: \(st1)")
        }
        if st2 != noErr {
            log("encoder \(config.rid): data rate limit not set: \(st2)")
        }
    }

    /// Changes the bitrate on the encoder's queue, without the lock: VideoToolbox waits for the
    /// frames in flight, whose output handler takes the lock (holding it here deadlocked the
    /// first live bitrate change).
    func setBitrate(_ kbps: Int) {
        lock.lock()
        let changed = kbps > 0 && kbps != self.kbps
        if changed { self.kbps = kbps }
        lock.unlock()
        guard changed else { return }
        queue.async { [self] in
            do {
                try applyBitrate(kbps)
            } catch {
                log("\(error)")
            }
        }
    }

    func setFPS(_ fps: Int) {
        guard fps > 0 else { return }
        lock.lock()
        self.fps = fps
        lock.unlock()
        queue.async { [self] in
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        }
    }

    func requestKeyframe() {
        lock.lock()
        forceNext = true
        forcedAt.append(hostNanos())
        lock.unlock()
    }

    /// Whether a frame at pts is due at this layer's rate. The capture runs faster than the
    /// fastest layer (CaptureSession), and each layer keeps its own clock of due times, so a 60
    /// fps layer averages 60 on a 175 Hz display (taking 2 or 3 of its 5.7 ms ticks in turn)
    /// and a 30 fps layer takes every other frame of a 60 Hz one. A pending key frame is
    /// always due.
    func due(_ pts: CMTime) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let interval = 1.0 / Double(fps)
        let t = pts.seconds
        if forceNext || nextDue == nil {
            return true
        }
        // A fifth of an interval absorbs the capture's jitter.
        return t >= nextDue! - interval * 0.2
    }

    /// Queues one frame. The encoder runs on its own queue with at most maxInFlight frames
    /// submitted and not yet out: VTCompressionSessionEncodeFrame blocks while the hardware is
    /// behind (3440x1440 at 120 fps is more than one low-latency session encodes), and on the
    /// capture queue that stalled the capture itself. A frame over the limit is dropped before
    /// it is encoded (counted as busy), so the layer runs at what the encoder holds.
    func encode(_ buffer: CVPixelBuffer, pts: CMTime) {
        lock.lock()
        if inFlight >= LayerEncoder.maxInFlight {
            busy += 1
            lock.unlock()
            return
        }
        inFlight += 1
        let force = forceNext
        forceNext = false
        let interval = 1.0 / Double(fps)
        let t = pts.seconds
        // After a gap (a still screen) the clock starts again from this frame.
        if let due = nextDue, t - due < interval {
            nextDue = due + interval
        } else {
            nextDue = t + interval
        }
        lock.unlock()
        let props: CFDictionary? = force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        queue.async { [self] in
            let submitted = hostNanos()
            let status = VTCompressionSessionEncodeFrame(
                session, imageBuffer: buffer, presentationTimeStamp: pts, duration: .invalid,
                frameProperties: props, infoFlagsOut: nil
            ) { [weak self] status, flags, sample in
                guard let self else { return }
                self.lock.lock()
                self.inFlight -= 1
                self.lock.unlock()
                guard status == noErr, let sample, !flags.contains(.frameDropped) else {
                    self.lock.lock()
                    self.dropped += 1
                    if force { self.forceNext = true }
                    self.lock.unlock()
                    return
                }
                self.emit(sample, submitted: submitted)
            }
            if status != noErr {
                lock.lock()
                inFlight -= 1
                if force { forceNext = true }
                lock.unlock()
                log("encoder \(config.rid): encode failed: \(status)")
            }
        }
    }

    private func emit(_ sample: CMSampleBuffer, submitted: UInt64) {
        let now = hostNanos()
        let key = isKeyframe(sample)
        guard let au = annexB(sample, keyframe: key) else { return }
        let encodeMicros = UInt32(min(UInt64(UInt32.max), (now - submitted) / 1000))
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let header = VideoHeader(layer: index, keyframe: key, ptsNanos: UInt64(max(0, pts.seconds) * 1e9), encodeMicros: encodeMicros)
        var forced: [TimeInterval] = []
        lock.lock()
        frames += 1
        bytes += au.count
        let ms = Double(encodeMicros) / 1000
        encodeSum += ms
        encodeMax = max(encodeMax, ms)
        if key {
            keyframes += 1
            forced = forcedAt.map { Double(now - $0) / 1e9 }
            forcedAt.removeAll()
        }
        lock.unlock()
        output?(header, au)
        if let f = forcedKeyframe {
            forced.forEach(f)
        }
    }

    /// The stats since the last call.
    func takeStats() -> LayerStats {
        lock.lock()
        defer {
            frames = 0
            dropped = 0
            busy = 0
            keyframes = 0
            bytes = 0
            encodeSum = 0
            encodeMax = 0
            lock.unlock()
        }
        return LayerStats(rid: config.rid, frames: frames, dropped: dropped, busy: busy, keyframes: keyframes, bytes: bytes,
                          encodeMsAvg: frames > 0 ? encodeSum / Double(frames) : 0, encodeMsMax: encodeMax)
    }

    func flush() {
        queue.sync {}
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    }
}

func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
          let first = attachments.first
    else { return true }
    return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
}

private let startCode: [UInt8] = [0, 0, 0, 1]

/// annexB turns VideoToolbox's AVCC sample into an Annex B access unit, with the SPS and PPS
/// before every key frame (what h264parse config-interval=-1 does on Linux).
func annexB(_ sample: CMSampleBuffer, keyframe: Bool) -> Data? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    let length = CMBlockBufferGetDataLength(block)
    var avcc = Data(count: length)
    let copied = avcc.withUnsafeMutableBytes { raw in
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
    }
    guard copied == noErr else { return nil }
    var out = Data(capacity: length + 128)
    var nalLength: Int32 = 4
    if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                           parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                           nalUnitHeaderLengthOut: &nalLength)
        for i in 0..<count {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                  parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                  nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                out.append(contentsOf: startCode)
                out.append(ptr, count: size)
            }
        }
    }
    let n = Int(nalLength)
    var offset = 0
    while offset + n <= avcc.count {
        var size = 0
        for i in 0..<n {
            size = size << 8 | Int(avcc[offset + i])
        }
        offset += n
        guard size > 0, offset + size <= avcc.count else { break }
        out.append(contentsOf: startCode)
        out.append(avcc[offset..<(offset + size)])
        offset += size
    }
    return out
}
