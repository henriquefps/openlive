// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package overlay

import (
	"errors"
	"fmt"
	"image"
	"log/slog"
	"math"
	"sync"
	"time"

	"golang.org/x/image/font"
	"golang.org/x/sys/unix"
)

// frameEvery paces the animation while a ping runs; nothing ticks while none does.
const frameEvery = time.Second / 60

// buffersPerPing lets the compositor hold one buffer while the next is drawn.
const buffersPerPing = 3

// global is one entry of the compositor's registry.
type global struct {
	name    uint32
	iface   string
	version uint32
}

// wlOutput is a bound wl_output.
type wlOutput struct {
	id, global uint32
	name       string
	scale      int32
}

// handshake reads the registry: globals, then (after binding outputs) their names.
type handshake struct {
	c        *wlConn
	registry uint32
	globals  []global
}

// roundtrip sends wl_display.sync and handles events until its callback is done.
func (h *handshake) roundtrip(handle func(wlEvent)) error {
	cb := h.c.newID()
	if err := h.c.send(displayID, displaySync, new(msg).u32(cb)); err != nil {
		return err
	}
	for {
		ev, err := h.c.readEvent()
		if err != nil {
			return err
		}
		switch {
		case ev.obj == cb && ev.opcode == evCallbackDone:
			return nil
		case ev.obj == displayID && ev.opcode == evDisplayError:
			return displayError(ev)
		case ev.obj == h.registry && ev.opcode == evRegistryGlobal:
			r := argReader{b: ev.args}
			g := global{name: r.u32(), iface: r.str(), version: r.u32()}
			if r.err == nil {
				h.globals = append(h.globals, g)
			}
		default:
			if handle != nil {
				handle(ev)
			}
		}
	}
}

func displayError(ev wlEvent) error {
	r := argReader{b: ev.args}
	obj, code, text := r.u32(), r.u32(), r.str()
	return fmt.Errorf("wayland: protocol error on object %d (code %d): %s", obj, code, text)
}

func (h *handshake) find(iface string) (global, bool) {
	for _, g := range h.globals {
		if g.iface == iface {
			return g, true
		}
	}
	return global{}, false
}

// bind binds a global at no more than version max.
func (h *handshake) bind(g global, max uint32) (uint32, error) {
	id := h.c.newID()
	v := min(g.version, max)
	err := h.c.send(h.registry, registryBind, new(msg).u32(g.name).str(g.iface).u32(v).u32(id))
	return id, err
}

func connect() (*handshake, error) {
	c, err := dialWayland()
	if err != nil {
		return nil, err
	}
	h := &handshake{c: c, registry: c.newID()}
	if err := c.send(displayID, displayGetRegistry, new(msg).u32(h.registry)); err != nil {
		_ = c.close()
		return nil, err
	}
	if err := h.roundtrip(nil); err != nil {
		_ = c.close()
		return nil, err
	}
	return h, nil
}

// Probe connects to the Wayland compositor and checks for what the overlay needs.
func Probe() Support {
	h, err := connect()
	if err != nil {
		return Support{Err: err}
	}
	defer func() { _ = h.c.close() }()
	s := Support{Wayland: true}
	_, s.LayerShell = h.find(ifLayerShell)
	_, s.Viewporter = h.find(ifViewporter)
	for _, need := range []string{ifCompositor, ifShm} {
		if _, ok := h.find(need); !ok {
			s.Err = fmt.Errorf("the compositor has no %s", need)
		}
	}
	if !s.LayerShell && s.Err == nil {
		s.Err = ErrNoLayerShell
	}
	return s
}

// Wayland draws pings as small layer-shell surfaces on the overlay layer: above every
// window, fullscreen ones too, with an empty input region so clicks go through, and no
// keyboard focus. Each ping gets its own surface around the marker, created when the ping
// arrives and destroyed when its animation ends, so an idle overlay maps nothing and the
// compositor composites nothing extra.
type Wayland struct {
	c          *wlConn
	log        *slog.Logger
	registry   uint32
	compositor uint32
	shm        uint32
	layerShell uint32
	viewporter uint32
	outputs    map[uint32]*wlOutput // by object id

	shows  chan Spec
	events chan wlEvent
	quit   chan struct{}
	done   chan struct{}
	once   sync.Once
	errMu  sync.Mutex
	err    error

	// Owned by the loop goroutine.
	pings    Pings
	surfaces map[uint32]*pingSurface // by layer surface id (the ping's id)
	buffers  map[uint32]*shmBuffer   // by wl_buffer id
}

