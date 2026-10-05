package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// flowLoadOutput is a flow-load run's output, as flows/coding/flow-load.ts answers it.
func flowLoadOutput(commit string, versions ...FlowLoadVersion) string {
	if versions == nil {
		versions = []FlowLoadVersion{}
	}
	out, _ := json.Marshal(FlowLoadResult{CommitID: commit, Flows: versions})
	return string(out)
}

// projectLoad answers a flow-load run's terminal outcome, as flowdispatch would.
func (o *mythicalOrchestration) projectLoad(request flowdispatch.LaunchRequest, state jobs.State, runID, output string) {
	o.t.Helper()
	update := flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: runID,
		Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output}}}
	// The stack's own projector leaves flow-load's projections alone.
	require.NoError(o.t, o.service.ProjectFlowRuntime(context.Background(), update))
	require.NoError(o.t, NewFlowLoadRuntime(o.service).ProjectFlowRuntime(context.Background(), update))
}

// flowLoads answers every flow-load launch so far.
func (o *mythicalOrchestration) flowLoads() []flowdispatch.LaunchRequest {
	o.launcher.mu.Lock()
	defer o.launcher.mu.Unlock()
	loads := []flowdispatch.LaunchRequest{}
	for _, request := range o.launcher.requests {
		if request.FlowID == flowLoadFlow {
			loads = append(loads, request)
		}
	}
	return loads
}

func (o *mythicalOrchestration) commitFile(message, path, content string) string {
	o.t.Helper()
	require.NoError(o.t, os.MkdirAll(filepath.Join(o.work, filepath.Dir(path)), 0o700))
	o.commit(message, path, content)
	return o.publish()
}

func (o *mythicalOrchestration) flowCard(name string) FlowCard {
	o.t.Helper()
	cards, err := RepositoryFlowCatalog(context.Background(), db.New(o.pool), o.repoID)
	require.NoError(o.t, err)
	for _, card := range cards {
		if card.Name == name {
			return card
		}
	}
	return FlowCard{}
}

// states lists a card's versions as "state id[:error]".
func states(card FlowCard) []string {
	out := []string{}
	for _, version := range card.Versions {
		entry := version.State + " " + version.ID
		if version.Error != "" {
			entry += ": " + version.Error
		}
		out = append(out, entry)
	}
	return out
}

func loadBase(t *testing.T, request flowdispatch.LaunchRequest) (string, string) {
	var payload struct {
		Base struct {
			CommitID string `json:"commitId"`
			Ref      string `json:"ref"`
		} `json:"base"`
	}
	require.NoError(t, json.Unmarshal(request.Payload, &payload))
	return payload.Base.CommitID, payload.Base.Ref
}

