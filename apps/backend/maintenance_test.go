package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func maintenanceSnapshot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "1.2.3-20261003T220000.000000000Z")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte("captured database bytes")
	if err := os.WriteFile(filepath.Join(dir, "postgres.dump"), data, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	// Literal external format; no manifest writer or policy constants as oracle.
	manifest := map[string]any{
		"version": "1.2.3", "schema_version": 1, "postgres_major": 18,
		"quiesce_op": "backup-1", "quiesce_time": "2026-10-03T22:00:00Z",
		"files": []any{map[string]any{"path": "postgres.dump", "size": len(data), "sha256": hex.EncodeToString(sum[:])}},
		"stack": []any{}, "branch_heads": map[string]any{}, "machine_disks": []any{}, "run_journals": []any{},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "MANIFEST.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestHostMaintenanceUnavailableProvidersFailClosed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("maintenance intentionally refuses root")
	}
	dir := maintenanceSnapshot(t)
	state := t.TempDir()
	sentinel := filepath.Join(state, "version.env")
	if err := os.WriteFile(sentinel, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_DATA_ROOT", state)
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "invalid-must-never-bootstrap")
	for _, args := range [][]string{{"backup"}, {"upgrade"}, {"restore", dir}} {
		t.Run(args[0], func(t *testing.T) {
			err := run(context.Background(), append([]string{"host-maintenance"}, args...))
			if err == nil || !strings.HasPrefix(err.Error(), "host_maintenance_unavailable:") {
				t.Fatalf("refusal: %v", err)
			}
			entries, err := os.ReadDir(state)
			if err != nil || len(entries) != 1 {
				t.Fatalf("state mutated: %v %v", entries, err)
			}
			raw, err := os.ReadFile(sentinel)
			if err != nil || string(raw) != "unchanged" {
				t.Fatalf("sentinel changed: %q %v", raw, err)
			}
		})
	}
}

func TestHostRestorePathConfinement(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("maintenance intentionally refuses root")
	}
	for _, path := range []string{"/outside", "../outside", "trees/../../outside"} {
		t.Run(path, func(t *testing.T) {
			dir := maintenanceSnapshot(t)
			manifestPath := filepath.Join(dir, "MANIFEST.json")
			raw, err := os.ReadFile(manifestPath)
			if err != nil {
				t.Fatal(err)
			}
			raw = []byte(strings.Replace(string(raw), `"path":"postgres.dump"`, `"path":"`+path+`"`, 1))
			if err := os.WriteFile(manifestPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			err = run(context.Background(), []string{"host-maintenance", "restore", dir})
			if err == nil || !strings.HasPrefix(err.Error(), "unsafe_path:") {
				t.Fatalf("refusal: %v", err)
			}
			got, err := os.ReadFile(filepath.Join(dir, "postgres.dump"))
			if err != nil || string(got) != "captured database bytes" {
				t.Fatalf("dump changed: %q %v", got, err)
			}
		})
	}
	t.Run("escaping symlink", func(t *testing.T) {
		dir := maintenanceSnapshot(t)
		outside := filepath.Join(t.TempDir(), "sentinel")
		if err := os.WriteFile(outside, []byte("outside bytes"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dir, "postgres.dump")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(dir, "postgres.dump")); err != nil {
			t.Fatal(err)
		}
		err := run(context.Background(), []string{"host-maintenance", "restore", dir})
		if err == nil || !strings.HasPrefix(err.Error(), "unsafe_path:") {
			t.Fatalf("refusal: %v", err)
		}
		got, err := os.ReadFile(outside)
		if err != nil || string(got) != "outside bytes" {
			t.Fatalf("outside changed: %q %v", got, err)
		}
		info, err := os.Stat(outside)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("outside mode changed: %v %v", info, err)
		}
	})
}

// Exercise corruption through the backend entry point, before it can select
// an isolation runtime or touch the live state. Expected hashes come from
// bytes seeded before the operation, independently of the manifest writer.
func TestHostRestoreCorruptBackupLeavesStateUntouched(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("maintenance intentionally refuses root")
	}
	for _, fixture := range []struct{ name, code string }{
		{"missing manifest", "missing_file:"},
		{"missing dump", "missing_dump:"},
		{"changed dump", "hash_mismatch:"},
		{"extra file", "extra_file:"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			dir := maintenanceSnapshot(t)
			state := t.TempDir()
			sentinel := filepath.Join(state, "live-data")
			if err := os.WriteFile(sentinel, []byte("live database unchanged"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SMITHERS_DATA_ROOT", state)
			t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "invalid-must-never-bootstrap")
			var err error
			switch fixture.name {
			case "missing manifest":
				err = os.Remove(filepath.Join(dir, "MANIFEST.json"))
			case "missing dump":
				err = os.Remove(filepath.Join(dir, "postgres.dump"))
			case "changed dump":
				err = os.WriteFile(filepath.Join(dir, "postgres.dump"), []byte("tampered database bytes"), 0600)
			case "extra file":
				err = os.WriteFile(filepath.Join(dir, "unrecorded"), []byte("extra"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			err = run(t.Context(), []string{"host-maintenance", "restore", dir})
			if err == nil || !strings.HasPrefix(err.Error(), fixture.code) {
				t.Fatalf("expected %s, got %v", fixture.code, err)
			}
			data, err := os.ReadFile(sentinel)
			if err != nil || string(data) != "live database unchanged" {
				t.Fatalf("live data changed: %q %v", data, err)
			}
			info, err := os.Stat(sentinel)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("live data mode changed: %v %v", info, err)
			}
			entries, err := os.ReadDir(state)
			if err != nil || len(entries) != 1 {
				t.Fatalf("live state mutated: %v %v", entries, err)
			}
		})
	}
}

func TestHostRestoreReplacedDirectoryRefusesBeforeMutation(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("maintenance intentionally refuses root")
	}
	for _, name := range []string{"backup root", "payload ancestor", "manifest link"} {
		t.Run(name, func(t *testing.T) {
			dir := maintenanceSnapshot(t)
			state := t.TempDir()
			live := filepath.Join(state, "live-data")
			if err := os.WriteFile(live, []byte("live bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SMITHERS_DATA_ROOT", state)
			t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "invalid-must-never-bootstrap")
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "sentinel")
			if err := os.WriteFile(sentinel, []byte("outside bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "backup root":
				moved := filepath.Join(outside, filepath.Base(dir))
				if err := os.Rename(dir, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, dir); err != nil {
					t.Fatal(err)
				}
			case "payload ancestor":
				if err := os.Symlink(outside, filepath.Join(dir, "trees")); err != nil {
					t.Fatal(err)
				}
			case "manifest link":
				moved := filepath.Join(outside, "MANIFEST.json")
				if err := os.Rename(filepath.Join(dir, "MANIFEST.json"), moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, filepath.Join(dir, "MANIFEST.json")); err != nil {
					t.Fatal(err)
				}
			}
			err := run(t.Context(), []string{"host-maintenance", "restore", dir})
			if err == nil || !strings.HasPrefix(err.Error(), "unsafe_path:") {
				t.Fatalf("refusal: %v", err)
			}
			for path, expected := range map[string]string{live: "live bytes", sentinel: "outside bytes"} {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != expected {
					t.Fatalf("changed %s: %q %v", path, data, err)
				}
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Fatalf("mode changed %s: %v %v", path, info, err)
				}
			}
			entries, err := os.ReadDir(state)
			if err != nil || len(entries) != 1 {
				t.Fatalf("live tree changed: %v %v", entries, err)
			}
		})
	}
}
