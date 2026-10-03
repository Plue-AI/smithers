package microsandbox

import (
	"context"
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

func codingHelperFixture(t *testing.T, runtime *Runtime) {
	t.Helper()
	data := make([]byte, 64)
	copy(data, []byte("\x7fELF"))
	data[4], data[5], data[18] = 2, 1, 183
	file := filepath.Join(t.TempDir(), "smithers-jj-export")
	require.NoError(t, os.WriteFile(file, data, 0755))
	runtime.config.CodingHelper = file
	script, err := os.ReadFile(runtime.cli.binary)
	require.NoError(t, err)
	script = []byte(strings.Replace(string(script), "exit 0", "case \"$*\" in *' coding-helper-check') echo replace;; esac\nexit 0", 1))
	require.NoError(t, os.WriteFile(runtime.cli.binary, script, 0700))
}

func TestMicroVMCodingBindingSkipsUnchangedHelperAndRepairsDrift(t *testing.T) {
	runtime, argv, stdin := egressFakeMSB(t, nil)
	codingHelperFixture(t, runtime)
	egressWorkspace(t, runtime, "coding-lane", "running", 0)
	state := filepath.Join(t.TempDir(), "installed")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %q
cat > %q
case "$*" in
  *' coding-helper-check') if [ -f %q ]; then echo current; else echo replace; fi;;
  *' coding-helper') touch %q;;
esac
`, argv, stdin, state, state)
	require.NoError(t, os.WriteFile(runtime.cli.binary, []byte(script), 0700))
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	// The configured runtime retains its validated bytes even if the packaged
	// path disappears after startup; every guest still checks its own copy.
	require.NoError(t, os.Remove(runtime.config.CodingHelper))
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(args), " coding-helper\n"))
	require.Equal(t, 2, strings.Count(string(args), " coding-helper-check\n"))
	require.Equal(t, 2, strings.Count(string(args), " coding-binding\n"))
	require.NoError(t, os.Remove(state))
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
	args, err = os.ReadFile(argv)
	require.NoError(t, err)
	require.Equal(t, 2, strings.Count(string(args), " coding-helper\n"), "guest drift reinstalls cached bytes")
	require.NotContains(t, string(args), "sh -c")
}

func TestMicroVMCodingBindingRefusesUnknownHelperCheck(t *testing.T) {
	runtime, argv, _ := egressFakeMSB(t, nil)
	codingHelperFixture(t, runtime)
	egressWorkspace(t, runtime, "coding-lane", "running", 0)
	script, err := os.ReadFile(runtime.cli.binary)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(runtime.cli.binary, []byte(strings.Replace(string(script), "echo replace", "echo unexpected", 1)), 0700))
	err = runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture())
	require.ErrorContains(t, err, "invalid result")
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Contains(t, string(args), " coding-helper-check\n")
	require.NotContains(t, string(args), " coding-helper\n")
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
	for _, name := range []string{"missing", "directory", "wrong platform", "not executable"} {
		t.Run(name, func(t *testing.T) {
			runtime, argv, _ := egressFakeMSB(t, nil)
			egressWorkspace(t, runtime, "coding-lane", "running", 0)
			codingHelperFixture(t, runtime)
			switch name {
			case "missing":
				runtime.config.CodingHelper = ""
			case "directory":
				runtime.config.CodingHelper = t.TempDir()
			case "wrong platform":
				require.NoError(t, os.WriteFile(runtime.config.CodingHelper, []byte("#!/bin/sh\n"), 0755))
			case "not executable":
				require.NoError(t, os.Chmod(runtime.config.CodingHelper, 0644))
			}
			require.Error(t, runtime.InstallWorkspaceCodingBinding(context.Background(), "coding-lane", codingBindingFixture()))
			_, err := os.Stat(argv)
			require.ErrorIs(t, err, os.ErrNotExist)
		})
	}
}
