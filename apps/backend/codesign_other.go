//go:build !darwin

package main

import (
	"errors"
	"runtime"
)

// processCodeSigningFlags has no source off macOS: the installed bundle is
// darwin-arm64 only.
func processCodeSigningFlags() (uint32, error) {
	return 0, errors.New("code-signing flags are unavailable on " + runtime.GOOS)
}
