// SPDX-License-Identifier: AGPL-3.0-only

import AppKit
import CaptureProtocol
import CoreMedia
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox

// The one-shot subcommands: list, thumbnail and doctor print JSON (or a JPEG) on stdout.

struct DisplayInfo: Codable {
    var id: UInt32
    var name: String
    /// width and height are pixels; the point size times the backing scale.
    var width: Int
    var height: Int
    var refreshHz: Double
    var main: Bool
}

struct WindowInfo: Codable {
    var id: UInt32
    var title: String
    var app: String
    var bundleId: String
    var pid: Int32
    var width: Int
    var height: Int
}

struct AppEntry: Codable {
    var name: String
    var bundleId: String
    var pid: Int32
}

struct SourceList: Codable {
    var displays: [DisplayInfo]
    var windows: [WindowInfo]
    var apps: [AppEntry]
}

func shareableContent() async throws -> SCShareableContent {
    if !CGPreflightScreenCaptureAccess() {
        CGRequestScreenCaptureAccess()
        throw CaptureError.permission
    }
    do {
        return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        throw CaptureError.permission
    }
}

@MainActor
func screenInfo(_ id: CGDirectDisplayID) -> (name: String, scale: Double) {
    for s in NSScreen.screens {
        if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == id {
            return (s.localizedName, Double(s.backingScaleFactor))
        }
    }
    return ("Display \(id)", 1)
}

@MainActor
func listSources() async throws -> SourceList {
    let content = try await shareableContent()
    let own = ProcessInfo.processInfo.processIdentifier
    var displays: [DisplayInfo] = []
    for d in content.displays {
        let mode = CGDisplayCopyDisplayMode(d.displayID)
        let info = screenInfo(d.displayID)
        displays.append(DisplayInfo(id: d.displayID, name: info.name,
                                    width: mode?.pixelWidth ?? Int(Double(d.width) * info.scale),
                                    height: mode?.pixelHeight ?? Int(Double(d.height) * info.scale),
                                    refreshHz: mode?.refreshRate ?? 0, main: CGDisplayIsMain(d.displayID) != 0))
    }
    let scale = Double(NSScreen.main?.backingScaleFactor ?? 1)
    var windows: [WindowInfo] = []
    for w in content.windows {
        guard let app = w.owningApplication, app.processID != own, w.windowLayer == 0, w.isOnScreen,
              w.frame.width >= 64, w.frame.height >= 64
        else { continue }
        // Menu bar extras, the Dock and the like have no title and live in system apps.
        if app.bundleIdentifier == "com.apple.dock" || app.bundleIdentifier == "com.apple.WindowManager" { continue }
        windows.append(WindowInfo(id: w.windowID, title: w.title ?? "", app: app.applicationName, bundleId: app.bundleIdentifier,
                                  pid: app.processID, width: Int(w.frame.width * scale), height: Int(w.frame.height * scale)))
    }
    // Audio does not need a window on screen (one in another Space, or minimized, still plays):
    // every regular app (in the Dock) can be the audio source.
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && $0.processIdentifier != own }
        .map { AppEntry(name: $0.localizedName ?? $0.bundleIdentifier ?? "?", bundleId: $0.bundleIdentifier ?? "", pid: $0.processIdentifier) }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    return SourceList(displays: displays, windows: windows, apps: apps)
}

/// A still of a source as JPEG, fitted into maxWidth x maxHeight (the web's picker).
func thumbnail(source: SourceRef, maxWidth: Int, maxHeight: Int) async throws -> Data {
    guard #available(macOS 14.0, *) else { throw CaptureError.usage("thumbnails need macOS 14") }
    let content = try await shareableContent()
    let filter: SCContentFilter
    var w = 0.0, h = 0.0
    switch source.kind {
    case "display":
        guard let d = content.displays.first(where: { $0.displayID == source.id }) else { throw CaptureError.sourceNotFound("display \(source.id)") }
        filter = SCContentFilter(display: d, excludingApplications: [], exceptingWindows: [])
        w = Double(d.width)
        h = Double(d.height)
    case "window":
        guard let win = content.windows.first(where: { $0.windowID == source.id }) else { throw CaptureError.sourceNotFound("window \(source.id)") }
        filter = SCContentFilter(desktopIndependentWindow: win)
        w = win.frame.width
        h = win.frame.height
    default:
        throw CaptureError.usage("unknown source kind \(source.kind)")
    }
    let scale = min(Double(maxWidth) / max(w, 1), Double(maxHeight) / max(h, 1), 1)
    let sc = SCStreamConfiguration()
    sc.width = max(2, Int(w * scale))
    sc.height = max(2, Int(h * scale))
    sc.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: sc)
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw CaptureError.capture("jpeg") }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw CaptureError.capture("jpeg") }
    return out as Data
}

struct EncoderInfo: Codable {
    var name: String
    var codec: String
    var hardware: Bool
}

struct DoctorReport: Codable {
    var macOS: String
    var screenRecording: Bool
    var encoders: [EncoderInfo]
    var h264Hardware: Bool
    var hevcHardware: Bool
    var av1Hardware: Bool
    /// lowLatencyH264: a hardware H.264 session with low-latency rate control opens.
    var lowLatencyH264: Bool
    var lowLatencyError: String?
}

func fourCC(_ v: UInt32) -> String {
    String(bytes: [24, 16, 8, 0].map { UInt8((v >> $0) & 0xFF) }, encoding: .ascii) ?? "\(v)"
}

func doctor() -> DoctorReport {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    var list: CFArray?
    VTCopyVideoEncoderList(nil, &list)
    var encoders: [EncoderInfo] = []
    for case let e as [String: Any] in (list as? [Any]) ?? [] {
        let codec = (e[kVTVideoEncoderList_CodecType as String] as? NSNumber)?.uint32Value ?? 0
        let name = e[kVTVideoEncoderList_DisplayName as String] as? String ?? e[kVTVideoEncoderList_EncoderName as String] as? String ?? "?"
        let hw = (e[kVTVideoEncoderList_IsHardwareAccelerated as String] as? Bool) ?? false
        encoders.append(EncoderInfo(name: name, codec: fourCC(codec), hardware: hw))
    }
    let hw = { (c: String) in encoders.contains { $0.codec == c && $0.hardware } }
    var lowLatency = false
    var llError: String?
    do {
        _ = try LayerEncoder(index: 0, config: LayerConfig(rid: "f", width: 1920, height: 1080, fps: 60, kbps: 8000, vbvMs: 250), gopSeconds: 10)
        lowLatency = true
    } catch {
        llError = "\(error)"
    }
    return DoctorReport(macOS: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", screenRecording: CGPreflightScreenCaptureAccess(),
                        encoders: encoders, h264Hardware: hw("avc1"), hevcHardware: hw("hvc1"), av1Hardware: hw("av01"),
                        lowLatencyH264: lowLatency, lowLatencyError: llError)
}

func printJSON<T: Encodable>(_ value: T) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write((try? enc.encode(value)) ?? Data("{}".utf8))
    FileHandle.standardOutput.write(Data("\n".utf8))
}
