// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"fmt"
	"time"
)

// Encoder is a video encoder choice.
type Encoder string

const (
	// EncoderAuto picks the first hardware encoder GStreamer has (NVENC, then VA-API),
	// else x264.
	EncoderAuto  Encoder = "auto"
	EncoderNVENC Encoder = "nvh264"
	// EncoderVA is VA-API (AMD, Intel) through GStreamer's va plugin: vah264enc, or
	// vah264lpenc (Intel's low-power entrypoint) when only that one exists.
	EncoderVA Encoder = "va"
	// EncoderVALowPower is vah264lpenc; "va" resolves to it on GPUs without vah264enc.
	EncoderVALowPower Encoder = "va-lp"
	EncoderX264       Encoder = "x264"
	// EncoderVideoToolbox is macOS's hardware encoder, run by the capture sidecar (macos.go).
	EncoderVideoToolbox Encoder = "vt"
)

// EncoderUsage is the --encoder flag's help.
const EncoderUsage = "auto, nvh264 (NVENC), va (VA-API: AMD, Intel), va-lp (VA-API low power), x264 (software) or vt (VideoToolbox, macOS)"

// encoderElements are the GStreamer elements behind each concrete encoder.
var encoderElements = map[Encoder]string{
	EncoderNVENC:      "nvh264enc",
	EncoderVA:         "vah264enc",
	EncoderVALowPower: "vah264lpenc",
	EncoderX264:       "x264enc",
	// AV1 (av1.go): the AV1 layers' encoders, chosen from the H.264 encoder's family.
	EncoderNVAV1:         "nvav1enc",
	EncoderVAAV1:         "vaav1enc",
	EncoderVAAV1LowPower: "vaav1lpenc",
}

// Hardware reports whether the encoder runs on the GPU.
func (e Encoder) Hardware() bool { return e != EncoderX264 && e != EncoderAuto }

// IsVA reports whether the encoder is one of the VA-API ones (H.264 or AV1).
func (e Encoder) IsVA() bool {
	return e == EncoderVA || e == EncoderVALowPower || e == EncoderVAAV1 || e == EncoderVAAV1LowPower
}

// ParseEncoder validates an --encoder value.
func ParseEncoder(s string) (Encoder, error) {
	switch e := Encoder(s); e {
	case EncoderAuto, EncoderNVENC, EncoderVA, EncoderVALowPower, EncoderX264, EncoderVideoToolbox:
		return e, nil
	}
	return "", fmt.Errorf("unknown encoder %q (want %s)", s, EncoderUsage)
}

// ResolveEncoder turns auto (and va) into a concrete encoder: NVENC → VA-API → x264, or
// VideoToolbox on macOS. has reports whether a GStreamer element exists.
func ResolveEncoder(e Encoder, has func(element string) bool) (Encoder, error) {
	switch e {
	case EncoderAuto:
		if VideoToolboxAvailable {
			return EncoderVideoToolbox, nil
		}
		for _, c := range []Encoder{EncoderNVENC, EncoderVA, EncoderVALowPower, EncoderX264} {
			if has(encoderElements[c]) {
				return c, nil
			}
		}
		return "", fmt.Errorf("no H.264 encoder: GStreamer has none of nvh264enc, vah264enc, vah264lpenc or x264enc")
	case EncoderNVENC:
		if !has("nvh264enc") {
			return "", fmt.Errorf("nvh264enc is not available (NVIDIA driver or gst-plugins-bad nvcodec missing)")
		}
	case EncoderVA:
		if has("vah264enc") {
			return EncoderVA, nil
		}
		if has("vah264lpenc") {
			return EncoderVALowPower, nil
		}
		return "", fmt.Errorf("vah264enc is not available (a VA-API driver with H.264 encoding, Mesa or intel-media-driver, or gst-plugins-bad va missing)")
	case EncoderVALowPower:
		if !has("vah264lpenc") {
			return "", fmt.Errorf("vah264lpenc is not available (Intel's low-power VA-API entrypoint)")
		}
	case EncoderX264:
		if !has("x264enc") {
			return "", fmt.Errorf("x264enc is not available (gst-plugins-ugly missing)")
		}
	case EncoderVideoToolbox:
		if !VideoToolboxAvailable {
			return "", fmt.Errorf("VideoToolbox is macOS's encoder")
		}
	default:
		return "", fmt.Errorf("unknown encoder %q", e)
	}
	return e, nil
}

// DetectEncoders lists the H.264 encoders GStreamer has, in the order auto picks them
// (VideoToolbox alone on macOS).
func DetectEncoders(has func(element string) bool) []Encoder {
	if VideoToolboxAvailable {
		return []Encoder{EncoderVideoToolbox}
	}
	var out []Encoder
	for _, c := range []Encoder{EncoderNVENC, EncoderVA, EncoderVALowPower, EncoderX264} {
		if has(encoderElements[c]) {
			out = append(out, c)
		}
	}
	return out
}

// vaMaxGOP is vah264enc's largest key-int-max (GStreamer's va plugin, MAX_GOP_SIZE): the
// 10 s fallback GOP is 600 frames at 60 fps but 1200 at 120.
const vaMaxGOP = 1024

