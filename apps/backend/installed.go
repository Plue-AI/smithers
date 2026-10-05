package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
)

// Bundle members the backend loads, runs or reads at startup.
const (
	bundleFlowHosts  = "bin/flow-hosts.json"
	bundleFFILibrary = "bin/libsmithers_ffi.dylib"
	bundleNode       = "bin/node"
	bundleModelHost  = "bin/smithers-model-host"
	bundleGit        = "bin/git"
	bundleWebApp     = "views/mainview"
	flowHostsLimit   = 1 << 20
)

// gitDirectories are the bundle directories git reads its helper programs
// and repository templates from, by the variable that names each.
var gitDirectories = []struct{ name, directory string }{
	{"GIT_EXEC_PATH", "libexec/git-core"},
	{"GIT_TEMPLATE_DIR", "share/git-core/templates"},
}

// hostStateDirectories are the host-state directories, besides the data
// root and the PostgreSQL state, that a variable can name.
var hostStateDirectories = []string{"SMITHERS_REPO_STORAGE_PATH", "SMITHERS_BLOB_DATA_DIR", "SMITHERS_INSTALL_STATE_DIR",
	"SMITHERS_SSH_HOST_KEY_DIR", "SMITHERS_PACK_OBJECTS_CACHE_DIR", "SMITHERS_REPO_HOST_PACK_CACHE_DIR"}

// postgresPrograms are the PostgreSQL binaries the backend starts.
var postgresPrograms = []string{"postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"}

// hostInputs are the files and directories the backend loads, runs or keeps
// host state in. Beside an installed bundle each was verified against it.
type hostInputs struct {
	// bundle is the pinned installed bundle; nil in tests-only process mode.
	bundle   *installbundle.Bundle
	registry flowmanifest.Registry
	// dataRoot holds secrets, repositories and microVM metadata; stateRoot
	// holds the owned PostgreSQL data.
	dataRoot, stateRoot string
	// ffi is the repository engine library the backend dlopens; nil leaves
	// the engine's own resolution (process mode).
	ffi                          *installbundle.File
	node, modelHost, postgresBin string
	// environment is what the backend exports for the programs it starts
	// (git), each value verified against the bundle.
	environment map[string]string
}

// installedInputs pins the bundle the backend executable runs from, before
// anything else is loaded, and verifies every path the backend was handed
// against it (spec §17.3): an executable or library must be the bundle's own
// manifest member with the manifest's bytes, a host-state directory must be
// absolute and reached through a protected chain. A missing path answers the
// bundle's own member; nothing falls back to the working directory.
func installedInputs(executable string, getenv func(string) string) (hostInputs, error) {
	bundle, err := installbundle.OpenRunning(executable)
	if err != nil {
		return hostInputs{}, err
	}
	inputs := hostInputs{bundle: bundle}
	if inputs.dataRoot, err = protectedState("SMITHERS_DATA_ROOT", getenv("SMITHERS_DATA_ROOT")); err != nil {
		return hostInputs{}, err
	}
	inputs.stateRoot = inputs.dataRoot
	if state := strings.TrimSpace(getenv("SMITHERS_NATIVE_STATE_DIR")); state != "" {
		if inputs.stateRoot, err = protectedState("SMITHERS_NATIVE_STATE_DIR", state); err != nil {
			return hostInputs{}, err
		}
	}
	// Every other host-state directory defaults below the data root; one
	// handed elsewhere is held to the same rule. The repository host's pack
	// cache may be "off".
	for _, name := range hostStateDirectories {
		if value := strings.TrimSpace(getenv(name)); value != "" && !(name == "SMITHERS_REPO_HOST_PACK_CACHE_DIR" && value == "off") {
			if _, err := protectedState(name, value); err != nil {
				return hostInputs{}, err
			}
		}
	}
	// The Flow host manifest is parsed from the verified bytes, never read
	// again from a path.
	if value := strings.TrimSpace(getenv("SMITHERS_FLOW_HOST_MANIFEST")); value != "" {
		if relative, ok := bundle.Member(value); !filepath.IsAbs(value) || !ok || relative != bundleFlowHosts {
			return hostInputs{}, fmt.Errorf("%w: SMITHERS_FLOW_HOST_MANIFEST=%s is not the installed bundle's %s", installbundle.ErrUnapproved, value, bundleFlowHosts)
		}
	}
	data, _, err := bundle.Read(bundleFlowHosts, flowHostsLimit)
	if err != nil {
		return hostInputs{}, fmt.Errorf("SMITHERS_FLOW_HOST_MANIFEST: %w", err)
	}
	if inputs.registry, err = flowmanifest.Parse(data, bundle.Path("bin")); err != nil {
		return hostInputs{}, fmt.Errorf("load bundled Flow hosts: %w", err)
	}
	if _, err := bundle.Expect("SMITHERS_FFI_LIBRARY_PATH", strings.TrimSpace(getenv("SMITHERS_FFI_LIBRARY_PATH")), bundleFFILibrary, false); err != nil {
		return hostInputs{}, err
	}
	inputs.ffi = bundle.Library(bundleFFILibrary)
	if inputs.node, err = bundle.Expect("SMITHERS_NODE_BINARY", strings.TrimSpace(getenv("SMITHERS_NODE_BINARY")), bundleNode, true); err != nil {
		return hostInputs{}, err
	}
	if inputs.modelHost, err = bundle.Expect("SMITHERS_MODEL_HOST_BUNDLE", strings.TrimSpace(getenv("SMITHERS_MODEL_HOST_BUNDLE")), bundleModelHost, true); err != nil {
		return hostInputs{}, err
	}
	if value := strings.TrimSpace(getenv("SMITHERS_NATIVE_POSTGRES_BIN")); value != "" {
		if inputs.postgresBin, err = bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", value, postgresPrograms...); err != nil {
			return hostInputs{}, err
		}
	}
	if value := strings.TrimSpace(getenv("SMITHERS_WEB_ROOT")); value != "" {
		if _, err := bundle.ExpectDirectory("SMITHERS_WEB_ROOT", value, bundleWebApp); err != nil {
			return hostInputs{}, err
		}
	}
	if inputs.environment, err = gitEnvironment(bundle, getenv); err != nil {
		return hostInputs{}, err
	}
	return inputs, nil
}

