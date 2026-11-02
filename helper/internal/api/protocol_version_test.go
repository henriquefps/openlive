// SPDX-License-Identifier: AGPL-3.0-only
package api

import (
	"testing"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The helper announces the protocol it speaks in hello; the web gates features on it (voice
// sink, pings, 120 fps). It once stayed behind the protocol package by eight minors.
func TestProtocolVersionIsCurrent(t *testing.T) {
	if ProtocolVersion != protocol.CurrentProtocol {
		t.Fatalf("helper announces %d.%d, the protocol package is %d.%d",
			ProtocolVersion.Major, ProtocolVersion.Minor,
			protocol.CurrentProtocol.Major, protocol.CurrentProtocol.Minor)
	}
}
