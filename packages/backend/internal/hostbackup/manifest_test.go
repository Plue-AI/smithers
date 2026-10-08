package hostbackup

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

var fixtureBackupNames = []string{
	"1.2.3-20261003T220000.000000000Z",
	"1.2.3-20261003T220001.000000000Z",
	"1.2.3-20261003T220002.000000000Z",
	"1.2.3-20261003T220003.000000000Z",
	"1.2.3-20261003T220004.000000000Z",
}

func fixture(t *testing.T) (string, Manifest) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), ".partial-1")
	must(t, os.Mkdir(dir, 0700))
	must(t, os.WriteFile(filepath.Join(dir, "postgres.dump"), []byte("dump"), 0600))
	must(t, os.Mkdir(filepath.Join(dir, "trees"), 0700))
	must(t, os.WriteFile(filepath.Join(dir, "trees", "disk"), []byte("disk"), 0600))
	return dir, Manifest{Version: "1.2.3", SchemaVersion: 2, PostgresMajor: 18, QuiesceOp: "backup-1", QuiesceTime: time.Date(2026, 10, 3, 22, 0, 0, 0, time.UTC), Stack: json.RawMessage(`[{"number":1}]`), BranchHeads: json.RawMessage(`{}`), MachineDisks: json.RawMessage(`[]`), RunJournals: json.RawMessage(`[]`)}
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
	return filepath.Join(filepath.Dir(dir), "1.2.3-20261003T220000.000000000Z")
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
		{"wrong-version", Code("wrong_version"), func(t *testing.T, d string, v *Version) {
			editManifest(t, d, func(m *Manifest) { m.Version = "garbage" })
		}},
		{"older-installed", Code("older_version"), func(t *testing.T, d string, v *Version) { v.Release = "1.2.2" }},
		{"missing-dump", Code("missing_dump"), func(t *testing.T, d string, v *Version) { must(t, os.Remove(filepath.Join(d, "postgres.dump"))) }},
		{"tamper-byte", Code("hash_mismatch"), func(t *testing.T, d string, v *Version) {
			must(t, os.WriteFile(filepath.Join(d, "trees", "disk"), []byte("risk"), 0600))
		}},
		{"missing-file", Code("missing_file"), func(t *testing.T, d string, v *Version) { must(t, os.Remove(filepath.Join(d, "trees", "disk"))) }},
		{"extra-file", Code("extra_file"), func(t *testing.T, d string, v *Version) { must(t, os.WriteFile(filepath.Join(d, "extra"), nil, 0600)) }},
		{"newer-schema", Code("newer_schema"), func(t *testing.T, d string, v *Version) { v.Schema = 1 }},
		{"absolute-path", Code("unsafe_path"), func(t *testing.T, d string, v *Version) {
			editManifest(t, d, func(m *Manifest) { m.Files[0].Path = "/etc/passwd" })
		}},
		{"traversal", Code("unsafe_path"), func(t *testing.T, d string, v *Version) {
			editManifest(t, d, func(m *Manifest) { m.Files[0].Path = "../outside" })
		}},
		{"symlink", Code("unsafe_path"), func(t *testing.T, d string, v *Version) {
			must(t, os.Remove(filepath.Join(d, "trees", "disk")))
			must(t, os.Symlink("/etc/passwd", filepath.Join(d, "trees", "disk")))
		}},
		{"postgres-major", Code("wrong_version"), func(t *testing.T, d string, v *Version) { v.PostgresMajor = 17 }},
		{"size", Code("hash_mismatch"), func(t *testing.T, d string, v *Version) { editManifest(t, d, func(m *Manifest) { m.Files[0].Size++ }) }},
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
	requireCode(t, VerifyManifest(d, installed()), Code("partial"))
}
func TestRetention(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		d, m := fixture(t)
		m.QuiesceTime = m.QuiesceTime.Add(time.Duration(i) * time.Second)
		must(t, WriteManifest(d, m))
		must(t, os.Rename(filepath.Join(filepath.Dir(d), fixtureBackupNames[i]), filepath.Join(root, fixtureBackupNames[i])))
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
		_, err := os.Stat(filepath.Join(root, fixtureBackupNames[i]))
		if (err == nil) != (i >= 2) {
			t.Fatalf("backup %d: %v", i, err)
		}
	}
}
func TestSpaceAndCloneFailClosed(t *testing.T) {
	requireCode(t, CheckFreeSpace(t.TempDir(), ^uint64(0), 40<<30), Code("insufficient_space"))
	must(t, CheckFreeSpace(t.TempDir(), 0, 0))
	var c Cloner = RefusingCloner{}
	requireCode(t, c.Clone("a", "b"), Code("clone_unavailable"))
}