// gitEnvironment verifies the git the backend runs by name, as PATH
// resolves it, and the directories git reads its helpers and templates
// from, and answers the variables that keep every git the backend starts on
// them with no system or user configuration. An unset directory variable
// answers the bundle's own.
func gitEnvironment(bundle *installbundle.Bundle, getenv func(string) string) (map[string]string, error) {
	git, err := lookPath("git", getenv("PATH"))
	if err != nil {
		return nil, fmt.Errorf("%w: PATH: %v", installbundle.ErrUnapproved, err)
	}
	if _, err := bundle.Expect("PATH", git, bundleGit, true); err != nil {
		return nil, err
	}
	environment := map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.DevNull, "GIT_CONFIG_SYSTEM": os.DevNull}
	for _, name := range []string{"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"} {
		if value := strings.TrimSpace(getenv(name)); value != "" && value != os.DevNull {
			return nil, fmt.Errorf("%w: %s=%s: beside an installed bundle git reads no configuration file", installbundle.ErrUnapproved, name, value)
		}
	}
	for _, variable := range gitDirectories {
		value := strings.TrimSpace(getenv(variable.name))
		if value == "" {
			value = bundle.Path(variable.directory)
		}
		directory, err := bundle.ExpectDirectory(variable.name, value, variable.directory)
		if err != nil {
			return nil, err
		}
		environment[variable.name] = directory
	}
	return environment, nil
}

// lookPath resolves name through the search path list as os/exec does,
// refusing a match relative to the working directory, which os/exec would
// refuse to run.
func lookPath(name, list string) (string, error) {
	for _, directory := range filepath.SplitList(list) {
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			continue
		}
		if !filepath.IsAbs(candidate) {
			return "", fmt.Errorf("%s resolves to %s, relative to the working directory", name, candidate)
		}
		return candidate, nil
	}
	return "", fmt.Errorf("%s is not on it", name)
}

// protectedState verifies a host-state directory handed through name,
// creating it private first when it is absent.
func protectedState(name, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: %s is required beside an installed bundle", installbundle.ErrUnapproved, name)
	}
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("%w: %s=%s is not an absolute path", installbundle.ErrUnapproved, name, value)
	}
	if err := os.MkdirAll(value, 0o700); err != nil {
		return "", fmt.Errorf("create %s=%s: %w", name, value, err)
	}
	return installbundle.ProtectedDirectory(name, filepath.Clean(value))
}

// processInputs reads the tests-only process mode's inputs as given.
func processInputs(getenv func(string) string) (hostInputs, error) {
	manifestPath := strings.TrimSpace(getenv("SMITHERS_FLOW_HOST_MANIFEST"))
	if manifestPath == "" {
		return hostInputs{}, errors.New("SMITHERS_FLOW_HOST_MANIFEST is required to serve the packaged Flow hosts")
	}
	registry, err := flowmanifest.Load(manifestPath)
	if err != nil {
		return hostInputs{}, fmt.Errorf("load bundled Flow hosts: %w", err)
	}
	inputs := hostInputs{registry: registry, dataRoot: getenv("SMITHERS_DATA_ROOT"),
		node: strings.TrimSpace(getenv("SMITHERS_NODE_BINARY")), modelHost: strings.TrimSpace(getenv("SMITHERS_MODEL_HOST_BUNDLE")),
		postgresBin: strings.TrimSpace(getenv("SMITHERS_NATIVE_POSTGRES_BIN"))}
	inputs.stateRoot = strings.TrimSpace(getenv("SMITHERS_NATIVE_STATE_DIR"))
	if inputs.stateRoot == "" {
		inputs.stateRoot = inputs.dataRoot
	}
	return inputs, nil
}
