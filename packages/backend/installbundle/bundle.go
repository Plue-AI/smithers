// Package installbundle pins the installed server bundle a backend runs from
// and verifies, against that one pinned manifest, every file the host loads,
// runs or plants into a guest (spec §17.3).
//
// For stage S1 an approved bundle is the one the backend executable sits in
// at bin/smithers-backend, whose directory, manifest and every ancestor up to
// / are owned by root or the running user and not writable by group or
// others. The adversaries of the guest root boundary (repository content, a
// branch, a machine user, a member's request, the process environment) cannot
// write it; the install owner who starts another bundle is not one of them.
package installbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// BackendPath is the backend executable's place in the bundle.
const BackendPath = "bin/smithers-backend"

// manifestLimit bounds the bundle's manifest.json.
const manifestLimit = 16 << 20

// ErrUnapproved refuses a host file or directory the installed bundle does
// not approve: not a member, other bytes or mode, or reached through a path
// someone other than root or the running user can change.
var ErrUnapproved = errors.New("not approved by the installed bundle")

var (
	revisionSyntax = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
	digestSyntax   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Entry is one file of the bundle's manifest.json, the record
// `smthrs host start` verified before it started this backend.
type Entry struct {
	Path    string  `json:"path"`
	SHA256  string  `json:"sha256"`
	Stage   string  `json:"stage"`
	Mode    int     `json:"mode"`
	Symlink *string `json:"symlink,omitempty"`
}

// Bundle is an installed bundle's manifest, pinned once. A later change to
// manifest.json approves nothing: every use is checked against these entries.
type Bundle struct {
	// root is the bundle directory with its symlinks resolved once; the
	// resolved chain from / is what every use walks and checks.
	root     string
	revision string
	// digest is manifest.json's own sha256, the value an operator compares
	// with the manifest the release build produced.
	digest  string
	entries map[string]Entry
}

// Locate answers the bundle directory the backend executable runs from: the
// directory holding it at bin/smithers-backend. A backend outside one, such
// as a development build, has none.
func Locate(executable string) (string, error) {
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("locate the installed bundle: %w", err)
	}
	bin := filepath.Dir(resolved)
	if filepath.Base(resolved) != path.Base(BackendPath) || filepath.Base(bin) != "bin" {
		return "", fmt.Errorf("the backend %s does not run from an installed bundle's %s", resolved, BackendPath)
	}
	return filepath.Dir(bin), nil
}

// OpenRunning pins the bundle executable runs from and refuses unless the
// executable is that bundle's bin/smithers-backend with the manifest's bytes.
func OpenRunning(executable string) (*Bundle, error) {
	root, err := Locate(executable)
	if err != nil {
		return nil, err
	}
	bundle, err := Open(root)
	if err != nil {
		return nil, err
	}
	if relative, ok := bundle.Member(executable); !ok || relative != BackendPath {
		return nil, fmt.Errorf("%w: the running backend %s is not the bundle's %s", ErrUnapproved, executable, BackendPath)
	}
	if err := bundle.Program(BackendPath).Check(); err != nil {
		return nil, err
	}
	return bundle, nil
}

// Open pins root's manifest.json, read through the protected chain.
func Open(root string) (*Bundle, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, fmt.Errorf("%w: the installed bundle path must be absolute and clean", ErrUnapproved)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve the installed bundle: %v", ErrUnapproved, err)
	}
	data, _, err := readProtected(resolved, "manifest.json", manifestLimit)
	if err != nil {
		return nil, fmt.Errorf("%w: read the bundle manifest: %v", ErrUnapproved, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest struct {
		Version  int     `json:"version"`
		Platform string  `json:"platform"`
		Revision string  `json:"revision"`
		Files    []Entry `json:"files"`
	}
	if err := decoder.Decode(&manifest); err != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("%w: the bundle manifest is not one JSON document", ErrUnapproved)
	}
	if manifest.Version != 1 || manifest.Platform != "darwin-arm64" || !revisionSyntax.MatchString(manifest.Revision) || len(manifest.Files) == 0 {
		return nil, fmt.Errorf("%w: the bundle manifest is invalid", ErrUnapproved)
	}
	entries := make(map[string]Entry, len(manifest.Files))
	for _, entry := range manifest.Files {
		_, duplicate := entries[entry.Path]
		if duplicate || !relativePath(entry.Path) || !digestSyntax.MatchString(entry.SHA256) ||
			strings.TrimSpace(entry.Stage) == "" || entry.Mode < 0 || entry.Mode > 0o777 {
			return nil, fmt.Errorf("%w: the bundle manifest entry %q is invalid", ErrUnapproved, entry.Path)
		}
		entries[entry.Path] = entry
	}
	sum := sha256.Sum256(data)
	return &Bundle{root: resolved, revision: manifest.Revision, digest: hex.EncodeToString(sum[:]), entries: entries}, nil
}