func TestOpaqueSummaryRefusesAbsolutePath(t *testing.T) {
	d, m := fixture(t)
	m.MachineDisks = json.RawMessage(`{"disk":"/private/state/disk"}`)
	requireCode(t, WriteManifest(d, m), Code("unsafe_path"))
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
				path := filepath.Join(root, fixtureBackupNames[i])
				must(t, os.Rename(filepath.Join(filepath.Dir(d), fixtureBackupNames[i]), path))
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
	if err == nil || (errors.As(err, &refusal) && refusal.Code == Code("wrong_version")) {
		t.Fatalf("negative retention needs its own error, got %v", err)
	}
}

func TestManifestRequiresEveryAuthoritySummary(t *testing.T) {
	for _, field := range []string{"stack", "branch_heads", "machine_disks", "run_journals"} {
		for _, raw := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`"empty"`), json.RawMessage(`true`)} {
			t.Run(field+"="+string(raw), func(t *testing.T) {
				dir, m := fixture(t)
				switch field {
				case "stack":
					m.Stack = raw
				case "branch_heads":
					m.BranchHeads = raw
				case "machine_disks":
					m.MachineDisks = raw
				case "run_journals":
					m.RunJournals = raw
				}
				requireCode(t, WriteManifest(dir, m), Code("wrong_version"))
				if _, err := os.Lstat(filepath.Join(dir, "MANIFEST.json")); !os.IsNotExist(err) {
					t.Fatalf("incomplete authority published: %v", err)
				}
			})
		}
	}
}

func TestManifestPublishedContractUsesIndependentLiteralDigests(t *testing.T) {
	dir := completed(t)
	body, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	must(t, err)
	var actual, expected map[string]any
	must(t, json.Unmarshal(body, &actual))
	must(t, json.Unmarshal([]byte(`{
 "version":"1.2.3","schema_version":2,"postgres_major":18,
 "quiesce_op":"backup-1","quiesce_time":"2026-10-03T22:00:00Z",
 "files":[
  {"path":"postgres.dump","size":4,"sha256":"b6ca0868bca6a2926b70aa1a71592038d9030fe26d4214edcfbd6cf41f2f4654"},
  {"path":"trees/disk","size":4,"sha256":"1044dec7206e8d7c9fbb4ae8f766668406d2567fc7fc1a160a9d4700fcf8f8e9"}
 ],
 "stack":[{"number":1}],"branch_heads":{},"machine_disks":[],"run_journals":[]
 }`), &expected))
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("manifest contract differs: %s", body)
	}
}

// Replacing the pathname after opening the snapshot must never switch the
// manifest or payload to the replacement directory.
func TestSnapshotDirectoryIdentityIsPinned(t *testing.T) {
	dir := completed(t)
	root, err := openSnapshot(dir)
	must(t, err)
	defer root.Close()
	moved := dir + "-moved"
	must(t, os.Rename(dir, moved))
	must(t, os.Mkdir(dir, 0700))
	must(t, os.WriteFile(filepath.Join(dir, "MANIFEST.json"), []byte("replacement"), 0600))
	must(t, os.WriteFile(filepath.Join(dir, "postgres.dump"), []byte("replacement"), 0600))
	manifest, err := readManifestRoot(root)
	must(t, err)
	files, err := inventoryRoot(root)
	must(t, err)
	if !reflect.DeepEqual(manifest.Files, files) {
		t.Fatalf("verification switched directory: manifest=%v inventory=%v", manifest.Files, files)
	}
}

func TestOpenedPayloadRejectsLinksAndSpecialFiles(t *testing.T) {
	dir := t.TempDir()
	must(t, os.WriteFile(filepath.Join(dir, "payload"), []byte("captured bytes"), 0600))
	must(t, os.Symlink("payload", filepath.Join(dir, "link")))
	must(t, unix.Mkfifo(filepath.Join(dir, "fifo"), 0600))
	root, err := openSnapshot(dir)
	must(t, err)
	defer root.Close()
	for _, name := range []string{"link", "fifo", "."} {
		t.Run(name, func(t *testing.T) {
			f, err := openRegular(root, name)
			if f != nil {
				f.Close()
				t.Fatal("unsafe file opened")
			}
			requireCode(t, err, Code("unsafe_path"))
		})
	}
	f, err := openRegular(root, "payload")
	must(t, err)
	must(t, f.Close())
}

