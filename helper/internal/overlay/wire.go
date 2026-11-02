// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package overlay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

// This file is a minimal Wayland wire client: just the requests and events the ping
// overlay uses. Messages are a header (object id, then size<<16 | opcode)
// and 32-bit arguments in the host's byte order; file descriptors travel as SCM_RIGHTS.

// wlConn is one connection to the compositor. Requests may be sent from any goroutine;
// events are read by one goroutine (readEvent).
type wlConn struct {
	sock *net.UnixConn

	wmu    sync.Mutex
	nextID uint32

	rbuf []byte
}

// wlEvent is one decoded event header and its raw arguments.
type wlEvent struct {
	obj    uint32
	opcode uint16
	args   []byte
}

var native = binary.LittleEndian

// socketPath resolves $WAYLAND_DISPLAY the way libwayland does.
func socketPath() (string, error) {
	name := os.Getenv("WAYLAND_DISPLAY")
	if name == "" {
		return "", errors.New("WAYLAND_DISPLAY is not set (not a Wayland session)")
	}
	if filepath.IsAbs(name) {
		return name, nil
	}
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		return "", errors.New("XDG_RUNTIME_DIR is not set")
	}
	return filepath.Join(dir, name), nil
}

func dialWayland() (*wlConn, error) {
	path, err := socketPath()
	if err != nil {
		return nil, err
	}
	sock, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("wayland: %w", err)
	}
	// Object 1 is wl_display; the client allocates ids from 2.
	return &wlConn{sock: sock, nextID: 2}, nil
}

func (c *wlConn) close() error { return c.sock.Close() }

// newID allocates the next client object id. Ids are never reused: the server accepts a
// new id only at the end of its table, and a long-lived overlay creates a few per ping.
func (c *wlConn) newID() uint32 {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	id := c.nextID
	c.nextID++
	return id
}

// msg builds one request.
type msg struct {
	buf []byte
	fds []int
}

func (m *msg) u32(v uint32) *msg { m.buf = native.AppendUint32(m.buf, v); return m }
func (m *msg) i32(v int32) *msg  { return m.u32(uint32(v)) }
func (m *msg) fixed(v float64) *msg {
	return m.i32(int32(math.Round(v * 256)))
}
func (m *msg) str(s string) *msg {
	m.u32(uint32(len(s) + 1))
	m.buf = append(m.buf, s...)
	m.buf = append(m.buf, 0)
	for len(m.buf)%4 != 0 {
		m.buf = append(m.buf, 0)
	}
	return m
}
func (m *msg) fd(fd int) *msg { m.fds = append(m.fds, fd); return m }

// send writes a request to obj.
func (c *wlConn) send(obj uint32, opcode uint16, m *msg) error {
	var body []byte
	var fds []int
	if m != nil {
		body, fds = m.buf, m.fds
	}
	size := 8 + len(body)
	out := make([]byte, 0, size)
	out = native.AppendUint32(out, obj)
	out = native.AppendUint32(out, uint32(size)<<16|uint32(opcode))
	out = append(out, body...)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var oob []byte
	if len(fds) > 0 {
		oob = syscall.UnixRights(fds...)
	}
	n, _, err := c.sock.WriteMsgUnix(out, oob, nil)
	if err != nil {
		return err
	}
	if n != len(out) {
		return fmt.Errorf("wayland: short write (%d of %d)", n, len(out))
	}
	return nil
}