// Open connects to the compositor; the connection stays open, mapping nothing, until a
// ping is shown.
func Open(log *slog.Logger) (Drawer, error) {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	h, err := connect()
	if err != nil {
		return nil, err
	}
	w := &Wayland{
		c: h.c, log: log, registry: h.registry, outputs: map[uint32]*wlOutput{},
		shows: make(chan Spec, MaxPings), events: make(chan wlEvent, 64),
		quit: make(chan struct{}), done: make(chan struct{}),
		surfaces: map[uint32]*pingSurface{}, buffers: map[uint32]*shmBuffer{},
	}
	fail := func(err error) (Drawer, error) { _ = h.c.close(); return nil, err }
	binds := []struct {
		iface string
		max   uint32
		id    *uint32
		need  bool
	}{
		{ifCompositor, 4, &w.compositor, true}, // damage_buffer is version 4
		{ifShm, 1, &w.shm, true},
		{ifLayerShell, 4, &w.layerShell, true},
		{ifViewporter, 1, &w.viewporter, false},
	}
	for _, b := range binds {
		g, ok := h.find(b.iface)
		if !ok {
			if b.need {
				if b.iface == ifLayerShell {
					return fail(ErrNoLayerShell)
				}
				return fail(fmt.Errorf("the compositor has no %s", b.iface))
			}
			continue
		}
		if *b.id, err = h.bind(g, b.max); err != nil {
			return fail(err)
		}
	}
	for _, g := range h.globals {
		if g.iface == ifOutput {
			if err := w.bindOutput(h, g); err != nil {
				return fail(err)
			}
		}
	}
	// A second roundtrip delivers the outputs' names and scales.
	if err := h.roundtrip(w.handleOutput); err != nil {
		return fail(err)
	}
	go w.read()
	go w.loop()
	return w, nil
}

func (w *Wayland) bindOutput(h *handshake, g global) error {
	id, err := h.bind(g, 4) // the name event is version 4
	if err != nil {
		return err
	}
	w.outputs[id] = &wlOutput{id: id, global: g.name, scale: 1}
	return nil
}

// handleOutput reads a wl_output's name and scale.
func (w *Wayland) handleOutput(ev wlEvent) {
	o, ok := w.outputs[ev.obj]
	if !ok {
		return
	}
	r := argReader{b: ev.args}
	switch ev.opcode {
	case evOutputScale:
		if s := r.i32(); r.err == nil && s > 0 {
			o.scale = s
		}
	case evOutputName:
		if n := r.str(); r.err == nil {
			o.name = n
		}
	}
}

// Show queues a ping.
func (w *Wayland) Show(s Spec) error {
	select {
	case <-w.done:
		return w.failure()
	default:
	}
	select {
	case w.shows <- s:
		return nil
	case <-w.done:
		return w.failure()
	default:
		return errors.New("overlay: too many pings at once")
	}
}

func (w *Wayland) failure() error {
	w.errMu.Lock()
	defer w.errMu.Unlock()
	if w.err != nil {
		return w.err
	}
	return errors.New("overlay: closed")
}

func (w *Wayland) setErr(err error) {
	w.errMu.Lock()
	if w.err == nil {
		w.err = err
	}
	w.errMu.Unlock()
}

// Close removes every ping and disconnects.
func (w *Wayland) Close() {
	w.once.Do(func() { close(w.quit) })
	<-w.done
}

// read forwards events to the loop until the connection ends.
func (w *Wayland) read() {
	defer close(w.events)
	for {
		ev, err := w.c.readEvent()
		if err != nil {
			select {
			case <-w.quit:
			default:
				w.setErr(fmt.Errorf("overlay: %w", err))
			}
			return
		}
		select {
		case w.events <- ev:
		case <-w.quit:
			return
		}
	}
}

