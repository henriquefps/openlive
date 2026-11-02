// SPDX-License-Identifier: AGPL-3.0-only

//go:build !darwin

package media

// MacAvailable is false outside macOS (macos.go still builds on Linux for its tests).
const MacAvailable = false

// VideoToolboxAvailable is false outside macOS.
const VideoToolboxAvailable = false