// readEvent blocks for the next event.
func (c *wlConn) readEvent() (wlEvent, error) {
	for {
		if len(c.rbuf) >= 8 {
			obj := native.Uint32(c.rbuf[0:])
			word := native.Uint32(c.rbuf[4:])
			size := int(word >> 16)
			if size < 8 {
				return wlEvent{}, fmt.Errorf("wayland: bad message size %d", size)
			}
			if len(c.rbuf) >= size {
				ev := wlEvent{obj: obj, opcode: uint16(word & 0xffff), args: append([]byte(nil), c.rbuf[8:size]...)}
				c.rbuf = c.rbuf[size:]
				return ev, nil
			}
		}
		buf := make([]byte, 4096)
		oob := make([]byte, syscall.CmsgSpace(4*28))
		n, oobn, _, _, err := c.sock.ReadMsgUnix(buf, oob)
		if err != nil {
			return wlEvent{}, err
		}
		if n == 0 {
			return wlEvent{}, errors.New("wayland: connection closed")
		}
		if oobn > 0 {
			// No event this overlay handles carries a descriptor; close any so none leak.
			if msgs, err := syscall.ParseSocketControlMessage(oob[:oobn]); err == nil {
				for _, cm := range msgs {
					if fds, err := syscall.ParseUnixRights(&cm); err == nil {
						for _, fd := range fds {
							_ = syscall.Close(fd)
						}
					}
				}
			}
		}
		c.rbuf = append(c.rbuf, buf[:n]...)
	}
}

// argReader decodes event arguments.
type argReader struct {
	b   []byte
	err error
}

func (r *argReader) u32() uint32 {
	if len(r.b) < 4 {
		r.err = errors.New("wayland: short event")
		return 0
	}
	v := native.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *argReader) i32() int32 { return int32(r.u32()) }

func (r *argReader) str() string {
	n := int(r.u32())
	if n == 0 {
		return ""
	}
	padded := (n + 3) &^ 3
	if len(r.b) < padded {
		r.err = errors.New("wayland: short string")
		return ""
	}
	s := string(r.b[:n-1])
	r.b = r.b[padded:]
	return s
}

// Interfaces and opcodes used (wayland.xml, wlr-layer-shell-unstable-v1.xml, viewporter.xml).
const (
	ifCompositor = "wl_compositor"
	ifShm        = "wl_shm"
	ifOutput     = "wl_output"
	ifLayerShell = "zwlr_layer_shell_v1"
	ifViewporter = "wp_viewporter"

	displayID = 1

	// wl_display
	displaySync        = 0
	displayGetRegistry = 1
	evDisplayError     = 0
	evDisplayDeleteID  = 1
	// wl_registry
	registryBind     = 0
	evRegistryGlobal = 0
	evRegistryRemove = 1
	// wl_callback
	evCallbackDone = 0
	// wl_compositor
	compositorCreateSurface = 0
	compositorCreateRegion  = 1
	// wl_shm, wl_shm_pool, wl_buffer
	shmCreatePool    = 0
	poolCreateBuffer = 0
	poolDestroy      = 1
	bufferDestroy    = 0
	evBufferRelease  = 0
	shmFormatARGB    = 0 // premultiplied, B G R A in memory on little-endian
	// wl_surface
	surfaceDestroy        = 0
	surfaceAttach         = 1
	surfaceFrame          = 3
	surfaceSetInputRegion = 5
	surfaceCommit         = 6
	surfaceSetBufferScale = 8
	surfaceDamageBuffer   = 9
	// wl_region
	regionDestroy = 0
	// wl_output
	evOutputScale = 3
	evOutputName  = 4
	evOutputDone  = 2
	outputRelease = 0
	// zwlr_layer_shell_v1
	layerShellGetLayerSurface = 0
	layerOverlay              = 3
	// zwlr_layer_surface_v1
	layerSurfaceSetSize          = 0
	layerSurfaceSetAnchor        = 1
	layerSurfaceSetExclusiveZone = 2
	layerSurfaceSetMargin        = 3
	layerSurfaceSetKeyboard      = 4
	layerSurfaceAckConfigure     = 6
	layerSurfaceDestroy          = 7
	evLayerSurfaceConfigure      = 0
	evLayerSurfaceClosed         = 1
	anchorTop                    = 1
	anchorLeft                   = 4
	// wp_viewporter, wp_viewport
	viewporterGetViewport  = 1
	viewportDestroy        = 0
	viewportSetDestination = 2
)
