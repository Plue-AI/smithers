package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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
	instructionRevision := func(want string) {
		t.Helper()
		row, err := h.q.GetInstallSetting(ctx, fmt.Sprintf("agent.instructions.main:%d", h.repoID))
		require.NoError(t, err)
		require.JSONEq(t, strconv.Quote(want), string(row.Value))
	}
	m1 := move("export default 'one'\n")
	require.Len(t, loads(), 1)
	d1 := strings.Repeat("1", 64)
	settle(loads()[0], m1, d1, "loaded", "")
	active, err := ActiveFlowDigest(ctx, h.q, h.repoID, "todo")
	require.NoError(t, err)
	require.Equal(t, d1, active)
	instructionRevision(m1)
	m2 := move("const prompt: string = 123\nexport default prompt\n")
	require.Len(t, loads(), 2)
	settle(loads()[1], m2, strings.Repeat("2", 64), "failed", "flows/todo/flow.ts:29: Type 'number' is not assignable to type 'string'.")
	active, err = ActiveFlowDigest(ctx, h.q, h.repoID, "todo")
	require.NoError(t, err)
	require.Equal(t, d1, active)
	instructionRevision(m1)
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
	instructionRevision(m1)
	settle(loads()[3], m5, strings.Repeat("5", 64), "loaded", "")
	instructionRevision(m5)
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
	instructionRevision(m5)
	cards, err = RepositoryFlowCatalog(ctx, h.q, h.repoID)
	require.NoError(t, err)
	require.Equal(t, []FlowStep{{ID: "changelog", Label: "Changelog"}}, cards[0].Versions[0].Steps)
	require.Contains(t, states(cards[0]), "merged-failed "+d6+": flows/todo/flow.ts: Module flows require a literal description in the default Flow.make value")
	rows, err = h.q.ListFlowVersions(ctx, h.repoID)
	require.NoError(t, err)
	require.Len(t, rows, 5)

	// A fresh provider replays the exact committed transitions, including an
	// earlier failure after a later success, without rebuilding today's card.
	restarted, err := jobs.NewStore(h.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	page, err := restarted.Replay(ctx, FlowLiveScope(h.repoID), 0, 1000)
	require.NoError(t, err)
	var sawFirstFailure, sawNewest bool
	for _, event := range page.Events {
		var projection struct {
			Card []FlowCard `json:"card"`
		}
		require.NoError(t, json.Unmarshal(event.Data, &projection))
		require.NotEmpty(t, projection.Card)
		versions := states(projection.Card[0])
		if slices.Contains(versions, "merged-failed "+strings.Repeat("2", 64)+": flows/todo/flow.ts:29: Type 'number' is not assignable to type 'string'.") && projection.Card[0].Versions[0].ID == d1 {
			sawFirstFailure = true
		}
		if projection.Card[0].Versions[0].ID == strings.Repeat("5", 64) {
			sawNewest = true
		}
	}
	require.True(t, sawFirstFailure, "replay must retain the first Active beside its failed replacement")
	require.True(t, sawNewest, "replay must include the new Active")
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

func TestFlowLoadProjectionRollsBackWithActivation(t *testing.T) {
	h := newMergeHarness(t)
	ctx := t.Context()
	store, err := jobs.NewStore(h.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	tx, err := h.pool.Begin(ctx)
	require.NoError(t, err)
	digest := strings.Repeat("a", 64)
	_, err = persistFlowVersions(ctx, db.New(tx), h.repoID, strings.Repeat("1", 40), []FlowLoadVersion{{Name: "todo", Path: "flows/todo/flow.ts", Digest: digest, Status: "loaded"}})
	require.NoError(t, err)
	require.NoError(t, h.service.recordFlowFact(ctx, tx, h.repoID))
	require.NoError(t, tx.Rollback(ctx))
	page, err := store.Replay(ctx, FlowLiveScope(h.repoID), 0, 100)
	require.NoError(t, err)
	require.Empty(t, page.Events)
	require.Zero(t, page.Head)
	versions, err := h.q.ListFlowVersions(ctx, h.repoID)
	require.NoError(t, err)
	require.Empty(t, versions)
}

func TestFlowLoadProposalFactsReplayAndDeduplicate(t *testing.T) {
	h := newMergeHarness(t)
	require.NoError(t, os.MkdirAll(filepath.Join(h.work, "flows/todo"), 0700))
	ctx := t.Context()
	item := h.todo("Change flow", "Change the TODO flow", h.main, "flows/todo/flow.ts", "export default 'candidate'\n")
	store, err := jobs.NewStore(h.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	before, err := store.Head(ctx, FlowLiveScope(h.repoID))
	require.NoError(t, err)
	todoBefore, err := store.Head(ctx, todoOperationScope(item))
	require.NoError(t, err)
	record := func() {
		t.Helper()
		tx, err := h.pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		_, err = h.service.recordTodoFlowFact(ctx, tx, item, uuid.NewString(), "todo.run_updated", todoState(item), json.RawMessage(`{}`))
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
	}
	record()
	todoPage, err := store.Replay(ctx, todoOperationScope(item), todoBefore, 100)
	require.NoError(t, err)
	require.Len(t, todoPage.Events, 1)
	var todoProjection struct {
		Card map[string]any `json:"card"`
	}
	require.NoError(t, json.Unmarshal(todoPage.Events[0].Data, &todoProjection))
	require.Equal(t, todoState(item), todoProjection.Card["state"], "flow publication retains the committed TODO card")
	head, err := store.Head(ctx, FlowLiveScope(h.repoID))
	require.NoError(t, err)
	require.Equal(t, before+1, head)
	record()
	unchanged, err := store.Head(ctx, FlowLiveScope(h.repoID))
	require.NoError(t, err)
	require.Equal(t, head, unchanged, "unrelated TODO facts cannot advance the flows cursor")
	item.State = "cancelled"
	item, err = h.q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	record()
	page, err := store.Replay(ctx, FlowLiveScope(h.repoID), before, 100)
	require.NoError(t, err)
	require.Len(t, page.Events, 2)
	for i, event := range page.Events {
		var data struct {
			Card []FlowCard `json:"card"`
		}
		require.NoError(t, json.Unmarshal(event.Data, &data))
		proposed := []int64{}
		for _, card := range data.Card {
			for _, version := range card.Versions {
				if version.State == "proposed" {
					proposed = append(proposed, version.Todo)
				}
			}
		}
		if i == 0 {
			require.Equal(t, []int64{item.Number.Int64}, proposed)
		} else {
			require.Empty(t, proposed)
		}
	}
}
