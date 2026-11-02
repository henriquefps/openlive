// SPDX-License-Identifier: AGPL-3.0-only

//go:build !unix

package single

import "os"

// Windows and the rest: no lock yet (the Windows backend comes last).
func tryLock(*os.File) error { return nil }

func unlock(*os.File) error { return nil }
