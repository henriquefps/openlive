// SPDX-License-Identifier: AGPL-3.0-only

//go:build !unix

package main

import "time"

// processCPUTime is not measured on this system yet: helper.stats leaves cpuPct out.
func processCPUTime() (time.Duration, bool) { return 0, false }
