package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func codingBindingFixture() workspaceapi.WorkspaceCodingBinding {
	return workspaceapi.WorkspaceCodingBinding{ActorID: 9, RepositoryID: 77, RepositorySlug: "acme/widgets", APIBaseURL: "http://127.0.0.1:4000/api", GitURL: "http://127.0.0.1:4000/acme/widgets.git"}
}

// codingHelperFixture gives runtime an approved bundle holding the helper and
// answers the fake msb's helper check with "replace"; it returns the
// helper's bundle path and digest, which the guest commands carry.
func codingHelperFixture(t *testing.T, runtime *Runtime) (string, string) {
	t.Helper()
	bundle, files := approvedBundleFixture(t)
	runtime.config.Bundle = bundle
	script, err := os.ReadFile(runtime.cli.binary)
	require.NoError(t, err)
	script = []byte(strings.Replace(string(script), "exit 0", "case \"$*\" in *' coding-helper-check '*) echo replace;; esac\nexit 0", 1))
	require.NoError(t, os.WriteFile(runtime.cli.binary, script, 0700))
	sum := sha256.Sum256(files[codingHelperBundlePath])
	return filepath.Join(bundle, filepath.FromSlash(codingHelperBundlePath)), hex.EncodeToString(sum[:])
}

func TestMicroVMCodingBindingSkipsUnchangedHelperAndRepairsDrift(t *testing.T) {
	runtime, argv, stdin := egressFakeMSB(t, nil)
	helper, digest := codingHelperFixture(t, runtime)
	egressWorkspace(t, runtime, "coding-lane", "running", 0)
	state := filepath.Join(t.TempDir(), "installed")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %q
cat > %q
case "$*" in
  *' coding-helper-check '*) if [ -f %q ]; then echo current; else echo replace; fi;;
  *' coding-helper '*) touch %q;;