// Root, Revision and ManifestSHA256 are the startup receipt.
func (b *Bundle) Root() string           { return b.root }
func (b *Bundle) Revision() string       { return b.revision }
func (b *Bundle) ManifestSHA256() string { return b.digest }

// Entry answers the manifest entry of a bundle-relative path.
func (b *Bundle) Entry(relative string) (Entry, bool) {
	entry, ok := b.entries[relative]
	return entry, ok
}

// Matching lists the manifest paths that match pattern (path.Match syntax).
func (b *Bundle) Matching(pattern string) []string {
	var out []string
	for name := range b.entries {
		if ok, _ := path.Match(pattern, name); ok {
			out = append(out, name)
		}
	}
	return out
}

// relativePath is a manifest path: relative, slash-separated, with no
// empty, "." or ".." element.
func relativePath(value string) bool {
	if value == "" || strings.ContainsAny(value, "\\\x00") || path.IsAbs(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// Member answers the manifest path of an absolute host path below the
// bundle, as given or with its symlinks resolved; ok is false otherwise.
func (b *Bundle) Member(program string) (string, bool) {
	if !filepath.IsAbs(program) {
		return "", false
	}
	if relative, ok := Relative(b.root, program); ok {
		return relative, true
	}
	resolved, err := filepath.EvalSymlinks(program)
	if err != nil {
		return "", false
	}
	return Relative(b.root, resolved)
}

// Relative is the slash-separated path of an absolute program below root;
// ok is false for root itself and anything outside it.
func Relative(root, program string) (string, bool) {
	if !filepath.IsAbs(program) {
		return "", false
	}
	rel, err := filepath.Rel(root, filepath.Clean(program))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// Path is the host path of a bundle-relative path, below the resolved root.
func (b *Bundle) Path(relative string) string {
	return filepath.Join(b.root, filepath.FromSlash(relative))
}

// Read returns the bytes of one declared regular file, read through the
// protected chain, only when they and its mode match the pinned manifest.
func (b *Bundle) Read(relative string, limit int64) ([]byte, Entry, error) {
	entry, ok := b.entries[relative]
	switch {
	case !ok:
		return nil, Entry{}, fmt.Errorf("%w: %s is not declared by the bundle manifest", ErrUnapproved, relative)
	case entry.Symlink != nil:
		return nil, Entry{}, fmt.Errorf("%w: %s is a symlink", ErrUnapproved, relative)
	}
	data, mode, err := readProtected(b.root, relative, limit)
	if err != nil {
		return nil, Entry{}, fmt.Errorf("%w: %s: %v", ErrUnapproved, relative, err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != entry.SHA256 {
		return nil, Entry{}, fmt.Errorf("%w: %s differs from the bundle manifest", ErrUnapproved, relative)
	}
	if int(mode) != entry.Mode {
		return nil, Entry{}, fmt.Errorf("%w: %s mode differs from the bundle manifest", ErrUnapproved, relative)
	}
	return data, entry, nil
}

// Expect verifies that a host path the backend was handed through name (an
// environment variable or argument) is exactly the bundle's member want,
// with the manifest's bytes, and answers its host path. An empty value
// answers the member itself: beside a bundle nothing falls back to the
// working directory or a search path.
func (b *Bundle) Expect(name, value, want string, executable bool) (string, error) {
	target := b.Path(want)
	if value != "" {
		if !filepath.IsAbs(value) {
			return "", fmt.Errorf("%w: %s=%s is not an absolute path", ErrUnapproved, name, value)
		}
		if relative, ok := b.Member(value); !ok || relative != want {
			return "", fmt.Errorf("%w: %s=%s is not the installed bundle's %s", ErrUnapproved, name, value, want)
		}
	}
	file := b.Library(want)
	if executable {
		file = b.Program(want)
	}
	if err := file.Check(); err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return target, nil
}

// ExpectPrograms verifies a directory of host programs handed through name
// (the PostgreSQL binary directory): absolute, inside the bundle, and each
// named program in it a member with the manifest's bytes. It answers the
// directory below the resolved bundle root.
func (b *Bundle) ExpectPrograms(name, value string, programs ...string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("%w: %s=%s is not an absolute path", ErrUnapproved, name, value)
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil {
		return "", fmt.Errorf("%w: %s=%s: %v", ErrUnapproved, name, value, err)
	}
	directory, ok := Relative(b.root, resolved)
	if !ok {
		return "", fmt.Errorf("%w: %s=%s is not a directory of the installed bundle", ErrUnapproved, name, value)
	}
	for _, program := range programs {
		if err := b.Program(path.Join(directory, program)).Check(); err != nil {
			return "", fmt.Errorf("%s: %w", name, err)
		}
	}
	return b.Path(directory), nil
}

// ExpectDirectory verifies a directory of bundle files handed through name
// (git's helper programs, its templates): absolute, exactly the bundle's
// directory want, and every regular file the manifest declares below it
// with the manifest's bytes and mode. A symlink entry is not opened; the
// file it names is declared and verified as itself. It answers the
// directory below the resolved bundle root.
func (b *Bundle) ExpectDirectory(name, value, want string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("%w: %s=%s is not an absolute path", ErrUnapproved, name, value)
	}
	if relative, ok := b.Member(value); !ok || relative != want {
		return "", fmt.Errorf("%w: %s=%s is not the installed bundle's %s", ErrUnapproved, name, value, want)
	}
	var files []string
	for relative, entry := range b.entries {
		if strings.HasPrefix(relative, want+"/") && entry.Symlink == nil {
			files = append(files, relative)
		}
	}
	if len(files) == 0 {
		return "", fmt.Errorf("%w: %s: the bundle manifest declares nothing below %s", ErrUnapproved, name, want)
	}
	sort.Strings(files)
	for _, relative := range files {
		file := b.Library(relative)
		if b.entries[relative].Mode&0o111 != 0 {
			file = b.Program(relative)
		}
		if err := file.Check(); err != nil {
			return "", fmt.Errorf("%s: %w", name, err)
		}
	}
	return b.Path(want), nil
}

// Absent verifies that nothing, not even a link, is at a bundle path that a
// program searches before a declared file (msb's guest kernel lookup), so
// the declared file is the one it loads. The parent is reached through the
// protected chain.
func (b *Bundle) Absent(relative string) error {
	parts := strings.Split(relative, "/")
	fd, err := walkProtected(filepath.Join(append([]string{b.root}, parts[:len(parts)-1]...)...))
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrUnapproved, relative, err)
	}
	defer unix.Close(fd)
	var info unix.Stat_t
	switch err := unix.Fstatat(fd, parts[len(parts)-1], &info, unix.AT_SYMLINK_NOFOLLOW); {
	case errors.Is(err, unix.ENOENT):
		return nil
	case err != nil:
		return fmt.Errorf("%w: stat %s: %v", ErrUnapproved, relative, err)
	}
	return fmt.Errorf("%w: %s exists and would be loaded instead of the declared file", ErrUnapproved, relative)
}

// File is a host file of the bundle (a program or a library) verified
// against the pinned manifest each time it is used: it is reopened through
// the protected chain, and any change in its identity since the last
// verification (device, inode, size, mode, owner, modification or change
// time) hashes it again. Only root or the running user can change it, and
// no change keeps all of those.
type File struct {
	bundle     *Bundle
	relative   string
	executable bool

	mu       sync.Mutex
	verified *unix.Stat_t
}

// Program is a file the host executes: its manifest entry must be executable.
func (b *Bundle) Program(relative string) *File {
	return &File{bundle: b, relative: relative, executable: true}
}

// Library is a file the host loads or maps (a dylib, the guest kernel).
func (b *Bundle) Library(relative string) *File {
	return &File{bundle: b, relative: relative}
}

// Path is the file's host path below the resolved bundle root.
func (f *File) Path() string { return f.bundle.Path(f.relative) }

// Check verifies the file against the pinned manifest now.
func (f *File) Check() error {
	entry, ok := f.bundle.entries[f.relative]
	if !ok || entry.Symlink != nil || (f.executable && entry.Mode&0o111 == 0) {
		return fmt.Errorf("%w: the bundle manifest declares no such file %s", ErrUnapproved, f.relative)
	}
	file, info, err := openProtected(f.bundle.root, f.relative)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrUnapproved, f.relative, err)
	}
	defer file.Close()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.verified != nil && sameFile(f.verified, info) {
		return nil
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("%w: read %s: %v", ErrUnapproved, f.relative, err)
	}
	if hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return fmt.Errorf("%w: %s differs from the bundle manifest", ErrUnapproved, f.relative)
	}
	if int(info.Mode&0o777) != entry.Mode {
		return fmt.Errorf("%w: %s mode differs from the bundle manifest", ErrUnapproved, f.relative)
	}
	// The identity is read again after hashing: a write while it was read
	// changes it, and the next use hashes again.
	var after unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &after); err != nil || !sameFile(info, &after) {
		return fmt.Errorf("%w: %s changed while it was verified", ErrUnapproved, f.relative)
	}
	f.verified = info
	return nil
}