// loop owns the surfaces: it creates them, animates them while any runs and removes them.
func (w *Wayland) loop() {
	defer close(w.done)
	defer func() {
		for _, s := range w.surfaces {
			w.destroy(s)
		}
		_ = w.c.close()
	}()
	var ticker *time.Ticker
	defer func() {
		if ticker != nil {
			ticker.Stop()
		}
	}()
	for {
		var tick <-chan time.Time
		if ticker != nil {
			tick = ticker.C
		}
		select {
		case <-w.quit:
			return
		case ev, ok := <-w.events:
			if !ok {
				w.setErr(errors.New("overlay: the compositor closed the connection"))
				return
			}
			if err := w.dispatch(ev); err != nil {
				w.setErr(err)
				w.log.Warn("overlay: the compositor refused a request", "err", err)
				return
			}
		case s := <-w.shows:
			if err := w.create(s, time.Now()); err != nil {
				w.log.Warn("overlay: could not show a ping", "err", err)
			}
		case now := <-tick:
			w.tick(now)
		}
		// Tick only while a ping runs: an idle overlay takes no CPU.
		switch {
		case w.pings.Len() > 0 && ticker == nil:
			ticker = time.NewTicker(frameEvery)
		case w.pings.Len() == 0 && ticker != nil:
			ticker.Stop()
			ticker = nil
		}
	}
}

func (w *Wayland) dispatch(ev wlEvent) error {
	r := argReader{b: ev.args}
	switch ev.obj {
	case displayID:
		if ev.opcode == evDisplayError {
			return displayError(ev)
		}
		return nil // delete_id: ids are never reused
	case w.registry:
		switch ev.opcode {
		case evRegistryGlobal:
			g := global{name: r.u32(), iface: r.str(), version: r.u32()}
			if r.err == nil && g.iface == ifOutput {
				// A monitor plugged in while streaming.
				id := w.c.newID()
				if err := w.c.send(w.registry, registryBind, new(msg).u32(g.name).str(g.iface).u32(min(g.version, 4)).u32(id)); err != nil {
					return err
				}
				w.outputs[id] = &wlOutput{id: id, global: g.name, scale: 1}
			}
		case evRegistryRemove:
			name := r.u32()
			for id, o := range w.outputs {
				if o.global == name {
					delete(w.outputs, id)
				}
			}
		}
		return nil
	}
	if _, ok := w.outputs[ev.obj]; ok {
		w.handleOutput(ev)
		return nil
	}
	if b, ok := w.buffers[ev.obj]; ok {
		if ev.opcode == evBufferRelease {
			b.busy = false
		}
		return nil
	}
	if s, ok := w.surfaces[ev.obj]; ok {
		switch ev.opcode {
		case evLayerSurfaceConfigure:
			serial := r.u32()
			if err := w.c.send(s.layer, layerSurfaceAckConfigure, new(msg).u32(serial)); err != nil {
				return err
			}
			first := !s.configured
			s.configured = true
			if first {
				w.draw(s, time.Now())
			}
		case evLayerSurfaceClosed:
			w.pings.Remove(s.layer)
			w.destroy(s)
		}
	}
	return nil
}

// shmBuffer is one wl_buffer in a ping's pool.
type shmBuffer struct {
	id     uint32
	offset int
	busy   bool
}

// pingSurface is one ping on screen.
type pingSurface struct {
	surface, layer, viewport, pool uint32
	configured                     bool

	spec    Spec
	name    string
	lay     Layout
	scale   float64 // buffer pixels per logical pixel
	bw, bh  int
	mem     []byte
	bufs    []*shmBuffer
	img     *image.RGBA
	face    font.Face
	started time.Time
}

// outputFor is the wl_output of an output name: the only one when names are missing.
func (w *Wayland) outputFor(name string) *wlOutput {
	for _, o := range w.outputs {
		if o.name == name && name != "" {
			return o
		}
	}
	if len(w.outputs) == 1 {
		for _, o := range w.outputs {
			return o
		}
	}
	return nil
}

