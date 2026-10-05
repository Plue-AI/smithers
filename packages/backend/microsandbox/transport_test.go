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

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

// approvedBundleFixture writes an installed bundle and its manifest.json the
// way the bundle assembler does: every file with digest, stage and mode.
func approvedBundleFixture(t *testing.T) (string, map[string][]byte) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	bundle := filepath.Join(root, "bundle")
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
	}
	modes := map[string]os.FileMode{"bin/flow-hosts.json": 0o644}
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
	runtime := &Runtime{cli: &cli{binary: binary, home: t.TempDir()}, config: Config{Bundle: bundle}, root: root,
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
				_, err := runtime.approvedBundle()
				require.NoError(t, err)
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

	t.Run("an invalid bundle manifest refuses", func(t *testing.T) {
		for name, manifest := range map[string]string{
			"missing":        "",
			"version":        `{"version":2,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}]}`,
			"platform":       `{"version":1,"platform":"linux-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}]}`,
			"no files":       `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[]}`,
			"traversal":      `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/../x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}]}`,
			"absolute":       `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"/bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}]}`,
			"duplicate":      `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493},{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}]}`,
			"digest":         `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/x","sha256":"` + strings.Repeat("B", 64) + `","stage":"s","mode":493}]}`,
			"unknown field":  `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493,"approved":true}]}`,
			"trailing value": `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}]} {}`,
			"symlink":        "->",
		} {
			t.Run(name, func(t *testing.T) {
				bundle, err := filepath.EvalSymlinks(t.TempDir())
				require.NoError(t, err)
				switch manifest {
				case "":
				case "->":
					real := filepath.Join(t.TempDir(), "manifest.json")
					require.NoError(t, os.WriteFile(real, []byte(`{"version":1,"platform":"darwin-arm64","revision":"`+strings.Repeat("a", 40)+`","files":[{"path":"bin/x","sha256":"`+strings.Repeat("b", 64)+`","stage":"s","mode":493}]}`), 0o644))
					require.NoError(t, os.Symlink(real, filepath.Join(bundle, "manifest.json")))
				default:
					require.NoError(t, os.WriteFile(filepath.Join(bundle, "manifest.json"), []byte(manifest), 0o644))
				}
				runtime, argv, _ := guestArtifactMSB(t, bundle)
				_, err = runtime.plantArtifact(ctx, "fresh", filepath.Join(bundle, "bin", "x"))
				require.ErrorIs(t, err, ErrUnapprovedArtifact)
				_, err = os.Stat(argv)
				require.ErrorIs(t, err, os.ErrNotExist)
			})
		}
		_, err := loadApprovedBundle("relative/bundle")
		require.ErrorIs(t, err, ErrUnapprovedArtifact)
		_, err = loadApprovedBundle("/tmp/../tmp/bundle")
		require.ErrorIs(t, err, ErrUnapprovedArtifact)
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

// New pins the installed bundle and, before it runs msb or writes state,
// verifies against that one manifest: the chain from / to the bundle and its
// manifest (owned by root or this user, not group or world writable), the
// running backend's own bytes, the msb it drives (only the bundle's bin/msb),
// every file it will plant (the coding helper and each bundle program) and
// the Flow host manifest it read. A refusal starts nothing and names the
// path; the approved bundle passes and stops only at the fixture msb's
// qualification.
func TestNewChecksTheInstalledBundleBeforeMicrosandbox(t *testing.T) {
	codingHost := "bin/smithers-coding-host"
	for _, test := range []struct {
		name     string
		prepare  func(t *testing.T, bundle string, config *Config)
		approved bool
		unproven bool   // refused, but not as an unapproved artifact
		names    string // the refusal names this path
	}{
		{name: "approved", approved: true},
		{name: "approved through a symlinked ancestor", approved: true, prepare: func(t *testing.T, bundle string, config *Config) {
			link := filepath.Join(t.TempDir(), "keg")
			require.NoError(t, os.Symlink(filepath.Dir(bundle), link))
			config.Bundle = filepath.Join(link, filepath.Base(bundle))
			config.Executable = filepath.Join(config.Bundle, "bin", "smithers-backend")
		}},
		{name: "no bundle with a program", prepare: func(t *testing.T, _ string, config *Config) { config.Bundle = "" }},
		{name: "msb chosen outside the bundle", prepare: func(t *testing.T, bundle string, config *Config) {
			config.Binary = filepath.Join(bundle, "bin", "msb")
		}},
		{name: "invalid manifest", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "manifest.json"), []byte(`{}`), 0o644))
		}},
		{name: "group-writable manifest", names: "manifest.json", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.Chmod(filepath.Join(bundle, "manifest.json"), 0o664))
		}},
		{name: "group-writable bundle directory", names: "bundle is not owned", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.Chmod(bundle, 0o775))
		}},
		{name: "world-writable ancestor", names: "is not owned by root", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.Chmod(filepath.Dir(bundle), 0o777))
		}},
		{name: "symlinked ancestor whose target is writable", names: "is not owned by root", prepare: func(t *testing.T, bundle string, config *Config) {
			require.NoError(t, os.Chmod(filepath.Dir(bundle), 0o757))
			link := filepath.Join(t.TempDir(), "keg")
			require.NoError(t, os.Symlink(filepath.Dir(bundle), link))
			config.Bundle = filepath.Join(link, filepath.Base(bundle))
			config.Executable = filepath.Join(config.Bundle, "bin", "smithers-backend")
		}},
		{name: "group-writable bin directory", names: "bin is not owned", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.Chmod(filepath.Join(bundle, "bin"), 0o775))
		}},
		{name: "backend outside the bundle", names: "is not the bundle's bin/smithers-backend", prepare: func(t *testing.T, _ string, config *Config) {
			config.Executable = filepath.Join(t.TempDir(), "smithers-backend")
			require.NoError(t, os.WriteFile(config.Executable, []byte("approved backend"), 0o755))
		}},
		{name: "backend unnamed", names: "is not the bundle's bin/smithers-backend", prepare: func(t *testing.T, _ string, config *Config) {
			config.Executable = ""
		}},
		{name: "backend bytes changed", names: "bin/smithers-backend differs", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "smithers-backend"), []byte("branch-built backend"), 0o755))
		}},
		{name: "backend undeclared", names: "bin/smithers-backend", prepare: func(t *testing.T, bundle string, _ *Config) {
			approveBundleFile(t, bundle, "bin/smithers-backend", nil, 0)
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
		{name: "Flow host manifest changed", names: "bin/flow-hosts.json differs", prepare: func(t *testing.T, bundle string, _ *Config) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "flow-hosts.json"), []byte(`{"hosts":{}}`), 0o644))
		}},
		{name: "Flow host manifest outside the bundle", names: "is not a file of the installed bundle", prepare: func(t *testing.T, _ string, config *Config) {
			outside := filepath.Join(t.TempDir(), "flow-hosts.json")
			require.NoError(t, os.WriteFile(outside, []byte("{}\n"), 0o644))
			config.BundleFiles = []string{outside}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			bundle, _ := approvedBundleFixture(t)
			ran := filepath.Join(filepath.Dir(bundle), "msb-ran")
			state := filepath.Join(t.TempDir(), "state")
			config := Config{Root: state, CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1,
				Bundle: bundle, Executable: filepath.Join(bundle, "bin", "smithers-backend"),
				BundlePrograms: []string{filepath.Join(bundle, filepath.FromSlash(codingHost))},
				BundleFiles:    []string{filepath.Join(bundle, "bin", "flow-hosts.json")}}
			if test.prepare != nil {
				test.prepare(t, bundle, &config)
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

// msb is verified against the pinned manifest at each use, not only at
// startup: changed bytes refuse the next run before anything starts, and the
// approved bytes written back are accepted again.
func TestBundleMSBIsVerifiedBeforeEveryRun(t *testing.T) {
	bundle, files := approvedBundleFixture(t)
	ran := filepath.Join(filepath.Dir(bundle), "msb-ran")
	pinned, err := loadApprovedBundle(bundle)
	require.NoError(t, err)
	msb := pinned.program(bundleMSBPath)
	require.NoError(t, msb.check())
	client, err := runtimeCLI(Config{}, msb)
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
	_, err = client.run(context.Background(), nil, "--version")
	require.NoError(t, err)
	require.Equal(t, 1, runs())

	// Same size, different bytes: the identity changed, so it is hashed again.
	tampered := append([]byte(nil), files["bin/msb"]...)
	tampered[len(tampered)-2] = '1'
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "msb"), tampered, 0o755))
	_, err = client.run(context.Background(), nil, "--version")
	require.ErrorIs(t, err, ErrUnapprovedArtifact)
	require.ErrorIs(t, err, ErrUnavailable)
	require.Equal(t, 1, runs(), "the changed msb never ran")

	// A group-writable msb refuses, whatever its bytes.
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "msb"), files["bin/msb"], 0o755))
	require.NoError(t, os.Chmod(filepath.Join(bundle, "bin", "msb"), 0o775))
	_, err = client.run(context.Background(), nil, "--version")
	require.ErrorIs(t, err, ErrUnapprovedArtifact)
	require.Equal(t, 1, runs())

	require.NoError(t, os.Chmod(filepath.Join(bundle, "bin", "msb"), 0o755))
	_, err = client.run(context.Background(), nil, "--version")
	require.NoError(t, err)
	require.Equal(t, 2, runs())
}

