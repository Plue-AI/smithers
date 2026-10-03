// Package hostbackup validates and publishes quiescent host snapshots. It has no
// runtime or command wiring; callers must supply already quiesced trees.
package hostbackup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type Code string

const (
	WrongVersion      Code = "wrong_version"
	OlderVersion      Code = "older_version"
	MissingDump       Code = "missing_dump"
	HashMismatch      Code = "hash_mismatch"
	MissingFile       Code = "missing_file"
	ExtraFile         Code = "extra_file"
	NewerSchema       Code = "newer_schema"
	Partial           Code = "partial"
	UnsafePath        Code = "unsafe_path"
	InsufficientSpace Code = "insufficient_space"
	CloneUnavailable  Code = "clone_unavailable"
)

type Error struct {
	Code Code
	Path string
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Path }

type Version struct {
	Release       string
	Schema        int
	PostgresMajor int
}
type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type Manifest struct {
	Version       string          `json:"version"`
	SchemaVersion int             `json:"schema_version"`
	PostgresMajor int             `json:"postgres_major"`
	QuiesceOp     string          `json:"quiesce_op"`
	QuiesceTime   time.Time       `json:"quiesce_time"`
	Files         []File          `json:"files"`
	Stack         json.RawMessage `json:"stack"`
	BranchHeads   json.RawMessage `json:"branch_heads"`
	MachineDisks  json.RawMessage `json:"machine_disks"`
	RunJournals   json.RawMessage `json:"run_journals"`
}

func backupName(m Manifest) string {
	return m.Version + "-" + m.QuiesceTime.UTC().Format("20060102T150405.000000000Z")
}

// WriteManifest inventories a quiescent staging directory and publishes it only
// after MANIFEST.json and the directory are synced. Callers own the freeze.
func WriteManifest(dir string, m Manifest) error {
	if !strings.HasPrefix(filepath.Base(dir), ".partial-") {
		return &Error{Code: Partial, Path: dir}
	}
	if err := metadata(m); err != nil {
		return err
	}
	files, err := inventory(dir)
	if err != nil {
		return err
	}
	if _, err = os.Lstat(filepath.Join(dir, "MANIFEST.json")); !os.IsNotExist(err) {
		return &Error{Code: ExtraFile, Path: "MANIFEST.json"}
	}
	if !hasDump(files) {
		return &Error{Code: MissingDump, Path: "postgres.dump"}
	}
	m.Files = files
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	final := filepath.Join(filepath.Dir(dir), backupName(m))
	if _, err = os.Lstat(final); !os.IsNotExist(err) {
		return &Error{Code: ExtraFile, Path: filepath.Base(final)}
	}
	if err = os.Chmod(dir, 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "MANIFEST.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = syncDir(dir); err != nil {
		return err
	}
	if err = os.Rename(dir, final); err != nil {
		return err
	}
	return syncDir(filepath.Dir(final))
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

var releasePattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func release(v string) ([3]uint64, error) {
	var parts [3]uint64
	matches := releasePattern.FindStringSubmatch(v)
	if matches == nil {
		return parts, &Error{Code: WrongVersion, Path: v}
	}
	for i := range parts {
		n, err := strconv.ParseUint(matches[i+1], 10, 64)
		if err != nil {
			return parts, &Error{Code: WrongVersion, Path: v}
		}
		parts[i] = n
	}
	return parts, nil
}
func metadata(m Manifest) error {
	if _, err := release(m.Version); err != nil {
		return err
	}
	if m.SchemaVersion < 1 || m.PostgresMajor < 1 || m.QuiesceOp == "" || m.QuiesceTime.IsZero() {
		return &Error{Code: WrongVersion, Path: "incomplete metadata"}
	}
	if filepath.IsAbs(m.QuiesceOp) {
		return &Error{Code: UnsafePath, Path: "quiesce_op"}
	}
	for _, raw := range []json.RawMessage{m.Stack, m.BranchHeads, m.MachineDisks, m.RunJournals} {
		if len(raw) == 0 {
			continue
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return &Error{Code: WrongVersion, Path: "summary"}
		}
		if err := relativeSummary(value); err != nil {
			return err
		}
	}
	return nil
}
func relativeSummary(value any) error {
	switch v := value.(type) {
	case string:
		if filepath.IsAbs(v) || strings.HasPrefix(v, "\\") || (len(v) > 2 && v[1] == ':' && (v[2] == '/' || v[2] == '\\')) {
			return &Error{Code: UnsafePath, Path: "summary"}
		}
	case []any:
		for _, entry := range v {
			if err := relativeSummary(entry); err != nil {
				return err
			}
		}
	case map[string]any:
		for key, entry := range v {
			if err := relativeSummary(key); err != nil {
				return err
			}
			if err := relativeSummary(entry); err != nil {
				return err
			}
		}
	}
	return nil
}
func safePath(p string) bool {
	return p != "" && p != "." && fs.ValidPath(p) && !filepath.IsAbs(p) && !strings.ContainsAny(p, ":\\\x00")
}
func hasDump(files []File) bool {
	for _, f := range files {
		if f.Path == "postgres.dump" {
			return true
		}
	}
	return false
}

// inventory uses streaming SHA-256, including sparse holes; it rejects links
// and special files instead of following paths outside the snapshot.
func inventory(dir string) ([]File, error) {
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, &Error{Code: UnsafePath, Path: dir}
	}
	var files []File
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == dir {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !safePath(rel) {
			return &Error{Code: UnsafePath, Path: rel}
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return &Error{Code: UnsafePath, Path: rel}
		}
		if rel == "MANIFEST.json" {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		hash := sha256.New()
		size, err := io.Copy(hash, f)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		files = append(files, File{rel, size, hex.EncodeToString(hash.Sum(nil))})
		return nil
	})
	return files, err
}
func readManifest(dir string) (Manifest, error) {
	var m Manifest
	path := filepath.Join(dir, "MANIFEST.json")
	info, err := os.Lstat(path)
	if err != nil {
		return m, &Error{Code: MissingFile, Path: "MANIFEST.json"}
	}
	if !info.Mode().IsRegular() || info.Size() > 16<<20 {
		return m, &Error{Code: UnsafePath, Path: "MANIFEST.json"}
	}
	f, err := os.Open(path)
	if err != nil {
		return m, err
	}
	defer f.Close()
	dec := json.NewDecoder(io.LimitReader(f, 16<<20))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&m); err != nil {
		return m, &Error{Code: WrongVersion, Path: "MANIFEST.json"}
	}
	if dec.Decode(new(any)) != io.EOF {
		return m, &Error{Code: WrongVersion, Path: "MANIFEST.json"}
	}
	return m, nil
}

