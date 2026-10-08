// Package hostbackup validates and publishes quiescent host snapshots.
// Callers must supply already quiesced trees.
package hostbackup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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

// File is one regular file, or one symbolic link when Link holds its target.
// A link records no bytes: its size is zero and its digest is empty.
type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Link   string `json:"link,omitempty"`
}

// same reports whether a recorded entry and an observed one are identical.
func (f File) same(other File) bool {
	return f.Size == other.Size && f.SHA256 == other.SHA256 && f.Link == other.Link
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
	parent, err := openSnapshot(filepath.Dir(dir))
	if err != nil {
		return err
	}
	defer parent.Close()
	return writeManifestRoot(context.Background(), parent, filepath.Base(dir), m)
}

func writeManifestRoot(ctx context.Context, parent *os.Root, name string, m Manifest) (err error) {
	if err = context.Cause(ctx); err != nil {
		return err
	}
	if !strings.HasPrefix(name, ".partial-") || !safePath(name) {
		return &Error{Code: Partial, Path: name}
	}
	if err := metadata(m); err != nil {
		return err
	}
	info, err := parent.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return &Error{Code: UnsafePath, Path: name}
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return err
	}
	defer root.Close()
	pinned, err := root.Stat(".")
	if err != nil || !os.SameFile(info, pinned) {
		return &Error{Code: UnsafePath, Path: name}
	}
	files, err := inventoryRootContext(ctx, root, linksInTopLevel)
	if err != nil {
		return err
	}
	if _, err = root.Lstat("MANIFEST.json"); !os.IsNotExist(err) {
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
	final := backupName(m)
	if _, err = parent.Lstat(final); !os.IsNotExist(err) {
		return &Error{Code: ExtraFile, Path: final}
	}
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	if err = directory.Chmod(0700); err != nil {
		return err
	}
	if err = context.Cause(ctx); err != nil {
		return err
	}
	f, err := root.OpenFile("MANIFEST.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	published := false
	defer func() {
		if !published {
			err = errors.Join(err, root.Remove("MANIFEST.json"), directory.Sync())
		}
	}()
	_, err = f.Write(data)
	err = errors.Join(err, f.Sync(), f.Close())
	if err != nil {
		return err
	}
	if err = directory.Sync(); err != nil {
		return err
	}
	if err = context.Cause(ctx); err != nil {
		return err
	}
	if err = parent.Rename(name, final); err != nil {
		return err
	}
	published = true
	ancestor, err := parent.Open(".")
	if err != nil {
		return err
	}
	return errors.Join(ancestor.Sync(), ancestor.Close())
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func metadata(m Manifest) error {
	if _, _, err := releaseParts(m.Version); err != nil {
		return err
	}
	if m.SchemaVersion < 1 || m.PostgresMajor < 1 || m.QuiesceOp == "" || m.QuiesceTime.IsZero() {
		return &Error{Code: WrongVersion, Path: "incomplete metadata"}
	}
	if filepath.IsAbs(m.QuiesceOp) {
		return &Error{Code: UnsafePath, Path: "quiesce_op"}
	}
	return ValidateSummary(m)
}

// ValidateSummary shares the manifest's completeness and relative-path guards
// with the live owner bridge, before a summary is published or copied.
func ValidateSummary(m Manifest) error {
	for _, raw := range []json.RawMessage{m.Stack, m.BranchHeads, m.MachineDisks, m.RunJournals} {
		if len(raw) == 0 {
			return &Error{Code: WrongVersion, Path: "incomplete summary"}
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return &Error{Code: WrongVersion, Path: "summary"}
		}
		switch value.(type) {
		case []any, map[string]any:
		default:
			return &Error{Code: WrongVersion, Path: "incomplete summary"}
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

// openSnapshot pins the directory identity for the whole verification. A root
// symlink or replacement between lstat and open is never a snapshot authority.
func openSnapshot(dir string) (*os.Root, error) {
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, &Error{Code: UnsafePath, Path: dir}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	pinned, err := root.Stat(".")
	if err != nil || !os.SameFile(info, pinned) {
		root.Close()
		return nil, &Error{Code: UnsafePath, Path: dir}
	}
	return root, nil
}

// A directory entry may change after WalkDir or Lstat. O_NOFOLLOW rejects a
// substituted link; O_NONBLOCK prevents a substituted FIFO from hanging the CLI.
func openRegular(root *os.Root, path string) (*os.File, error) {
	// Root.OpenFile resolves links itself, including with O_NOFOLLOW on macOS.
	// Resolve only the parent inside Root, then open its final entry atomically.
	parent, err := root.Open(filepath.Dir(path))
	if err != nil {
		return nil, &Error{Code: UnsafePath, Path: path}
	}
	defer parent.Close()
	fd, err := unix.Openat(int(parent.Fd()), filepath.Base(path), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &Error{Code: UnsafePath, Path: path}
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, &Error{Code: UnsafePath, Path: path}
	}
	return f, nil
}

// linkScope names the directory a tree's symbolic links must resolve inside.
type linkScope int

const (
	// linksInRoot confines every link to the inventoried tree: a bundle or a
	// staged state tree, which restore publishes as one directory.
	linksInRoot linkScope = iota
	// linksInTopLevel confines every link to its first path component and
	// allows none beside them: a snapshot's state/ and bundle/ are published
	// separately, so a link from one into the other leaves its tree.
	linksInTopLevel
)

// linkHops bounds link resolution, so a loop is refused instead of followed.
const linkHops = 40

// linkStaysInside reports whether name, a path under base, resolves inside
// base when every link on the way is followed. A link is relative to the
// directory holding it. Absolute targets, a climb above base and loops are
// refused; a target that does not exist is not. A restored tree is published
// into the live state root, so no link in it may lead outside: the backend
// would read and write through it.
func linkStaysInside(root *os.Root, base, name string) bool {
	rest, current, hops := name, "", 0
	for rest != "" {
		var part string
		part, rest, _ = strings.Cut(rest, "/")
		switch part {
		case "", ".":
			continue
		case "..":
			if current == "" {
				return false
			}
			current = filepath.Dir(current)
			if current == "." {
				current = ""
			}
			continue
		}
		next := filepath.Join(current, part)
		info, err := root.Lstat(filepath.Join(base, next))
		if err != nil {
			// A missing component is a dangling path that still stays inside.
			// Any other failure cannot prove confinement.
			if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, unix.ENOTDIR) {
				return false
			}
			current = next
			continue
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			current = next
			continue
		}
		if hops++; hops > linkHops {
			return false
		}
		target, err := root.Readlink(filepath.Join(base, next))
		if err != nil || target == "" || filepath.IsAbs(target) || strings.ContainsRune(target, 0) {
			return false
		}
		if rest != "" {
			target += "/" + rest
		}
		rest = target
	}
	return true
}

// inventory streams SHA-256, including sparse holes, without following links.
func inventory(dir string) ([]File, error) {
	root, err := openSnapshot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return inventoryRoot(root)
}

func inventoryRoot(root *os.Root) ([]File, error) {
	return inventoryRootContext(context.Background(), root, linksInRoot)
}

// inventoryRootContext records every regular file's bytes and every confined
// link's target. Any other entry, and a link that leaves its tree, is refused.
func inventoryRootContext(ctx context.Context, root *os.Root, scope linkScope) ([]File, error) {
	var files []File
	err := fs.WalkDir(root.FS(), ".", func(path string, d fs.DirEntry, walkErr error) error {
		if err := context.Cause(ctx); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if path == "." {
			return nil
		}
		rel := filepath.ToSlash(path)
		if !safePath(rel) {
			return &Error{Code: UnsafePath, Path: rel}
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			base, name := "", rel
			if scope == linksInTopLevel {
				var nested bool
				if base, name, nested = strings.Cut(rel, "/"); !nested {
					return &Error{Code: UnsafePath, Path: rel}
				}
			}
			if !linkStaysInside(root, base, name) {
				return &Error{Code: UnsafePath, Path: rel}
			}
			target, err := root.Readlink(path)
			if err != nil {
				return &Error{Code: UnsafePath, Path: rel}
			}
			files = append(files, File{Path: rel, Link: target})
			return nil
		}
		if !d.Type().IsRegular() {
			return &Error{Code: UnsafePath, Path: rel}
		}
		if rel == "MANIFEST.json" {
			return nil
		}
		f, err := openRegular(root, rel)
		if err != nil {
			return err
		}
		hash := sha256.New()
		size, err := io.Copy(hash, snapshotReader{ctx: ctx, source: f})
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		files = append(files, File{Path: rel, Size: size, SHA256: hex.EncodeToString(hash.Sum(nil))})
		return nil
	})
	return files, err
}
func readManifest(dir string) (Manifest, error) {
	root, err := openSnapshot(dir)
	if err != nil {
		return Manifest{}, err
	}
	defer root.Close()
	return readManifestRoot(root)
}

func readManifestRoot(root *os.Root) (Manifest, error) {
	var m Manifest
	info, err := root.Lstat("MANIFEST.json")
	if err != nil {
		return m, &Error{Code: MissingFile, Path: "MANIFEST.json"}
	}
	if !info.Mode().IsRegular() || info.Size() > 16<<20 {
		return m, &Error{Code: UnsafePath, Path: "MANIFEST.json"}
	}
	f, err := openRegular(root, "MANIFEST.json")
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

// VerifySnapshot validates the recorded version and all bytes without asserting
// installed compatibility. Native upgrade uses it to bind a pre-upgrade backup.
func VerifySnapshot(dir string) (Manifest, error) {
	return VerifySnapshotContext(context.Background(), dir)
}

// VerifySnapshotContext stops disk hashing when the owner cancels maintenance.
func VerifySnapshotContext(ctx context.Context, dir string) (Manifest, error) {
	return verifiedManifest(ctx, dir, nil)
}

// VerifyManifest accepts newer installed releases, but never a downgrade or a
// different PostgreSQL major. The directory name binds the recorded release.
func VerifyManifest(dir string, installed Version) error {
	_, err := VerifiedManifest(dir, installed)
	return err
}

// VerifiedManifest returns the validated metadata for restore and upgrade.
func VerifiedManifest(dir string, installed Version) (Manifest, error) {
	return verifiedManifest(context.Background(), dir, &installed)
}

func verifiedManifest(ctx context.Context, dir string, installed *Version) (Manifest, error) {
	var m Manifest
	if err := context.Cause(ctx); err != nil {
		return m, err
	}
	if strings.HasPrefix(filepath.Base(dir), ".partial-") {
		return m, &Error{Code: Partial, Path: dir}
	}
	root, err := openSnapshot(dir)
	if err != nil {
		return m, err
	}
	defer root.Close()
	return verifyPinnedManifest(ctx, root, filepath.Base(dir), installed)
}

func verifyPinnedManifest(ctx context.Context, root *os.Root, name string, installed *Version) (Manifest, error) {
	m, err := readManifestRoot(root)
	if err != nil {
		return m, err
	}
	if err := metadata(m); err != nil {
		return m, err
	}
	if name != backupName(m) {
		return m, &Error{Code: WrongVersion, Path: name}
	}
	if installed == nil {
		installed = &Version{Release: m.Version, Schema: m.SchemaVersion, PostgresMajor: m.PostgresMajor}
	}
	order, err := CompareRelease(installed.Release, m.Version)
	if err != nil {
		return m, err
	}
	if order < 0 {
		return m, &Error{Code: OlderVersion, Path: installed.Release}
	}
	if m.SchemaVersion > installed.Schema {
		return m, &Error{Code: NewerSchema, Path: m.Version}
	}
	if m.PostgresMajor != installed.PostgresMajor {
		return m, &Error{Code: WrongVersion, Path: "postgres major"}
	}
	expected := make(map[string]File, len(m.Files))
	for _, f := range m.Files {
		if !safePath(f.Path) || f.Path == "MANIFEST.json" {
			return m, &Error{Code: UnsafePath, Path: f.Path}
		}
		if _, ok := expected[f.Path]; ok {
			return m, &Error{Code: ExtraFile, Path: f.Path}
		}
		// A link records a target and no bytes; a recorded absolute target
		// could never have been published.
		if f.Link != "" && (f.Size != 0 || f.SHA256 != "" || filepath.IsAbs(f.Link)) {
			return m, &Error{Code: UnsafePath, Path: f.Path}
		}
		expected[f.Path] = f
	}
	if !hasDump(m.Files) {
		return m, &Error{Code: MissingDump, Path: "postgres.dump"}
	}
	if _, err = root.Lstat("postgres.dump"); os.IsNotExist(err) {
		return m, &Error{Code: MissingDump, Path: "postgres.dump"}
	}
	actual, err := inventoryRootContext(ctx, root, linksInTopLevel)
	if err != nil {
		return m, err
	}
	for _, f := range actual {
		e, ok := expected[f.Path]
		if !ok {
			return m, &Error{Code: ExtraFile, Path: f.Path}
		}
		if !e.same(f) {
			return m, &Error{Code: HashMismatch, Path: f.Path}
		}
		delete(expected, f.Path)
	}
	for path := range expected {
		return m, &Error{Code: MissingFile, Path: path}
	}
	return m, nil
}

// Prune retains completed snapshots by manifest time without reading payloads.
// Unreadable manifests, mismatched names, partial and pre-restore trees are preserved.
func Prune(dir string, keep int) error {
	if keep < 0 {
		return errors.New("negative retention")
	}
	root, err := openSnapshot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	entries, err := directory.ReadDir(-1)
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
		child, err := root.OpenRoot(e.Name())
		if err != nil {
			continue
		}
		m, err := readManifestRoot(child)
		child.Close()
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
		if err = root.RemoveAll(backups[i].name); err != nil {
			return err
		}
	}
	return directory.Sync()
}

// FreeSpaceFloor reserves 40 GiB on the state volume.
const FreeSpaceFloor uint64 = 40 << 30

// CheckFreeSpace checks caller-available bytes against the requested size and floor.
func CheckFreeSpace(dir string, need uint64, floor uint64) error {
	free, err := availableBytes(dir)
	if err != nil {
		return err
	}
	return requireFreeSpace(dir, free, need, floor)
}

// availableBytes reports the bytes an unprivileged caller may still write on
// dir's volume.
func availableBytes(dir string) (uint64, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(dir, &stat); err != nil {
		return 0, err
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}

func requireFreeSpace(dir string, free, need, floor uint64) error {
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

// DirectoryCloner accepts pinned ancestors so renamed STATE paths cannot redirect
// a maintenance capture. Names are single directory entries, never paths.
type DirectoryCloner interface {
	CloneAt(source *os.File, name string, destination *os.File, target string) error
}

func (RefusingCloner) CloneAt(*os.File, string, *os.File, string) error {
	return &Error{Code: CloneUnavailable}
}

// Disk hashing must observe a lost freeze before another chunk is consumed.
// Keep one inventory implementation for offline verification and live backup.
type snapshotReader struct {
	ctx    context.Context
	source io.Reader
}

func (r snapshotReader) Read(bytes []byte) (int, error) {
	if err := context.Cause(r.ctx); err != nil {
		return 0, err
	}
	return r.source.Read(bytes)
}
