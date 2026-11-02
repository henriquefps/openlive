// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/thumbnail"
)

func TestPutThumbnail(t *testing.T) {
	var got struct {
		method, path, auth, ctype, kind string
		body                            []byte
	}
	status := http.StatusNoContent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path = r.Method, r.URL.Path
		got.auth, got.ctype = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		got.kind = r.Header.Get("X-Openlive-Thumbnail")
		got.body, _ = io.ReadAll(r.Body)
		if status != http.StatusNoContent {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"code":"stream_paused","streamId":"st_1"}`))
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL, "tok", "test")
	if err != nil {
		t.Fatal(err)
	}
	img := []byte{0xff, 0xd8, 0xff, 1, 2}
	if err := c.PutThumbnail(context.Background(), "r_1", "st_1", img, false); err != nil {
		t.Fatal(err)
	}
	if got.method != "PUT" || got.path != "/api/rtc/rooms/r_1/streams/st_1/thumbnail" ||
		got.auth != "Bearer tok" || got.ctype != "image/jpeg" || got.kind != "" || string(got.body) != string(img) {
		t.Fatalf("request: %+v", got)
	}
	if err := c.PutThumbnail(context.Background(), "r_1", "st_1", img, true); err != nil || got.kind != "paused" {
		t.Fatalf("placeholder: %v, header %q", err, got.kind)
	}

	status = http.StatusConflict
	err = c.PutThumbnail(context.Background(), "r_1", "st_1", img, false)
	if !errors.Is(err, thumbnail.ErrRefused) || ErrorCode(err) != "stream_paused" {
		t.Fatalf("409: %v", err)
	}
	status = http.StatusTooManyRequests
	if err := c.PutThumbnail(context.Background(), "r_1", "st_1", img, false); err == nil || errors.Is(err, thumbnail.ErrRefused) {
		t.Fatalf("429 must be retryable: %v", err)
	}
}