func (w *Wayland) create(spec Spec, now time.Time) error {
	out := w.outputFor(spec.Point.Output.Name)
	outW, outH := spec.Point.Output.Width, spec.Point.Output.Height
	if outW <= 0 || outH <= 0 {
		return errors.New("the output's size is unknown")
	}
	// KWin's devicePixelRatio is the exact (fractional) scale; wl_output's is rounded up.
	scale := spec.Point.Output.Scale
	if scale <= 0 && out != nil {
		scale = float64(out.scale)
	}
	scale = math.Max(scale, 1)
	bufScale := 0 // wl_surface.set_buffer_scale, without a viewporter
	if w.viewporter == 0 {
		bufScale = int(math.Ceil(scale))
		scale = float64(bufScale)
	}
	face, err := Face(scale)
	if err != nil {
		return err
	}
	name := ShortName(spec.Name)
	lay := Place(outW, outH, spec.Point.X, spec.Point.Y, TextWidth(face, scale, name))
	s := &pingSurface{spec: spec, name: name, lay: lay, scale: scale, face: face, started: now,
		bw: int(math.Ceil(float64(lay.W) * scale)), bh: int(math.Ceil(float64(lay.H) * scale))}
	if bufScale > 0 {
		s.bw, s.bh = lay.W*bufScale, lay.H*bufScale
	}
	s.img = image.NewRGBA(image.Rect(0, 0, s.bw, s.bh))
	if err := w.allocate(s); err != nil {
		w.destroy(s)
		return err
	}

	var outID uint32
	if out != nil {
		outID = out.id
	}
	// Each id is taken right before the request that creates it: the server only accepts
	// the next id in sequence.
	var region uint32
	steps := []func() error{
		func() error {
			s.surface = w.c.newID()
			return w.c.send(w.compositor, compositorCreateSurface, new(msg).u32(s.surface))
		},
		// An empty input region: the pointer and touches go to what is under the ping.
		func() error {
			region = w.c.newID()
			return w.c.send(w.compositor, compositorCreateRegion, new(msg).u32(region))
		},
		func() error { return w.c.send(s.surface, surfaceSetInputRegion, new(msg).u32(region)) },
		func() error { return w.c.send(region, regionDestroy, nil) },
		func() error {
			if bufScale > 0 {
				return w.c.send(s.surface, surfaceSetBufferScale, new(msg).i32(int32(bufScale)))
			}
			s.viewport = w.c.newID()
			if err := w.c.send(w.viewporter, viewporterGetViewport, new(msg).u32(s.viewport).u32(s.surface)); err != nil {
				return err
			}
			return w.c.send(s.viewport, viewportSetDestination, new(msg).i32(int32(lay.W)).i32(int32(lay.H)))
		},
		func() error {
			s.layer = w.c.newID()
			w.surfaces[s.layer] = s
			return w.c.send(w.layerShell, layerShellGetLayerSurface,
				new(msg).u32(s.layer).u32(s.surface).u32(outID).u32(layerOverlay).str("openlive-ping"))
		},
		func() error {
			return w.c.send(s.layer, layerSurfaceSetSize, new(msg).u32(uint32(lay.W)).u32(uint32(lay.H)))
		},
		func() error { return w.c.send(s.layer, layerSurfaceSetAnchor, new(msg).u32(anchorTop|anchorLeft)) },
		// -1: placed from the output's edges, not moved by panels' exclusive zones.
		func() error { return w.c.send(s.layer, layerSurfaceSetExclusiveZone, new(msg).i32(-1)) },
		func() error {
			return w.c.send(s.layer, layerSurfaceSetMargin, new(msg).i32(int32(lay.Top)).i32(0).i32(0).i32(int32(lay.Left)))
		},
		func() error { return w.c.send(s.layer, layerSurfaceSetKeyboard, new(msg).u32(0)) },
		// The first commit has no buffer; the configure event answers it.
		func() error { return w.c.send(s.surface, surfaceCommit, nil) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			w.destroy(s)
			return err
		}
	}
	if evicted, ok := w.pings.Add(s.layer, now); ok {
		if old, ok := w.surfaces[evicted]; ok {
			w.destroy(old)
		}
	}
	return nil
}

