// SPDX-License-Identifier: AGPL-3.0-only

// The sidecar's wire format (README.md "Socket protocol"); helper/internal/sidecar mirrors it in
// Go and both test suites check the same bytes.
//
// Every message is a 4-byte big-endian length (of what follows), a 1-byte type and the
// payload. Media messages have a fixed binary header before the data; the rest are JSON.

import Foundation

public enum MessageType: UInt8 {
    // Sidecar → helper.
    case hello = 0x01
    case started = 0x02
    case video = 0x03
    case audio = 0x04
    case stats = 0x05
    case error = 0x06
    case event = 0x07
    case thumbnail = 0x08
    // Agent → helper (Agent.swift).
    case menuClick = 0x09
    case hotkey = 0x0A
    case hotkeysBound = 0x0B
    case notifications = 0x0C
    // Helper → sidecar.
    case config = 0x20
    case keyframe = 0x21
    case bitrate = 0x22
    case fps = 0x23
    case stop = 0x24
    case curtain = 0x25
    // Helper → agent.
    case menu = 0x26
    case notify = 0x27
    case hotkeys = 0x28
}

/// The protocol version in hello; the helper refuses a sidecar of another one. Version 2 added
/// the privacy curtain and the agent's messages.
public let protocolVersion = 2

/// The largest message either side accepts (a 2160p IDR is well under it).
public let maxMessageSize = 32 << 20

public struct Message: Equatable {
    public var type: UInt8
    public var payload: Data

    public init(type: UInt8, payload: Data) {
        self.type = type
        self.payload = payload
    }

    public init(_ type: MessageType, _ payload: Data = Data()) {
        self.init(type: type.rawValue, payload: payload)
    }

    /// The message on the wire: length, type, payload.
    public func encoded() -> Data {
        var out = Data(capacity: 5 + payload.count)
        out.appendBE(UInt32(1 + payload.count))
        out.append(type)
        out.append(payload)
        return out
    }
}

public enum WireError: Error, Equatable {
    case tooLarge(Int)
    case empty
    case short(String)
}

/// Splits a byte stream into messages.
public struct MessageReader {
    private var buffer = Data()

    public init() {}

    public mutating func feed(_ data: Data) {
        buffer.append(data)
    }

    /// The next complete message, nil until one has arrived.
    public mutating func next() throws -> Message? {
        guard buffer.count >= 4 else { return nil }
        let start = buffer.startIndex
        let length = Int(buffer.readBE(UInt32.self, at: start))
        if length == 0 { throw WireError.empty }
        if length > maxMessageSize { throw WireError.tooLarge(length) }
        guard buffer.count >= 4 + length else { return nil }
        let type = buffer[start + 4]
        let payload = Data(buffer[(start + 5)..<(start + 4 + length)])
        buffer.removeSubrange(start..<(start + 4 + length))
        return Message(type: type, payload: payload)
    }
}

/// The header of a video message: layer index (in the config's order), flags, presentation
/// time and how long the encoder took, then the access unit (H.264 Annex B).
public struct VideoHeader: Equatable {
    public static let size = 14
    public static let keyframeFlag: UInt8 = 1

    public var layer: UInt8
    public var keyframe: Bool
    /// ptsNanos is the capture time on the host clock.
    public var ptsNanos: UInt64
    public var encodeMicros: UInt32

    public init(layer: UInt8, keyframe: Bool, ptsNanos: UInt64, encodeMicros: UInt32) {
        self.layer = layer
        self.keyframe = keyframe
        self.ptsNanos = ptsNanos
        self.encodeMicros = encodeMicros
    }

    public func message(_ data: Data) -> Message {
        var p = Data(capacity: VideoHeader.size + data.count)
        p.append(layer)
        p.append(keyframe ? VideoHeader.keyframeFlag : 0)
        p.appendBE(ptsNanos)
        p.appendBE(encodeMicros)
        p.append(data)
        return Message(.video, p)
    }
}

/// The header of an audio message: presentation time and duration, then one Opus packet.
public struct AudioHeader: Equatable {
    public static let size = 12

    public var ptsNanos: UInt64
    public var durationMicros: UInt32

