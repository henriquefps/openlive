// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// Sound is one of the notice sounds: the web has the same
// set for its own notices.
type Sound string

const (
	// SoundStart is short and soft: a stream started.
	SoundStart Sound = "start"
	// SoundStop is the start's answer, falling.
	SoundStop Sound = "stop"
	// SoundAlert is the stream dropped or the network is unstable.
	SoundAlert Sound = "alert"
	// SoundViewer is discreet: someone started watching.
	SoundViewer Sound = "viewer"
)

// Sounds lists every sound.
var Sounds = []Sound{SoundStart, SoundStop, SoundAlert, SoundViewer}

type note struct {
	hz float64
	ms int
}

// The sounds are a few sine notes with a soft attack and decay, so they need no files and
// stay the same everywhere.
var notes = map[Sound][]note{
	SoundStart:  {{660, 90}, {880, 160}},
	SoundStop:   {{880, 90}, {660, 160}},
	SoundAlert:  {{988, 110}, {0, 50}, {988, 110}, {0, 50}, {740, 200}},
	SoundViewer: {{1175, 70}},
}

const sampleRate = 48000

// WAV renders s as a 16-bit mono WAV file.
func WAV(s Sound) ([]byte, error) {
	ns, ok := notes[s]
	if !ok {
		return nil, fmt.Errorf("unknown sound %q", s)
	}
	var pcm []int16
	for _, n := range ns {
		count := sampleRate * n.ms / 1000
		attack, release := sampleRate*5/1000, sampleRate*40/1000
		for i := range count {
			if n.hz == 0 {
				pcm = append(pcm, 0)
				continue
			}
			env := 1.0
			if i < attack {
				env = float64(i) / float64(attack)
			} else if left := count - i; left < release {
				env = float64(left) / float64(release)
			}
			v := 0.25 * env * math.Sin(2*math.Pi*n.hz*float64(i)/sampleRate)
			pcm = append(pcm, int16(v*math.MaxInt16))
		}
	}
	var b bytes.Buffer
	data := uint32(len(pcm) * 2)
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, 36+data)
	b.WriteString("WAVEfmt ")
	// PCM, mono, 16-bit.
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(sampleRate), uint32(sampleRate * 2), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, data)
	_ = binary.Write(&b, binary.LittleEndian, pcm)
	return b.Bytes(), nil
}

// CommandPlayer plays the sounds with the first audio player found: pw-play (PipeWire),
// paplay (PulseAudio) or aplay (ALSA). The WAV files are written once to Dir.
type CommandPlayer struct {
	Dir  string
	path string
	once sync.Once
	err  error
}

// ErrNoPlayer: none of the players is installed.
var ErrNoPlayer = errors.New("no audio player (pw-play, paplay, aplay or afplay) found")

func (p *CommandPlayer) setup() {
	// afplay is macOS's.
	for _, name := range []string{"pw-play", "paplay", "aplay", "afplay"} {
		if path, err := exec.LookPath(name); err == nil {
			p.path = path
			break
		}
	}
	if p.path == "" {
		p.err = ErrNoPlayer
		return
	}
	if err := os.MkdirAll(p.Dir, 0o700); err != nil {
		p.err = err
		return
	}
	for _, s := range Sounds {
		wav, err := WAV(s)
		if err == nil {
			err = os.WriteFile(p.file(s), wav, 0o600)
		}
		if err != nil {
			p.err = err
			return
		}
	}
}

func (p *CommandPlayer) file(s Sound) string { return filepath.Join(p.Dir, string(s)+".wav") }

// Play implements Player; it does not wait for the sound to end.
func (p *CommandPlayer) Play(s Sound) error {
	p.once.Do(p.setup)
	if p.err != nil {
		return p.err
	}
	cmd := exec.Command(p.path, p.file(s))
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
