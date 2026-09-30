package services

import (
	"context"
	"errors"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// toolsRuntime answers the box's tool probe.
type toolsRuntime struct {
	workspaceapi.WorkspaceRuntime
	execution bool
	result    workspaceapi.CommandResult
	err       error
	commands  []workspaceapi.Command
}

func (r *toolsRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{Execution: r.execution}
}

func (r *toolsRuntime) ExecuteCommand(_ context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.commands = append(r.commands, command)
	return r.result, r.err
}

// A lane's coding host starts only on a box that has every tool its
// placement declares; a box without one refuses the start with a typed
// failure the run does not retry past.
func TestPrepareBoxHostVerifiesTheDeclaredTools(t *testing.T) {
	ctx := context.Background()
	workspace := db.Workspace{ID: "ws-lane", RepositoryID: 77, UserID: 9, Status: "running"}
	declared := func(context.Context, string) ([]string, error) { return []string{"go", "pnpm"}, nil }
	for _, tc := range []struct {
		name    string
		tools   func(context.Context, string) ([]string, error)
		runtime *toolsRuntime
		missing []string
		failed  bool
		probed  bool
	}{
		{name: "no placement provider", runtime: &toolsRuntime{execution: true}},
		{name: "nothing declared", tools: func(context.Context, string) ([]string, error) { return nil, nil }, runtime: &toolsRuntime{execution: true}},
		{name: "unreadable declaration", tools: func(context.Context, string) ([]string, error) { return nil, errors.New("down") },
			runtime: &toolsRuntime{execution: true}, failed: true},
		{name: "every tool present", tools: declared, runtime: &toolsRuntime{execution: true}, probed: true},
		{name: "one tool missing", tools: declared, runtime: &toolsRuntime{execution: true, result: workspaceapi.CommandResult{Stdout: "pnpm\n"}},
			missing: []string{"pnpm"}, probed: true},
		{name: "only declared tools, once", tools: declared,
			runtime: &toolsRuntime{execution: true, result: workspaceapi.CommandResult{Stdout: "go\nmotd\ngo\n"}}, missing: []string{"go"}, probed: true},
		{name: "a failed probe", tools: declared, runtime: &toolsRuntime{execution: true, result: workspaceapi.CommandResult{ExitCode: 2}},
			failed: true, probed: true},
		{name: "a truncated probe", tools: declared, runtime: &toolsRuntime{execution: true, result: workspaceapi.CommandResult{Stdout: "go", OutputTruncated: true}},
			failed: true, probed: true},
		{name: "a box that is not running", tools: declared, runtime: &toolsRuntime{execution: true, err: workspaceapi.ErrWorkspaceStopped},
			failed: true, probed: true},
		{name: "a runtime that cannot run the probe", tools: declared, runtime: &toolsRuntime{}, missing: []string{"go", "pnpm"}},
		{name: "no runtime", tools: declared, missing: []string{"go", "pnpm"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options := []WorkspaceServiceOption{}
			if tc.runtime != nil {
				options = append(options, WithWorkspaceRuntime(tc.runtime))
			}
			if tc.tools != nil {
				options = append(options, WithWorkspaceBoxTools(tc.tools))
			}
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
			}, options...)
			_, err := svc.PrepareBoxHost(ctx, "host-1", workspace.ID, 77, 9)
			var refusal boxToolsMissing
			switch {
			case tc.missing != nil:
				require.ErrorAs(t, err, &refusal)
				assert.Equal(t, tc.missing, refusal.tools)
				var failure flowruntime.Failure
				require.ErrorAs(t, err, &failure)
				assert.Equal(t, "environment_tools_missing", failure.FlowRuntimeCode())
				assert.False(t, failure.FlowRuntimeRetryable(), "no retry grows the tool")
			case tc.failed:
				require.Error(t, err)
				assert.False(t, errors.As(err, &refusal), "an unproven probe is never the owner's fault")
			default:
				require.NoError(t, err)
			}
			if tc.runtime == nil {
				return
			}
			if !tc.probed {
				assert.Empty(t, tc.runtime.commands)
				return
			}
			require.Len(t, tc.runtime.commands, 1)
			assert.Equal(t, []string{"/bin/sh", "-lc", boxToolsProbe, "sh", "go", "pnpm"}, tc.runtime.commands[0].Args)
		})
	}

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("gone")
		},
	}, WithWorkspaceRuntime(&toolsRuntime{execution: true}), WithWorkspaceBoxTools(declared))
	_, err := svc.PrepareBoxHost(ctx, "host-1", workspace.ID, 77, 9)
	require.Error(t, err, "a box the requester cannot reach is never probed")
}

// The probe prints exactly the arguments that are no command on PATH.
func TestBoxToolsProbeNamesTheMissingTools(t *testing.T) {
	out, err := exec.Command("/bin/sh", "-c", boxToolsProbe, "sh", "sh", "smithers-no-such-tool", "ls", "smithers-no-such-tool-2").Output()
	require.NoError(t, err)
	assert.Equal(t, "smithers-no-such-tool\nsmithers-no-such-tool-2\n", string(out))
	out, err = exec.Command("/bin/sh", "-c", boxToolsProbe, "sh").Output()
	require.NoError(t, err)
	assert.Empty(t, string(out), "no tools, nothing missing")
}
