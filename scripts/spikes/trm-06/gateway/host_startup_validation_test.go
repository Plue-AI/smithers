package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestHostStartupCheckoutRefusesAndRetainsEvidence(t *testing.T) {
	entry, err := filepath.Abs("../run.sh")
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"positive", "all"}
	for name := range startupEnvironmentPoisons {
		names = append(names, name)
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := hostStartupControl(ctx, entry, strings.Repeat("a", 40), directory, name); err == nil {
				t.Fatal("checkout entry supplied installed startup evidence")
			}
			stderr, err := os.ReadFile(filepath.Join(directory, "stderr.raw"))
			if err != nil || !strings.Contains(string(stderr), "prototype_authority_unavailable") {
				t.Fatalf("refusal evidence missing: %s %v", stderr, err)
			}
			stdout, err := os.ReadFile(filepath.Join(directory, "startup.raw"))
			if err != nil || len(stdout) != 0 {
				t.Fatalf("checkout produced startup evidence: %s %v", stdout, err)
			}
			if _, err = os.Stat(filepath.Join(directory, "process.raw")); !os.IsNotExist(err) {
				t.Fatal("unstarted gateway supplied process observation")
			}
		})
	}
}

// Executes the same production shell/authority/OS-sampling path as check-install.
// An installed approved native bundle is required; Linux fixture receipts do
// not enable it or supply a replacement signer, executable or authority flag.
func TestInstalledHostStartupEnvironmentBoundary(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("approved Apple Silicon install required")
	}
	path := "/usr/local/lib/smithers/current/bin/trm06-gateway"
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Skip("main-pinned installed gateway unavailable")
	}
	authority, err := loadInstalledAuthority(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := validateInstalledHostStartup(ctx, authority, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

func TestHostStartupUnknownPoisonRefusesBeforeLaunch(t *testing.T) {
	directory := t.TempDir()
	if err := hostStartupControl(context.Background(), "/missing", strings.Repeat("a", 40), directory, "member-selected"); err == nil {
		t.Fatal("unknown selector accepted")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("unknown selector reached execution: %v %v", entries, err)
	}
}
