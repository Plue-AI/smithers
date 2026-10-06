package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL and githubfake drive the production main poll worker. The
// launcher records admission only: this is supplemental, not C-SEC-02 proof.
func TestFlowLoadProductionPollKeepsPreviousAndCoalesces(t *testing.T) {
	h := newMergeHarness(t)
	require.NoError(t, os.MkdirAll(filepath.Join(h.work, "flows/todo"), 0700))
	ctx := context.Background()
	launcher, lanes := &fakeMythicalLauncher{}, &fakeMythicalLanes{}
	lanes.provision = func(id string) {
		h.exec(`INSERT INTO workspaces(id,repository_id,user_id,name,status) VALUES($1,$2,$3,$4,'running')`, id, h.repoID, h.userID, id)
	}
	h.service.SetOrchestration(h.service.github, launcher, lanes)
	h.service.SetFlowLoad(true)
	sync := NewGitHubMainPullService(h.q, h.host, h.connections, h.connections)
	qualifyMainPullFixture(sync)
	sync.SetMainMoved(h.service.MainMoved)
	loads := func() []flowdispatch.LaunchRequest {
		launcher.mu.Lock()
		defer launcher.mu.Unlock()
		out := []flowdispatch.LaunchRequest{}
		for _, request := range launcher.requests {
			if request.FlowID == "flow-load" {
				out = append(out, request)
			}
		}
		return out
	}
	poll := func() {
		_, err := sync.Request(ctx, h.repoID)
		require.NoError(t, err)
		require.NoError(t, sync.PollOnce(ctx))
		require.NoError(t, h.service.PollOnce(ctx))
	}
	settle := func(request flowdispatch.LaunchRequest, commit, digest, status, loadError string) {
		output := flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: digest, Status: status, Error: loadError, Steps: []FlowStep{{ID: "changelog", Label: "Changelog"}}})
		require.NoError(t, NewFlowLoadRuntime(h.service).ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateCompleted,
			Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: commit, Run: &flowruntime.FlowRuntimeRun{RunID: commit, FinalOutput: &output}}}))
		require.NoError(t, h.service.PollOnce(ctx))
	}
	move := func(text string) string {
		h.git(h.work, "checkout", "-q", "main")
		head := h.commit("flow edit", "flows/todo/flow.ts", text)
		h.git(h.work, "push", "-q", h.github, "main:refs/heads/main")
		poll()
		require.Equal(t, head, h.hostRef("refs/heads/main"), "only the poll sync brings main into the install")
		return head
	}
	// A frozen stack must still load main; it cannot hold activation hostage.
	h.exec(`UPDATE mythical_stacks SET state='frozen' WHERE repository_id=$1`, h.repoID)
	m1 := move("export default 'one'\n")
	require.Len(t, loads(), 1)
	d1 := strings.Repeat("1", 64)
	settle(loads()[0], m1, d1, "loaded", "")
	active, err := ActiveFlowDigest(ctx, h.q, h.repoID, "todo")
	require.NoError(t, err)
	require.Equal(t, d1, active)
	m2 := move("const prompt: string = 123\nexport default prompt\n")
	require.Len(t, loads(), 2)
	settle(loads()[1], m2, strings.Repeat("2", 64), "failed", "flows/todo/flow.ts:29: Type 'number' is not assignable to type 'string'.")
	active, err = ActiveFlowDigest(ctx, h.q, h.repoID, "todo")
	require.NoError(t, err)
	require.Equal(t, d1, active)
	cards, err := RepositoryFlowCatalog(ctx, h.q, h.repoID)
	require.NoError(t, err)
	require.Equal(t, []FlowStep{{ID: "changelog", Label: "Changelog"}}, cards[0].Versions[0].Steps)
	require.Contains(t, states(cards[0]), "merged-failed "+strings.Repeat("2", 64)+": flows/todo/flow.ts:29: Type 'number' is not assignable to type 'string'.")
	m3 := move("export default 'three'\n")
	require.Len(t, loads(), 3)
	move("export default 'four'\n")
	m5 := move("export default 'five'\n")
	require.Len(t, loads(), 3)
	settle(loads()[2], m3, strings.Repeat("3", 64), "loaded", "")
	require.Len(t, loads(), 4)
	commit, _ := loadBase(t, loads()[3])
	require.Equal(t, m5, commit)
	active, err = ActiveFlowDigest(ctx, h.q, h.repoID, "todo")
	require.NoError(t, err)
	require.Equal(t, d1, active, "stale success cannot activate")
	settle(loads()[3], m5, strings.Repeat("5", 64), "loaded", "")
	rows, err := db.New(h.pool).ListFlowVersions(ctx, h.repoID)
	require.NoError(t, err)
	require.Len(t, rows, 4)
	// A declaration rejected by guest discovery is a failed version, not a
	// deletion. Its previous Active survives the production poll/settlement.
	m6 := move("export default {}\n")
	require.Len(t, loads(), 5)
	d6 := strings.Repeat("6", 64)
	settle(loads()[4], m6, d6, "failed", "flows/todo/flow.ts: Module flows require a literal description in the default Flow.make value")
	active, err = ActiveFlowDigest(ctx, h.q, h.repoID, "todo")
	require.NoError(t, err)
	require.Equal(t, strings.Repeat("5", 64), active)
	cards, err = RepositoryFlowCatalog(ctx, h.q, h.repoID)
	require.NoError(t, err)
	require.Equal(t, []FlowStep{{ID: "changelog", Label: "Changelog"}}, cards[0].Versions[0].Steps)
	require.Contains(t, states(cards[0]), "merged-failed "+d6+": flows/todo/flow.ts: Module flows require a literal description in the default Flow.make value")
	rows, err = h.q.ListFlowVersions(ctx, h.repoID)
	require.NoError(t, err)
	require.Len(t, rows, 5)
}

func TestFlowLoadProposalsUseCandidateDiffNotWorkingCopy(t *testing.T) {
	h := newMergeHarness(t)
	require.NoError(t, os.MkdirAll(filepath.Join(h.work, "flows/todo"), 0700))
	item := h.todo("Change flow", "Change the TODO flow", h.main, "flows/todo/flow.ts", "export default 'candidate'\n")
	proposals, err := h.service.FlowProposals(t.Context(), h.repoID)
	require.NoError(t, err)
	require.Len(t, proposals["todo"], 1)
	require.Equal(t, "proposed", proposals["todo"][0].State)
	require.Equal(t, item.Number.Int64, proposals["todo"][0].Todo)
	// Mutable local bytes cannot change the recorded candidate's identity.
	h.commit("unaccepted", "flows/todo/flow.ts", "export default 'not accepted'\n")
	again, err := h.service.FlowProposals(t.Context(), h.repoID)
	require.NoError(t, err)
	require.Equal(t, proposals, again)
	h.exec(`UPDATE mythical_items SET state='landed' WHERE id=$1`, item.ID)
	proposals, err = h.service.FlowProposals(t.Context(), h.repoID)
	require.NoError(t, err)
	require.Empty(t, proposals)
	// A prompt/helper inside the flow directory also proposes a version;
	// the entry itself need not change.
	helper := h.todo("Change flow prompt", "Change its prompt", item.CandidateHead, "flows/todo/prompt.md", "New prompt\n")
	proposals, err = h.service.FlowProposals(t.Context(), h.repoID)
	require.NoError(t, err)
	require.Len(t, proposals["todo"], 1)
	require.Equal(t, helper.Number.Int64, proposals["todo"][0].Todo)
}