func sameFile(a, b *unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size && a.Mode == b.Mode && a.Uid == b.Uid &&
		a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

// ProtectedDirectory verifies a host-state directory the backend was handed
// through name: absolute, with its symlinks resolved once, and every
// component from / owned by root or the running user and not writable by
// group or others. It answers the resolved path. The directory must exist.
func ProtectedDirectory(name, value string) (string, error) {
	if !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", fmt.Errorf("%w: %s=%s must be an absolute, clean path", ErrUnapproved, name, value)
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil {
		return "", fmt.Errorf("%w: %s=%s: %v", ErrUnapproved, name, value, err)
	}
	fd, err := walkProtected(resolved)
	if err != nil {
		return "", fmt.Errorf("%w: %s=%s: %v", ErrUnapproved, name, value, err)
	}
	_ = unix.Close(fd)
	return resolved, nil
}

// TrustedOwnership is the trust rule for one directory or file: owned by root
// or the running user, and not writable by group or others.
func TrustedOwnership(uid, mode uint32) bool {
	return (uid == 0 || int(uid) == os.Getuid()) && mode&0o022 == 0
}

func protectedOwner(info *unix.Stat_t) bool {
	return TrustedOwnership(info.Uid, uint32(info.Mode))
}

// readProtected reads one regular file below root within limit; the caller
// hashes exactly the bytes returned.
func readProtected(root, relative string, limit int64) ([]byte, uint32, error) {
	file, info, err := openProtected(root, relative)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	if info.Size > limit {
		return nil, 0, errors.New("exceeds the size bound")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, 0, err
	}
	if int64(len(data)) > limit {
		return nil, 0, errors.New("exceeds the size bound")
	}
	return data, uint32(info.Mode & 0o777), nil
}

// walkProtected opens directory by one descriptor walk from /: every
// component is opened without following a symlink and must satisfy
// TrustedOwnership. An error names the path that failed.
func walkProtected(directory string) (int, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open /: %w", err)
	}
	current := "/"
	var names []string
	if directory != "/" {
		names = strings.Split(strings.TrimPrefix(directory, "/"), "/")
	}
	for _, name := range append([]string{""}, names...) {
		if name != "" {
			child, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			_ = unix.Close(fd)
			current = filepath.Join(current, name)
			if err != nil {
				return -1, fmt.Errorf("open %s without following links: %w", current, err)
			}
			fd = child
		}
		var info unix.Stat_t
		if err := unix.Fstat(fd, &info); err != nil {
			_ = unix.Close(fd)
			return -1, fmt.Errorf("stat %s: %w", current, err)
		}
		if !protectedOwner(&info) {
			_ = unix.Close(fd)
			return -1, fmt.Errorf("%s is not owned by root or this user, or is writable by group or others", current)
		}
	}
	return fd, nil
}

