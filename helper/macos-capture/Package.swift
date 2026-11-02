// swift-tools-version:5.10
// SPDX-License-Identifier: AGPL-3.0-only

// openlive-capture: the macOS sidecar of the Openlive helper. It captures a
// display or a window with ScreenCaptureKit, encodes the simulcast layers with VideoToolbox and
// an app's audio as Opus, and hands them to the Go helper over a Unix socket (README.md). The
// same binary is the helper's menu bar agent (Agent.swift).
import PackageDescription

let package = Package(
    name: "openlive-capture",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "openlive-capture", targets: ["openlive-capture"]),
    ],
    targets: [
        // The wire format alone, so it is tested without a display or permissions.
        .target(name: "CaptureProtocol"),
        .executableTarget(
            name: "openlive-capture",
            dependencies: ["CaptureProtocol"],
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreImage"),
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("UserNotifications"),
            ]
        ),
        .testTarget(name: "CaptureProtocolTests", dependencies: ["CaptureProtocol"]),
    ]
)
