package native

import (
	"context"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var oldRelease = Version{"0.0.9", "1", "18"}
var newRelease = Version{"0.1.0", "2", "18"}

func put(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestStartVersion(t *testing.T) {
	for _, name := range []string{"first boot", "matching restart", "version", "schema", "postgres", "marker", "unversioned", "malformed"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			state := oldRelease
			switch name {
			case "version":
				state.Version = "other"
			case "schema":
				state.Schema = "2"
			case "postgres":
				state.Postgres = "17"
			}
			if name != "first boot" && name != "unversioned" {
				if err := WriteVersion(root, state); err != nil {
					t.Fatal(err)
				}
			}
			if name == "marker" {
				put(t, filepath.Join(root, ".upgrade-incomplete"), "/backup with spaces\n")
			}
			if name == "unversioned" {
				put(t, filepath.Join(root, "proof"), "data")
			}
			if name == "malformed" {
				put(t, filepath.Join(root, "version.env"), "SMITHERS_SCHEMA_VERSION=$(false)\n")
			}
			err := EnsureVersion(root, oldRelease)
			if name == "first boot" || name == "unversioned" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(root, "version.env")); !os.IsNotExist(err) {
					t.Fatal("preflight adopted state before database check")
				}
				return
			}
			if name == "matching restart" {
				if err != nil {
					t.Fatal(err)
				}
				got, err := ReadVersion(filepath.Join(root, "version.env"))
				if err != nil || got != oldRelease {
					t.Fatalf("%+v %v", got, err)
				}
				return
			}
			if err == nil {
				t.Fatal("unsafe start accepted")
			}
			if name == "marker" {
				var guard *GuardError
				if !errors.As(err, &guard) || !strings.Contains(err.Error(), "smthrs host restore '/backup with spaces'") {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestIncompleteUpgradeRefusesOperations(t *testing.T) {
	for _, operation := range []string{"start", "backup", "upgrade"} {
		t.Run(operation, func(t *testing.T) {
			root := t.TempDir()
			put(t, filepath.Join(root, ".upgrade-incomplete"), "verified-backup")
			if err := WriteVersion(root, oldRelease); err != nil {
				t.Fatal(err)
			}
			var err error
			switch operation {
			case "start":
				err = EnsureVersion(root, oldRelease)
			case "backup":
				err = VerifyVersion(root, oldRelease)
			case "upgrade":
				err = Upgrade(context.Background(), root, "missing-backup", newRelease, nil)
			}
			if err == nil || !strings.Contains(err.Error(), "upgrade incomplete") || !strings.Contains(err.Error(), "smthrs host restore verified-backup") {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(filepath.Join(root, ".upgrade-incomplete"))
			if string(got) != "verified-backup" {
				t.Fatal("marker changed")
			}
		})
	}
}
func TestUpgradeGuards(t *testing.T) {
	for _, name := range []string{"downgrade", "postgres", "same", "backup mismatch", "numeric", "unavailable"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := WriteVersion(root, oldRelease); err != nil {
				t.Fatal(err)
			}
			backup := backupFixture(t, oldRelease)
			release := newRelease
			switch name {
			case "downgrade":
				release.Schema = "0"
			case "postgres":
				release.Postgres = "19"
			case "same":
				release = oldRelease
			case "backup mismatch":
				backup = backupFixture(t, newRelease)
			case "numeric":
				release.Schema = "x"
			}
			called := false
			var steps *UpgradeSteps
			if name != "unavailable" {
				steps = &UpgradeSteps{Migrate: func(context.Context) error { called = true; return nil }}
			}
			if err := Upgrade(context.Background(), root, backup, release, steps); err == nil {
				t.Fatal("unsafe upgrade accepted")
			}
			if called {
				t.Fatal("migration executed")
			}
			if _, err := os.Stat(filepath.Join(root, ".upgrade-incomplete")); !os.IsNotExist(err) {
				t.Fatal("guard wrote marker")
			}
		})
	}
}
func TestNativeRunGuardsBeforePostgres(t *testing.T) {
	head, err := product.HeadVersion()
	if err != nil {
		t.Fatal(err)
	}
	release := Version{compose.BuildVersion, fmt.Sprint(head), "18"}
	for _, name := range []string{"first boot", "matching restart", "version", "schema", "postgres", "marker", "bundle manifest"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			cfg := Config{Postgres: postgres.Config{StateDir: filepath.Join(root, "postgres"), BinDir: filepath.Join(root, "missing-tools"), Major: 18}}
			state := release
			switch name {
			case "version":
				state.Version = "other"
			case "schema":
				state.Schema = fmt.Sprint(head + 1)
			case "postgres":
				state.Postgres = "17"
			case "bundle manifest":
				cfg.Release = release
			}
			if name != "first boot" && name != "bundle manifest" {
				if err := WriteVersion(root, state); err != nil {
					t.Fatal(err)
				}
			}
			if name == "marker" {
				put(t, filepath.Join(root, ".upgrade-incomplete"), "verified-backup")
			}
			err := Run(context.Background(), cfg)
			if err == nil {
				t.Fatal("missing PostgreSQL tools accepted")
			}
			reached := name == "first boot" || name == "matching restart" || name == "bundle manifest" || name == "version"
			if strings.Contains(err.Error(), "start owned postgres") != reached {
				t.Fatal(err)
			}
			if name == "marker" && !strings.Contains(err.Error(), "smthrs host restore verified-backup") {
				t.Fatal(err)
			}
			if name == "first boot" || name == "bundle manifest" {
				if _, err := os.Stat(filepath.Join(root, "version.env")); !os.IsNotExist(err) {
					t.Fatal("failed startup published version")
				}
			}
		})
	}
}

func TestStartVersionOrdering(t *testing.T) {
	for _, tc := range []struct {
		state, binary string
		refuse        bool
	}{
		{"1.9.9", "1.10.0", false}, {"1.10.0", "1.9.9", true},
		{"2.0.0", "1.99.99", true}, {"1.2.4", "1.2.3", true},
		{"1.2.3", "1.2.4", false}, {"1.2.3", "1.2.3", false},
		{"dev", "1.0.0", false}, {"1.0.0", "dev", false},
		{"invalid", "1.0.0", true}, {"1.0.0", "1.x.0", true},
		{"18446744073709551616.0.0", "1.0.0", true},
	} {
		t.Run(tc.state+"/"+tc.binary, func(t *testing.T) {
			err := matchVersion(Version{tc.state, "1", "18"}, Version{tc.binary, "2", "18"})
			if (err != nil) != tc.refuse {
				t.Fatalf("refuse=%v: %v", tc.refuse, err)
			}
			if err != nil && strings.Contains(err.Error(), "newer") && !strings.Contains(err.Error(), "smthrs host restore '<backup>'") {
				t.Fatal(err)
			}
		})
	}
}

func TestDevStartRetainsStorageGuards(t *testing.T) {
	for _, tc := range []struct{ state, binary Version }{
		{Version{"dev", "3", "18"}, Version{"1.0.0", "2", "18"}},
		{Version{"1.0.0", "3", "18"}, Version{"dev", "2", "18"}},
		{Version{"dev", "1", "17"}, Version{"1.0.0", "2", "18"}},
		{Version{"1.0.0", "1", "17"}, Version{"dev", "2", "18"}},
		{Version{"dev", "x", "18"}, Version{"dev", "2", "18"}},
		{Version{"dev", "1", "18"}, Version{"dev", "x", "18"}},
	} {
		if err := matchVersion(tc.state, tc.binary); err == nil {
			t.Fatalf("unsafe dev start: %+v -> %+v", tc.state, tc.binary)
		}
	}
}
