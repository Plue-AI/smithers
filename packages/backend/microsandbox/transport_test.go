package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"os/user"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// approvedBundleFixture writes an installed bundle and its manifest.json the
// way the bundle assembler does: every file with digest, stage and mode.
func approvedBundleFixture(t *testing.T) (string, map[string][]byte) {
	t.Helper()
	bundle := filepath.Join(bundletest.ProtectedTempDir(t), "bundle")
	helper := make([]byte, 64)
	copy(helper, "\x7fELF")
	helper[4], helper[5], helper[18] = 2, 1, 183
	files := map[string][]byte{
		"bin/smithers-coding-host":           []byte("#!/usr/bin/env node\nconsole.log('approved coding host')\n"),
		"bin/linux-arm64/smithers-jj-export": helper,
		"bin/flow-hosts.json":                []byte("{}\n"),
		"bin/smithers-backend":               []byte("approved backend"),
		// The fixture msb records each run beside the bundle and reports a
		// version no runtime qualifies, so New stops at its qualification.
		"bin/msb": []byte("#!/bin/sh\necho \"$*\" >> \"$(dirname \"$0\")/../../msb-ran\"\necho 'msb 0.0.0'\n"),
		// The guest kernel msb loads from lib/ beside its bin/.
		"lib/libkrunfw.5.dylib": []byte("approved guest kernel"),
	}
	modes := map[string]os.FileMode{"bin/flow-hosts.json": 0o644, "lib/libkrunfw.5.dylib": 0o644}
	var entries []map[string]any
	for name, body := range files {
		mode := modes[name]
		if mode == 0 {
			mode = 0o755
		}
		target := filepath.Join(bundle, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		require.NoError(t, os.WriteFile(target, body, mode))
		require.NoError(t, os.Chmod(target, mode))
		sum := sha256.Sum256(body)
		entries = append(entries, map[string]any{"path": name, "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": int(mode)})
	}
	require.NoError(t, os.Symlink("smithers-coding-host", filepath.Join(bundle, "bin", "coding-link")))
	sum := sha256.Sum256(files["bin/smithers-coding-host"])
	entries = append(entries, map[string]any{"path": "bin/coding-link", "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": 0o755, "symlink": "smithers-coding-host"})
	writeBundleManifest(t, bundle, entries)
	return bundle, files
}

// pinned opens an installed bundle fixture the way the backend does at
// startup; "" is no bundle.
func pinned(t *testing.T, root string) *installbundle.Bundle {
	t.Helper()
	if root == "" {
		return nil
	}
	bundle, err := installbundle.Open(root)
	require.NoError(t, err)
	return bundle
}

// approveBundleFile writes one bundle file and records it in manifest.json, as
// a differently assembled bundle would; mode 0 drops the entry.
func approveBundleFile(t *testing.T, bundle, relative string, body []byte, mode os.FileMode) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(bundle, "manifest.json"))
	require.NoError(t, err)
	var manifest struct {
		Files []map[string]any `json:"files"`
	}
	require.NoError(t, json.Unmarshal(data, &manifest))
	entries := manifest.Files[:0]
	for _, entry := range manifest.Files {
		if entry["path"] != relative {
			entries = append(entries, entry)
		}
	}
	target := filepath.Join(bundle, filepath.FromSlash(relative))
	if mode != 0 {
		require.NoError(t, os.WriteFile(target, body, mode))
		require.NoError(t, os.Chmod(target, mode))
		sum := sha256.Sum256(body)
		entries = append(entries, map[string]any{"path": relative, "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": int(mode)})
	}
	writeBundleManifest(t, bundle, entries)
}

func writeBundleManifest(t *testing.T, bundle string, entries []map[string]any) {
	t.Helper()
	manifest, err := json.Marshal(map[string]any{"version": 1, "platform": "darwin-arm64", "revision": strings.Repeat("a", 40), "files": entries})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "manifest.json"), manifest, 0o644))
}

