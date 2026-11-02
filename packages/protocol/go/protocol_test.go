// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// The fixtures and schemas live next to this module in packages/protocol and are shared with
// the TypeScript tests (test/contract.test.ts), so both sides judge them the same way.
const (
	fixturesDir = "../fixtures"
	schemaDir   = "../schema"
	schemaBase  = "https://openlive.invalid/protocol/v1/"
)

type schemas struct {
	envelope *jsonschema.Schema
	byType   map[string]*jsonschema.Schema
}

func loadSchemas(t *testing.T) schemas {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	var files []string
	err := filepath.WalkDir(schemaDir, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".json") {
			files = append(files, path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		doc := readJSON(t, f)
		rel, _ := filepath.Rel(schemaDir, f)
		if err := c.AddResource(schemaBase+filepath.ToSlash(rel), doc); err != nil {
			t.Fatal(err)
		}
	}
	s := schemas{byType: map[string]*jsonschema.Schema{}}
	if s.envelope, err = c.Compile(schemaBase + "envelope.json"); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		rel, _ := filepath.Rel(schemaDir, f)
		if !strings.HasPrefix(filepath.ToSlash(rel), "messages/") {
			continue
		}
		typ := strings.TrimSuffix(filepath.Base(f), ".json")
		if s.byType[typ], err = c.Compile(schemaBase + filepath.ToSlash(rel)); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

// validate applies the strict schema: envelope first, then the schema of the message type.
func (s schemas) validate(doc any) error {
	if err := s.envelope.Validate(doc); err != nil {
		return err
	}
	typ, _ := doc.(map[string]any)["type"].(string)
	sch, ok := s.byType[typ]
	if !ok {
		return ErrUnknownType
	}
	return sch.Validate(doc)
}

func readJSON(t *testing.T, path string) any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	doc, err := jsonschema.UnmarshalJSON(f)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return doc
}

func fixtures(t *testing.T, kind string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(fixturesDir, kind, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no %s fixtures: %v", kind, err)
	}
	sort.Strings(files)
	return files
}

// semantic compares two JSON documents ignoring formatting and key order.
func semantic(t *testing.T, data []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestValidFixtures(t *testing.T) {
	s := loadSchemas(t)
	covered := map[MessageType]bool{}
	for _, path := range fixtures(t, "valid") {
		t.Run(filepath.Base(path), func(t *testing.T) {
			if err := s.validate(readJSON(t, path)); err != nil {
				t.Fatalf("strict schema rejects a valid fixture: %v", err)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			env, p, err := Decode(data)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			covered[env.Type] = true

			// The generated struct must hold every field of the fixture: decode again refusing
			// unknown fields, then re-encode and compare with the original.
			strict := NewPayload(env.Type)
			dec := json.NewDecoder(bytes.NewReader(env.Payload))
			dec.DisallowUnknownFields()
			if err := dec.Decode(strict); err != nil {
				t.Fatalf("payload has fields the Go type lacks: %v", err)
			}
			if !reflect.DeepEqual(strict, p) {
				t.Fatalf("strict and lenient decode differ")
			}
			out, err := Encode(env.ID, p)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := semantic(t, out), semantic(t, data); !reflect.DeepEqual(got, want) {
				t.Fatalf("round trip changed the message\n got: %s\nwant: %s", out, data)
			}
		})
	}
	for typ := range Messages {
		if !covered[typ] {
			t.Errorf("no valid fixture for %s", typ)
		}
	}
}

func TestInvalidFixtures(t *testing.T) {
	s := loadSchemas(t)
	for _, path := range fixtures(t, "invalid") {
		t.Run(filepath.Base(path), func(t *testing.T) {
			if err := s.validate(readJSON(t, path)); err == nil {
				t.Fatal("strict schema accepts an invalid fixture")
			}
		})
	}
}

func TestCatalogueMatchesSchemas(t *testing.T) {
	s := loadSchemas(t)
	for typ := range s.byType {
		if _, ok := Messages[MessageType(typ)]; !ok {
			t.Errorf("schema %s has no generated MessageType", typ)
		}
		if NewPayload(MessageType(typ)) == nil {
			t.Errorf("NewPayload(%s) is nil", typ)
		}
	}
	if len(Messages) != len(s.byType) {
		t.Errorf("%d generated message types, %d schemas", len(Messages), len(s.byType))
	}
	for typ, info := range Messages {
		for _, r := range info.Replies {
			if _, ok := Messages[r]; !ok {
				t.Errorf("%s: reply %s is not a message type", typ, r)
			}
		}
	}
}

func TestEncodePing(t *testing.T) {
	// Must match PING_FRAME / PONG_FRAME byte for byte (hibernation auto-response).
	ping, err := Encode("", PingPayload{})
	if err != nil {
		t.Fatal(err)
	}
	if string(ping) != `{"type":"ping","payload":{}}` {
		t.Fatalf("ping frame = %s", ping)
	}
}

func TestDecodeUnknownTypeAndFields(t *testing.T) {
	env, p, err := Decode([]byte(`{"type":"stream.rewind","id":"5","payload":{}}`))
	if err != ErrUnknownType || p != nil || env.ID != "5" {
		t.Fatalf("got %v %v %v", env, p, err)
	}
	_, p, err = Decode([]byte(`{"type":"slot.request","payload":{"streamId":"st_1","since":"1.1"}}`))
	if err != nil {
		t.Fatalf("unknown fields must be ignored: %v", err)
	}
	if got := p.(*SlotRequestPayload).StreamID; got != "st_1" {
		t.Fatalf("streamId = %q", got)
	}
}

// TestRestFixtures checks fixtures/rest/<Body>[.<label>].json against rest.json and the generated
// REST body types, the same way TestValidFixtures checks messages.
func TestRestFixtures(t *testing.T) {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	for _, f := range []string{"common.json", "codes.json", "envelope.json", "rest.json"} {
		if err := c.AddResource(schemaBase+f, readJSON(t, filepath.Join(schemaDir, f))); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range fixtures(t, "rest") {
		t.Run(filepath.Base(path), func(t *testing.T) {
			name := strings.SplitN(filepath.Base(path), ".", 2)[0]
			sch, err := c.Compile(schemaBase + "rest.json#/$defs/" + name)
			if err != nil {
				t.Fatal(err)
			}
			if err := sch.Validate(readJSON(t, path)); err != nil {
				t.Fatalf("strict schema rejects a valid fixture: %v", err)
			}
			body := NewRestBody(name)
			if body == nil {
				t.Fatalf("no generated REST body %s", name)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.DisallowUnknownFields()
			if err := dec.Decode(body); err != nil {
				t.Fatalf("fixture has fields the Go type lacks: %v", err)
			}
			out, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := semantic(t, out), semantic(t, data); !reflect.DeepEqual(got, want) {
				t.Fatalf("round trip changed the body\n got: %s\nwant: %s", out, data)
			}
		})
	}
}
