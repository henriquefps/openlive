// SPDX-License-Identifier: AGPL-3.0-only

package compositor

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// privateBus starts a throwaway dbus-daemon so the tests never touch the user's session.
func privateBus(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("dbus-daemon")
	if err != nil {
		t.Skip("dbus-daemon not installed")
	}
	cmd := exec.Command(path, "--session", "--nofork", "--print-address")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	addr, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(addr)
}

func connect(t *testing.T, addr string) *dbus.Conn {
	t.Helper()
	c, err := dbus.Connect(addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// fakeKWin mimics the parts of KWin's scripting service the watcher uses, including the
// stale-script quirk: a script whose plugin name is "stale" keeps an object that accepts
// run() but never executes anything.
type fakeKWin struct {
	conn *dbus.Conn

	mu         sync.Mutex
	scripts    map[string]int32 // plugin -> id
	started    map[int32]bool
	pending    map[int32]bool // loaded, not run yet
	nextID     int32
	staleIDs   map[int32]bool // ids whose Script object swallows run()
	reuseID    int32          // when set, the next loadScript returns this (stale) id
	runCalls   int
	startCalls int
	unloads    []string
	neverRun   bool   // even Scripting.start() does nothing
	helper     string // the helper connection's unique name
}

type fakeScripting struct{ f *fakeKWin }
type fakeScript struct {
	f  *fakeKWin
	id int32
}

func newFakeKWin(t *testing.T, addr string) *fakeKWin {
	f := &fakeKWin{conn: connect(t, addr), scripts: map[string]int32{}, started: map[int32]bool{},
		pending: map[int32]bool{}, staleIDs: map[int32]bool{}}
	if err := f.conn.ExportWithMap(fakeScripting{f}, map[string]string{"LoadScript": "loadScript", "UnloadScript": "unloadScript", "IsScriptLoaded": "isScriptLoaded", "Start": "start"}, "/Scripting", kwinScripting); err != nil {
		t.Fatal(err)
	}
	rep, err := f.conn.RequestName(kwinDest, dbus.NameFlagDoNotQueue)
	if err != nil || rep != dbus.RequestNameReplyPrimaryOwner {
		t.Fatalf("request name: %v %v", rep, err)
	}
	return f
}

func (f *fakeKWin) exportScript(id int32) {
	_ = f.conn.ExportWithMap(fakeScript{f, id}, map[string]string{"Run": "run"}, dbus.ObjectPath(fmt.Sprintf("/Scripting/Script%d", id)), kwinScript)
}

// execute pretends the script ran: it pushes a snapshot to the helper.
func (f *fakeKWin) execute(id int32) {
	f.mu.Lock()
	f.started[id] = true
	f.mu.Unlock()
	go f.push()
}

func (f *fakeKWin) helperName() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.helper
}

// setup mutates the fake's state under its lock.
func (f *fakeKWin) setup(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

func (f *fakeKWin) push() {
	raw := `{"windows":[],"outputs":[{"name":"DP-1","x":0,"y":0,"w":1920,"h":1080,"scale":1}]}`
	_ = f.conn.Object(f.helperName(), watchPath).Call(watchIface+".Update", 0, raw).Err
}

func (s fakeScripting) LoadScript(file, plugin string) (int32, *dbus.Error) {
	f := s.f
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.scripts[plugin]; ok {
		return -1, nil // KWin refuses a name that is already loaded
	}
	id := f.nextID
	if f.reuseID != 0 {
		id, f.reuseID = f.reuseID, 0
	} else {
		f.nextID++
	}
	f.scripts[plugin] = id
	if !f.staleIDs[id] {
		f.exportScript(id)
	}
	f.pending[id] = true
	return id, nil
}

func (s fakeScripting) UnloadScript(plugin string) (bool, *dbus.Error) {
	f := s.f
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unloads = append(f.unloads, plugin)
	id, ok := f.scripts[plugin]
	if !ok {
		return false, nil
	}
	delete(f.scripts, plugin)
	delete(f.pending, id)
	delete(f.started, id)
	return true, nil
}

func (s fakeScripting) IsScriptLoaded(plugin string) (bool, *dbus.Error) {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	_, ok := s.f.scripts[plugin]
	return ok, nil
}

func (s fakeScripting) Start() *dbus.Error {
	f := s.f
	f.mu.Lock()
	f.startCalls++
	var ids []int32
	for id := range f.pending {
		ids = append(ids, id)
	}
	never := f.neverRun
	f.mu.Unlock()
	if !never {
		for _, id := range ids {
			f.execute(id)
		}
	}
	return nil
}

func (s fakeScript) Run() *dbus.Error {
	f := s.f
	f.mu.Lock()
	f.runCalls++
	stale := f.staleIDs[s.id]
	never := f.neverRun
	f.mu.Unlock()
	if !stale && !never {
		f.execute(s.id)
	}
	return nil
}

func (f *fakeKWin) loaded(plugin string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.scripts[plugin]
	return ok
}

func startWatch(t *testing.T, f *fakeKWin, addr, plugin string, timeout time.Duration) (*KWin, error) {
	t.Helper()
	old := answerTimeout
	answerTimeout = 300 * time.Millisecond
	t.Cleanup(func() { answerTimeout = old })
	conn := connect(t, addr)
	f.setup(func() { f.helper = conn.Names()[0] })
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return watchKWinOn(ctx, conn, plugin)
}

func TestWatchKWinFresh(t *testing.T) {
	addr := privateBus(t)
	f := newFakeKWin(t, addr)
	k, err := startWatch(t, f, addr, "openlive-helper-watch", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !f.loaded("openlive-helper-watch") || len(k.Snapshot().Outputs) != 1 {
		t.Fatalf("not loaded or no snapshot: %+v", k.Snapshot())
	}
	k.Close()
	if f.loaded("openlive-helper-watch") {
		t.Fatal("script still loaded after Close")
	}
}

// A crashed helper left its script loaded: the next start must unload it first, so loadScript
// is not refused and the new script runs.
func TestWatchKWinUnloadsLeftover(t *testing.T) {
	addr := privateBus(t)
	f := newFakeKWin(t, addr)
	f.setup(func() { f.scripts["openlive-helper-watch"] = 3 })
	f.exportScript(3)
	k, err := startWatch(t, f, addr, "openlive-helper-watch", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.unloads) == 0 || f.unloads[0] != "openlive-helper-watch" {
		t.Fatalf("unloads = %v", f.unloads)
	}
	if f.startCalls != 0 {
		t.Fatalf("fell back to start() %d times without need", f.startCalls)
	}
}

// KWin hands the same id back and its Script object swallows run(): the fallback must use
// Scripting.start().
func TestWatchKWinStaleIDFallsBackToStart(t *testing.T) {
	addr := privateBus(t)
	f := newFakeKWin(t, addr)
	f.setup(func() { f.staleIDs[3], f.reuseID = true, 3 })
	k, err := startWatch(t, f, addr, "openlive-helper-watch", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startCalls == 0 {
		t.Fatal("start() was never used")
	}
	if len(k.Snapshot().Outputs) != 1 {
		t.Fatalf("snapshot = %+v", k.Snapshot())
	}
}

func TestWatchKWinGivesUpWithClearError(t *testing.T) {
	addr := privateBus(t)
	f := newFakeKWin(t, addr)
	f.setup(func() { f.neverRun = true })
	_, err := startWatch(t, f, addr, "openlive-helper-watch", 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "could not start the watch script") {
		t.Fatalf("err = %v", err)
	}
	if f.loaded("openlive-helper-watch") {
		t.Fatal("script left loaded after failure")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startCalls != 2 {
		t.Fatalf("startCalls = %d, want one per attempt", f.startCalls)
	}
}
