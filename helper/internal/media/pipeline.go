// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"fmt"
	"strings"
	"time"
)

// Element names in the test pipeline that the Go side looks up.
const (
	clockOverlayName = "wallclock"
	toneName         = "tone"
	audioSinkName    = "asink"
	thumbSinkName    = "thumbsink"
)

// Thumbnail branch: one small JPEG of the encoder input
// every thumbEvery, kept in an appsink that holds only the newest (internal/thumbnail
// takes it every 10 s). Its queue is leaky and the appsink drops, so the branch can never
// hold the tee, and so the encoders, back.
const (
	thumbWidth = 320
	// thumbEvery is the branch's frame rate as a fraction: one frame every 2 s.
	thumbEvery   = "1/2"
	thumbQuality = 70
)

// thumbHeight keeps the output's aspect at thumbWidth, even.
func thumbHeight(w, h int) int { return max(2, (thumbWidth*h/w)&^1) }

// thumbSink ends every thumbnail branch.
var thumbSink = fmt.Sprintf("jpegenc quality=%d ! appsink name=%s emit-signals=false sync=false max-buffers=1 drop=true ", thumbQuality, thumbSinkName)

// rawThumbBranch is the thumbnail branch for a system-memory tee.
func rawThumbBranch(w, h int) string {
	return fmt.Sprintf("t. ! queue max-size-buffers=1 leaky=downstream ! videorate drop-only=true ! video/x-raw,framerate=%s "+
		"! videoscale ! videoconvert ! video/x-raw,format=I420,width=%d,height=%d ! %s",
		thumbEvery, thumbWidth, thumbHeight(w, h), thumbSink)
}

func videoSinkName(rid string) string { return "sink_" + rid }
func encoderName(rid string) string   { return "enc_" + rid }

// ClockFormat is the wall-clock text drawn on every frame (local time, milliseconds), so
// latency can be read on the viewer: photograph the source clock next to the player, or
// compare it with a clock on the same screen.
const ClockFormat = "15:04:05.000"

// testPipelineDescription builds the gst-launch description of the test source:
//
//	videotestsrc (moving SMPTE) → frame counter → wall clock → tee
//	  → per layer: scale + rate → layer label → encoder → h264parse → appsink sink_<rid>
//	audiotestsrc (440 Hz) → Opus → appsink asink        (when audio is on)
//
// The source runs at the top layer's size and rate. The counter and the clock are drawn
// before the tee, so every layer shows the same frame number.
func testPipelineDescription(layers []Layer, enc Encoder, gop time.Duration, audio bool) (string, error) {
	if len(layers) == 0 {
		return "", fmt.Errorf("no layers")
	}
	top := layers[0]
	var b strings.Builder
	fmt.Fprintf(&b, "videotestsrc is-live=true pattern=smpte horizontal-speed=4 "+
		"! video/x-raw,width=%d,height=%d,framerate=%d/1 "+
		"! timeoverlay time-mode=buffer-count halignment=left valignment=top font-desc=\"Sans 48\" shaded-background=true "+
		"! textoverlay name=%s text=\"\" halignment=right valignment=top font-desc=\"Monospace 48\" shaded-background=true "+
		"! tee name=t ", top.Width, top.Height, top.FPS, clockOverlayName)
	for _, l := range layers {
		encDesc, err := encoderElement(enc, l, gop)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "t. ! queue max-size-buffers=2 leaky=downstream "+
			"! videoscale ! videorate ! video/x-raw,width=%d,height=%d,framerate=%d/1 "+
			"! textoverlay text=\"layer %s  %dx%d@%d\" halignment=center valignment=bottom font-desc=\"Sans 36\" shaded-background=true "+
			"! videoconvert ! %s ! %s "+
			"! appsink name=%s emit-signals=true sync=false max-buffers=4 drop=false ",
			l.Width, l.Height, l.FPS, l.RID, l.Width, l.Height, l.FPS, encDesc, parserElement(l), videoSinkName(l.RID))
	}
	b.WriteString(rawThumbBranch(top.Width, top.Height))
	if audio {
		// Opus 48 kHz stereo, 128 kbit/s; 20 ms frames.
		fmt.Fprintf(&b, "audiotestsrc name=%s is-live=true wave=sine freq=440 volume=0.2 "+
			"! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 "+
			"! opusenc bitrate=128000 frame-size=20 "+
			"! appsink name=%s emit-signals=true sync=false max-buffers=16 drop=false ", toneName, audioSinkName)
	}
	return strings.TrimSpace(b.String()), nil
}
