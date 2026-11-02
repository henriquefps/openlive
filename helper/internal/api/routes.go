// SPDX-License-Identifier: AGPL-3.0-only

package api

// Routes the helper calls (docs/PROTOCOL.md §11.1–11.2). The bodies are the generated
// types in packages/protocol/go.
const (
	pathDeviceCode  = "/api/devices/code"
	pathDeviceToken = "/api/devices/token"
	// %s is the room id. Phase 1 route; its body is not in the schema yet (PROTOCOL.md §11).
	pathRoomFmt               = "/api/rooms/%s"
	pathICEFmt                = "/api/rtc/rooms/%s/ice"
	pathPublishFmt            = "/api/rtc/rooms/%s/publish"
	pathPublishRenegotiateFmt = "/api/rtc/rooms/%s/publish/renegotiate"
	pathUnpublishFmt          = "/api/rtc/rooms/%s/unpublish"
	// %s are the room and stream ids (PROTOCOL.md §11.3).
	pathThumbnailFmt  = "/api/rtc/rooms/%s/streams/%s/thumbnail"
	pathRoomSocketFmt = "/ws/rooms/%s"
	// The page where a signed-in user types the code.
	pathLink = "/link"
)
