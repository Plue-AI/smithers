package hostbackup

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (string, Manifest) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), ".partial-1")
	must(t, os.Mkdir(dir, 0700))
	must(t, os.WriteFile(filepath.Join(dir, "postgres.dump"), []byte("dump"), 0600))
	must(t, os.Mkdir(filepath.Join(dir, "trees"), 0700))
	must(t, os.WriteFile(filepath.Join(dir, "trees", "disk"), []byte("disk"), 0600))
	return dir, Manifest{Version: "1.2.3", SchemaVersion: 2, PostgresMajor: 18, QuiesceOp: "backup-1", QuiesceTime: time.Date(2026, 10, 3, 22, 0, 0, 0, time.UTC), Stack: json.RawMessage(`[{"number":1}]`)}
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func completed(t *testing.T) string {
	t.Helper()
	dir, m := fixture(t)
	must(t, WriteManifest(dir, m))
	return filepath.Join(filepath.Dir(dir), backupName(m))
}
func installed() Version { return Version{Release: "1.2.3", Schema: 2, PostgresMajor: 18} }
func requireCode(t *testing.T, err error, code Code) {
	t.Helper()
	var refusal *Error
	if !errors.As(err, &refusal) || refusal.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func editManifest(t *testing.T, dir string, edit func(*Manifest)) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	must(t, err)
	var m Manifest
	must(t, json.Unmarshal(b, &m))
	edit(&m)
	b, err = json.Marshal(m)
	must(t, err)
	must(t, os.WriteFile(filepath.Join(dir, "MANIFEST.json"), b, 0600))
}
func TestRoundTrip(t *testing.T) {
	dir := completed(t)
	must(t, VerifyManifest(dir, installed()))
	info, err := os.Stat(dir)
	must(t, err)
	if info.Mode().Perm() != 0700 {
		t.Fatal(info.Mode())
	}
	v := installed()
	v.Release = "1.10.0"
	must(t, VerifyManifest(dir, v))
}
func TestNoAbsolutePaths(t *testing.T) {
	dir := completed(t)
	b, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	must(t, err)
	if strings.Contains(string(b), filepath.Dir(dir)) {
		t.Fatal("absolute path recorded")
	}
	var m Manifest
	must(t, json.Unmarshal(b, &m))
	var stack []map[string]int
	must(t, json.Unmarshal(m.Stack, &stack))
	if len(m.Files) != 2 || len(stack) != 1 || stack[0]["number"] != 1 {
		t.Fatal(m)
	}
	for _, f := range m.Files {
		if filepath.IsAbs(f.Path) {
			t.Fatal(f.Path)
		}
	}
}
func TestRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		code   Code
		mutate func(*testing.T, string, *Version)
	}{
		{"wrong-version", WrongVersion, func(t *testing.T, d string, v *Version) {
			editManifest(t, d, func(m *Manifest) { m.Version = "garbage" })
		}},
		{"older-installed", OlderVersion, func(t *testing.T, d string, v *Version) { v.Release = "1.2.2" }},
		{"missing-dump", MissingDump, func(t *testing.T, d string, v *Version) { must(t, os.Remove(filepath.Join(d, "postgres.dump"))) }},
		{"tamper-byte", HashMismatch, func(t *testing.T, d string, v *Version) {
			must(t, os.WriteFile(filepath.Join(d, "trees", "disk"), []byte("risk"), 0600))
		}},
		{"missing-file", MissingFile, func(t *testing.T, d string, v *Version) { must(t, os.Remove(filepath.Join(d, "trees", "disk"))) }},
		{"extra-file", ExtraFile, func(t *testing.T, d string, v *Version) { must(t, os.WriteFile(filepath.Join(d, "extra"), nil, 0600)) }},
		{"newer-schema", NewerSchema, func(t *testing.T, d string, v *Version) { v.Schema = 1 }},
		{"absolute-path", UnsafePath, func(t *testing.T, d string, v *Version) {
			editManifest(t, d, func(m *Manifest) { m.Files[0].Path = "/etc/passwd" })
		}},
		{"traversal", UnsafePath, func(t *testing.T, d string, v *Version) {
			editManifest(t, d, func(m *Manifest) { m.Files[0].Path = "../outside" })
		}},
		{"symlink", UnsafePath, func(t *testing.T, d string, v *Version) {
			must(t, os.Remove(filepath.Join(d, "trees", "disk")))
			must(t, os.Symlink("/etc/passwd", filepath.Join(d, "trees", "disk")))
		}},
		{"postgres-major", WrongVersion, func(t *testing.T, d string, v *Version) { v.PostgresMajor = 17 }},
		{"size", HashMismatch, func(t *testing.T, d string, v *Version) { editManifest(t, d, func(m *Manifest) { m.Files[0].Size++ }) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := completed(t)
			v := installed()
			tc.mutate(t, d, &v)
			requireCode(t, VerifyManifest(d, v), tc.code)
		})
	}
}
func TestPartialRefused(t *testing.T) {
	d, _ := fixture(t)
	requireCode(t, VerifyManifest(d, installed()), Partial)
}
func TestRetention(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		d, m := fixture(t)
		m.QuiesceTime = m.QuiesceTime.Add(time.Duration(i) * time.Second)
		must(t, WriteManifest(d, m))
		must(t, os.Rename(filepath.Join(filepath.Dir(d), backupName(m)), filepath.Join(root, backupName(m))))
	}
	for _, name := range []string{"pre-restore-1", ".partial-live", "unrelated"} {
		must(t, os.Mkdir(filepath.Join(root, name), 0700))
	}
	must(t, Prune(root, 3))
	entries, err := os.ReadDir(root)
	must(t, err)
	if len(entries) != 6 {
		t.Fatal(entries)
	}
	for i := 0; i < 5; i++ {
		m := Manifest{Version: "1.2.3", QuiesceTime: time.Date(2026, 10, 3, 22, 0, i, 0, time.UTC)}
		_, err := os.Stat(filepath.Join(root, backupName(m)))
		if (err == nil) != (i >= 2) {
			t.Fatalf("backup %d: %v", i, err)
		}
	}
}
func TestSpaceAndCloneFailClosed(t *testing.T) {
	requireCode(t, CheckFreeSpace(t.TempDir(), ^uint64(0), FreeSpaceFloor), InsufficientSpace)
	must(t, CheckFreeSpace(t.TempDir(), 0, 0))
	var c Cloner = RefusingCloner{}
	requireCode(t, c.Clone("a", "b"), CloneUnavailable)
}

