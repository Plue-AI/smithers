package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Inject a guest's certified exit at the runtime boundary. Repository preparation
// and durable execution are exercised with real dependencies in the integration test.
// Spec oracle (§8.6.2, §6.2.3, §19.4): a missing tool names its declaration file,
// keeps the user fault class end to end, and retains the completed exit evidence.
// Expected failure envelope fields: code, class (user), message and fix.
func TestWorkspaceCommandMissingToolPreservesCompletedResult(t *testing.T) {
	result := workspaceapi.CommandResult{ExitCode: 127, Stdout: "before failure", Stderr: "cargo: not found\n", OutputTruncated: true}
	refusal := microsandbox.MissingToolError(workspaceapi.Command{Args: []string{"cargo"}}, result)
	for _, wrapped := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "wrapped"}[wrapped], func(t *testing.T) {
			failure := refusal
			if wrapped {
				failure = errors.Join(errors.New("guest diagnostic"), refusal)
			}
			runtime := &toolsRuntime{execution: true, result: result, err: failure}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(runtime))
			output, err := service.executePreparedWorkspaceCommand(context.Background(), sampleDBWorkspace("missing-tool"), WorkspaceCommandInput{Args: []string{"cargo"}})
			require.NoError(t, err, "a certified exit remains a completed command receipt")
			require.Equal(t, 127, output.ExitCode)
			require.Equal(t, result.Stdout, output.Stdout)
			require.Equal(t, result.Stderr, output.Stderr)
			require.True(t, output.OutputTruncated)
			raw, err := json.Marshal(output)
			require.NoError(t, err)
			require.Contains(t, string(raw), `"code":"missing_machine_tool"`)
			require.Contains(t, string(raw), `"class":"user"`)
			require.Contains(t, string(raw), "rust-toolchain.toml")
		})
	}
}

func TestWorkspaceCommandMissingToolDoesNotCertifyOtherRuntimeFailures(t *testing.T) {
	result := workspaceapi.CommandResult{ExitCode: 127, Stdout: "before failure", Stderr: "cargo: not found\n", OutputTruncated: true}
	refusal := microsandbox.MissingToolError(workspaceapi.Command{Args: []string{"cargo"}}, result)
	for _, tc := range []struct {
		name     string
		exitCode int
		failure  error
	}{
		{"unconfirmed termination", 127, errors.Join(refusal, workspaceapi.ErrCommandTerminationUnconfirmed)},
		{"cancelled command", 127, errors.Join(refusal, workspaceapi.ErrCommandCancelled)},
		{"different process exit", 126, refusal},
		{"no process exit", 0, refusal},
		{"other recipe failure", 127, &microsandbox.RecipeError{Code: "recipe_dependencies_failed", Class: "user", Message: "dependencies failed"}},
		{"infra recipe failure", 127, &microsandbox.RecipeError{Code: "missing_machine_tool", Class: "infra", Message: "transport failed"}},
		{"unknown runtime failure", 127, errors.New("guest transport disconnected")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			guestResult := result
			guestResult.ExitCode = tc.exitCode
			runtime := &toolsRuntime{execution: true, result: guestResult, err: tc.failure}
			activityUpdates := 0
			queries := &mockWorkspaceQuerier{touchWorkspaceActivityFn: func(context.Context, string) error {
				activityUpdates++
				return nil
			}}
			service := newWorkspaceServiceForTests(queries, WithWorkspaceRuntime(runtime))
			output, err := service.executePreparedWorkspaceCommand(t.Context(), sampleDBWorkspace("missing-tool"), WorkspaceCommandInput{Args: []string{"cargo"}})
			require.ErrorIs(t, err, tc.failure)
			require.Nil(t, output.Error, "an unconfirmed or unrelated failure is not a completed missing-tool receipt")
			require.Equal(t, guestResult.ExitCode, output.ExitCode)
			require.Equal(t, guestResult.Stdout, output.Stdout)
			require.Equal(t, guestResult.Stderr, output.Stderr)
			require.True(t, output.OutputTruncated)
			require.Zero(t, activityUpdates)
		})
	}
}

// Spec oracle (§6.2.3, §19.4): recovery retains the typed failure's user class and
// actionable fix. The permanent history rule keeps existing receipts readable.
func TestWorkspaceCommandMissingToolReadsPersistedAndLegacyReceipt(t *testing.T) {
	// Existing completed receipts predate the optional typed annotation. Recovery
	// must retain their bytes and exit status without inventing a diagnosis.
	for _, annotated := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "typed"}[annotated], func(t *testing.T) {
			receipt := `{"exit_code":127,"stdout":"YmVmb3JlAGZhaWx1cmU=","stderr":"Y2FyZ286IG5vdCBmb3VuZAo=","output_truncated":true`
			if annotated {
				receipt += `,"error":{"code":"missing_machine_tool","class":"user","message":"cargo isn't installed · add rust-toolchain.toml","fix":"Add rust-toolchain.toml"}`
			}
			receipt += `}`
			run, err := commandRunReceipt(jobs.Operation{ID: "persisted-command", State: jobs.StateCompleted, TerminalReceipt: []byte(receipt)})
			require.NoError(t, err)
			require.Equal(t, jobs.StateCompleted, run.State)
			require.Empty(t, run.Error)
			require.NotNil(t, run.Result)
			require.Equal(t, 127, run.Result.ExitCode)
			require.Equal(t, "before\x00failure", run.Result.Stdout)
			require.Equal(t, "cargo: not found\n", run.Result.Stderr)
			require.True(t, run.Result.OutputTruncated)
			if annotated {
				require.Equal(t, &microsandbox.RecipeError{Code: "missing_machine_tool", Class: "user", Message: "cargo isn't installed · add rust-toolchain.toml", Fix: "Add rust-toolchain.toml"}, run.Result.Error)
			} else {
				require.Nil(t, run.Result.Error)
			}
		})
	}
}
