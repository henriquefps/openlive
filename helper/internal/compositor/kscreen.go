// SPDX-License-Identifier: AGPL-3.0-only

package compositor

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"
)

// RefreshRates reads each enabled output's refresh rate in Hz, by name, from KScreen
// (`kscreen-doctor -j`, Plasma). KWin's scripting API does not expose it. Elsewhere, or
// inside a sandbox without kscreen-doctor, it returns an error and the helper captures at
// the preset's rate.
func RefreshRates(ctx context.Context) (map[string]float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "kscreen-doctor", "-j").Output()
	if err != nil {
		return nil, err
	}
	return parseKScreen(out)
}

// parseKScreen reads the current mode's refresh rate of every enabled output.
func parseKScreen(raw []byte) (map[string]float64, error) {
	var doc struct {
		Outputs []struct {
			Name          string `json:"name"`
			Enabled       bool   `json:"enabled"`
			CurrentModeID string `json:"currentModeId"`
			Modes         []struct {
				ID          string  `json:"id"`
				RefreshRate float64 `json:"refreshRate"`
			} `json:"modes"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	rates := map[string]float64{}
	for _, o := range doc.Outputs {
		if !o.Enabled {
			continue
		}
		for _, m := range o.Modes {
			if m.ID == o.CurrentModeID && m.RefreshRate > 0 {
				rates[o.Name] = m.RefreshRate
			}
		}
	}
	return rates, nil
}
