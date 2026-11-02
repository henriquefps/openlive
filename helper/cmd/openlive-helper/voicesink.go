// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"log/slog"
	"runtime"

	"github.com/henriquefps/openlive/helper/internal/audio"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// startVoiceSink keeps the voice sink while the helper runs and reports it in
// helper.status, so the web plays voice where app-audio capture never looks. Without
// PipeWire's tools the helper runs as before, and the web warns instead. The returned
// function removes the sink.
func startVoiceSink(ctx context.Context, ctl *controller, lang i18n.Lang, log *slog.Logger) func() {
	if runtime.GOOS != "linux" {
		return func() {}
	}
	label := i18n.Catalog{Lang: lang}.T(i18n.VoiceSinkLabel)
	vs, err := audio.StartVoiceSink(label, log, func(present bool) {
		var info *protocol.VoiceSink
		if present {
			info = &protocol.VoiceSink{Name: audio.VoiceSinkName, Label: label}
		}
		ctl.setVoiceSink(ctx, info)
	})
	if err != nil {
		log.Warn("no voice sink: voice played by a shared browser can reach the stream", "err", err)
		return func() {}
	}
	ctl.mu.Lock()
	ctl.voiceOutput = vs.SetOutput
	ctl.mu.Unlock()
	return func() { _ = vs.Close() }
}
