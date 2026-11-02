// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"fmt"
	"math"
)

// h264Level is one row of H.264 Table A-1: the most macroblocks per second and per frame,
// and the most bitrate (baseline and main profiles, kbit/s), at a level.
type h264Level struct {
	idc      int // level_idc: 10 × the level (31 = 3.1)
	maxMBPS  int
	maxFS    int
	maxBRKbs int
}

var h264Levels = []h264Level{
	{10, 1485, 99, 64},
	{11, 3000, 396, 192},
	{12, 6000, 396, 384},
	{13, 11880, 396, 768},
	{20, 11880, 396, 2000},
	{21, 19800, 792, 4000},
	{22, 20250, 1620, 4000},
	{30, 40500, 1620, 10000},
	{31, 108000, 3600, 14000},
	{32, 216000, 5120, 20000},
	{40, 245760, 8192, 20000},
	{41, 245760, 8192, 50000},
	{42, 522240, 8704, 50000},
	{50, 589824, 22080, 135000},
	{51, 983040, 36864, 240000},
	{52, 2073600, 36864, 240000},
	{60, 4177920, 139264, 240000},
	{61, 8355840, 139264, 480000},
	{62, 16711680, 139264, 800000},
}

// MinSDPLevel is the lowest level the helper announces: pion's default H.264 entry
// (42e01f, 3.1), which every SFU and browser so far accepted.
const MinSDPLevel = 31

// H264Level is the lowest level_idc whose limits hold a w×h stream at fps and kbps: the
// macroblock rate, the frame size (and its width and height, at most √(8·MaxFS) macroblocks
// each) and the bitrate. 1080p120 needs 5.1 and 1440p120 5.2: 4.2 stops at 1080p64 and 5.1
// at 1440p68. 0 when no level holds it.
func H264Level(w, h, fps, kbps int) int {
	mbW, mbH := (w+15)/16, (h+15)/16
	fs := mbW * mbH
	for _, l := range h264Levels {
		side := int(math.Sqrt(float64(8 * l.maxFS)))
		if fs*fps <= l.maxMBPS && fs <= l.maxFS && mbW <= side && mbH <= side && kbps <= l.maxBRKbs {
			return l.idc
		}
	}
	return 0
}

// H264Level is the level the layer's stream needs (see the function).
func (l Layer) H264Level() int { return H264Level(l.Width, l.Height, l.FPS, l.Kbps) }

// SDPLevel is the level the SDP announces for the layers: one H.264 payload type carries
// every simulcast encoding, so it is the highest any layer needs, and at least MinSDPLevel.
// The SPS of each layer carries its own (lower or equal) level, which the encoders set.
func SDPLevel(layers []Layer) int {
	level := MinSDPLevel
	for _, l := range layers {
		level = max(level, l.H264Level())
	}
	return level
}

// LevelName formats a level_idc as "5.1".
func LevelName(idc int) string { return fmt.Sprintf("%d.%d", idc/10, idc%10) }

// SPSLevel finds the first SPS (NAL type 7) in an Annex B access unit and returns its
// level_idc. The SPS starts profile_idc, constraint flags, level_idc.
func SPSLevel(au []byte) (int, bool) {
	for i := 0; i+2 < len(au); i++ {
		if au[i] != 0 || au[i+1] != 0 || au[i+2] != 1 {
			continue
		}
		n := i + 3
		if n+3 < len(au) && au[n]&0x1f == 7 {
			return int(au[n+3]), true
		}
	}
	return 0, false
}