// guestArtifactMSB is an msb that runs the real guest helper's subcommand
// against a temporary guest root. Only the helper's protected base ("/" in a
// guest) and root UID are replaced, for an unprivileged developer; the
// production CLI accepts no such override. Every invocation is logged.
func guestArtifactMSB(t *testing.T, bundle string) (*Runtime, string, string) {
	t.Helper()
	require.NotZero(t, os.Geteuid(), "branch tests must never execute as host root")
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	helper, err := filepath.Abs(filepath.Join("guest", "smithers-guest.py"))
	require.NoError(t, err)
	dir := t.TempDir()
	guestRootDir, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	argv := filepath.Join(dir, "argv")
	binary := filepath.Join(dir, "fake-msb")
	etc, bin := filepath.Join(guestRootDir, "etc"), filepath.Join(guestRootDir, "usr", "local", "bin")
	for _, directory := range []string{etc, bin} {
		require.NoError(t, os.MkdirAll(directory, 0o755))
	}
	script := fmt.Sprintf(`#!%s
import importlib.util, os, sys
with open(%q, "a") as log: log.write(" ".join(sys.argv[1:]) + "\n")
args = sys.argv[1:]
if "run" not in args:
    sys.exit(0)
spec = importlib.util.spec_from_file_location("guest", %q)
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
guest.ROOT_UID = os.geteuid()
guest.PROTECTED_BASE = %q
guest.main(args[args.index("run") + 1:])
`, python, argv, helper, guestRootDir)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "workspaces"), 0o700))
	runtime := &Runtime{cli: &cli{binary: binary, home: t.TempDir()}, config: Config{Bundle: pinned(t, bundle)}, root: root,
		owner: "smithers-backend-0123456789abcdef", holder: "test", workspaces: map[string]*workspace{}}
	return runtime, argv, guestRootDir
}

// guestCalls counts the guest helper invocations of one subcommand.
func guestCalls(t *testing.T, argv, subcommand string) int {
	t.Helper()
	data, err := os.ReadFile(argv)
	if os.IsNotExist(err) {
		return 0
	}
	require.NoError(t, err)
	return strings.Count(string(data), " run "+subcommand+" ") + strings.Count(string(data), " run "+subcommand+"\n")
}

func guestPlanted(t *testing.T, guestRoot, relative string) ([]byte, os.FileInfo) {
	t.Helper()
	target := filepath.Join(guestRoot, "opt", "smithers", "bundle", filepath.FromSlash(relative))
	info, err := os.Lstat(target)
	require.NoError(t, err)
	body, err := os.ReadFile(target)
	require.NoError(t, err)
	return body, info
}