func TestOpaqueSummaryRefusesAbsolutePath(t *testing.T) {
	d, m := fixture(t)
	m.MachineDisks = json.RawMessage(`{"disk":"/private/state/disk"}`)
	requireCode(t, WriteManifest(d, m), UnsafePath)
}

func TestRetentionCountsDamagedBackups(t *testing.T) {
	for _, damage := range []string{"tampered", "unreadable"} {
		t.Run(damage, func(t *testing.T) {
			root := t.TempDir()
			var paths []string
			for i := 0; i < 4; i++ {
				d, m := fixture(t)
				m.QuiesceTime = m.QuiesceTime.Add(time.Duration(i) * time.Second)
				must(t, WriteManifest(d, m))
				path := filepath.Join(root, backupName(m))
				must(t, os.Rename(filepath.Join(filepath.Dir(d), backupName(m)), path))
				paths = append(paths, path)
			}
			disk := filepath.Join(paths[0], "trees", "disk")
			if damage == "tampered" {
				must(t, os.WriteFile(disk, []byte("risk"), 0600))
			} else {
				must(t, os.Chmod(disk, 0000))
				f, err := os.Open(disk)
				if err == nil {
					f.Close()
					t.Fatal("test requires a host where mode 0000 prevents reading")
				}
			}
			must(t, Prune(root, 3))
			for i, path := range paths {
				_, err := os.Stat(path)
				if i == 0 {
					if !os.IsNotExist(err) {
						t.Fatalf("old damaged backup remains: %v", err)
					}
				} else {
					must(t, err)
				}
			}
		})
	}
}

func TestNegativeRetention(t *testing.T) {
	root := t.TempDir()
	err := Prune(root, -1)
	var refusal *Error
	if err == nil || (errors.As(err, &refusal) && refusal.Code == WrongVersion) {
		t.Fatalf("negative retention needs its own error, got %v", err)
	}
}