    public init(ptsNanos: UInt64, durationMicros: UInt32) {
        self.ptsNanos = ptsNanos
        self.durationMicros = durationMicros
    }

    public func message(_ packet: Data) -> Message {
        var p = Data(capacity: AudioHeader.size + packet.count)
        p.appendBE(ptsNanos)
        p.appendBE(durationMicros)
        p.append(packet)
        return Message(.audio, p)
    }
}

/// A control message from the helper.
public enum Control: Equatable {
    case keyframe(layer: UInt8)
    case bitrate(layer: UInt8, kbps: UInt32)
    case fps(layer: UInt8, fps: UInt16)
    case stop
    /// The privacy curtain: a black frame instead of the screen, the audio muted.
    case curtain(on: Bool)

    public init?(_ m: Message) throws {
        let p = m.payload
        switch MessageType(rawValue: m.type) {
        case .keyframe:
            guard p.count >= 1 else { throw WireError.short("keyframe") }
            self = .keyframe(layer: p[p.startIndex])
        case .bitrate:
            guard p.count >= 5 else { throw WireError.short("bitrate") }
            self = .bitrate(layer: p[p.startIndex], kbps: p.readBE(UInt32.self, at: p.startIndex + 1))
        case .fps:
            guard p.count >= 3 else { throw WireError.short("fps") }
            self = .fps(layer: p[p.startIndex], fps: p.readBE(UInt16.self, at: p.startIndex + 1))
        case .stop:
            self = .stop
        case .curtain:
            guard p.count >= 1 else { throw WireError.short("curtain") }
            self = .curtain(on: p[p.startIndex] & 1 != 0)
        default:
            return nil
        }
    }

    public func message() -> Message {
        var p = Data()
        switch self {
        case let .keyframe(layer):
            p.append(layer)
            return Message(.keyframe, p)
        case let .bitrate(layer, kbps):
            p.append(layer)
            p.appendBE(kbps)
            return Message(.bitrate, p)
        case let .fps(layer, fps):
            p.append(layer)
            p.appendBE(fps)
            return Message(.fps, p)
        case .stop:
            return Message(.stop)
        case let .curtain(on):
            p.append(on ? 1 : 0)
            return Message(.curtain, p)
        }
    }
}

// MARK: - JSON payloads

public struct Hello: Codable, Equatable {
    public var protocolVersion: Int
    public var version: String
    public var os: String

    public init(protocolVersion: Int, version: String, os: String) {
        self.protocolVersion = protocolVersion
        self.version = version
        self.os = os
    }
}

public struct LayerConfig: Codable, Equatable {
    public var rid: String
    public var width: Int
    public var height: Int
    public var fps: Int
    public var kbps: Int
    /// vbvMs is the data-rate window: the encoder never sends more than kbps over it.
    public var vbvMs: Int

    public init(rid: String, width: Int, height: Int, fps: Int, kbps: Int, vbvMs: Int) {
        self.rid = rid
        self.width = width
        self.height = height
        self.fps = fps
        self.kbps = kbps
        self.vbvMs = vbvMs
    }
}

public struct SourceRef: Codable, Equatable {
    /// kind is "display" or "window"; id is the CGDirectDisplayID or CGWindowID.
    public var kind: String
    public var id: UInt32

    public init(kind: String, id: UInt32) {
        self.kind = kind
        self.id = id
    }
}

public struct AudioConfig: Codable, Equatable {
    /// The app whose audio is captured: by pid when known, else by bundle id.
    public var pid: Int32?
    public var bundleId: String?
    public var kbps: Int?

    public init(pid: Int32? = nil, bundleId: String? = nil, kbps: Int? = nil) {
        self.pid = pid
        self.bundleId = bundleId
        self.kbps = kbps
    }
}

public struct ThumbnailConfig: Codable, Equatable {
    public var width: Int
    public var everyMs: Int

    public init(width: Int, everyMs: Int) {
        self.width = width
        self.everyMs = everyMs
    }
}

public struct Config: Codable, Equatable {
    public var source: SourceRef
    /// layers are highest first; the first one sets the capture size and rate.
    public var layers: [LayerConfig]
    public var gopSeconds: Double
    public var cursor: Bool
    public var audio: AudioConfig?
    public var thumbnail: ThumbnailConfig?

