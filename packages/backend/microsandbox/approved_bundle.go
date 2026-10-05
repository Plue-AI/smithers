package microsandbox

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
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// guestBundleRoot is where approved bundle files are planted in a guest. The
// guest helper creates it and every directory under it root-owned and
// protected, and never follows a symlink there.
const guestBundleRoot = "/opt/smithers/bundle"

// managedArtifactLimit bounds one planted file; the guest helper applies the
// same bound to the bytes it receives.
const managedArtifactLimit = 64 << 20

// managedArtifactDepth and managedArtifactMode are the guest helper's own
// bounds: a planted path has at most this many segments, and every planted
// file is written with this mode, so only a manifest entry with exactly it
// is planted.
const (
	managedArtifactDepth = 8
	managedArtifactMode  = 0o755
)

// bundleManifestLimit bounds the installed bundle's manifest.json.
const bundleManifestLimit = 16 << 20

// The two host programs that perform privileged guest operations: the
// backend itself and the Microsandbox CLI it drives. Both are files of the
// bundle at these manifest paths.
const (
	bundleBackendPath = "bin/smithers-backend"
	bundleMSBPath     = "bin/msb"
)

// ErrUnapprovedArtifact refuses a managed host file that the approved
// installed bundle does not declare with exactly these bytes and mode.
var ErrUnapprovedArtifact = errors.New("managed host artifact is not approved by the installed bundle")

