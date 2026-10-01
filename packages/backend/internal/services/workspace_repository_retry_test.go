package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type fetchRetryRuntime struct {
	workspaceapi.WorkspaceRuntime
	commands   []workspaceapi.Command
	operations []string
	results    []workspaceapi.CommandResult
	transport  error
	cancel     context.CancelFunc
	entries    []workspaceapi.FileEntry
	listErr    error
}

func (r *fetchRetryRuntime) ExecuteCommand(ctx context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.commands = append(r.commands, command)
	operation, ok := workspaceapi.OperationFromContext(ctx)
	if !ok {
		panic("missing operation")
	}
	r.operations = append(r.operations, operation.OperationID)
	if r.cancel != nil {
		r.cancel()
	}
	if r.transport != nil {
		return workspaceapi.CommandResult{}, r.transport
	}
	result := r.results[0]
	if len(r.results) > 1 {
		r.results = r.results[1:]
	}
	return result, nil
}
func (r *fetchRetryRuntime) ListFiles(context.Context, string, string) ([]workspaceapi.FileEntry, error) {
	return r.entries, r.listErr
}
func fetchRefusal(status string) workspaceapi.CommandResult {
	return workspaceapi.CommandResult{ExitCode: 128, Stderr: "fatal: unable to access repository: The requested URL returned error: " + status}
}
func TestWorkspaceRepositoryFetchRetriesAdmission(t *testing.T) {
	for _, status := range []string{"503", "504"} {
		t.Run(status, func(t *testing.T) {
			runtime := &fetchRetryRuntime{results: []workspaceapi.CommandResult{fetchRefusal(status), {}}}
			svc := &WorkspaceService{runtime: runtime}
			row := sampleDBWorkspace("retry-fetch")
			command := workspaceapi.Command{Args: []string{"git", "fetch", "--depth=200", "origin", "main"}, Environment: map[string]string{"GIT_TERMINAL_PROMPT": "0"}}
			require.NoError(t, svc.runRuntimeRepositoryCommand(context.Background(), row, row.UserID, "fetch", command))
			require.Equal(t, []workspaceapi.Command{command, command}, runtime.commands)
			require.NotEqual(t, runtime.operations[0], runtime.operations[1], "a retry must execute rather than replay the failed exec receipt")
			require.True(t, strings.HasSuffix(runtime.operations[1], "-retry-1"))
		})
	}
}
func TestWorkspaceRepositoryFetchRetryStops(t *testing.T) {
	for _, scenario := range []string{"budget", "auth", "checkout", "truncated", "transport", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := fetchRefusal("503")
			command := workspaceapi.Command{Args: []string{"git", "fetch", "origin", "main"}}
			runtime := &fetchRetryRuntime{}
			switch scenario {
			case "auth":
				result = fetchRefusal("403")
			case "checkout":
				command.Args[1] = "checkout"
			case "truncated":
				result.OutputTruncated = true
			case "transport":
				runtime.transport = errors.New("lost worker")
			case "cancel":
				runtime.cancel = cancel
			}
			runtime.results = []workspaceapi.CommandResult{result}
			svc := &WorkspaceService{runtime: runtime}
			row := sampleDBWorkspace("retry-stops")
			err := svc.runRuntimeRepositoryCommand(ctx, row, row.UserID, "fetch", command)
			require.Error(t, err)
			if scenario == "budget" {
				require.Len(t, runtime.commands, 4)
				require.ErrorContains(t, err, "503")
			} else {
				require.Len(t, runtime.commands, 1)
			}
			if scenario == "cancel" {
				require.ErrorIs(t, err, context.Canceled)
			}
		})
	}
}
func TestWorkspaceRepositoryContinuationKeepsShallowDepth(t *testing.T) {
	runtime := &fetchRetryRuntime{results: []workspaceapi.CommandResult{{Stdout: "https://smithers.example/alice/demo.git"}, {}, {}}}
	svc := &WorkspaceService{runtime: runtime}
	row := sampleDBWorkspace("shallow-continuation")
	require.NoError(t, svc.continueRuntimeRepositoryCheckout(context.Background(), row, row.UserID, "https://smithers.example/alice/demo.git", "main", nil))
	require.Equal(t, []string{"git", "fetch", "--depth=200", "origin", "main"}, runtime.commands[1].Args)
	require.Equal(t, []string{"git", "checkout", "-B", "main", "origin/main"}, runtime.commands[2].Args)
}

func TestWorkspaceRepositoryCloneRetriesOnlyEmptyDestination(t *testing.T) {
	for _, scenario := range []string{"empty", "partial-repository", "user-file", "unavailable-files"} {
		t.Run(scenario, func(t *testing.T) {
			runtime := &fetchRetryRuntime{results: []workspaceapi.CommandResult{fetchRefusal("503"), {}}}
			switch scenario {
			case "partial-repository":
				runtime.entries = []workspaceapi.FileEntry{{Name: ".git", IsDir: true}}
			case "user-file":
				runtime.entries = []workspaceapi.FileEntry{{Name: "user.txt"}}
			case "unavailable-files":
				runtime.listErr = errors.New("files unavailable")
			}
			svc := &WorkspaceService{runtime: runtime}
			row := sampleDBWorkspace("retry-clone")
			command := workspaceapi.Command{Args: []string{"git", "clone", "--depth", "200", "--branch", "main", "--", "https://smithers.example/alice/demo.git", "."}}
			err := svc.runRuntimeRepositoryCommand(context.Background(), row, row.UserID, "clone", command)
			if scenario == "empty" {
				require.NoError(t, err)
				require.Equal(t, []workspaceapi.Command{command, command}, runtime.commands)
			} else {
				require.Error(t, err)
				require.Len(t, runtime.commands, 1)
			}
		})
	}
}

func TestWorkspaceRepositoryAdvertisementRetriesAdmission(t *testing.T) {
	runtime := &fetchRetryRuntime{results: []workspaceapi.CommandResult{fetchRefusal("503"), {Stdout: "remote refs\n"}}}
	svc := &WorkspaceService{runtime: runtime}
	row := sampleDBWorkspace("retry-advertisement")
	out, err := svc.runtimeRepositoryCommandOutput(context.Background(), row, row.UserID, "advertisement", workspaceapi.Command{Args: []string{"git", "ls-remote", "--", "https://smithers.example/alice/demo.git"}})
	require.NoError(t, err)
	require.Equal(t, "remote refs", out)
	require.Len(t, runtime.commands, 2)
	require.NotEqual(t, runtime.operations[0], runtime.operations[1])
}