// C-J5-02 at the stack's boundary: every main move admits one flow-load at
// main's commit; loads coalesce; a loaded version becomes Active, a failed
// one leaves Active in place and shows its error, and a load whose digests
// already have rows writes nothing.
func TestFlowLoadLoadsEveryMainMoveAndKeepsThePreviousVersionWhenALoadFails(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	q := db.New(o.pool)
	o.lanes.provision = func(id string) {
		_, err := o.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,status) VALUES($1,$2,$3,$4,'running')`, id, o.repoID, o.userID, id)
		require.NoError(t, err)
	}
	digests, err := builtinFlowDigests()
	require.NoError(t, err)
	d1 := digests["todo"]

	// Off, no load runs.
	o.wake()
	assert.Empty(t, o.flowLoads())

	// On, the current main loads once on its own workspace.
	o.service.SetFlowLoad(true)
	stack := o.wake()
	loads := o.flowLoads()
	require.Len(t, loads, 1)
	first := loads[0]
	commit, ref := loadBase(t, first)
	assert.Equal(t, stack.LandedMain, commit)
	assert.Equal(t, stack.LandedMain, o.hostRef(ref), "main's commit is retained for the load's workspace")
	assert.Equal(t, flowLoadBindingKind, first.Target.BindingKind)
	row, err := q.GetFlowLoad(ctx, o.repoID)
	require.NoError(t, err)
	assert.Equal(t, "running", row.State)
	assert.Equal(t, first.Target.WorkspaceID, row.WorkspaceID)

	// The target resolver authorizes exactly the bound workspace.
	resolver := NewFlowLoadRuntime(o.service)
	authority, err := resolver.ResolveFlowHostTarget(ctx, first.Target)
	require.NoError(t, err)
	assert.Equal(t, row.WorkspaceID, authority.WorkspaceID)
	forged := first.Target
	forged.WorkspaceID = "00000000-0000-4000-8000-000000000000"
	_, err = resolver.ResolveFlowHostTarget(ctx, forged)
	require.Error(t, err)
	_, err = NewMythicalFlowHostTargetResolver(o.service).ResolveFlowHostTarget(ctx, first.Target)
	require.Error(t, err, "the stack's item resolver does not authorize a flow-load")

	// A running load is never launched twice.
	o.wake()
	require.Len(t, o.flowLoads(), 1)

	// It loads: main declares no flow, so nothing is written and the
	// built-in stays Active. Its workspace is retired.
	o.projectLoad(first, jobs.StateCompleted, "load-1", flowLoadOutput(commit))
	o.wake()
	row, err = q.GetFlowLoad(ctx, o.repoID)
	require.NoError(t, err)
	assert.Equal(t, "idle", row.State, row.Error)
	assert.Equal(t, commit, row.LoadedCommit)
	assert.Contains(t, o.lanes.deleted, first.Target.WorkspaceID)
	versions, err := q.ListFlowVersions(ctx, o.repoID)
	require.NoError(t, err)
	assert.Empty(t, versions)
	assert.Equal(t, []string{"active " + d1}, states(o.flowCard("todo")))
	assert.Equal(t, FlowSource{Builtin: true}, o.flowCard("todo").Source)

	// Main moves with a todo composition: one load, merged-syncing until it
	// loads, then Active at its digest with the built-in previous.
	edit := "export default \"todo v2\"\n"
	m2 := o.commitFile("✨ feat: our todo flow", "flows/todo/flow.ts", edit)
	o.wake()
	loads = o.flowLoads()
	require.Len(t, loads, 2)
	commit, _ = loadBase(t, loads[1])
	assert.Equal(t, m2, commit)
	assert.Equal(t, []string{"active " + d1, "merged-syncing " + sha256Hex(edit)}, states(o.flowCard("todo")))
	d2 := strings.Repeat("2", 64)
	o.projectLoad(loads[1], jobs.StateCompleted, "load-2", flowLoadOutput(m2, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: d2, Status: "loaded"}))
	o.wake()
	card := o.flowCard("todo")
	assert.Equal(t, []string{"active " + d2, "previous " + d1}, states(card))
	assert.Equal(t, FlowSource{Path: "flows/todo/flow.ts"}, card.Source)
	assert.Equal(t, builtinFlowSteps["todo"], card.Versions[0].Steps)
	active, err := ActiveFlowDigest(ctx, q, o.repoID, "todo")
	require.NoError(t, err)
	assert.Equal(t, d2, active)

	// A move no flow cares about loads once and writes nothing.
	m3 := o.commitFile("📝 docs: unrelated", "src/index.ts", "export const unrelated = 1\n")
	o.wake()
	loads = o.flowLoads()
	require.Len(t, loads, 3)
	assert.Equal(t, []string{"active " + d2, "previous " + d1}, states(o.flowCard("todo")), "nothing in flows/ changed")
	o.projectLoad(loads[2], jobs.StateCompleted, "load-3", flowLoadOutput(m3, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: d2, Status: "loaded"}))
	o.wake()
	versions, err = q.ListFlowVersions(ctx, o.repoID)
	require.NoError(t, err)
	require.Len(t, versions, 1)
	assert.Equal(t, m2, versions[0].SourceCommit.String)

	// A broken flow writes a failed version; Active stays where it was and
	// the card shows the error.
	m4 := o.commitFile("💥 feat: broken todo flow", "flows/todo/flow.ts", "export default (\n")
	o.wake()
	loads = o.flowLoads()
	require.Len(t, loads, 4)
	d4 := strings.Repeat("4", 64)
	o.projectLoad(loads[3], jobs.StateCompleted, "load-4", flowLoadOutput(m4, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: d4, Status: "failed",
		Error: "flows/todo/flow.ts:2: Expression expected"}))
	o.wake()
	assert.Equal(t, []string{"active " + d2, "merged-failed " + d4 + ": flows/todo/flow.ts:2: Expression expected", "previous " + d1}, states(o.flowCard("todo")))
	active, err = ActiveFlowDigest(ctx, q, o.repoID, "todo")
	require.NoError(t, err)
	assert.Equal(t, d2, active)

	// Loads coalesce: main moves twice while one runs, and one more load
	// runs, at the newest commit.
	m5 := o.commitFile("✨ feat: five", "flows/todo/flow.ts", "export default \"todo v5\"\n")
	o.wake()
	loads = o.flowLoads()
	require.Len(t, loads, 5)
	o.commitFile("✨ feat: six", "flows/todo/flow.ts", "export default \"todo v6\"\n")
	o.wake()
	m7 := o.commitFile("✨ feat: seven", "flows/todo/flow.ts", "export default \"todo v7\"\n")
	o.wake()
	require.Len(t, o.flowLoads(), 5, "a running load is not launched twice")
	// An older generation's late projection changes nothing.
	o.projectLoad(loads[3], jobs.StateFailed, "load-4", "")
	o.projectLoad(loads[4], jobs.StateCompleted, "load-5", flowLoadOutput(m5, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: strings.Repeat("5", 64), Status: "loaded"}))
	o.wake()
	loads = o.flowLoads()
	require.Len(t, loads, 6)
	commit, _ = loadBase(t, loads[5])
	assert.Equal(t, m7, commit, "the next load reads the newest main; none runs at six")

	// A load that fails to run writes nothing, keeps Active, and runs again.
	o.projectLoad(loads[5], jobs.StateFailed, "load-6", "")
	o.wake()
	row, err = q.GetFlowLoad(ctx, o.repoID)
	require.NoError(t, err)
	assert.Equal(t, "idle", row.State)
	assert.NotEmpty(t, row.Error)
	active, err = ActiveFlowDigest(ctx, q, o.repoID, "todo")
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("5", 64), active)
	_, err = o.pool.Exec(ctx, `UPDATE flow_loads SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	o.wake()
	require.Len(t, o.flowLoads(), 7)

	// A repository that removes its todo returns to the built-in version.
	m8 := o.commitFile("🔥 feat: drop the todo override", "flows/todo/flow.ts", "")
	o.git(o.work, "rm", "-q", "flows/todo/flow.ts")
	o.git(o.work, "commit", "-q", "-m", "🔥 drop")
	m8 = o.publish()
	o.projectLoad(o.flowLoads()[6], jobs.StateCompleted, "load-7", flowLoadOutput(m7, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: strings.Repeat("7", 64), Status: "loaded"}))
	o.wake()
	loads = o.flowLoads()
	require.Len(t, loads, 8)
	commit, _ = loadBase(t, loads[7])
	require.Equal(t, m8, commit)
	o.projectLoad(loads[7], jobs.StateCompleted, "load-8", flowLoadOutput(m8))
	o.wake()
	assert.Equal(t, []string{"active " + d1}, states(o.flowCard("todo")))
	active, err = ActiveFlowDigest(ctx, q, o.repoID, "todo")
	require.NoError(t, err)
	assert.Equal(t, d1, active)
	fmt.Fprintln(os.Stderr, "flow-load launches:", len(o.flowLoads()))
}