var (
	bundleRevision  = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
	bundleDigest    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	guestPathSyntax = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$`)
)

// bundleEntry is one file of the install bundle's manifest.json, the record
// `smthrs host start` verified before it started this backend.
type bundleEntry struct {
	Path    string  `json:"path"`
	SHA256  string  `json:"sha256"`
	Stage   string  `json:"stage"`
	Mode    int     `json:"mode"`
	Symlink *string `json:"symlink,omitempty"`
}

// approvedBundle is the installed bundle's manifest, pinned when it is first
// loaded. A later change to manifest.json approves nothing: every file the
// backend runs or plants is checked against these entries when it is used.
type approvedBundle struct {
	// root is the bundle directory with its own symlinks resolved once; the
	// resolved chain from / is what every use walks and checks.
	root     string
	revision string
	// digest is manifest.json's own sha256, the value an operator compares
	// with the release build's manifest.
	digest  string
	entries map[string]bundleEntry
}

type approvedBundleCache struct {
	once   sync.Once
	bundle *approvedBundle
	err    error
}

// approvedBundle answers the bundle New pinned. A runtime without one plants
// nothing: no host file reaches a guest.
func (r *Runtime) approvedBundle() (*approvedBundle, error) {
	r.bundle.once.Do(func() {
		r.bundle.bundle, r.bundle.err = loadApprovedBundle(r.config.Bundle)
	})
	return r.bundle.bundle, r.bundle.err
}

// ApprovedBundle reports the pinned bundle's directory, manifest revision and
// manifest sha256 for the startup log; ok is false for a runtime without one.
func (r *Runtime) ApprovedBundle() (root, revision, manifestSHA256 string, ok bool) {
	if r.config.Bundle == "" {
		return "", "", "", false
	}
	bundle, err := r.approvedBundle()
	if err != nil {
		return "", "", "", false
	}
	return bundle.root, bundle.revision, bundle.digest, true
}

// startupBundle pins config.Bundle before the runtime starts and verifies,
// against that one pinned manifest, the backend's own executable, the msb it
// will drive, every file it will plant (the coding binding's helper and each
// of config.BundlePrograms) and every input file it read (config.BundleFiles).
// It answers the verified msb. A runtime without a bundle plants nothing, so
// it can name no program, and runs the msb config.Binary names.
func startupBundle(config Config) (*approvedBundle, *bundleProgram, error) {
	if config.Bundle == "" {
		if len(config.BundlePrograms) > 0 || len(config.BundleFiles) > 0 || config.Executable != "" {
			return nil, nil, fmt.Errorf("%w: bundle programs require the installed bundle", ErrUnapprovedArtifact)
		}
		return nil, nil, nil
	}
	if config.Binary != "" {
		return nil, nil, fmt.Errorf("%w: msb comes only from the installed bundle's %s", ErrUnapprovedArtifact, bundleMSBPath)
	}
	bundle, err := loadApprovedBundle(config.Bundle)
	if err != nil {
		return nil, nil, err
	}
	if relative, ok := bundle.member(config.Executable); !ok || relative != bundleBackendPath {
		return nil, nil, fmt.Errorf("%w: the running backend %s is not the bundle's %s", ErrUnapprovedArtifact, config.Executable, bundleBackendPath)
	}
	if err := bundle.program(bundleBackendPath).check(); err != nil {
		return nil, nil, err
	}
	msb := bundle.program(bundleMSBPath)
	if err := msb.check(); err != nil {
		return nil, nil, err
	}
	if _, _, err := codingHelperFrom(bundle); err != nil {
		return nil, nil, err
	}
	for _, program := range config.BundlePrograms {
		relative, ok := bundle.member(program)
		if !ok {
			return nil, nil, fmt.Errorf("%w: %s is not a file of the installed bundle", ErrUnapprovedArtifact, program)
		}
		if _, _, err := bundle.read(relative); err != nil {
			return nil, nil, err
		}
	}
	for _, file := range config.BundleFiles {
		relative, ok := bundle.member(file)
		if !ok {
			return nil, nil, fmt.Errorf("%w: %s is not a file of the installed bundle", ErrUnapprovedArtifact, file)
		}
		if _, _, err := bundle.verified(relative, bundleManifestLimit); err != nil {
			return nil, nil, err
		}
	}
	return bundle, msb, nil
}

func loadApprovedBundle(root string) (*approvedBundle, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, fmt.Errorf("%w: the installed bundle path must be absolute and clean", ErrUnapprovedArtifact)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve the installed bundle: %v", ErrUnapprovedArtifact, err)
	}
	data, err := readProtected(resolved, "manifest.json", bundleManifestLimit)
	if err != nil {
		return nil, fmt.Errorf("%w: read the bundle manifest: %v", ErrUnapprovedArtifact, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest struct {
		Version  int           `json:"version"`
		Platform string        `json:"platform"`
		Revision string        `json:"revision"`
		Files    []bundleEntry `json:"files"`
	}
	if err := decoder.Decode(&manifest); err != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("%w: the bundle manifest is not one JSON document", ErrUnapprovedArtifact)
	}
	if manifest.Version != 1 || manifest.Platform != "darwin-arm64" || !bundleRevision.MatchString(manifest.Revision) || len(manifest.Files) == 0 {
		return nil, fmt.Errorf("%w: the bundle manifest is invalid", ErrUnapprovedArtifact)
	}
	entries := make(map[string]bundleEntry, len(manifest.Files))
	for _, entry := range manifest.Files {
		_, duplicate := entries[entry.Path]
		if duplicate || !bundleRelativePath(entry.Path) || !bundleDigest.MatchString(entry.SHA256) ||
			strings.TrimSpace(entry.Stage) == "" || entry.Mode < 0 || entry.Mode > 0o777 {
			return nil, fmt.Errorf("%w: the bundle manifest entry %q is invalid", ErrUnapprovedArtifact, entry.Path)
		}
		entries[entry.Path] = entry
	}
	sum := sha256.Sum256(data)
	return &approvedBundle{root: resolved, revision: manifest.Revision, digest: hex.EncodeToString(sum[:]), entries: entries}, nil
}

// bundleRelativePath is a manifest path: relative, slash-separated, with no
// empty, "." or ".." element.
func bundleRelativePath(value string) bool {
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

// member answers the manifest path of an absolute host path below the bundle,
// as configured or with its symlinks resolved; ok is false for anything else.
func (b *approvedBundle) member(program string) (string, bool) {
	if !filepath.IsAbs(program) {
		return "", false
	}
	if relative, ok := bundleRelative(b.root, program); ok {
		return relative, true
	}
	resolved, err := filepath.EvalSymlinks(program)
	if err != nil {
		return "", false
	}
	return bundleRelative(b.root, resolved)
}

// bundleArtifact answers the manifest path of program when it names a file
// of the configured bundle. ok is false for anything else: a guest program.
func (r *Runtime) bundleArtifact(program string) (relative string, ok bool, err error) {
	if r.config.Bundle == "" {
		return "", false, nil
	}
	relative, ok = bundleRelative(r.config.Bundle, program)
	bundle, err := r.approvedBundle()
	if !ok && err == nil {
		relative, ok = bundleRelative(bundle.root, program)
	}
	if !ok {
		return "", false, nil
	}
	return relative, true, err
}

// bundleRelative is the slash-separated path of an absolute program below
// root; ok is false for root itself and anything outside it.
func bundleRelative(root, program string) (string, bool) {
	if !filepath.IsAbs(program) {
		return "", false
	}
	rel, err := filepath.Rel(root, filepath.Clean(program))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// read returns the bytes of one declared mode-0755 file that a guest may
// plant, only when they match the pinned manifest's digest and mode.
func (b *approvedBundle) read(relative string) ([]byte, string, error) {
	entry, ok := b.entries[relative]
	parts := strings.Split(relative, "/")
	switch {
	case !ok:
		return nil, "", fmt.Errorf("%w: %s is not declared by the bundle manifest", ErrUnapprovedArtifact, relative)
	case entry.Mode != managedArtifactMode:
		return nil, "", fmt.Errorf("%w: %s is not a mode 0755 executable", ErrUnapprovedArtifact, relative)
	case len(parts) > managedArtifactDepth:
		return nil, "", fmt.Errorf("%w: %s is deeper than %d segments", ErrUnapprovedArtifact, relative, managedArtifactDepth)
	}
	for _, part := range parts {
		if !guestPathSyntax.MatchString(part) {
			return nil, "", fmt.Errorf("%w: %s is not a plantable path", ErrUnapprovedArtifact, relative)
		}
	}
	return b.verified(relative, managedArtifactLimit)
}

// verified returns the bytes of one declared regular file, read through the
// protected chain, only when they and its mode match the pinned manifest.
func (b *approvedBundle) verified(relative string, limit int64) ([]byte, string, error) {
	entry, ok := b.entries[relative]
	switch {
	case !ok:
		return nil, "", fmt.Errorf("%w: %s is not declared by the bundle manifest", ErrUnapprovedArtifact, relative)
	case entry.Symlink != nil:
		return nil, "", fmt.Errorf("%w: %s is a symlink", ErrUnapprovedArtifact, relative)
	}
	data, mode, err := readProtectedBytes(b.root, relative, limit)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %s: %v", ErrUnapprovedArtifact, relative, err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != entry.SHA256 {
		return nil, "", fmt.Errorf("%w: %s differs from the bundle manifest", ErrUnapprovedArtifact, relative)
	}
	if int(mode) != entry.Mode {
		return nil, "", fmt.Errorf("%w: %s mode differs from the bundle manifest", ErrUnapprovedArtifact, relative)
	}
	return data, entry.SHA256, nil
}

// bundleProgram is a host program of the bundle (the backend or msb),
// verified against the pinned manifest each time it is used: the file is
// reopened through the protected chain, and any change in its identity since
// the last verification (device, inode, size, mode, owner, modification or
// change time) hashes it again. Only root or the running user can change it,
// and no change keeps all of those.
type bundleProgram struct {
	bundle   *approvedBundle
	relative string
	path     string

	mu       sync.Mutex
	verified *unix.Stat_t
}

func (b *approvedBundle) program(relative string) *bundleProgram {
	return &bundleProgram{bundle: b, relative: relative, path: filepath.Join(b.root, filepath.FromSlash(relative))}
}

func (p *bundleProgram) check() error {
	entry, ok := p.bundle.entries[p.relative]
	if !ok || entry.Symlink != nil || entry.Mode&0o111 == 0 {
		return fmt.Errorf("%w: the bundle manifest declares no executable %s", ErrUnapprovedArtifact, p.relative)
	}
	file, info, err := openProtected(p.bundle.root, p.relative)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrUnapprovedArtifact, p.relative, err)
	}
	defer file.Close()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.verified != nil && sameFile(p.verified, info) {
		return nil
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("%w: read %s: %v", ErrUnapprovedArtifact, p.relative, err)
	}
	if hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return fmt.Errorf("%w: %s differs from the bundle manifest", ErrUnapprovedArtifact, p.relative)
	}
	if int(info.Mode&0o777) != entry.Mode {
		return fmt.Errorf("%w: %s mode differs from the bundle manifest", ErrUnapprovedArtifact, p.relative)
	}
	// The identity is read again after hashing: a write while it was read
	// changes it, and the next use hashes again.
	var after unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &after); err != nil || !sameFile(info, &after) {
		return fmt.Errorf("%w: %s changed while it was verified", ErrUnapprovedArtifact, p.relative)
	}
	p.verified = info
	return nil
}

func sameFile(a, b *unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size && a.Mode == b.Mode && a.Uid == b.Uid &&
		a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

// protectedOwner is the bundle's trust rule for one directory or file: owned
// by root or the running user, and not writable by group or others.
func protectedOwner(info *unix.Stat_t) bool {
	return trustedOwnership(info.Uid, uint32(info.Mode))
}

func trustedOwnership(uid, mode uint32) bool {
	return (uid == 0 || int(uid) == os.Getuid()) && mode&0o022 == 0
}

func readProtected(root, relative string, limit int64) ([]byte, error) {
	data, _, err := readProtectedBytes(root, relative, limit)
	return data, err
}

// readProtectedBytes reads one regular file below root within limit and
// hashes nothing itself: the caller hashes exactly the bytes returned.
func readProtectedBytes(root, relative string, limit int64) ([]byte, uint32, error) {
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

// openProtected opens root/relative through one descriptor walk from /: every
// directory on the way, the bundle root and those inside it, and the file
// itself are opened without following any symlink, and each must be owned by
// root or the running user and not writable by group or others. root has its
// symlinks resolved already, so a symlinked ancestor of the configured bundle
// is followed once, there, and its resolved chain is what is checked. An
// error names the path that failed.
func openProtected(root, relative string) (*os.File, *unix.Stat_t, error) {
	names := strings.Split(strings.TrimPrefix(root, "/"), "/")
	if root == "/" {
		names = nil
	}
	parts := strings.Split(relative, "/")
	names = append(names, parts[:len(parts)-1]...)
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /: %w", err)
	}
	current := "/"
	for _, name := range append([]string{""}, names...) {
		if name != "" {
			child, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			_ = unix.Close(fd)
			current = filepath.Join(current, name)
			if err != nil {
				return nil, nil, fmt.Errorf("open %s without following links: %w", current, err)
			}
			fd = child
		}
		var info unix.Stat_t
		if err := unix.Fstat(fd, &info); err != nil {
			_ = unix.Close(fd)
			return nil, nil, fmt.Errorf("stat %s: %w", current, err)
		}
		if !protectedOwner(&info) {
			_ = unix.Close(fd)
			return nil, nil, fmt.Errorf("%s is not owned by root or this user, or is writable by group or others", current)
		}
	}
	name := parts[len(parts)-1]
	target := filepath.Join(current, name)
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
