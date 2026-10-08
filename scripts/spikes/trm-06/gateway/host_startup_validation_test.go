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

func TestHostStartupRealCanariesThroughCheckoutBoundary(t *testing.T) {
	// Exercise real import/library/shell controls, then the production entry.
	// This is refusal evidence; an approved native install supplies the positive
	// gateway control in TestInstalledHostStartupEnvironmentBoundary.
	directory := filepath.Join(t.TempDir(), "apostrophe'quote")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	canaries, err := prepareHostStartupCanaries(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"import-positive", "shell-positive", "library-positive"} {
		body, err := os.ReadFile(filepath.Join(directory, "host-startup-canaries", name+".marker"))
		if err != nil || string(body) != "canary" {
			t.Fatalf("%s: %q %v", name, body, err)
		}
	}
	entry, err := filepath.Abs("../run.sh")
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"all"}
	for name := range canaries.environment {
		names = append(names, name)
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			evidence := t.TempDir()
			if err := hostStartupControlWithEnvironment(ctx, entry, strings.Repeat("a", 40), evidence, name, canaries.environment); err == nil {
				t.Fatal("checkout accepted")
			}
			// Linux loads LD_PRELOAD before the shell can sanitize its environment.
			// Retain this observable platform limit; only the native Mac path
			// is eligible for installed startup acceptance.
			if runtime.GOOS == "linux" && (name == "LD_PRELOAD" || name == "all") {
				body, err := os.ReadFile(canaries.marker)
				if err != nil || string(body) != "canary" {
					t.Fatalf("Linux loader control: %q %v", body, err)
				}
				if err := os.Remove(canaries.marker); err != nil {
					t.Fatal(err)
				}
			} else if err := canaries.unchanged(); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(evidence, "stderr.raw"))
			if err != nil || !strings.Contains(string(raw), "prototype_authority_unavailable") {
				t.Fatalf("missing refusal: %q %v", raw, err)
			}
		})
	}
	if err := os.WriteFile(canaries.marker, []byte("canary"), 0600); err != nil {
		t.Fatal(err)
	}
	if canaries.unchanged() == nil {
		t.Fatal("executed canary accepted")
	}
	if err := os.Remove(canaries.marker); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/missing", canaries.marker); err != nil {
		t.Fatal(err)
	}
	if canaries.unchanged() == nil {
		t.Fatal("replaced sentinel accepted")
	}
}

func TestHostStartupCanaryPreparationCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	directory := t.TempDir()
	if _, err := prepareHostStartupCanaries(ctx, directory); err == nil {
		t.Fatal("cancelled preparation passed")
	}
	if _, err := os.Stat(filepath.Join(directory, "host-startup-canaries", "compile-library.raw")); err != nil {
		t.Fatal("failed compiler evidence missing", err)
	}
}
