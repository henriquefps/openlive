// SPDX-License-Identifier: AGPL-3.0-only

package compositor

import "testing"

// The shape of `kscreen-doctor -j` (Plasma 6.5), trimmed: a disabled TV and a 175 Hz monitor.
const kscreenJSON = `{"outputs":[
 {"name":"HDMI-A-1","enabled":false,"currentModeId":"1","modes":[{"id":"1","refreshRate":60,"size":{"width":3840,"height":2160}}]},
 {"name":"DP-2","enabled":true,"currentModeId":"37","modes":[
  {"id":"36","refreshRate":59.97,"size":{"width":3440,"height":1440}},
  {"id":"37","refreshRate":174.96200561523438,"size":{"width":3440,"height":1440}}]},
 {"name":"DP-3","enabled":true,"currentModeId":"9","modes":[{"id":"9","refreshRate":59.94}]}]}`

func TestParseKScreen(t *testing.T) {
	rates, err := parseKScreen([]byte(kscreenJSON))
	if err != nil {
		t.Fatal(err)
	}
	if len(rates) != 2 || rates["DP-2"] < 174.9 || rates["DP-2"] > 175 || rates["DP-3"] != 59.94 {
		t.Fatalf("rates %v, want DP-2 ≈ 175 and DP-3 59.94 (the disabled output left out)", rates)
	}
	if _, err := parseKScreen([]byte("not json")); err == nil {
		t.Fatal("garbage parsed")
	}
}