// encoderSettings are a layer's per-fps encoder numbers.
type encoderSettings struct {
	// gopFrames is the fallback keyframe interval in frames: the GOP's time at the layer's
	// fps, so a 120 fps layer has twice the frames of a 60 fps one for the same seconds.
	gopFrames int
	// vbvMillis is the VBV as time, and vbvKbit the same buffer as data at the start
	// bitrate. It is fixed for the stream and kept as time, not frames: at 120
	// fps it holds twice the frames, and an IDR (bounded by it) stays the same share of a
	// second.
	vbvMillis, vbvKbit int
}

func settingsFor(e Encoder, l Layer, gop time.Duration) encoderSettings {
	s := encoderSettings{gopFrames: max(1, int(gop.Seconds()*float64(l.FPS))), vbvMillis: l.vbvMillis()}
	if e.IsVA() {
		s.gopFrames = min(s.gopFrames, vaMaxGOP)
	}
	s.vbvKbit = l.Kbps * s.vbvMillis / 1000
	return s
}

// encoderElement is the gst-launch description of one layer's encoder plus the caps
// after it. The element is named enc_<rid> so the bitrate can be changed live.
//
// Every encoder: CBR, no B-frames, low-latency tuning, constrained
// baseline (what pion's default H.264 fmtp announces), keyframe every gop as a fallback.
// The level is left to the encoder, which derives it from the size, fps and bitrate (the
// SDP announces the highest one, media.SDPLevel).
// VA-API: no CABAC and no 8x8 transform (baseline has neither; with both off and no
// B-frames vah264enc picks a baseline profile), one reference frame, the fastest
// target-usage, and the CPB (its VBV) in kbit.
// AV1 (NVENC, VA-API): the same rules, main profile (8-bit 4:2:0); NVENC AV1 has no
// B-frames in low-latency tuning and changes its bitrate in place like nvh264enc.
// x264 uses sliced threads: frame threads (sliced-threads=false, as in the first
// experiments) delay every frame by one per thread, measured at ~390 ms for a forced
// IDR on a 16-thread CPU versus ~18 ms with slices.
func encoderElement(e Encoder, l Layer, gop time.Duration) (string, error) {
	if l.IsAV1() {
		a, ok := e.AV1()
		if !ok {
			return "", fmt.Errorf("layer %s: no AV1 encoder with %s", l.RID, e)
		}
		e = a
	} else if e.IsAV1() {
		return "", fmt.Errorf("layer %s: %s is not an H.264 encoder", l.RID, e)
	}
	s := settingsFor(e, l, gop)
	switch e {
	case EncoderNVENC:
		return fmt.Sprintf("nvh264enc name=%s preset=p1 tune=ultra-low-latency rc-mode=cbr bitrate=%d "+
			"vbv-buffer-size=%d gop-size=%d bframes=0 zerolatency=true aud=true repeat-sequence-header=true "+
			"! video/x-h264,profile=constrained-baseline",
			encoderName(l.RID), l.Kbps, s.vbvKbit, s.gopFrames), nil
	case EncoderVA, EncoderVALowPower:
		return fmt.Sprintf("%s name=%s rate-control=cbr bitrate=%d cpb-size=%d key-int-max=%d b-frames=0 ref-frames=1 "+
			"cabac=false dct8x8=false aud=true target-usage=7 "+
			"! video/x-h264,profile=constrained-baseline",
			encoderElements[e], encoderName(l.RID), l.Kbps, s.vbvKbit, s.gopFrames), nil
	case EncoderX264:
		return fmt.Sprintf("x264enc name=%s tune=zerolatency speed-preset=ultrafast sliced-threads=true bitrate=%d "+
			"vbv-buf-capacity=%d key-int-max=%d bframes=0 aud=true "+
			"! video/x-h264,profile=constrained-baseline",
			encoderName(l.RID), l.Kbps, s.vbvMillis, s.gopFrames), nil
	case EncoderNVAV1:
		return fmt.Sprintf("nvav1enc name=%s preset=p1 tune=ultra-low-latency rc-mode=cbr bitrate=%d "+
			"vbv-buffer-size=%d gop-size=%d bframes=0 zerolatency=true "+
			"! video/x-av1,profile=main",
			encoderName(l.RID), l.Kbps, s.vbvKbit, s.gopFrames), nil
	case EncoderVAAV1, EncoderVAAV1LowPower:
		return fmt.Sprintf("%s name=%s rate-control=cbr bitrate=%d cpb-size=%d key-int-max=%d target-usage=7 "+
			"! video/x-av1,profile=main",
			encoderElements[e], encoderName(l.RID), l.Kbps, s.vbvKbit, s.gopFrames), nil
	}
	return "", fmt.Errorf("unknown encoder %q", e)
}

// parserElement is what follows a layer's encoder: the parser that frames one access unit
// per buffer for the appsink. H.264: Annex B with SPS/PPS before every IDR. AV1: OBUs with
// size fields, one temporal unit per buffer (what pion's AV1 payloader reads); the
// encoders put a sequence header before every key frame.
func parserElement(l Layer) string {
	if l.IsAV1() {
		return "av1parse ! video/x-av1,stream-format=obu-stream,alignment=tu"
	}
	return "h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au"
}