func TestFlowLoadResultIsCheckedBeforeItIsWritten(t *testing.T) {
	commit := strings.Repeat("a", 40)
	digest := strings.Repeat("b", 64)
	for name, output := range map[string]string{
		"another commit":       flowLoadOutput(strings.Repeat("c", 40)),
		"not json":             "{",
		"bad digest":           flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Digest: "x", Status: "loaded"}),
		"bad status":           flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Digest: digest, Status: "active"}),
		"failed without error": flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Digest: digest, Status: "failed"}),
		"loaded with error":    flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Digest: digest, Status: "loaded", Error: "x"}),
		"duplicate":            flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Digest: digest, Status: "loaded"}, FlowLoadVersion{Name: "todo", Digest: digest, Status: "loaded"}),
	} {
		_, err := decodeFlowLoadResult([]byte(output), commit)
		assert.Error(t, err, name)
	}
	result, err := decodeFlowLoadResult([]byte(flowLoadOutput(commit, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: digest, Status: "loaded"})), commit)
	require.NoError(t, err)
	assert.Len(t, result.Flows, 1)
}

func TestFlowEntryNameIsTheFlowsDirectory(t *testing.T) {
	for path, want := range map[string]string{
		"flows/todo/flow.ts":           "todo",
		"flows/checks/wiki/flow.mdx":   "checks/wiki",
		"flows/todo/helper.ts":         "",
		"src/flows/todo/flow.ts":       "",
		"flows/flow.ts":                "",
		"flows/review/change/flow.mdx": "review/change",
	} {
		name, ok := flowEntryName(path)
		assert.Equal(t, want, name, path)
		assert.Equal(t, want != "", ok, path)
	}
}
