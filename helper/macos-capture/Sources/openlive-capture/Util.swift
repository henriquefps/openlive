// SPDX-License-Identifier: AGPL-3.0-only

import Darwin
import Foundation

let sidecarVersion = "0.1.0"

enum CaptureError: Error, CustomStringConvertible {
    case permission
    case sourceNotFound(String)
    case encoder(String)
    case audio(String)
    case capture(String)
    case usage(String)

    var code: String {
        switch self {
        case .permission: "permission"
        case .sourceNotFound: "source_not_found"
        case .encoder: "encoder"
        case .audio: "audio"
        case .capture: "capture"
        case .usage: "usage"
        }
    }

    var description: String {
        switch self {
        case .permission: "Screen Recording permission is not granted (System Settings > Privacy & Security > Screen & System Audio Recording)"
        case let .sourceNotFound(s): "source not found: \(s)"
        case let .encoder(s): "encoder: \(s)"
        case let .audio(s): "audio: \(s)"
        case let .capture(s): "capture: \(s)"
        case let .usage(s): s
        }
    }
}

/// Logs go to stderr: the helper copies them into its own log.
func log(_ message: String) {
    FileHandle.standardError.write(Data("openlive-capture: \(message)\n".utf8))
}

private let timebase: mach_timebase_info_data_t = {
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    return tb
}()

/// The host clock in nanoseconds (the clock ScreenCaptureKit stamps frames with).
func hostNanos() -> UInt64 {
    machToNanos(mach_absolute_time())
}

func machToNanos(_ t: UInt64) -> UInt64 {
    t * UInt64(timebase.numer) / UInt64(timebase.denom)
}

/// CPU time of this process as a share of one core since the last call.
final class CPUMeter {
    private var lastCPU = CPUMeter.cpuSeconds()
    private var lastWall = Date()

    static func cpuSeconds() -> Double {
        var u = rusage()
        getrusage(RUSAGE_SELF, &u)
        func s(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1e6 }
        return s(u.ru_utime) + s(u.ru_stime)
    }

    func sample() -> Double {
        let cpu = CPUMeter.cpuSeconds()
        let now = Date()
        let wall = now.timeIntervalSince(lastWall)
        defer {
            lastCPU = cpu
            lastWall = now
        }
        return wall > 0 ? (cpu - lastCPU) / wall * 100 : 0
    }
}

/// Percentiles of a sample, for the bench report.
func percentile(_ values: [Double], _ p: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let i = min(sorted.count - 1, max(0, Int((Double(sorted.count - 1) * p).rounded())))
    return sorted[i]
}
