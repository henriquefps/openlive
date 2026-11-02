// SPDX-License-Identifier: AGPL-3.0-only

import AVFoundation
import CaptureProtocol
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

/// One app's audio: its own ScreenCaptureKit stream whose filter includes that
/// app only, so nothing else is heard (a browser in an Openlive voice channel is left out
/// unless it is the app captured), with this process left out too. The PCM (48 kHz stereo) is
/// encoded to Opus by AudioToolbox in 20 ms packets.
final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let config: AudioConfig
    private let sink: FrameSink
    private let queue = DispatchQueue(label: "openlive.audio", qos: .userInteractive)
    private var stream: SCStream?
    private var opus: OpusEncoder?
    private let lock = NSLock()
    private var packets = 0
    private var loggedFirst = false
    private var mutedFlag = false

    /// muted encodes silence instead of the app (the privacy curtain): the track keeps its
    /// timing and the viewers hear nothing.
    var muted: Bool {
        get { lock.withLock { mutedFlag } }
        set { lock.withLock { mutedFlag = newValue } }
    }

    init(config: AudioConfig, sink: FrameSink) {
        self.config = config
        self.sink = sink
    }

    func start(content: SCShareableContent) async throws -> AppInfo {
        let app = content.applications.first { a in
            if let pid = config.pid, pid > 0 { return a.processID == pid }
            return a.bundleIdentifier == config.bundleId
        }
        guard let app, let display = content.displays.first else {
            throw CaptureError.audio("app \(config.pid.map(String.init) ?? config.bundleId ?? "?") not found")
        }
        // A browser (and other multi-process apps) plays its sound from helper processes,
        // listed as apps of their own: com.google.Chrome.helper, com.brave.Browser.helper….
        let family = content.applications.filter { a in
            a.processID == app.processID || (!app.bundleIdentifier.isEmpty && a.bundleIdentifier.hasPrefix(app.bundleIdentifier + "."))
        }
        log("audio: \(app.applicationName) with \(family.count - 1) helper process(es)")
        let filter = SCContentFilter(display: display, including: family, exceptingWindows: [])
        let sc = SCStreamConfiguration()
        sc.capturesAudio = true
        sc.excludesCurrentProcessAudio = true
        sc.sampleRate = 48000
        sc.channelCount = 2
        // The video of this stream is not used: keep it tiny and slow.
        sc.width = 2
        sc.height = 2
        sc.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        sc.queueDepth = 3
        let s = SCStream(filter: filter, configuration: sc, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        // Without a screen output ScreenCaptureKit logs every dropped video frame.
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        opus = try OpusEncoder(bitrate: (config.kbps ?? 128) * 1000)
        try await s.startCapture()
        stream = s
        return AppInfo(name: app.applicationName, bundleId: app.bundleIdentifier, pid: app.processID)
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
    }

    func takePackets() -> Int {
        lock.lock()
        defer {
            packets = 0
            lock.unlock()
        }
        return packets
    }

    private var samples = 0

    func stream(_: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid, let opus else { return }
        samples += 1
        if samples == 1, let d = CMSampleBufferGetFormatDescription(sample), let a = CMAudioFormatDescriptionGetStreamBasicDescription(d) {
            log("audio: first buffer \(a.pointee.mSampleRate) Hz, \(a.pointee.mChannelsPerFrame) ch, flags \(a.pointee.mFormatFlags), \(CMSampleBufferGetNumSamples(sample)) frames")
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        opus.feed(sample, pts: pts, silent: muted) { [self] packet, ptsNanos in
            lock.lock()
            packets += 1
            let first = packets == 1 && !loggedFirst
            loggedFirst = loggedFirst || first
            lock.unlock()
            if first, let toc = packet.first {
                // TOC 0xfc: CELT fullband 20 ms, stereo (RFC 6716 §3.1).
                log("audio: first Opus packet \(packet.count) bytes, TOC 0x\(String(toc, radix: 16))")
            }
            sink.send(AudioHeader(ptsNanos: ptsNanos, durationMicros: 20000).message(packet))
        }
    }

    func stream(_: SCStream, didStopWithError error: Error) {
        log("audio capture stopped: \(error)")
        sink.send(.json(.error, ErrorPayload(code: "audio", message: "\(error)", fatal: false)))
    }
}

/// PCM → Opus with AVAudioConverter, 20 ms (960 frames at 48 kHz) per packet.
final class OpusEncoder {
    static let frames: AVAudioFrameCount = 960
    private let pcmFormat: AVAudioFormat
    private let opusFormat: AVAudioFormat
    private let converter: AVAudioConverter
    private let pending: AVAudioPCMBuffer
    private var pendingPTS: UInt64 = 0
    private var inputConverter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var failures = 0

    init(bitrate: Int) throws {
        guard let pcm = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false),
              let op = AVAudioFormat(settings: [AVFormatIDKey: kAudioFormatOpus, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2]),
              let conv = AVAudioConverter(from: pcm, to: op),
              let buf = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: OpusEncoder.frames)
        else { throw CaptureError.audio("no Opus encoder in AudioToolbox") }
        conv.bitRate = bitrate
        pcmFormat = pcm
        opusFormat = op
        converter = conv
        pending = buf
    }

    /// Adds a sample buffer's PCM and calls out once per full 20 ms packet.
    func feed(_ sample: CMSampleBuffer, pts: CMTime, silent: Bool = false, out: (Data, UInt64) -> Void) {
        guard let desc = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)
        else { return }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard frames > 0 else { return }
        var streamDesc = asbd.pointee
        guard let fmt = AVAudioFormat(streamDescription: &streamDesc),
              let input = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames)
        else { return }
        input.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: input.mutableAudioBufferList) == noErr else { return }
        guard let pcm = toPCM(input) else { return }
        var ptsNanos = UInt64(max(0, pts.seconds) * 1e9)
        var offset: AVAudioFrameCount = 0
        while offset < pcm.frameLength {
            if pending.frameLength == 0 { pendingPTS = ptsNanos }
            let n = min(OpusEncoder.frames - pending.frameLength, pcm.frameLength - offset)
            for ch in 0..<Int(pcmFormat.channelCount) {
                let src = pcm.floatChannelData![min(ch, Int(pcm.format.channelCount) - 1)] + Int(offset)
                let dst = pending.floatChannelData![ch] + Int(pending.frameLength)
                if silent {
                    dst.update(repeating: 0, count: Int(n))
                } else {
                    dst.update(from: src, count: Int(n))
                }
            }
            pending.frameLength += n
            offset += n
            ptsNanos += UInt64(n) * 1_000_000_000 / 48000
            if pending.frameLength == OpusEncoder.frames {
                if let packet = encode() { out(packet, pendingPTS) }
                pending.frameLength = 0
            }
        }
    }

    /// The input as non-interleaved Float32 48 kHz stereo (ScreenCaptureKit already sends that).
    private func toPCM(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if input.format == pcmFormat { return input }
        if inputFormat != input.format {
            inputConverter = AVAudioConverter(from: input.format, to: pcmFormat)
            inputFormat = input.format
        }
        guard let conv = inputConverter else { return nil }
        let cap = AVAudioFrameCount(Double(input.frameLength) * 48000 / input.format.sampleRate) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: cap) else { return nil }
        var given = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return input
        }
        return err == nil ? out : nil
    }

    private func encode() -> Data? {
        let out = AVAudioCompressedBuffer(format: opusFormat, packetCapacity: 1, maximumPacketSize: max(converter.maximumOutputPacketSize, 1500))
        var given = false
        var err: NSError?
        let status = converter.convert(to: out, error: &err) { [pending] _, st in
            if given {
                st.pointee = .noDataNow
                return nil
            }
            given = true
            st.pointee = .haveData
            return pending
        }
        guard status != .error, err == nil, out.packetCount > 0, out.byteLength > 0 else {
            failures += 1
            if failures == 1 || failures % 500 == 0 {
                log("audio: Opus encode gave nothing (status \(status.rawValue), \(String(describing: err)), \(out.packetCount) packets)")
            }
            return nil
        }
        if let descs = out.packetDescriptions {
            let d = descs[0]
            return Data(bytes: out.data + Int(d.mStartOffset), count: Int(d.mDataByteSize))
        }
        return Data(bytes: out.data, count: Int(out.byteLength))
    }
}