esac
`, argv, stdin, state, state)
	require.NoError(t, os.WriteFile(runtime.cli.binary, []byte(script), 0700))
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	// The configured runtime retains its validated bytes even if the packaged
	// path disappears after startup; every guest still checks its own copy.
	require.NoError(t, os.Remove(helper))
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(args), " coding-helper "+digest+"\n"), "the guest re-hashes the bytes against this digest")
	require.Equal(t, 2, strings.Count(string(args), " coding-helper-check "+digest+"\n"))
	require.Equal(t, 2, strings.Count(string(args), " coding-binding\n"))
	require.NoError(t, os.Remove(state))
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	args, err = os.ReadFile(argv)
	require.NoError(t, err)
	require.Equal(t, 2, strings.Count(string(args), " coding-helper "+digest+"\n"), "guest drift reinstalls cached bytes")
	require.NotContains(t, string(args), "sh -c")
}

func TestMicroVMCodingBindingRefusesUnknownHelperCheck(t *testing.T) {
	runtime, argv, _ := egressFakeMSB(t, nil)
	_, digest := codingHelperFixture(t, runtime)
	egressWorkspace(t, runtime, "coding-lane", "running", 0)
	script, err := os.ReadFile(runtime.cli.binary)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(runtime.cli.binary, []byte(strings.Replace(string(script), "echo replace", "echo unexpected", 1)), 0700))
	err = runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture())
	require.ErrorContains(t, err, "invalid result")
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Contains(t, string(args), " coding-helper-check "+digest+"\n")
	require.NotContains(t, string(args), " coding-helper "+digest)
	require.NotContains(t, string(args), " coding-binding\n")
}

func TestMicroVMCodingBindingUsesRuntimeAuthority(t *testing.T) {
	runtime, argv, stdin := egressFakeMSB(t, nil)
	codingHelperFixture(t, runtime)
	egressWorkspace(t, runtime, "coding-lane", "running", 0)
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Contains(t, string(args), "run coding-binding")
	require.Contains(t, string(args), "run coding-helper")
	require.Less(t, strings.Index(string(args), "coding-helper"), strings.Index(string(args), "coding-binding"), "guest helper installed before binding")
	require.NotContains(t, string(args), "sh -c", "no arbitrary root command")
	body, err := os.ReadFile(stdin)
	require.NoError(t, err)
	var binding map[string]any
	require.NoError(t, json.Unmarshal(body, &binding))
	require.Equal(t, "coding-lane", binding["workspaceId"])
	require.Equal(t, guestRoot, binding["repositoryPath"])
	require.Equal(t, guestUser, binding["username"])
	require.Equal(t, guestHome+"/.cache/smithers/git-credential/socket", binding["credentialSocket"])
	require.Equal(t, float64(9), binding["actorId"])
	require.Equal(t, float64(77), binding["repositoryId"])
	require.Equal(t, "acme/widgets", binding["repositorySlug"])
}

func TestMicroVMCodingBindingRefusesBeforeGuestExecution(t *testing.T) {
	for _, test := range []struct {
		name   string
		state  string
		mutate func(*workspaceapi.WorkspaceCodingBinding)
		cancel bool
	}{
		{name: "stopped", state: "stopped"},
		{name: "cancelled", state: "running", cancel: true},
		{name: "actor", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.ActorID = 0 }},
		{name: "repository", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.RepositoryID = -1 }},
		{name: "slug traversal", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.RepositorySlug = "../widgets" }},
		{name: "slug missing", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.RepositorySlug = "widgets" }},
		{name: "API credentials", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.APIBaseURL = "http://secret@127.0.0.1:4000/api" }},
		{name: "git mismatch", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.GitURL = "http://other.example/acme/widgets.git" }},
		{name: "API path", state: "running", mutate: func(b *workspaceapi.WorkspaceCodingBinding) { b.APIBaseURL += "/other" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime, argv, _ := egressFakeMSB(t, nil)
			egressWorkspace(t, runtime, "coding-lane", test.state, 0)
			binding := codingBindingFixture()
			if test.mutate != nil {
				test.mutate(&binding)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if test.cancel {
				cancel()
			}
			err := runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", binding)
			require.Error(t, err)
			_, err = os.Stat(argv)
			require.ErrorIs(t, err, os.ErrNotExist, "refusal starts no guest process")
		})
	}
}

func TestMicroVMCodingBindingReportsGuestFailure(t *testing.T) {
	runtime, _, _ := egressFakeMSB(t, nil)
	codingHelperFixture(t, runtime)
	egressWorkspace(t, runtime, "coding-lane", "running", 0)
	require.NoError(t, os.WriteFile(runtime.cli.binary, []byte("#!/bin/sh\necho binding-denied >&2\nexit 4\n"), 0700))
	err := runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture())
	require.ErrorContains(t, err, "binding-denied")
	require.True(t, strings.Contains(err.Error(), "coding-helper"), "helper failure prevents binding installation")
}

func TestMicroVMCodingBindingRefusesInvalidPackagedHelper(t *testing.T) {
	for _, name := range []string{"no installed bundle", "directory", "wrong platform", "not executable", "undeclared", "changed bytes", "symlink to identical bytes"} {
		t.Run(name, func(t *testing.T) {
			runtime, argv, _ := egressFakeMSB(t, nil)
			egressWorkspace(t, runtime, "coding-lane", "running", 0)
			helper, _ := codingHelperFixture(t, runtime)
			bundle := runtime.config.Bundle
			approved, err := os.ReadFile(helper)
			require.NoError(t, err)
			switch name {
			case "no installed bundle":
				runtime.config.Bundle = ""
			case "directory":
				require.NoError(t, os.Remove(helper))
				require.NoError(t, os.Mkdir(helper, 0o755))
			case "wrong platform":
				// Approved by the manifest, but not a Linux arm64 executable.
				approveBundleFile(t, bundle, codingHelperBundlePath, []byte("#!/bin/sh\nexit 0\n"+strings.Repeat("#", 64)), 0o755)
			case "not executable":
				approveBundleFile(t, bundle, codingHelperBundlePath, approved, 0o644)
			case "undeclared":
				approveBundleFile(t, bundle, codingHelperBundlePath, nil, 0)
			case "changed bytes":
				changed := append([]byte(nil), approved...)
				changed[63] = 1
				require.NoError(t, os.WriteFile(helper, changed, 0o755))
			case "symlink to identical bytes":
				copied := filepath.Join(t.TempDir(), "smithers-jj-export")
				require.NoError(t, os.WriteFile(copied, approved, 0o755))
				require.NoError(t, os.Remove(helper))
				require.NoError(t, os.Symlink(copied, helper))
			}
			err = runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture())
			require.Error(t, err)
			if name != "wrong platform" {
				require.ErrorIs(t, err, ErrUnapprovedArtifact)
			}
			_, err = os.Stat(argv)
			require.ErrorIs(t, err, os.ErrNotExist)
		})
	}
}

// T-FLW-11 and the T-FLW-01 follow-up (#3438): the root coding binding through
// production InstallWorkspaceCodingBinding, against the real guest helper on
// a fresh and then a retained machine. The helper bytes are the approved
// bundle's; the binding's path, user and socket are the runtime's own, never
// the request's; hostile fields refuse before the guest and replaced parents
// refuse without writing through a link. C-SEC-02 is the real-machine receipt.
func TestTodoRootCodingBinding(t *testing.T) {
	ctx := context.Background()
	readBinding := func(t *testing.T, guestDir string) map[string]any {
		t.Helper()
		body, err := os.ReadFile(filepath.Join(guestDir, "etc", "smithers", "workspace-coding.json"))
		require.NoError(t, err)
		var binding map[string]any
		require.NoError(t, json.Unmarshal(body, &binding))
		return binding
	}

	t.Run("fresh then retained machine", func(t *testing.T) {
		bundle, files := approvedBundleFixture(t)
		runtime, argv, guestDir := guestArtifactMSB(t, bundle)
		egressWorkspace(t, runtime, "coding-lane", "running", 0)
		require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", codingBindingFixture()))
		helper := filepath.Join(guestDir, "usr", "local", "bin", "smithers-jj-export")
		body, err := os.ReadFile(helper)
		require.NoError(t, err)
		require.Equal(t, files[codingHelperBundlePath], body)
		info, err := os.Lstat(helper)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o755), info.Mode())
		require.Equal(t, map[string]any{"version": float64(1), "workspaceId": "coding-lane", "actorId": float64(9), "repositoryId": float64(77),
			"repositorySlug": "acme/widgets", "apiBaseUrl": "http://127.0.0.1:4000/api", "gitUrl": "http://127.0.0.1:4000/acme/widgets.git",
			"repositoryPath": guestRoot, "username": guestUser, "credentialSocket": guestHome + "/.cache/smithers/git-credential/socket"}, readBinding(t, guestDir))
		require.Equal(t, 1, guestCalls(t, argv, "coding-helper"))

		// Retained and current: the helper is checked, not rewritten; the
		// binding is replaced atomically with the new actor.
		next := codingBindingFixture()
		next.ActorID = 10
		require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", next))
		require.Equal(t, 1, guestCalls(t, argv, "coding-helper"))
		require.Equal(t, 2, guestCalls(t, argv, "coding-helper-check"))
		require.Equal(t, float64(10), readBinding(t, guestDir)["actorId"])
		entries, err := os.ReadDir(filepath.Join(guestDir, "etc", "smithers"))
		require.NoError(t, err)
		require.Len(t, entries, 1, "no temporary binding remains")

		// Retained with drifted helper bytes: the approved bytes return.
		require.NoError(t, os.WriteFile(helper, []byte("tampered"), 0o755))
		require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", next))
		body, err = os.ReadFile(helper)
		require.NoError(t, err)
		require.Equal(t, files[codingHelperBundlePath], body)
		require.Equal(t, 2, guestCalls(t, argv, "coding-helper"))
		log, err := os.ReadFile(argv)
		require.NoError(t, err)
		require.NotContains(t, string(log), "sh -c")
	})

	t.Run("hostile binding fields refuse before the guest", func(t *testing.T) {
		for name, mutate := range map[string]func(*workspaceapi.WorkspaceCodingBinding){
			"zero actor":       func(b *workspaceapi.WorkspaceCodingBinding) { b.ActorID = 0 },
			"slug traversal":   func(b *workspaceapi.WorkspaceCodingBinding) { b.RepositorySlug = "../widgets" },
			"API credentials":  func(b *workspaceapi.WorkspaceCodingBinding) { b.APIBaseURL = "http://secret@127.0.0.1:4000/api" },
			"git elsewhere":    func(b *workspaceapi.WorkspaceCodingBinding) { b.GitURL = "http://other.example/acme/widgets.git" },
			"API path":         func(b *workspaceapi.WorkspaceCodingBinding) { b.APIBaseURL += "/other" },
			"negative project": func(b *workspaceapi.WorkspaceCodingBinding) { b.RepositoryID = -1 },
		} {
			t.Run(name, func(t *testing.T) {
				bundle, _ := approvedBundleFixture(t)
				runtime, argv, guestDir := guestArtifactMSB(t, bundle)
				egressWorkspace(t, runtime, "coding-lane", "running", 0)
				binding := codingBindingFixture()
				mutate(&binding)
				require.Error(t, runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", binding))
				_, err := os.Stat(argv)
				require.ErrorIs(t, err, os.ErrNotExist, "refusal starts no guest process")
				_, err = os.Stat(filepath.Join(guestDir, "etc", "smithers"))
				require.ErrorIs(t, err, os.ErrNotExist)
			})
		}
	})

	t.Run("replaced parents on a retained machine refuse without following", func(t *testing.T) {
		for _, test := range []struct {
			name   string
			helper bool
			swap   func(t *testing.T, guestDir, outside, sentinel string)
		}{
			{name: "binding directory link", swap: func(t *testing.T, guestDir, outside, _ string) {
				require.NoError(t, os.RemoveAll(filepath.Join(guestDir, "etc", "smithers")))
				require.NoError(t, os.Symlink(outside, filepath.Join(guestDir, "etc", "smithers")))
			}},
			{name: "binding target link", swap: func(t *testing.T, guestDir, _, sentinel string) {
				target := filepath.Join(guestDir, "etc", "smithers", "workspace-coding.json")
				require.NoError(t, os.Remove(target))
				require.NoError(t, os.Symlink(sentinel, target))
			}},
			{name: "writable binding directory", swap: func(t *testing.T, guestDir, _, _ string) {
				require.NoError(t, os.Chmod(filepath.Join(guestDir, "etc", "smithers"), 0o777))
			}},
			{name: "helper target link", helper: true, swap: func(t *testing.T, guestDir, _, sentinel string) {
				target := filepath.Join(guestDir, "usr", "local", "bin", "smithers-jj-export")
				require.NoError(t, os.Remove(target))
				require.NoError(t, os.Symlink(sentinel, target))
			}},
			{name: "writable helper directory", helper: true, swap: func(t *testing.T, guestDir, _, _ string) {
				require.NoError(t, os.Chmod(filepath.Join(guestDir, "usr", "local", "bin"), 0o775))
			}},
		} {
			t.Run(test.name, func(t *testing.T) {
				bundle, _ := approvedBundleFixture(t)
				runtime, argv, guestDir := guestArtifactMSB(t, bundle)
				egressWorkspace(t, runtime, "coding-lane", "running", 0)
				require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", codingBindingFixture()))
				before := guestCalls(t, argv, "coding-binding")
				outside := t.TempDir()
				sentinel := filepath.Join(outside, "sentinel")
				require.NoError(t, os.WriteFile(sentinel, []byte("unchanged"), 0o600))
				test.swap(t, guestDir, outside, sentinel)
				err := runtime.InstallWorkspaceCodingBinding(ctx, "coding-lane", codingBindingFixture())
				require.ErrorIs(t, err, ErrUnavailable)
				body, readErr := os.ReadFile(sentinel)
				require.NoError(t, readErr)
				require.Equal(t, "unchanged", string(body))
				entries, readErr := os.ReadDir(outside)
				require.NoError(t, readErr)
				require.Len(t, entries, 1, "nothing was written through a link")
				if test.helper {
					require.Equal(t, before, guestCalls(t, argv, "coding-binding"), "a refused helper installs no binding")
				}
			})
		}
	})
}