    public init(source: SourceRef, layers: [LayerConfig], gopSeconds: Double, cursor: Bool, audio: AudioConfig? = nil, thumbnail: ThumbnailConfig? = nil) {
        self.source = source
        self.layers = layers
        self.gopSeconds = gopSeconds
        self.cursor = cursor
        self.audio = audio
        self.thumbnail = thumbnail
    }
}

public struct Started: Codable, Equatable {
    public var width: Int
    public var height: Int
    public var encoder: String
    public var audioApp: AppInfo?

    public init(width: Int, height: Int, encoder: String, audioApp: AppInfo? = nil) {
        self.width = width
        self.height = height
        self.encoder = encoder
        self.audioApp = audioApp
    }
}

public struct AppInfo: Codable, Equatable {
    public var name: String
    public var bundleId: String
    public var pid: Int32

    public init(name: String, bundleId: String, pid: Int32) {
        self.name = name
        self.bundleId = bundleId
        self.pid = pid
    }
}

public struct LayerStats: Codable, Equatable {
    public var rid: String
    public var frames: Int
    /// dropped frames went into the encoder and did not come out (its rate control skipped them).
    public var dropped: Int
    /// busy frames were due while the encoder still had maxInFlight frames in flight, and were skipped.
    public var busy: Int
    public var keyframes: Int
    public var bytes: Int
    public var encodeMsAvg: Double
    public var encodeMsMax: Double

    public init(rid: String, frames: Int, dropped: Int, busy: Int, keyframes: Int, bytes: Int, encodeMsAvg: Double, encodeMsMax: Double) {
        self.rid = rid
        self.frames = frames
        self.dropped = dropped
        self.busy = busy
        self.keyframes = keyframes
        self.bytes = bytes
        self.encodeMsAvg = encodeMsAvg
        self.encodeMsMax = encodeMsMax
    }
}

/// Stats cover the second before they are sent.
public struct Stats: Codable, Equatable {
    public var captured: Int
    public var idle: Int
    public var repeated: Int
    public var dropped: Int
    public var captureDelayMsAvg: Double
    public var cpuPercent: Double
    public var layers: [LayerStats]
    public var audioPackets: Int

    public init(captured: Int, idle: Int, repeated: Int, dropped: Int, captureDelayMsAvg: Double, cpuPercent: Double, layers: [LayerStats], audioPackets: Int) {
        self.captured = captured
        self.idle = idle
        self.repeated = repeated
        self.dropped = dropped
        self.captureDelayMsAvg = captureDelayMsAvg
        self.cpuPercent = cpuPercent
        self.layers = layers
        self.audioPackets = audioPackets
    }
}

public struct ErrorPayload: Codable, Equatable {
    /// code: "permission", "source_not_found", "encoder", "audio", "capture", "protocol".
    public var code: String
    public var message: String
    public var fatal: Bool

    public init(code: String, message: String, fatal: Bool) {
        self.code = code
        self.message = message
        self.fatal = fatal
    }
}

public struct Event: Codable, Equatable {
    /// event: "ended" (the window closed, the display went away), "hidden", "shown".
    public var event: String
    public var width: Int?
    public var height: Int?

    public init(event: String, width: Int? = nil, height: Int? = nil) {
        self.event = event
        self.width = width
        self.height = height
    }
}

// MARK: - Agent payloads (helper/internal/sidecar/agent.go)

/// One entry of the menu bar item's menu.
public struct AgentMenuItem: Codable, Equatable {
    public var id: Int32
    public var label: String?
    public var enabled: Bool?
    public var separator: Bool?
    /// checked is a toggle's state; nil for plain items.
    public var checked: Bool?

    public init(id: Int32, label: String? = nil, enabled: Bool? = nil, separator: Bool? = nil, checked: Bool? = nil) {
        self.id = id
        self.label = label
        self.enabled = enabled
        self.separator = separator
        self.checked = checked
    }
}

/// The menu bar item: icon ("idle", "live", "paused", "curtain"), tooltip and menu.
public struct AgentMenu: Codable, Equatable {
    public var icon: String
    public var tooltip: String
    public var items: [AgentMenuItem]

