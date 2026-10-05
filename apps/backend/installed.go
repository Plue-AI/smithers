package main

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/installbundle"
)

// Bundle members the backend loads, runs or reads at startup.
const (
	bundleFlowHosts  = "bin/flow-hosts.json"
	bundleFFILibrary = "bin/libsmithers_ffi.dylib"
	bundleNode       = "bin/node"
	bundleModelHost  = "bin/smithers-model-host"
	bundleGit        = "bin/git"
	bundleJJ         = "bin/jj"
	bundleWebApp     = "views/mainview"
	flowHostsLimit   = 1 << 20
)

// systemPath follows the bundle's bin directory on every PATH the backend
// sets: directories only the operating system writes.
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin"

// gitDirectories are the bundle directories git reads its helper programs
// and repository templates from, by the variable that names each.
var gitDirectories = []struct{ name, directory string }{
	{"GIT_EXEC_PATH", "libexec/git-core"},
	{"GIT_TEMPLATE_DIR", "share/git-core/templates"},
}

// hostStateDirectories are the host-state directories, besides the data
// root and the PostgreSQL state, that a variable can name.
var hostStateDirectories = []string{"SMITHERS_REPO_STORAGE_PATH", "SMITHERS_BLOB_DATA_DIR", "SMITHERS_INSTALL_STATE_DIR",
	"SMITHERS_SSH_HOST_KEY_DIR", "SMITHERS_REPO_HOST_PACK_CACHE_DIR"}

// postgresPrograms are the PostgreSQL binaries the backend starts.
var postgresPrograms = []string{"postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"}

// passedValues are the launcher's variables whose values name no file: the
// backend keeps them as given. The GitHub base URLs, like the proxy
// variables, choose where GitHub requests go; the no-GitHub walk points them
// at its GitHub fake (apps/app/scripts/run-local-no-github.ts).
var passedValues = []string{
	"USER", "LOGNAME", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SMITHERS_GITHUB_APP_API_BASE_URL", "SMITHERS_AUTH_GITHUB_API_BASE_URL", "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL",
	"SMITHERS_WORKSPACE_ISOLATION", "SMITHERS_AUTH_MODE", "SMITHERS_NATIVE_POSTGRES_MAJOR",
	"SMITHERS_SERVER_ADDR", "SMITHERS_EGRESS_RELAY_PORT", "SMITHERS_SSH_ADDR",
}

// childValues are the variables, of the backend's own environment, that the
// programs it starts get (hostexec); no SMITHERS_* setting reaches them.
var childValues = []string{"PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR"}

// allowedGit are the git variables the launcher passes; each must hold the
// value the backend would set.
var allowedGit = map[string]bool{"GIT_EXEC_PATH": true, "GIT_TEMPLATE_DIR": true, "GIT_CONFIG_NOSYSTEM": true,
	"GIT_CONFIG_GLOBAL": true, "GIT_CONFIG_SYSTEM": true}

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
	// environment is the backend's whole environment beside a bundle, built
	// from the allowlist with every path replaced by its verified,
	// canonical target; host is what the programs it starts get.
	environment map[string]string
	host        hostexec.Config
}