// T-FLW-01/T-SEC-01 R5: the managed host program planted as guest root is a
// file of the approved installed bundle, with the bytes and mode its pinned
// manifest declares, written under root-owned protected directories that are
// never followed, on fresh and retained machines. Branch-built bytes are
// never planted, whatever their digest. The real-machine receipt is C-SEC-02.
func TestRootManagedArtifactInstallUsesApprovedBundleOnly(t *testing.T) {
	ctx := context.Background()
	codingHost := "bin/smithers-coding-host"

	t.Run("fresh then retained machine", func(t *testing.T) {
		bundle, files := approvedBundleFixture(t)
		runtime, argv, guestRoot := guestArtifactMSB(t, bundle)
		program := filepath.Join(bundle, filepath.FromSlash(codingHost))
		planted, err := runtime.plantArtifact(ctx, "fresh", program)
		require.NoError(t, err)
		require.Equal(t, "/opt/smithers/bundle/bin/smithers-coding-host", planted)
		body, info := guestPlanted(t, guestRoot, codingHost)
		require.Equal(t, files[codingHost], body)
		require.Equal(t, os.FileMode(0o755), info.Mode().Perm())
		require.True(t, info.Mode().IsRegular())
		for _, directory := range []string{"opt", "opt/smithers", "opt/smithers/bundle", "opt/smithers/bundle/bin"} {
			info, err := os.Lstat(filepath.Join(guestRoot, directory))
			require.NoError(t, err)
			require.True(t, info.IsDir(), directory)
			require.Zero(t, info.Mode().Perm()&0o022, directory)
		}
		require.Equal(t, 1, guestCalls(t, argv, "managed-artifact"))
		log, err := os.ReadFile(argv)
		require.NoError(t, err)
		require.NotContains(t, string(log), "sh -c", "no raw root shell plants an artifact")
		sum := sha256.Sum256(files[codingHost])
		require.Contains(t, string(log), " run managed-artifact "+codingHost+" "+hex.EncodeToString(sum[:])+"\n")

		// Retained and unchanged: checked, never rewritten.
		_, err = runtime.plantArtifact(ctx, "fresh", program)
		require.NoError(t, err)
		require.Equal(t, 1, guestCalls(t, argv, "managed-artifact"))
		require.Equal(t, 2, guestCalls(t, argv, "managed-artifact-check"))

		// Retained with drifted bytes or mode: the approved bytes replace them.
		target := filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin", "smithers-coding-host")
		require.NoError(t, os.WriteFile(target, []byte("tampered"), 0o755))
		_, err = runtime.plantArtifact(ctx, "fresh", program)
		require.NoError(t, err)
		require.NoError(t, os.Chmod(target, 0o700))
		_, err = runtime.plantArtifact(ctx, "fresh", program)
		require.NoError(t, err)
		body, info = guestPlanted(t, guestRoot, codingHost)
		require.Equal(t, files[codingHost], body)
		require.Equal(t, os.FileMode(0o755), info.Mode().Perm())
		require.Equal(t, 3, guestCalls(t, argv, "managed-artifact"))

		// A nested bundle path keeps its place under the guest bundle root.
		helper := "bin/linux-arm64/smithers-jj-export"
		planted, err = runtime.plantArtifact(ctx, "fresh", filepath.Join(bundle, filepath.FromSlash(helper)))
		require.NoError(t, err)
		require.Equal(t, "/opt/smithers/bundle/bin/linux-arm64/smithers-jj-export", planted)
		body, _ = guestPlanted(t, guestRoot, helper)
		require.Equal(t, files[helper], body)
		entries, err := os.ReadDir(filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin"))
		require.NoError(t, err)
		for _, entry := range entries {
			require.False(t, strings.HasPrefix(entry.Name(), "."), "temporary files are cleaned: %s", entry.Name())
		}
	})

	t.Run("guest programs and outside files are never planted", func(t *testing.T) {
		bundle, files := approvedBundleFixture(t)
		branch := filepath.Join(t.TempDir(), "smithers-coding-host")
		require.NoError(t, os.WriteFile(branch, files[codingHost], 0o755))
		sibling := bundle + "-other"
		require.NoError(t, os.MkdirAll(filepath.Join(sibling, "bin"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(sibling, "bin", "smithers-coding-host"), files[codingHost], 0o755))
		for name, value := range map[string]string{
			"branch build with the approved digest": branch,
			"sibling directory prefix":              filepath.Join(sibling, "bin", "smithers-coding-host"),
			"escape through dot-dot":                bundle + "/../" + filepath.Base(sibling) + "/bin/smithers-coding-host",
			"guest interpreter":                     "/usr/bin/node",
			"relative program":                      "node",
			"URL":                                   "http://127.0.0.1:4000" + bundle + "/bin/smithers-coding-host",
		} {
			t.Run(name, func(t *testing.T) {
				runtime, argv, _ := guestArtifactMSB(t, bundle)
				planted, err := runtime.plantArtifact(ctx, "fresh", value)
				require.NoError(t, err)
				require.Equal(t, value, planted, "a value outside the bundle passes through as a guest program")
				_, err = os.Stat(argv)
				require.ErrorIs(t, err, os.ErrNotExist, "nothing reached the guest")
			})
		}
		t.Run("no installed bundle", func(t *testing.T) {
			runtime, argv, _ := guestArtifactMSB(t, "")
			program := filepath.Join(bundle, filepath.FromSlash(codingHost))
			planted, err := runtime.plantArtifact(ctx, "fresh", program)
			require.NoError(t, err)
			require.Equal(t, program, planted)
			_, err = os.Stat(argv)
			require.ErrorIs(t, err, os.ErrNotExist)
		})
	})

	t.Run("unapproved bundle bytes refuse before the guest", func(t *testing.T) {
		for _, test := range []struct {
			name    string
			program string
			mutate  func(t *testing.T, bundle string, runtime *Runtime)
		}{
			{name: "undeclared file", program: "bin/extra", mutate: func(t *testing.T, bundle string, _ *Runtime) {
				require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "extra"), []byte("extra"), 0o755))
			}},
			{name: "changed bytes", program: codingHost, mutate: func(t *testing.T, bundle string, _ *Runtime) {
				require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "smithers-coding-host"), []byte("#!/usr/bin/env node\nconsole.log('branch-built host!')\n"), 0o755))
			}},
			{name: "file replaced by a symlink to identical bytes", program: codingHost, mutate: func(t *testing.T, bundle string, _ *Runtime) {
				target := filepath.Join(bundle, "bin", "smithers-coding-host")
				body, err := os.ReadFile(target)
				require.NoError(t, err)
				copied := filepath.Join(t.TempDir(), "copy")
				require.NoError(t, os.WriteFile(copied, body, 0o755))
				require.NoError(t, os.Remove(target))
				require.NoError(t, os.Symlink(copied, target))
			}},
			{name: "directory replaced by a symlink to identical bytes", program: "bin/linux-arm64/smithers-jj-export", mutate: func(t *testing.T, bundle string, _ *Runtime) {
				directory := filepath.Join(bundle, "bin", "linux-arm64")
				copied := filepath.Join(t.TempDir(), "linux-arm64")
				require.NoError(t, os.Rename(directory, copied))
				require.NoError(t, os.Symlink(copied, directory))
			}},
			{name: "mode differs", program: codingHost, mutate: func(t *testing.T, bundle string, _ *Runtime) {
				require.NoError(t, os.Chmod(filepath.Join(bundle, "bin", "smithers-coding-host"), 0o775))
			}},
			{name: "not executable", program: "bin/flow-hosts.json"},
			{name: "symlink entry", program: "bin/coding-link"},
			{name: "manifest edited after the bundle was pinned", program: codingHost, mutate: func(t *testing.T, bundle string, runtime *Runtime) {
				body := []byte("#!/usr/bin/env node\nconsole.log('branch-built host!')\n")
				require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "smithers-coding-host"), body, 0o755))
				sum := sha256.Sum256(body)
				writeBundleManifest(t, bundle, []map[string]any{{"path": codingHost, "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": 0o755}})
			}},
		} {
			t.Run(test.name, func(t *testing.T) {
				bundle, _ := approvedBundleFixture(t)
				runtime, argv, guestRoot := guestArtifactMSB(t, bundle)
				if test.mutate != nil {
					test.mutate(t, bundle, runtime)
				}
				_, err := runtime.plantArtifact(ctx, "fresh", filepath.Join(bundle, filepath.FromSlash(test.program)))
				require.ErrorIs(t, err, ErrUnapprovedArtifact)
				_, err = os.Stat(argv)
				require.ErrorIs(t, err, os.ErrNotExist, "refused before any guest process")
				_, err = os.Stat(filepath.Join(guestRoot, "opt"))
				require.ErrorIs(t, err, os.ErrNotExist)
			})
		}
	})

	t.Run("hostile retained guest directories refuse without following", func(t *testing.T) {
		for _, test := range []struct {
			name    string
			prepare func(t *testing.T, guestRoot, outside string)
		}{
			{name: "bundle root symlink", prepare: func(t *testing.T, guestRoot, outside string) {
				require.NoError(t, os.MkdirAll(filepath.Join(guestRoot, "opt", "smithers"), 0o755))
				require.NoError(t, os.Symlink(outside, filepath.Join(guestRoot, "opt", "smithers", "bundle")))
			}},
			{name: "parent symlink", prepare: func(t *testing.T, guestRoot, outside string) {
				require.NoError(t, os.MkdirAll(filepath.Join(guestRoot, "opt", "smithers", "bundle"), 0o755))
				require.NoError(t, os.Symlink(outside, filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin")))
			}},
			{name: "target symlink", prepare: func(t *testing.T, guestRoot, outside string) {
				require.NoError(t, os.MkdirAll(filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin"), 0o755))
				require.NoError(t, os.Symlink(filepath.Join(outside, "sentinel"), filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin", "smithers-coding-host")))
			}},
			{name: "target directory", prepare: func(t *testing.T, guestRoot, _ string) {
				require.NoError(t, os.MkdirAll(filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin", "smithers-coding-host"), 0o755))
			}},
			{name: "writable ancestor", prepare: func(t *testing.T, guestRoot, _ string) {
				require.NoError(t, os.MkdirAll(filepath.Join(guestRoot, "opt", "smithers", "bundle"), 0o755))
				require.NoError(t, os.Chmod(filepath.Join(guestRoot, "opt", "smithers"), 0o777))
			}},
			{name: "writable parent", prepare: func(t *testing.T, guestRoot, _ string) {
				require.NoError(t, os.MkdirAll(filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin"), 0o755))
				require.NoError(t, os.Chmod(filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin"), 0o775))
			}},
		} {
			t.Run(test.name, func(t *testing.T) {
				bundle, _ := approvedBundleFixture(t)
				runtime, argv, guestRoot := guestArtifactMSB(t, bundle)
				outside := t.TempDir()
				sentinel := filepath.Join(outside, "sentinel")
				require.NoError(t, os.WriteFile(sentinel, []byte("unchanged"), 0o600))
				test.prepare(t, guestRoot, outside)
				_, err := runtime.plantArtifact(ctx, "retained", filepath.Join(bundle, filepath.FromSlash(codingHost)))
				require.ErrorIs(t, err, ErrUnavailable)
				require.Contains(t, err.Error(), "smithers-guest: protected")
				body, err := os.ReadFile(sentinel)
				require.NoError(t, err)
				require.Equal(t, "unchanged", string(body))
				entries, err := os.ReadDir(outside)
				require.NoError(t, err)
				require.Len(t, entries, 1, "nothing was written through a link")
				require.Zero(t, guestCalls(t, argv, "managed-artifact"), "the check refuses before bytes are sent")
			})
		}
	})
}

// Fable round 1, F1: a managed host's environment is never planted. A
// repository admin's agent variable naming a bundle file, or an undeclared
// one, reaches the host as the value it is, with no guest root call for it;
// only the host program itself is planted.
func TestManagedHostPlantsOnlyItsProgram(t *testing.T) {
	bundle, _ := approvedBundleFixture(t)
	runtime, argv, guestRoot := guestArtifactMSB(t, bundle)
	environment := map[string]string{
		"AGENT_VARIABLE_HELPER":               filepath.Join(bundle, "bin", "linux-arm64", "smithers-jj-export"),
		"AGENT_VARIABLE_MANIFEST":             filepath.Join(bundle, "bin", "flow-hosts.json"),
		"AGENT_VARIABLE_UNDECLARED":           filepath.Join(bundle, "bin", "extra"),
		"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": "/usr/local/bin/smithers-jj-export",
	}
	command, err := runtime.managedHostCommand(context.Background(), "fresh", workspaceapi.Command{
		Args:        []string{filepath.Join(bundle, "bin", "smithers-coding-host"), "--listen", "127.0.0.1:20000"},
		Environment: maps.Clone(environment),
	})
	require.NoError(t, err)
	require.Equal(t, []string{"/opt/smithers/bundle/bin/smithers-coding-host", "--listen", "127.0.0.1:20000"}, command.Args)
	require.Equal(t, environment, command.Environment, "every variable reaches the host unchanged")
	require.Equal(t, 1, guestCalls(t, argv, "managed-artifact-check"), "only the program is checked")
	require.Equal(t, 1, guestCalls(t, argv, "managed-artifact"), "only the program is planted")
	log, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.NotContains(t, string(log), "linux-arm64", "no variable reached guest root")
	require.NotContains(t, string(log), "flow-hosts.json")
	_, err = os.Stat(filepath.Join(guestRoot, "opt", "smithers", "bundle", "bin", "linux-arm64"))
	require.ErrorIs(t, err, os.ErrNotExist)
}

// New verifies, against the bundle the backend pinned and before it runs
// msb or writes state, the msb it drives (only the bundle's bin/msb), the
// guest kernel msb loads, and every file it will plant (the coding helper
// and each bundle program). A refusal starts nothing and names the file; the
// approved bundle passes and stops only at the fixture msb's qualification.
// The chain, manifest and backend checks are installbundle's own tests.
func TestNewChecksTheInstalledBundleBeforeMicrosandbox(t *testing.T) {
	codingHost := "bin/smithers-coding-host"
	for _, test := range []struct {
		name      string
		prepare   func(t *testing.T, bundle string, config *Config)
		approved  bool
		unproven  bool   // refused, but not as an unapproved artifact
		names     string // the refusal names this path
		unbundled bool
	}{
		{name: "approved", approved: true},
		{name: "no bundle with a program", unbundled: true},
		{name: "msb chosen beside the bundle", prepare: func(t *testing.T, bundle string, config *Config) {
			config.Binary = filepath.Join(bundle, "bin", "msb")
		}},
		{name: "msb bytes changed", names: "bin/msb differs", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "msb"), []byte("#!/bin/sh\necho 'msb 0.6.16'\n"), 0o755))
		}},
		{name: "msb undeclared", names: "bin/msb", prepare: func(t *testing.T, bundle string, _ *Config) {
			body, err := os.ReadFile(filepath.Join(bundle, "bin", "msb"))
			require.NoError(t, err)
			approveBundleFile(t, bundle, "bin/msb", nil, 0)
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "msb"), body, 0o755))
		}},
		{name: "msb replaced by a symlink to identical bytes", names: "bin/msb", prepare: func(t *testing.T, bundle string, _ *Config) {
			target := filepath.Join(bundle, "bin", "msb")
			body, err := os.ReadFile(target)
			require.NoError(t, err)
			copied := filepath.Join(t.TempDir(), "msb")
			require.NoError(t, os.WriteFile(copied, body, 0o755))
			require.NoError(t, os.Remove(target))
			require.NoError(t, os.Symlink(copied, target))
		}},
		{name: "guest kernel bytes changed", names: "lib/libkrunfw.5.dylib differs", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "lib", "libkrunfw.5.dylib"), []byte("branch-built kernel"), 0o644))
		}},
		{name: "guest kernel undeclared", names: "lib/libkrunfw*.dylib", prepare: func(t *testing.T, bundle string, _ *Config) {
			approveBundleFile(t, bundle, "lib/libkrunfw.5.dylib", nil, 0)
		}},
		{name: "group-writable lib directory", names: "lib is not owned", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.Chmod(filepath.Join(bundle, "lib"), 0o775))
		}},
		{name: "coding helper undeclared", prepare: func(t *testing.T, bundle string, _ *Config) {
			approveBundleFile(t, bundle, codingHelperBundlePath, nil, 0)
		}},
		{name: "coding helper mode 0775", prepare: func(t *testing.T, bundle string, _ *Config) {
			body, err := os.ReadFile(filepath.Join(bundle, filepath.FromSlash(codingHelperBundlePath)))
			require.NoError(t, err)
			approveBundleFile(t, bundle, codingHelperBundlePath, body, 0o775)
		}},
		{name: "coding helper for another platform", unproven: true, prepare: func(t *testing.T, bundle string, _ *Config) {
			approveBundleFile(t, bundle, codingHelperBundlePath, []byte("#!/bin/sh\nexit 0\n"+strings.Repeat("#", 64)), 0o755)
		}},
		{name: "program outside the bundle", prepare: func(t *testing.T, bundle string, config *Config) {
			outside := filepath.Join(t.TempDir(), "smithers-coding-host")
			require.NoError(t, os.WriteFile(outside, []byte("#!/usr/bin/env node\n"), 0o755))
			config.BundlePrograms = []string{outside}
		}},
		{name: "program undeclared", prepare: func(t *testing.T, bundle string, config *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "extra"), []byte("extra"), 0o755))
			config.BundlePrograms = []string{filepath.Join(bundle, "bin", "extra")}
		}},
		{name: "program bytes changed", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, filepath.FromSlash(codingHost)), []byte("#!/usr/bin/env node\n// branch\n"), 0o755))
		}},
		{name: "program deeper than the guest plants", prepare: func(t *testing.T, bundle string, config *Config) {
			deep := "a/b/c/d/e/f/g/h/host"
			require.NoError(t, os.MkdirAll(filepath.Join(bundle, filepath.FromSlash(path.Dir(deep))), 0o755))
			approveBundleFile(t, bundle, deep, []byte("#!/usr/bin/env node\n"), 0o755)
			config.BundlePrograms = []string{filepath.Join(bundle, filepath.FromSlash(deep))}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			bundle, _ := approvedBundleFixture(t)
			ran := filepath.Join(filepath.Dir(bundle), "msb-ran")
			state := filepath.Join(bundletest.ProtectedTempDir(t), "state")
			config := Config{Root: state, CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1,
				BundlePrograms: []string{filepath.Join(bundle, filepath.FromSlash(codingHost))}}
			if test.prepare != nil {
				test.prepare(t, bundle, &config)
			}
			if !test.unbundled {
				config.Bundle = pinned(t, bundle)
			}
			runtime, err := New(context.Background(), config)
			require.Error(t, err)
			require.Nil(t, runtime)
			_, ranErr := os.Stat(ran)
			if test.approved {
				require.NotErrorIs(t, err, ErrUnapprovedArtifact)
				require.ErrorIs(t, err, ErrUnavailable, "only the fixture msb's qualification refused")
				require.NoError(t, ranErr, "the approved bundle reached Microsandbox")
				return
			}
			if !test.unproven {
				require.ErrorIs(t, err, ErrUnapprovedArtifact)
			}
			if test.names != "" {
				require.Contains(t, err.Error(), test.names)
			}
			require.ErrorIs(t, ranErr, os.ErrNotExist, "refused before msb ran")
			_, err = os.Stat(state)
			require.ErrorIs(t, err, os.ErrNotExist, "refused before any state was written")
		})
	}
}