// The bundle trust rule: root or the running user owns it, and neither group
// nor others can write it.
func TestProtectedOwnerRule(t *testing.T) {
	uid := uint32(os.Getuid())
	for _, test := range []struct {
		uid  uint32
		mode uint32
		ok   bool
	}{
		{0, 0o755, true}, {uid, 0o700, true}, {uid, 0o755, true},
		{uid + 1, 0o755, uid+1 == 0}, {0, 0o775, false}, {uid, 0o757, false}, {uid, 0o722, false},
	} {
		require.Equal(t, test.ok, trustedOwnership(test.uid, unix.S_IFDIR|test.mode), "uid %d mode %o", test.uid, test.mode)
	}
}

// The guest side validates every request field and the bytes itself, before
// it touches the filesystem, and survives an ancestor swapped mid-walk.
func TestGuestManagedArtifactRefusesUntrustedRequests(t *testing.T) {
	digest := func(body string) string {
		sum := sha256.Sum256([]byte(body))
		return hex.EncodeToString(sum[:])
	}
	boundaryPython(t, fmt.Sprintf(`
import hashlib
with tempfile.TemporaryDirectory() as directory:
 directory=os.path.realpath(directory)
 g.ROOT_UID=os.geteuid(); g.PROTECTED_BASE=directory
 body=b'approved'; good=%q
 def refused(call, *args):
  try: call(*args)
  except SystemExit as exit: assert exit.code==3, exit.code
  else: raise AssertionError('accepted %%r' %% (args,))
 for path in ('', '/abs', '../x', 'bin/../x', '.hidden', 'bin//x', 'bin/', 'a/b/c/d/e/f/g/h/i', 'bin/é', 'bin/x y', 'x'*97):
  refused(g.install_managed_artifact, path, good, body)
  refused(g.managed_artifact_current, path, good)
 for wrong in ('', 'A'*64, 'g'*64, good[:63], good+'0'):
  refused(g.install_managed_artifact, 'bin/x', wrong, body)
  refused(g.managed_artifact_current, 'bin/x', wrong)
 refused(g.install_managed_artifact, 'bin/x', good, b'branch-built')
 g.MANAGED_ARTIFACT_LIMIT=4
 refused(g.install_managed_artifact, 'bin/x', good, body)
 g.MANAGED_ARTIFACT_LIMIT=64*1024*1024
 assert not os.path.exists(directory+'/opt'), 'refusals wrote nothing'
 g.ROOT_UID=os.geteuid()+1
 refused(g.install_managed_artifact, 'bin/x', good, body)
 refused(g.managed_artifact_current, 'bin/x', good)
 g.ROOT_UID=os.geteuid()
 assert g.managed_artifact_current('bin/x', good) is False
 g.install_managed_artifact('bin/x', good, body)
 assert g.managed_artifact_current('bin/x', good) is True
 assert g.managed_artifact_current('bin/x', %q) is False
 # Swap the parent for a link to a directory that passes every ownership
 # check, between its creation and its open: only no-follow refuses it.
 outside=directory+'/outside'; os.mkdir(outside,0o755)
 real_open=os.open
 def racing_open(path,flags,*args,**kwargs):
  if path=='race' and kwargs.get('dir_fd') is not None:
   os.rename(directory+'/opt/smithers/bundle/race',directory+'/opt/smithers/bundle/old-race')
   os.symlink(outside,directory+'/opt/smithers/bundle/race')
  return real_open(path,flags,*args,**kwargs)
 g.os.open=racing_open
 try: g.install_managed_artifact('race/x', good, body)
 except SystemExit as exit: assert exit.code==3, exit.code
 else: raise AssertionError('followed a raced parent')
 finally: g.os.open=real_open
 assert os.listdir(outside)==[], os.listdir(outside)
`, digest("approved"), digest("other")))
}

