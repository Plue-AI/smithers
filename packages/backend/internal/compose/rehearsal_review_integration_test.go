package compose

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func newRehearsalReviewRuntime(t *testing.T, runtime *rehearsalAdmissionRuntime, node, helper, host, evidence, daemon string, daemons *machined.Registry) *rehearsalReviewRuntime {
	t.Helper()
	bwrap, err := exec.LookPath("bwrap")
	require.NoError(t, err)
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	tools := t.TempDir()
	data, err := os.ReadFile(jj)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(tools, "jj"), data, 0700))
	data, err = os.ReadFile(bwrap)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(tools, "bwrap"), data, 0700))
	return &rehearsalReviewRuntime{rehearsalAdmissionRuntime: runtime, t: t, tools: tools, bubblewrap: bwrap, node: node, helper: helper, host: host, evidence: evidence, daemon: daemon, daemons: daemons}
}

// HTTP proof without waiting for J10's unrelated multi-TODO GitHub scenarios.
func TestJ10MemberReviewRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J10_REHEARSAL", "C-J10", "j10-review-")

	runtime := r.options.ReviewWorkspace.(*rehearsalReviewRuntime)
	machine, err := runtime.CreateWorkspace(r.ctx, workspaceapi.WorkspaceSpec{ID: "review-confinement"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(r.ctx, machine.ID)
	require.NoError(t, err)
	result, err := runtime.ExecuteCommand(r.ctx, machine.ID, workspaceapi.Command{Args: []string{"id", "-u"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	require.Equal(t, "19998\n", result.Stdout)
	secret := filepath.Join(t.TempDir(), "host-secret")
	require.NoError(t, os.WriteFile(secret, []byte("review-must-not-read-host"), 0600))
	result, err = runtime.ExecuteCommand(r.ctx, machine.ID, workspaceapi.Command{Args: []string{"cat", secret}})
	require.NoError(t, err)
	require.NotEqual(t, 0, result.ExitCode)
	require.NotContains(t, result.Stdout, "review-must-not-read-host")
	require.NoError(t, runtime.DeleteWorkspace(r.ctx, machine.ID))
	if !r.install("Install through Machine ready") {
		return
	}
	ben, err := r.member("ben", 201, "maintain")
	require.NoError(t, err)
	_, err = r.member("alice", 202, "write")
	require.NoError(t, err)
	r.j10BuiltinReviewActive()
	r.j10MemberReview(ben, "rehearsal-owner/app")
}