// Ruling item 3: the microVM metadata root names machines, snapshots and
// layer records that decide what guests boot. New refuses one that someone
// other than root or this user can change, before msb runs.
func TestNewRefusesUnprotectedMicroVMState(t *testing.T) {
	for name, prepare := range map[string]func(t *testing.T, state string){
		"group-writable state root": func(t *testing.T, state string) {
			require.NoError(t, os.MkdirAll(state, 0o700))
			require.NoError(t, os.Chmod(state, 0o770))
		},
		"world-writable layer records": func(t *testing.T, state string) {
			require.NoError(t, os.MkdirAll(filepath.Join(state, "layers"), 0o700))
			require.NoError(t, os.Chmod(filepath.Join(state, "layers"), 0o777))
		},
		"layer records through a link": func(t *testing.T, state string) {
			require.NoError(t, os.MkdirAll(state, 0o700))
			outside := filepath.Join(t.TempDir(), "layers")
			require.NoError(t, os.MkdirAll(outside, 0o777))
			require.NoError(t, os.Chmod(outside, 0o777))
			require.NoError(t, os.Symlink(outside, filepath.Join(state, "layers")))
		},
	} {
		t.Run(name, func(t *testing.T) {
			bundle, _ := approvedBundleFixture(t)
			state := filepath.Join(bundletest.ProtectedTempDir(t), "state")
			prepare(t, state)
			// Qualification runs: the refusal must come before msb is asked.
			_, err := New(context.Background(), Config{Root: state, CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1, Bundle: pinned(t, bundle)})
			require.ErrorIs(t, err, ErrUnapprovedArtifact)
			require.Contains(t, err.Error(), "is not owned by root or this user")
			_, statErr := os.Stat(filepath.Join(filepath.Dir(bundle), "msb-ran"))
			require.ErrorIs(t, statErr, os.ErrNotExist, "refused before msb ran")
		})
	}
}