// VerifyManifest accepts newer installed releases, but never a downgrade or a
// different PostgreSQL major. The directory name binds the recorded release.
func VerifyManifest(dir string, installed Version) error {
	if strings.HasPrefix(filepath.Base(dir), ".partial-") {
		return &Error{Code: Partial, Path: dir}
	}
	m, err := readManifest(dir)
	if err != nil {
		return err
	}
	if err := metadata(m); err != nil {
		return err
	}
	if filepath.Base(dir) != backupName(m) {
		return &Error{Code: WrongVersion, Path: filepath.Base(dir)}
	}
	want, err := release(m.Version)
	if err != nil {
		return err
	}
	have, err := release(installed.Release)
	if err != nil {
		return err
	}
	for i := range have {
		if have[i] < want[i] {
			return &Error{Code: OlderVersion, Path: installed.Release}
		}
		if have[i] > want[i] {
			break
		}
	}
	if m.SchemaVersion > installed.Schema {
		return &Error{Code: NewerSchema, Path: m.Version}
	}
	if m.PostgresMajor != installed.PostgresMajor {
		return &Error{Code: WrongVersion, Path: "postgres major"}
	}
	expected := make(map[string]File, len(m.Files))
	for _, f := range m.Files {
		if !safePath(f.Path) || f.Path == "MANIFEST.json" {
			return &Error{Code: UnsafePath, Path: f.Path}
		}
		if _, ok := expected[f.Path]; ok {
			return &Error{Code: ExtraFile, Path: f.Path}
		}
		expected[f.Path] = f
	}
	if !hasDump(m.Files) {
		return &Error{Code: MissingDump, Path: "postgres.dump"}
	}
	if _, err = os.Lstat(filepath.Join(dir, "postgres.dump")); os.IsNotExist(err) {
		return &Error{Code: MissingDump, Path: "postgres.dump"}
	}
	actual, err := inventory(dir)
	if err != nil {
		return err
	}
	for _, f := range actual {
		e, ok := expected[f.Path]
		if !ok {
			return &Error{Code: ExtraFile, Path: f.Path}
		}
		if e.Size != f.Size || e.SHA256 != f.SHA256 {
			return &Error{Code: HashMismatch, Path: f.Path}
		}
		delete(expected, f.Path)
	}
	for path := range expected {
		return &Error{Code: MissingFile, Path: path}
	}
	return nil
}

// Prune retains completed snapshots by manifest time without reading payloads.
// Unreadable manifests, mismatched names, partial and pre-restore trees are preserved.
func Prune(dir string, keep int) error {
	if keep < 0 {
		return errors.New("negative retention")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	type backup struct {
		name string
		at   time.Time
	}
	var backups []backup
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".partial-") || strings.HasPrefix(e.Name(), "pre-restore-") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		m, err := readManifest(path)
		if err != nil {
			continue
		}
		if e.Name() != backupName(m) {
			continue
		}
		backups = append(backups, backup{e.Name(), m.QuiesceTime})
	}
	sort.Slice(backups, func(i, j int) bool {
		if backups[i].at.Equal(backups[j].at) {
			return backups[i].name > backups[j].name
		}
		return backups[i].at.After(backups[j].at)
	})
	for i := keep; i < len(backups); i++ {
		if err = os.RemoveAll(filepath.Join(dir, backups[i].name)); err != nil {
			return err
		}
	}
	return syncDir(dir)
}

// FreeSpaceFloor reserves 40 GiB on the state volume.
const FreeSpaceFloor uint64 = 40 << 30

// CheckFreeSpace checks caller-available bytes against the requested size and floor.
func CheckFreeSpace(dir string, need uint64, floor uint64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(dir, &stat); err != nil {
		return err
	}
	free := uint64(stat.Bavail) * uint64(stat.Bsize)
	if free < floor || need > free-floor {
		return &Error{Code: InsufficientSpace, Path: dir}
	}
	return nil
}

type Cloner interface {
	Clone(source, destination string) error
}
type RefusingCloner struct{}

func (RefusingCloner) Clone(string, string) error { return &Error{Code: CloneUnavailable} }