// Outsider-started work in a microVM honours the per-run GitHub deny by
// construction: after WithholdConversationEgress, as before it, the machine
// is created with no network but the backend's own port, where the product
// applies the withheld conversation scopes. There is no GitHub route to deny.
func TestWithheldConversationEgressLeavesOnlyTheBackendPort(t *testing.T) {
	runtime := &Runtime{config: Config{CPUs: 4, MemoryMiB: 8192, HostPorts: []uint16{64820}}, owner: "smithers-backend-0123456789abcdef", holder: "test"}
	require.NoError(t, runtime.WithholdConversationEgress(context.Background(), "outsider-lane"))
	flags := runtime.machineFlags("outsider-lane")
	var network []string
	for index, flag := range flags {
		switch {
		case flag == "--no-net":
			network = append(network, flag)
		case strings.HasPrefix(flag, "--net"), strings.HasPrefix(flag, "--port"), flag == "-p", strings.HasPrefix(flag, "--dns"), strings.HasPrefix(flag, "--allow"):
			value := ""
			if index+1 < len(flags) {
				value = flags[index+1]
			}
			network = append(network, flag+" "+value)
		}
	}
	require.Equal(t, []string{"--no-net", "--net-rule allow@host:tcp:64820"}, network)
	for _, flag := range flags {
		require.NotContains(t, strings.ToLower(flag), "github")
	}
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
	client, err := newCLI(binary)
	require.NoError(t, err)
	require.Equal(t, filepath.Clean(account.HomeDir), client.home)
	require.Contains(t, client.environment(), "HOME="+filepath.Clean(account.HomeDir))
}