// refuseInjected refuses, naming it, any variable of the environment that
// can change what the backend or a program it starts loads or runs without
// being named on a command line: a dynamic-loader variable (DYLD_*, LD_*)
// or a git variable other than the five the launcher passes (spec §17.3,
// ruling (a)). It runs before anything is loaded.
func refuseInjected(environ []string) error {
	var names []string
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		if hostexec.Injected(name) && !allowedGit[name] {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	sort.Strings(names)
	return fmt.Errorf("%w: %s is set: beside an installed bundle the backend refuses dynamic-loader and git injection variables", installbundle.ErrUnapproved, names[0])
}

// installedInputs pins the bundle the backend executable runs from, before
// anything else is loaded, and verifies every path the backend was handed
// against it (spec §17.3): an executable or library must be the bundle's own
// manifest member with the manifest's bytes, a host-state directory must be
// absolute and reached through a protected chain. A missing path answers the
// bundle's own member; nothing falls back to the working directory. It
// builds the backend's environment from the launcher's allowlist, each path
// replaced by the verified target a consumer must use.
func installedInputs(executable string, getenv func(string) string) (hostInputs, error) {
	bundle, err := installbundle.OpenRunning(executable)
	if err != nil {
		return hostInputs{}, err
	}
	inputs := hostInputs{bundle: bundle, environment: map[string]string{}}
	env := inputs.environment
	for _, name := range passedValues {
		if value := strings.TrimSpace(getenv(name)); value != "" {
			env[name] = value
		}
	}
	env["PATH"] = bundle.Path("bin") + string(filepath.ListSeparator) + systemPath
	if env["HOME"], err = accountHome(); err != nil {
		return hostInputs{}, fmt.Errorf("resolve the account home directory: %w", err)
	}
	if value := strings.TrimSpace(getenv("TMPDIR")); value != "" {
		if env["TMPDIR"], err = protectedState("TMPDIR", value, false); err != nil {
			return hostInputs{}, err
		}
	}
	if value := strings.TrimSpace(getenv("SSL_CERT_DIR")); value != "" {
		if env["SSL_CERT_DIR"], err = protectedState("SSL_CERT_DIR", value, false); err != nil {
			return hostInputs{}, err
		}
	}
	if value := strings.TrimSpace(getenv("SSL_CERT_FILE")); value != "" {
		if env["SSL_CERT_FILE"], err = installbundle.ProtectedFile("SSL_CERT_FILE", value); err != nil {
			return hostInputs{}, err
		}
	}

	if inputs.dataRoot, err = protectedState("SMITHERS_DATA_ROOT", getenv("SMITHERS_DATA_ROOT"), true); err != nil {
		return hostInputs{}, err
	}
	env["SMITHERS_DATA_ROOT"] = inputs.dataRoot
	inputs.stateRoot = inputs.dataRoot
	if state := strings.TrimSpace(getenv("SMITHERS_NATIVE_STATE_DIR")); state != "" {
		if inputs.stateRoot, err = protectedState("SMITHERS_NATIVE_STATE_DIR", state, true); err != nil {
			return hostInputs{}, err
		}
		env["SMITHERS_NATIVE_STATE_DIR"] = inputs.stateRoot
	}
	// Every other host-state directory defaults below the data root; one
	// handed elsewhere is held to the same rule. The repository host's pack
	// cache may be "off".
	for _, name := range hostStateDirectories {
		value := strings.TrimSpace(getenv(name))
		switch {
		case value == "":
		case name == "SMITHERS_REPO_HOST_PACK_CACHE_DIR" && value == "off":
			env[name] = value
		default:
			if env[name], err = protectedState(name, value, true); err != nil {
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
	env["SMITHERS_FLOW_HOST_MANIFEST"] = bundle.Path(bundleFlowHosts)
	if env["SMITHERS_FFI_LIBRARY_PATH"], err = bundle.Expect("SMITHERS_FFI_LIBRARY_PATH", strings.TrimSpace(getenv("SMITHERS_FFI_LIBRARY_PATH")), bundleFFILibrary, false); err != nil {
		return hostInputs{}, err
	}
	inputs.ffi = bundle.Library(bundleFFILibrary)
	if inputs.node, err = bundle.Expect("SMITHERS_NODE_BINARY", strings.TrimSpace(getenv("SMITHERS_NODE_BINARY")), bundleNode, true); err != nil {
		return hostInputs{}, err
	}
	env["SMITHERS_NODE_BINARY"] = inputs.node
	if inputs.modelHost, err = bundle.Expect("SMITHERS_MODEL_HOST_BUNDLE", strings.TrimSpace(getenv("SMITHERS_MODEL_HOST_BUNDLE")), bundleModelHost, true); err != nil {
		return hostInputs{}, err
	}
	env["SMITHERS_MODEL_HOST_BUNDLE"] = inputs.modelHost
	// The backend's PostgreSQL is the bundle's own: beside a bundle there is
	// no external database.
	postgresBin := strings.TrimSpace(getenv("SMITHERS_NATIVE_POSTGRES_BIN"))
	if postgresBin == "" {
		return hostInputs{}, fmt.Errorf("%w: SMITHERS_NATIVE_POSTGRES_BIN is required beside an installed bundle", installbundle.ErrUnapproved)
	}
	if inputs.postgresBin, err = bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", postgresBin, postgresPrograms...); err != nil {
		return hostInputs{}, err
	}
	env["SMITHERS_NATIVE_POSTGRES_BIN"] = inputs.postgresBin
	if value := strings.TrimSpace(getenv("SMITHERS_WEB_ROOT")); value != "" {
		if env["SMITHERS_WEB_ROOT"], err = bundle.ExpectDirectory("SMITHERS_WEB_ROOT", value, bundleWebApp); err != nil {
			return hostInputs{}, err
		}
	}
	if err := gitEnvironment(bundle, getenv, &inputs); err != nil {
		return hostInputs{}, err
	}
	return inputs, nil
}

// gitEnvironment verifies the git and jj the backend and its repository
// engine run (the bundle's bin/git and bin/jj, first on the PATH the backend
// sets) and the directories git reads its helpers and templates from, and
// sets the variables that keep every git on them with no system or user
// configuration. An unset directory variable answers the bundle's own.
func gitEnvironment(bundle *installbundle.Bundle, getenv func(string) string, inputs *hostInputs) error {
	git, err := bundle.Expect("git", "", bundleGit, true)
	if err != nil {
		return err
	}
	if _, err := bundle.Expect("jj", "", bundleJJ, true); err != nil {
		return err
	}
	if value := strings.TrimSpace(getenv("GIT_CONFIG_NOSYSTEM")); value != "" && value != "1" {
		return fmt.Errorf("%w: GIT_CONFIG_NOSYSTEM=%s: beside an installed bundle git reads no system configuration", installbundle.ErrUnapproved, value)
	}
	for _, name := range []string{"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"} {
		if value := strings.TrimSpace(getenv(name)); value != "" && value != os.DevNull {
			return fmt.Errorf("%w: %s=%s: beside an installed bundle git reads no configuration file", installbundle.ErrUnapproved, name, value)
		}
	}
	env := inputs.environment
	env["GIT_CONFIG_NOSYSTEM"], env["GIT_CONFIG_GLOBAL"], env["GIT_CONFIG_SYSTEM"] = "1", os.DevNull, os.DevNull
	directories := map[string]string{}
	for _, variable := range gitDirectories {
		value := strings.TrimSpace(getenv(variable.name))
		if value == "" {
			value = bundle.Path(variable.directory)
		}
		directory, err := bundle.ExpectDirectory(variable.name, value, variable.directory)
		if err != nil {
			return err
		}
		env[variable.name], directories[variable.name] = directory, directory
	}
	inputs.host = hostexec.Config{Git: git, GitExecPath: directories["GIT_EXEC_PATH"], GitTemplateDir: directories["GIT_TEMPLATE_DIR"]}
	for _, name := range childValues {
		if value, ok := env[name]; ok {
			inputs.host.Environment = append(inputs.host.Environment, name+"="+value)
		}
	}
	return nil
}

// applyEnvironment replaces the backend's whole environment with the one it
// built: from here every variable a consumer reads, and every program the
// backend or its repository engine starts, sees only it.
func applyEnvironment(inputs hostInputs) error {
	os.Clearenv()
	for name, value := range inputs.environment {
		if err := os.Setenv(name, value); err != nil {
			return err
		}
	}
	_, err := hostexec.Configure(inputs.host)
	return err
}

// accountHome is the running account's home directory from the user
// database; the environment's HOME is never read.
func accountHome() (string, error) {
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(account.HomeDir) {
		return "", fmt.Errorf("home directory %q is not absolute", account.HomeDir)
	}
	return filepath.Clean(account.HomeDir), nil
}

// protectedState verifies a host-state directory handed through name and
// answers its canonical path, the one every consumer must use. The chain
// from / to the directory, or to its nearest existing ancestor, is checked
// before anything is created; create then makes the missing part private,
// and without create a missing directory answers its clean path.
func protectedState(name, value string, create bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: %s is required beside an installed bundle", installbundle.ErrUnapproved, name)
	}
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("%w: %s=%s is not an absolute path", installbundle.ErrUnapproved, name, value)
	}
	value = filepath.Clean(value)
	existing := value
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%w: %s=%s: %v", installbundle.ErrUnapproved, name, value, err)
		}
		existing = filepath.Dir(existing)
	}
	if _, err := installbundle.ProtectedDirectory(name, existing); err != nil {
		return "", err
	}
	if existing == value {
		return installbundle.ProtectedDirectory(name, value)
	}
	if !create {
		return value, nil
	}
	if err := os.MkdirAll(value, 0o700); err != nil {
		return "", fmt.Errorf("create %s=%s: %w", name, value, err)
	}
	return installbundle.ProtectedDirectory(name, value)
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