func TestCanceledManifestIsNotPublished(t *testing.T) {
	dir, manifest := fixture(t)
	parent, err := openSnapshot(filepath.Dir(dir))
	must(t, err)
	defer parent.Close()
	ctx, cancel := context.WithCancelCause(t.Context())
	lost := errors.New("owner quiesce lease changed")
	cancel(lost)
	if err := writeManifestRoot(ctx, parent, filepath.Base(dir), manifest); !errors.Is(err, lost) {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dir, "MANIFEST.json"), filepath.Join(filepath.Dir(dir), "1.2.3-20261003T220000.000000000Z")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("published %s: %v", path, err)
		}
	}
	bytes, err := os.ReadFile(filepath.Join(dir, "trees/disk"))
	must(t, err)
	if string(bytes) != "disk" {
		t.Fatal(string(bytes))
	}
}

type cancelingSnapshotReader struct {
	cancel func()
	calls  int
}

func (r *cancelingSnapshotReader) Read(bytes []byte) (int, error) {
	r.calls++
	r.cancel()
	return copy(bytes, "disk"), nil
}
func TestSnapshotHashStopsAfterLostLease(t *testing.T) {
	ctx, cancel := context.WithCancelCause(t.Context())
	lost := errors.New("owner quiesce lease changed")
	source := &cancelingSnapshotReader{cancel: func() { cancel(lost) }}
	n, err := io.Copy(io.Discard, snapshotReader{ctx: ctx, source: source})
	if n != 4 || !errors.Is(err, lost) || source.calls != 1 {
		t.Fatalf("read %d bytes, %d reads, %v", n, source.calls, err)
	}
}

func TestVerifySnapshotCancellationPreservesBackup(t *testing.T) {
	dir := completed(t)
	before, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	must(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := VerifySnapshotContext(ctx, dir); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	must(t, err)
	if string(before) != string(after) {
		t.Fatal("verification changed manifest")
	}
	if _, err := VerifySnapshot(dir); err != nil {
		t.Fatal(err)
	}
}

// The published format of a symbolic link, as literal bytes: {path, link}
// with size 0 and an empty digest. The writer produces exactly this, and a
// backup holding these bytes is read. From the first public release on,
// restore must keep reading this format (smithers-8a, 2026-10-07).
func TestManifestPublishedContractRecordsALinkAsPathAndTarget(t *testing.T) {
	const published = `{
 "version":"1.2.3","schema_version":2,"postgres_major":18,
 "quiesce_op":"backup-1","quiesce_time":"2026-10-03T22:00:00Z",
 "files":[
  {"path":"postgres.dump","size":4,"sha256":"b6ca0868bca6a2926b70aa1a71592038d9030fe26d4214edcfbd6cf41f2f4654"},
  {"path":"state/workspaces/run/file","size":1,"sha256":"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"},
  {"path":"state/workspaces/run/readme","size":0,"sha256":"","link":"../run/file"}
 ],
 "stack":[{"number":1}],"branch_heads":{},"machine_disks":[],"run_journals":[]
 }`
	tree := func(dir string) {
		must(t, os.MkdirAll(filepath.Join(dir, "state/workspaces/run"), 0700))
		must(t, os.WriteFile(filepath.Join(dir, "postgres.dump"), []byte("dump"), 0600))
		must(t, os.WriteFile(filepath.Join(dir, "state/workspaces/run/file"), []byte("x"), 0600))
		must(t, os.Symlink("../run/file", filepath.Join(dir, "state/workspaces/run/readme")))
	}

	// Written: the writer's bytes are the published contract.
	partial := filepath.Join(t.TempDir(), ".partial-1")
	tree(partial)
	_, m := fixture(t)
	must(t, WriteManifest(partial, m))
	body, err := os.ReadFile(filepath.Join(filepath.Dir(partial), "1.2.3-20261003T220000.000000000Z", "MANIFEST.json"))
	must(t, err)
	var actual, expected map[string]any
	must(t, json.Unmarshal(body, &actual))
	must(t, json.Unmarshal([]byte(published), &expected))
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("manifest contract differs: %s", body)
	}

	// Read: a backup holding exactly the published bytes verifies.
	released := filepath.Join(t.TempDir(), "1.2.3-20261003T220000.000000000Z")
	tree(released)
	must(t, os.WriteFile(filepath.Join(released, "MANIFEST.json"), []byte(published), 0600))
	read, err := VerifySnapshot(released)
	must(t, err)
	if len(read.Files) != 3 || read.Files[2] != (File{Path: "state/workspaces/run/readme", Link: "../run/file"}) {
		t.Fatalf("published link entry read as %+v", read.Files)
	}
	must(t, VerifyManifest(released, Version{Release: "1.3.0", Schema: 3, PostgresMajor: 18}))
}