// allocate makes the ping's shared-memory pool and its buffers.
func (w *Wayland) allocate(s *pingSurface) error {
	stride := s.bw * 4
	size := stride * s.bh
	total := size * buffersPerPing
	fd, err := unix.MemfdCreate("openlive-ping", unix.MFD_CLOEXEC)
	if err != nil {
		return fmt.Errorf("memfd: %w", err)
	}
	defer func() { _ = unix.Close(fd) }() // the compositor keeps its own copy
	if err := unix.Ftruncate(fd, int64(total)); err != nil {
		return err
	}
	mem, err := unix.Mmap(fd, 0, total, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		return fmt.Errorf("mmap: %w", err)
	}
	s.mem = mem
	s.pool = w.c.newID()
	if err := w.c.send(w.shm, shmCreatePool, new(msg).u32(s.pool).fd(fd).i32(int32(total))); err != nil {
		_ = unix.Munmap(mem)
		s.mem = nil
		return err
	}
	for i := range buffersPerPing {
		b := &shmBuffer{id: w.c.newID(), offset: i * size}
		if err := w.c.send(s.pool, poolCreateBuffer, new(msg).u32(b.id).i32(int32(b.offset)).
			i32(int32(s.bw)).i32(int32(s.bh)).i32(int32(stride)).u32(shmFormatARGB)); err != nil {
			return err
		}
		s.bufs = append(s.bufs, b)
		w.buffers[b.id] = b
	}
	return nil
}

func (w *Wayland) tick(now time.Time) {
	frames, ended := w.pings.Tick(now)
	for _, id := range ended {
		if s, ok := w.surfaces[id]; ok {
			w.destroy(s)
		}
	}
	for _, f := range frames {
		if s, ok := w.surfaces[f.ID]; ok && s.configured {
			w.paint(s, f.Look)
		}
	}
}

// draw paints the ping's frame at now.
func (w *Wayland) draw(s *pingSurface, now time.Time) {
	if look, done := LookAt(now.Sub(s.started)); !done {
		w.paint(s, look)
	}
}

// paint draws one frame into a free buffer and commits it; with every buffer still held by
// the compositor the frame is skipped.
func (w *Wayland) paint(s *pingSurface, look Look) {
	var buf *shmBuffer
	for _, b := range s.bufs {
		if !b.busy {
			buf = b
			break
		}
	}
	if buf == nil {
		return
	}
	Render(s.img, s.lay, s.scale, look, s.spec.Style, s.name, s.face)
	toARGB(s.mem[buf.offset:buf.offset+len(s.img.Pix)], s.img)
	buf.busy = true
	for _, err := range []error{
		w.c.send(s.surface, surfaceAttach, new(msg).u32(buf.id).i32(0).i32(0)),
		// The surface is only the ping's box: the damage is the ping's region.
		w.c.send(s.surface, surfaceDamageBuffer, new(msg).i32(0).i32(0).i32(int32(s.bw)).i32(int32(s.bh))),
		w.c.send(s.surface, surfaceCommit, nil),
	} {
		if err != nil {
			w.log.Debug("overlay: paint", "err", err)
			return
		}
	}
}

// destroy unmaps a ping and frees its memory.
func (w *Wayland) destroy(s *pingSurface) {
	delete(w.surfaces, s.layer)
	if s.layer != 0 {
		_ = w.c.send(s.layer, layerSurfaceDestroy, nil)
	}
	if s.viewport != 0 {
		_ = w.c.send(s.viewport, viewportDestroy, nil)
	}
	if s.surface != 0 {
		_ = w.c.send(s.surface, surfaceDestroy, nil)
	}
	for _, b := range s.bufs {
		delete(w.buffers, b.id)
		_ = w.c.send(b.id, bufferDestroy, nil)
	}
	if s.pool != 0 {
		_ = w.c.send(s.pool, poolDestroy, nil)
	}
	if s.mem != nil {
		_ = unix.Munmap(s.mem)
		s.mem = nil
	}
}
