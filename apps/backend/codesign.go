package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/installbundle"
)

// codeSigningRuntime is the kernel's CS_RUNTIME flag: the process runs with
// the hardened runtime, so the dynamic loader ignores DYLD_* variables and
// loads no library the process did not ask for.
const codeSigningRuntime = 0x10000

// codeSigningFlags answers the running backend's code-signing flags; tests
// that stand in for an assembled backend replace it.
var codeSigningFlags = processCodeSigningFlags

// requireHardenedRuntime refuses a backend that runs without the hardened
// runtime, or whose bundle manifest does not record it for the backend
// (spec §17.3, ruling (a)): without it a variable the environment sets
// inserts code before main runs, where no check of the backend's can see it.
func requireHardenedRuntime(bundle *installbundle.Bundle) error {
	flags, err := codeSigningFlags()
	if err != nil {
		return fmt.Errorf("%w: read the backend's code-signing flags: %v", installbundle.ErrUnapproved, err)
	}
	if flags&codeSigningRuntime == 0 {
		return fmt.Errorf("%w: the backend runs without the hardened runtime (code-signing flags %#x)", installbundle.ErrUnapproved, flags)
	}
	if bundle != nil {
		entry, _ := bundle.Entry(installbundle.BackendPath)
		if !slices.Contains(strings.Split(entry.CodeSignature, ","), "runtime") {
			return fmt.Errorf("%w: the bundle manifest records no hardened runtime for %s (codeSignature %q)", installbundle.ErrUnapproved, installbundle.BackendPath, entry.CodeSignature)
		}
	}
	return nil
}
