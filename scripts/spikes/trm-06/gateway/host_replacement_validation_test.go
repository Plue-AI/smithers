package main

import (
	"context"
	"os"
	"runtime"
	"testing"
	"time"
)

// Actual installed authority, pinned harness and protected native receipt.
// Missing Apple Silicon or an approved installation is pending evidence.
func TestInstalledHostReplacementBoundary(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("approved native fixture and installed bundle required")
	}
	path := "/usr/local/lib/smithers/current/bin/trm06-gateway"
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Skip("main-pinned gateway unavailable")
	}
	authority, err := loadInstalledAuthority(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := validateInstalledHostReplacements(ctx, authority, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
