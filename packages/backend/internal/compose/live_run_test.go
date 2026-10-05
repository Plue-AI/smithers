package compose

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// laneHost answers a lane's run projections by selector, as its coding host
// would, and counts the reads that reach it.
type laneHost struct {
	mu      sync.Mutex
	answers map[string]string
	reads   []string
}

func (h *laneHost) CallRPC(_ context.Context, target flowruntime.Target, _ string, payload json.RawMessage) (json.RawMessage, error) {
	tag, run, _ := live.RunProjection(payload)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.reads = append(h.reads, target.PrincipalID+" "+tag+" "+run)
	if answer, ok := h.answers[tag+" "+run]; ok {
		return json.RawMessage(answer), nil
	}
	return json.RawMessage(`{"ok":false,"error":{"message":"no such run"}}`), nil
}

func (*laneHost) RefuseRelay(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) error {
	return (&flowdispatch.Service{}).RefuseRelay(ctx, target, procedure, payload)
}

func (*laneHost) StartHost(context.Context, flowruntime.Target) (bool, error) { return true, nil }

func (h *laneHost) readCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.reads)
}

// The relay keeps what a running lane's host answers, verbatim, and answers
// it once the lane stops, without reaching the host. Only a kept, exact
// run projection read is answered so; anything else on a stopped lane is
// workspace_stopped as before.
func TestRelayAnswersAStoppedLanesRunAsKept(t *testing.T) {
	b := newRelayBoxes(t)
	lane := b.box(b.repo, b.machines, "running", b.owner)
	// Odd spacing: the kept copy is the host's bytes, not a re-encoding.
	summary := `{"ok":true,  "payload":{"rows":[{"runId":"run-1","flowId":"coding/request","status":"running"}]}}`
	host := &laneHost{answers: map[string]string{"run-summary run-1": summary}}
	api := b.api()
	api.dispatcher = host
	api.journals = newRunJournals(b.pool, b.Queries, host)
	relay := func(payload string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		api.rpc(recorder, b.request("/api/workflow/rpc", b.body(b.repo, lane, "Projection.Snapshot", payload), b.owner))
		return recorder
	}
	const read = `{"selector":{"_tag":"run-summary","runId":"run-1"}}`
	answer := relay(read)
	require.Equal(t, 200, answer.Code)
	require.Equal(t, summary, answer.Body.String())
	// A host that answers no such run keeps nothing.
	require.Equal(t, 200, relay(`{"selector":{"_tag":"run-events","runId":"run-1"}}`).Code)

	b.exec(`UPDATE workspaces SET status = 'stopped' WHERE id = $1`, lane)
	reached := host.readCount()
	kept := relay(read)
	require.Equal(t, 200, kept.Code, kept.Body.String())
	require.Equal(t, summary, kept.Body.String())
	require.Equal(t, reached, host.readCount(), "a stopped lane's read never reaches its host")
	for name, payload := range map[string]string{
		"never kept":         `{"selector":{"_tag":"run-tree","runId":"run-1"}}`,
		"answered no run":    `{"selector":{"_tag":"run-events","runId":"run-1"}}`,
		"another run":        `{"selector":{"_tag":"run-summary","runId":"run-2"}}`,
		"more than a read":   `{"selector":{"_tag":"run-summary","runId":"run-1"},"after":5}`,
		"not a run selector": `{"selector":{"_tag":"node-output","runId":"run-1"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			refused := relay(payload)
			require.Equal(t, 409, refused.Code, refused.Body.String())
			require.Contains(t, refused.Body.String(), `"code":"workspace_stopped"`)
		})
	}
	// Another person reads no lane that is not shared with them.
	recorder := httptest.NewRecorder()
	api.rpc(recorder, b.request("/api/workflow/rpc", b.body(b.repo, lane, "Projection.Snapshot", read), b.ben))
	require.Equal(t, 404, recorder.Code, recorder.Body.String())
}

// A later answer replaces the kept one; the same answer again writes
// nothing new.
func TestRunJournalKeepsTheLatestAnswer(t *testing.T) {
	b := newRelayBoxes(t)
	lane := b.box(b.repo, b.machines, "running", b.owner)
	journals := newRunJournals(b.pool, b.Queries, nil)
	ctx := t.Context()
	first, second := `{"ok":true,"payload":{"rows":[1]}}`, `{"ok":true,"payload":{"rows":[1,2]}}`
	journals.keep(ctx, b.repo.ID, lane, "run-1", "run-events", json.RawMessage(first))
	var captured1, captured2 string
	require.NoError(t, b.pool.QueryRow(ctx, `SELECT captured_at::text FROM run_journals WHERE workspace_id=$1`, lane).Scan(&captured1))
	journals.keep(ctx, b.repo.ID, lane, "run-1", "run-events", json.RawMessage(first))
	require.NoError(t, b.pool.QueryRow(ctx, `SELECT captured_at::text FROM run_journals WHERE workspace_id=$1`, lane).Scan(&captured2))
	require.Equal(t, captured1, captured2, "the same answer is not written again")
	journals.keep(ctx, b.repo.ID, lane, "run-1", "run-events", json.RawMessage(second))
	got, ok := journals.retained(ctx, lane, "run-1", "run-events")
	require.True(t, ok)
	require.Equal(t, second, string(got))
	// Other selectors and runs stay apart.
	_, ok = journals.retained(ctx, lane, "run-1", "run-summary")
	require.False(t, ok)
	_, ok = journals.retained(ctx, lane, "run-2", "run-events")
	require.False(t, ok)
	// A selector the install does not keep is never written.
	journals.keep(ctx, b.repo.ID, lane, "run-1", "node-output", json.RawMessage(first))
	_, ok = journals.retained(ctx, lane, "run-1", "node-output")
	require.False(t, ok)
}

// run:<lane>:<run> is the run's summary row and its steps: from the host,
// read as the person the lane is shared with, while the lane runs; as kept
// once it stops.
func TestRunSnapshotReadsTheLaneThenTheKeptCopy(t *testing.T) {
	b := newRelayBoxes(t)
	lane := b.box(b.repo, b.machines, "running", b.owner)
	slug := b.login + "/" + b.repo.Name
	host := &laneHost{answers: map[string]string{
		"run-summary run-1": `{"ok":true,"payload":{"rows":[{"runId":"run-1","status":"running"}]}}`,
		"run-tree run-1":    `{"ok":true,"payload":{"rows":[{"nodeId":"plan","status":"completed","startedAt":1,"endedAt":2},{"nodeId":"implement","status":"running","startedAt":3}]}}`,
	}}
	journals := newRunJournals(b.pool, b.Queries, host)
	live, err := journals.snapshot(t.Context(), slug, lane, "run-1")
	require.NoError(t, err)
	require.JSONEq(t, `{"run":{"runId":"run-1","status":"running"},"steps":[{"nodeId":"plan","status":"completed","startedAt":1,"endedAt":2},{"nodeId":"implement","status":"running","startedAt":3}]}`, string(live))
	for _, read := range host.reads {
		require.True(t, strings.HasPrefix(read, "user:"+itoa(b.owner)+" "), "read as the lane's person: %s", read)
	}

	b.exec(`UPDATE workspaces SET status = 'stopped' WHERE id = $1`, lane)
	host.answers = nil
	kept, err := journals.snapshot(t.Context(), slug, lane, "run-1")
	require.NoError(t, err)
	require.Equal(t, string(live), string(kept))
	_, err = journals.snapshot(t.Context(), slug, lane, "run-2")
	require.Error(t, err, "a run never kept has no snapshot")
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// Right before the stack stops a retired lane, the install keeps every
// projection of its TODO's run the host answers. A lane no longer running,
// or one of another repository, is not read.
func TestLaneStopKeepsItsTodosRun(t *testing.T) {
	b := newRelayBoxes(t)
	ctx := t.Context()
	lane := b.box(b.repo, b.machines, "running", b.owner)
	require.NoError(t, b.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository",
		Value: []byte(`{"owner_login":"` + b.login + `","repository_name":"repo"}`)}))
	var item pgtype.UUID
	require.NoError(t, b.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id, source, workspace_id, request_run_id) VALUES ($1, 'todo', $2, 'run-1') RETURNING id`,
		b.repo.ID, lane).Scan(&item))
	_, _, err := b.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: lane, RepositoryID: b.repo.ID, ItemID: item, Name: "TODO 1 attempt 1 g1"})
	require.NoError(t, err)
	host := &laneHost{answers: map[string]string{
		"run-summary run-1": `{"ok":true,"payload":{"rows":[{"runId":"run-1","status":"completed"}]}}`,
		"run-events run-1":  `{"ok":true,"payload":{"rows":[{"sequence":0},{"sequence":1}]}}`,
	}}
	journals := newRunJournals(b.pool, b.Queries, host)
	workspace, err := b.GetWorkspace(ctx, lane)
	require.NoError(t, err)
	journals.capture(ctx, workspace)
	for tag, want := range map[string]string{"run-summary": host.answers["run-summary run-1"], "run-events": host.answers["run-events run-1"]} {
		got, ok := journals.retained(ctx, lane, "run-1", tag)
		require.True(t, ok, tag)
		require.Equal(t, want, string(got))
	}
	// The host answered no run-tree, transcript or approvals: none is kept.
	_, ok := journals.retained(ctx, lane, "run-1", "run-tree")
	require.False(t, ok)
	require.Len(t, host.reads, len(live.KeptProjections))

	workspace.Status = "stopped"
	journals.capture(ctx, workspace)
	other := b.box(b.other, b.machines, "running", b.owner)
	elsewhere, err := b.GetWorkspace(ctx, other)
	require.NoError(t, err)
	journals.capture(ctx, elsewhere)
	require.Len(t, host.reads, len(live.KeptProjections), "a stopped lane and an unbound box are not read")
}