// openProtected opens root/relative through one descriptor walk from /:
// every directory on the way and the file itself are opened without
// following any symlink and must satisfy TrustedOwnership. root has its
// symlinks resolved already, so a symlinked ancestor of the configured
// bundle is followed once, there, and its resolved chain is what is checked.
func openProtected(root, relative string) (*os.File, *unix.Stat_t, error) {
	parts := strings.Split(relative, "/")
	fd, err := walkProtected(filepath.Join(append([]string{root}, parts[:len(parts)-1]...)...))
	if err != nil {
		return nil, nil, err
	}
	name := parts[len(parts)-1]
	target := filepath.Join(root, filepath.FromSlash(relative))
	file, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	_ = unix.Close(fd)
	if err != nil {
		return nil, nil, fmt.Errorf("open %s without following links: %w", target, err)
	}
	var info unix.Stat_t
	if err := unix.Fstat(file, &info); err != nil {
		_ = unix.Close(file)
		return nil, nil, fmt.Errorf("stat %s: %w", target, err)
	}
	if info.Mode&unix.S_IFMT != unix.S_IFREG {
		_ = unix.Close(file)
		return nil, nil, fmt.Errorf("%s is not a regular file", target)
	}
	if !protectedOwner(&info) {
		_ = unix.Close(file)
		return nil, nil, fmt.Errorf("%s is not owned by root or this user, or is writable by group or others", target)
	}
	return os.NewFile(uintptr(file), target), &info, nil
}
