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
// loaded. A later change to manifest.json approves nothing: every planted
// file is checked against these entries.
type approvedBundle struct {
	// root is the bundle directory with its own symlinks resolved; nothing
	// inside it may be a symlink on the way to a planted file.
	root    string
	digest  string
	entries map[string]bundleEntry
}

type approvedBundleCache struct {
	once   sync.Once
	bundle *approvedBundle
	err    error
}

// approvedBundle loads Config.Bundle once. A runtime without one plants
// nothing: no host file reaches a guest.
func (r *Runtime) approvedBundle() (*approvedBundle, error) {
	r.bundle.once.Do(func() {
		r.bundle.bundle, r.bundle.err = loadApprovedBundle(r.config.Bundle)
	})
	return r.bundle.bundle, r.bundle.err
}

// startupBundle loads and pins config.Bundle before the runtime starts and
// checks every file it will plant: the coding binding's helper and each of
// config.BundlePrograms. A runtime without a bundle plants nothing, so it
// cannot name a program.
func startupBundle(config Config) (*approvedBundle, error) {
	if config.Bundle == "" {
		if len(config.BundlePrograms) > 0 {
			return nil, fmt.Errorf("%w: bundle programs require the installed bundle", ErrUnapprovedArtifact)
		}
		return nil, nil
	}
	bundle, err := loadApprovedBundle(config.Bundle)
	if err != nil {
		return nil, err
	}
	if _, _, err := codingHelperFrom(bundle); err != nil {
		return nil, err
	}
	for _, program := range config.BundlePrograms {
		relative, ok := bundleRelative(config.Bundle, program)
		if !ok {
			relative, ok = bundleRelative(bundle.root, program)
		}
		if !ok {
			return nil, fmt.Errorf("%w: %s is not a file of the installed bundle", ErrUnapprovedArtifact, program)
		}
		if _, _, err := bundle.read(relative); err != nil {
			return nil, err
		}
	}
	return bundle, nil
}

func loadApprovedBundle(root string) (*approvedBundle, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, fmt.Errorf("%w: the installed bundle path must be absolute and clean", ErrUnapprovedArtifact)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve the installed bundle: %v", ErrUnapprovedArtifact, err)
	}
	data, err := readBundleFile(resolved, "manifest.json", bundleManifestLimit)
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
	return &approvedBundle{root: resolved, digest: hex.EncodeToString(sum[:]), entries: entries}, nil
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

// read returns the bytes of one declared mode-0755 file, read by descriptor
// from the resolved bundle root without following any symlink, and only when
// they match the pinned manifest's digest and mode.
func (b *approvedBundle) read(relative string) ([]byte, string, error) {
	entry, ok := b.entries[relative]
	parts := strings.Split(relative, "/")
	switch {
	case !ok:
		return nil, "", fmt.Errorf("%w: %s is not declared by the bundle manifest", ErrUnapprovedArtifact, relative)
	case entry.Symlink != nil:
		return nil, "", fmt.Errorf("%w: %s is a symlink", ErrUnapprovedArtifact, relative)
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
	data, mode, err := readBundleBytes(b.root, relative, managedArtifactLimit)
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

func readBundleFile(root, relative string, limit int64) ([]byte, error) {
	data, _, err := readBundleBytes(root, relative, limit)
	return data, err
}

// readBundleBytes opens every directory below root and the file itself by
// descriptor with O_NOFOLLOW, so a symlink anywhere inside the bundle is
// refused rather than followed, and hashes exactly the bytes it returns.
func readBundleBytes(root, relative string, limit int64) ([]byte, uint32, error) {
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, 0, err
	}
	parts := strings.Split(relative, "/")
	for _, name := range parts[:len(parts)-1] {
		child, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		_ = unix.Close(fd)
		if err != nil {
			return nil, 0, fmt.Errorf("open %s without following links: %w", name, err)
		}
		fd = child
	}
	file, err := unix.Openat(fd, parts[len(parts)-1], unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	_ = unix.Close(fd)
	if err != nil {
		return nil, 0, fmt.Errorf("open without following links: %w", err)
	}
	handle := os.NewFile(uintptr(file), relative)
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, 0, errors.New("not a regular file within the size bound")
	}
	data, err := io.ReadAll(io.LimitReader(handle, limit+1))
	if err != nil {
		return nil, 0, err
	}
	if int64(len(data)) > limit {
		return nil, 0, errors.New("exceeds the size bound")
	}
	return data, uint32(info.Mode().Perm()), nil
}
