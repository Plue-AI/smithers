package microsandbox

import (
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/smithersai/smithers/packages/backend/installbundle"
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

// msb and the guest kernel library it loads are the bundle files that
// perform privileged guest operations. Both are verified before every msb
// run. msb 0.6.16 loads the first libkrunfw.5.dylib it finds:
// MSB_LIBKRUNFW_PATH (never in its fixed environment, cli.go), beside the
// resolved msb, its ../lib, then its state home's lib/ (traced with msb
// doctor). The kernel is declared in lib/, and nothing may be beside msb.
const (
	bundleMSBPath    = "bin/msb"
	bundleKernelGlob = "lib/libkrunfw*.dylib"
)

// ErrUnapprovedArtifact refuses a host file that the approved installed
// bundle does not declare with exactly these bytes and mode.
var ErrUnapprovedArtifact = installbundle.ErrUnapproved

var guestPathSyntax = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$`)

// startupChecks verifies, against the bundle the caller pinned, the msb this
// runtime drives, the guest kernel msb loads, and every file it will plant
// (the coding binding's helper and each of config.BundlePrograms). It
// answers the check every msb run repeats. A runtime without a bundle plants
// nothing, so it can name no program, and runs the msb config.Binary names.
func startupChecks(config Config) (string, func() error, error) {
	bundle := config.Bundle
	if bundle == nil {
		if len(config.BundlePrograms) > 0 {
			return "", nil, fmt.Errorf("%w: bundle programs require the installed bundle", ErrUnapprovedArtifact)
		}
		return config.Binary, nil, nil
	}
	if config.Binary != "" {
		return "", nil, fmt.Errorf("%w: msb comes only from the installed bundle's %s", ErrUnapprovedArtifact, bundleMSBPath)
	}
	msb := bundle.Program(bundleMSBPath)
	kernels := bundle.Matching(bundleKernelGlob)
	if len(kernels) == 0 {
		return "", nil, fmt.Errorf("%w: the bundle manifest declares no guest kernel %s", ErrUnapprovedArtifact, bundleKernelGlob)
	}
	files := []*installbundle.File{msb}
	var shadows []string
	for _, kernel := range kernels {
		files = append(files, bundle.Library(kernel))
		shadows = append(shadows, path.Join(path.Dir(bundleMSBPath), path.Base(kernel)))
	}
	verify := func() error {
		for _, file := range files {
			if err := file.Check(); err != nil {
				return err
			}
		}
		for _, shadow := range shadows {
			if err := bundle.Absent(shadow); err != nil {
				return err
			}
		}
		return nil
	}
	if err := verify(); err != nil {
		return "", nil, err
	}
	if _, _, err := codingHelperFrom(bundle); err != nil {
		return "", nil, err
	}
	for _, program := range config.BundlePrograms {
		relative, ok := bundle.Member(program)
		if !ok {
			return "", nil, fmt.Errorf("%w: %s is not a file of the installed bundle", ErrUnapprovedArtifact, program)
		}
		if _, _, err := plantable(bundle, relative); err != nil {
			return "", nil, err
		}
	}
	return msb.Path(), verify, nil
}

// bundleArtifact answers the manifest path of program when it names a file
// of the configured bundle. ok is false for anything else: a guest program.
func (r *Runtime) bundleArtifact(program string) (relative string, ok bool) {
	if r.config.Bundle == nil {
		return "", false
	}
	return r.config.Bundle.Member(program)
}

// plantable returns the bytes of one declared mode-0755 file that a guest may
// plant, only when they match the pinned manifest's digest and mode.
func plantable(bundle *installbundle.Bundle, relative string) ([]byte, string, error) {
	entry, ok := bundle.Entry(relative)
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
	data, entry, err := bundle.Read(relative, managedArtifactLimit)
	if err != nil {
		return nil, "", err
	}
	return data, entry.SHA256, nil
}