    public init(icon: String, tooltip: String, items: [AgentMenuItem]) {
        self.icon = icon
        self.tooltip = tooltip
        self.items = items
    }
}

public struct MenuClick: Codable, Equatable {
    public var id: Int32

    public init(id: Int32) {
        self.id = id
    }
}

/// A notification; a later one with the same id replaces it.
public struct Notify: Codable, Equatable {
    public var id: UInt32
    public var title: String
    public var body: String?
    public var critical: Bool?
    public var transient: Bool?

    public init(id: UInt32, title: String, body: String? = nil, critical: Bool? = nil, transient: Bool? = nil) {
        self.id = id
        self.title = title
        self.body = body
        self.critical = critical
        self.transient = transient
    }
}

/// The notification permission: "authorized", "denied" or "unavailable" (no app bundle).
public struct NotificationState: Codable, Equatable {
    public var state: String
    public var bundle: String?
    public var error: String?

    public init(state: String, bundle: String? = nil, error: String? = nil) {
        self.state = state
        self.bundle = bundle
        self.error = error
    }
}

/// A global shortcut as RegisterEventHotKey takes it: a virtual key code and Carbon modifiers.
public struct HotkeyBinding: Codable, Equatable {
    public var action: String
    public var trigger: String
    public var keyCode: UInt32
    public var modifiers: UInt32

    public init(action: String, trigger: String, keyCode: UInt32, modifiers: UInt32) {
        self.action = action
        self.trigger = trigger
        self.keyCode = keyCode
        self.modifiers = modifiers
    }
}

public struct Hotkeys: Codable, Equatable {
    public var bindings: [HotkeyBinding]

    public init(bindings: [HotkeyBinding]) {
        self.bindings = bindings
    }
}

public struct HotkeyResult: Codable, Equatable {
    public var action: String
    public var trigger: String
    public var ok: Bool
    /// conflict: another app holds the same shortcut.
    public var conflict: Bool?
    public var error: String?

    public init(action: String, trigger: String, ok: Bool, conflict: Bool? = nil, error: String? = nil) {
        self.action = action
        self.trigger = trigger
        self.ok = ok
        self.conflict = conflict
        self.error = error
    }
}

public struct HotkeysBound: Codable, Equatable {
    public var results: [HotkeyResult]

    public init(results: [HotkeyResult]) {
        self.results = results
    }
}

public struct Hotkey: Codable, Equatable {
    public var action: String

    public init(action: String) {
        self.action = action
    }
}

public extension Message {
    static func json<T: Encodable>(_ type: MessageType, _ value: T) -> Message {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return Message(type, (try? enc.encode(value)) ?? Data("{}".utf8))
    }

    func decode<T: Decodable>(_: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: payload)
    }
}

// MARK: - Big-endian helpers

extension Data {
    mutating func appendBE<T: FixedWidthInteger>(_ v: T) {
        Swift.withUnsafeBytes(of: v.bigEndian) { append(contentsOf: $0) }
    }

    func readBE<T: FixedWidthInteger>(_: T.Type, at offset: Index) -> T {
        var v: T = 0
        for i in 0..<MemoryLayout<T>.size {
            v = v << 8 | T(self[offset + i])
        }
        return v
    }
}

public extension Data {
    /// A video or audio message's header and data.
    func videoHeader() throws -> (VideoHeader, Data) {
        guard count >= VideoHeader.size else { throw WireError.short("video") }
        let s = startIndex
        let h = VideoHeader(layer: self[s], keyframe: self[s + 1] & VideoHeader.keyframeFlag != 0,
                            ptsNanos: readBE(UInt64.self, at: s + 2), encodeMicros: readBE(UInt32.self, at: s + 10))
        return (h, Data(self[(s + VideoHeader.size)...]))
    }

    func audioHeader() throws -> (AudioHeader, Data) {
        guard count >= AudioHeader.size else { throw WireError.short("audio") }
        let s = startIndex
        let h = AudioHeader(ptsNanos: readBE(UInt64.self, at: s), durationMicros: readBE(UInt32.self, at: s + 8))
        return (h, Data(self[(s + AudioHeader.size)...]))
    }
}