// Fable round 2, B2: msb and the guest kernel it loads are verified against
// the pinned manifest before every run, not only at startup: changed bytes
// or a writable lib/ refuse the next run before anything starts, and the
// approved bytes written back are accepted again.
func TestBundleMSBIsVerifiedBeforeEveryRun(t *testing.T) {
	bundle, files := approvedBundleFixture(t)
	ran := filepath.Join(filepath.Dir(bundle), "msb-ran")
	binary, verify, err := startupChecks(Config{Bundle: pinned(t, bundle)})
	require.NoError(t, err)
	client, err := runtimeCLI(binary, verify)
	require.NoError(t, err)
	require.Equal(t, filepath.Join(bundle, "bin", "msb"), client.binary)
	runs := func() int {
		data, err := os.ReadFile(ran)
		if os.IsNotExist(err) {
			return 0
		}
		require.NoError(t, err)
		return strings.Count(string(data), "\n")
	}
	refused := func(why string) {
		t.Helper()
		before := runs()
		_, err := client.run(context.Background(), nil, "--version")
		require.ErrorIs(t, err, ErrUnapprovedArtifact, why)
		require.ErrorIs(t, err, ErrUnavailable, why)
		require.Equal(t, before, runs(), "%s: nothing ran", why)
	}
	accepted := func() {
		t.Helper()
		before := runs()
		_, err := client.run(context.Background(), nil, "--version")
		require.NoError(t, err)
		require.Equal(t, before+1, runs())
	}
	accepted()

	// Same size, different msb bytes: the identity changed, so it is hashed again.
	msb := filepath.Join(bundle, "bin", "msb")
	tampered := append([]byte(nil), files["bin/msb"]...)
	tampered[len(tampered)-2] = '1'
	require.NoError(t, os.WriteFile(msb, tampered, 0o755))
	refused("changed msb")
	require.NoError(t, os.WriteFile(msb, files["bin/msb"], 0o755))
	require.NoError(t, os.Chmod(msb, 0o775))
	refused("group-writable msb")
	require.NoError(t, os.Chmod(msb, 0o755))
	accepted()

	// The guest kernel msb loads, checked the same way, with no execute bit.
	kernel := filepath.Join(bundle, "lib", "libkrunfw.5.dylib")
	require.NoError(t, os.WriteFile(kernel, []byte("approved guest kerneL"), 0o644))
	refused("changed guest kernel")
	require.NoError(t, os.WriteFile(kernel, files["lib/libkrunfw.5.dylib"], 0o644))
	require.NoError(t, os.Chmod(filepath.Join(bundle, "lib"), 0o775))
	refused("group-writable lib/")
	require.NoError(t, os.Chmod(filepath.Join(bundle, "lib"), 0o755))
	require.NoError(t, os.Remove(kernel))
	require.NoError(t, os.Symlink(filepath.Join(t.TempDir(), "kernel"), kernel))
	refused("guest kernel replaced by a link")
	require.NoError(t, os.Remove(kernel))
	require.NoError(t, os.WriteFile(kernel, files["lib/libkrunfw.5.dylib"], 0o644))
	accepted()

	// msb loads the first libkrunfw.5.dylib it finds: MSB_LIBKRUNFW_PATH
	// (never in its fixed environment), beside msb, then ../lib, then its
	// state home's lib/ (traced with msb doctor, 0.6.16). A kernel beside msb
	// would be loaded instead of the verified one, so it refuses the run.
	beside := filepath.Join(bundle, "bin", "libkrunfw.5.dylib")
	require.NoError(t, os.WriteFile(beside, files["lib/libkrunfw.5.dylib"], 0o644))
	refused("a kernel beside msb is loaded before lib/")
	require.NoError(t, os.Remove(beside))
	require.NoError(t, os.Symlink(kernel, beside))
	refused("a link beside msb is loaded before lib/")
	require.NoError(t, os.Remove(beside))
	accepted()
}

// Astra round 1: msb keeps images, machines and snapshots (the root
// filesystems guests boot) under its state home. That home is the account's
// home directory from the user database; the process environment's HOME
// never selects it.
func TestMSBStateHomeIgnoresTheEnvironment(t *testing.T) {
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	require.NoError(t, err)
	binary := filepath.Join(t.TempDir(), "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\necho 'msb 0.6.16'\n"), 0o755))
	t.Setenv("HOME", t.TempDir())
	t.Setenv("MSB_LIBKRUNFW_PATH", filepath.Join(t.TempDir(), "libkrunfw.5.dylib"))
	client, err := newCLI(binary)
	require.NoError(t, err)
	require.Equal(t, filepath.Clean(account.HomeDir), client.home)
	require.Equal(t, []string{"HOME=" + filepath.Clean(account.HomeDir), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"},
		client.environment(), "no ambient variable, such as the one that selects msb's guest kernel, reaches msb")
}
