package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// archiveHost answers as a live coding host does, until it stops.
type archiveHost struct {
	stopped       bool
	summaryStatus string
	calls         []string
}

const archivedMonitorJSON = `{"id":"run-1","flow":"todo","version":"","title":"todo","state":"done",
	"attempts":[{"n":1,"run_id":"run-1","state":"done","graph":[],"steps":[{"key":"edit#1","id":"edit","k":1,"label":"Edited the files","state":"completed"}],"phases":[]}],
	"waits":[],"tokens":0,"time_s":2,"cost_usd":0,"engine":[],
	"extent":{"start":"2026-10-07T00:00:01.000Z","end":"2026-10-07T00:00:03.000Z"}}`

func (h *archiveHost) Monitor(_ context.Context, target flowruntime.Target, run string, at *int64) (json.RawMessage, error) {
	h.calls = append(h.calls, "monitor")
	if h.stopped || target.WorkspaceID != "lane-1" || run != "run-1" {
		return nil, errors.New("runtime_host_not_running")
	}
	return json.RawMessage(archivedMonitorJSON), nil
}

func (h *archiveHost) CallRPC(_ context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	h.calls = append(h.calls, procedure+" "+string(payload))
	if h.stopped || procedure != "Projection.Snapshot" {
		return nil, errors.New("runtime_host_not_running")
	}
	switch {
	case strings.Contains(string(payload), `"run-summary"`):
		raw := `{"ok":true,"payload":{"rows":[{"runId":"run-1","flowId":"todo","status":"completed","turns":2,"statusRollup":{"freshness":"stale"}}]}}`
		if h.summaryStatus != "" {
			raw = strings.Replace(raw, `"status":"completed"`, `"status":"`+h.summaryStatus+`"`, 1)
		}
		return json.RawMessage(raw), nil
	case strings.Contains(string(payload), `"run-tree"`):
		return json.RawMessage(`{"ok":true,"payload":{"rows":[{"nodeId":"edit","state":"done"}]}}`), nil
	}
	return nil, errors.New("unexpected snapshot")
}

// A run stays readable after its machine stops (T-FLW-07): lifecycle pages
// retain the live host's own answers, and the monitor, the browser relay and
// the run:<id> topic serve them without waking the box.
func TestRunArchivePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	checkpoint := flowdispatch.RuntimeCheckpoint{RunID: "run-1", FlowID: "todo", ExecutionDigest: strings.Repeat("a", 64),
		Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "lane-1", BindingKind: "mythical-item", BindingID: "item-1"}}
	host := &archiveHost{}
	archive := &runArchive{pool: pool, host: host}
	sequence := int64(0)
	page := func(kinds ...string) flowdispatch.ProjectionUpdate {
		update := flowdispatch.ProjectionUpdate{Scope: scope, Checkpoint: checkpoint}
		for _, kind := range kinds {
			sequence += 2
			update.Events = append(update.Events, flowruntime.Event{RunID: "run-1", Sequence: sequence, Kind: kind,
				OccurredAt: float64(1791331200000 + sequence*1000), Payload: json.RawMessage(fmt.Sprintf(`{"n":%d}`, sequence))})
		}
		return update
	}
	archived := func() (archivedRun, error) { return readRunArchive(ctx, pool, repo.ID, "lane-1", "run-1") }

	// Every page keeps its events; only lifecycle pages read the host.
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.engine.event")))
	require.Empty(t, host.calls)
	_, err = archived()
	require.ErrorIs(t, err, pgx.ErrNoRows)
	// A page replayed after a failed checkpoint keeps each event once.
	sequence = 0
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.engine.event")))
	var stored int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM run_archive_events`).Scan(&stored))
	require.Equal(t, 1, stored)
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.engine.event", "control.run.completed")))
	row, err := archived()
	require.NoError(t, err)
	require.Equal(t, "todo", row.FlowID)
	require.Equal(t, "completed", row.Status)
	require.JSONEq(t, `[{"nodeId":"edit","state":"done"}]`, string(row.Tree))

	// Native settlement may arrive before its final lifecycle event. A
	// terminal checkpoint alone must recapture, and refuse a stale summary.
	terminal := page()
	terminal.Checkpoint.Run = &flowruntime.Run{RunID: "run-1", Status: "completed"}
	host.summaryStatus = "parked"
	require.ErrorContains(t, archive.ProjectFlowRuntime(ctx, terminal), "terminal host summary has not settled")
	host.summaryStatus = ""
	require.NoError(t, archive.ProjectFlowRuntime(ctx, terminal))
	host.stopped = true
	require.ErrorContains(t, archive.ProjectFlowRuntime(ctx, terminal), "runtime_host_not_running")
	host.stopped = false

	// A capture on a stopped host never fails the observation, keeps the
	// answers the live host gave, and still keeps the page's events.
	host.stopped = true
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.run.running")))
	kept, err := archived()
	require.NoError(t, err)
	require.JSONEq(t, string(row.Monitor), string(kept.Monitor))

	// Snapshots: the summary and tree rows as retained, the journal as events.
	snapshot := func(payload string) (string, bool) {
		answer, ok, err := kept.snapshot(ctx, json.RawMessage(payload))
		require.NoError(t, err)
		return string(answer), ok
	}
	summary, ok := snapshot(`{"selector":{"_tag":"run-summary","runId":"run-1"}}`)
	require.True(t, ok)
	require.JSONEq(t, `{"ok":true,"payload":{"selector":{"_tag":"run-summary","runId":"run-1"},
		"cursor":{"selector":{"_tag":"run-summary","runId":"run-1"},"projection":"run-summary","runId":"run-1","value":8,"offset":0},
		"rows":[{"runId":"run-1","flowId":"todo","status":"completed","turns":2,"statusRollup":{"freshness":"stale"}}]}}`, summary)
	events, ok := snapshot(`{"selector":{"_tag":"run-events","runId":"run-1"}}`)
	require.True(t, ok)
	var journal struct {
		Payload struct {
			Rows []map[string]any `json:"rows"`
		} `json:"payload"`
	}
	require.NoError(t, json.Unmarshal([]byte(events), &journal))
	require.Equal(t, []map[string]any{
		{"sequence": 2.0, "kind": "control.engine.event", "runId": "run-1", "occurredAt": 1791331202000.0, "payload": map[string]any{"n": 2.0}},
		{"sequence": 4.0, "kind": "control.engine.event", "runId": "run-1", "occurredAt": 1791331204000.0, "payload": map[string]any{"n": 4.0}},
		{"sequence": 6.0, "kind": "control.run.completed", "runId": "run-1", "occurredAt": 1791331206000.0, "payload": map[string]any{"n": 6.0}},
		{"sequence": 8.0, "kind": "control.run.running", "runId": "run-1", "occurredAt": 1791331208000.0, "payload": map[string]any{"n": 8.0}},
	}, journal.Payload.Rows)
	later, ok := snapshot(`{"selector":{"_tag":"run-events","runId":"run-1"},"after":{"value":4,"offset":0}}`)
	require.True(t, ok)
	require.Contains(t, later, `"value":8`)
	require.Contains(t, later, `"rows":[{"kind":"control.run.completed"`)
	for _, refused := range []string{
		`{"selector":{"_tag":"run-summary","runId":"run-2"}}`,
		`{"selector":{"_tag":"run-summary","runId":"run-1"},"after":{"value":1}}`,
		`{"selector":{"_tag":"approvals","runId":"run-1"}}`,
		`{"selector":{"_tag":"run-summary","runId":"run-1","extra":"x"}}`,
		`not json`,
	} {
		_, ok := snapshot(refused)
		require.False(t, ok, refused)
	}

	// The run:<id> topic: the summary without its wall-clock rollup, and only
	// the journal after the subscriber's cursor.
	livePage, projection, err := kept.livePage(ctx, nil)
	require.NoError(t, err)
	require.Equal(t, int64(8), livePage.Cursor)
	require.Empty(t, projection["events"])
	require.NotContains(t, projection["summary"], "statusRollup")
	after := int64(3)
	_, projection, err = kept.livePage(ctx, &after)
	require.NoError(t, err)
	require.Len(t, projection["events"], 3)
	beyond := int64(9)
	gap, _, err := kept.livePage(ctx, &beyond)
	require.NoError(t, err)
	require.True(t, gap.Gap)

	// The monitor of a stopped host is the archived one, priced and named as
	// the install names it. Replay uses the retained journal.
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	_, err = store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "archive-run", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile})
	require.NoError(t, err)
	claim, err := store.Claim(ctx, "archive-fixture", time.Minute)
	require.NoError(t, err)
	raw, err := json.Marshal(checkpoint)
	require.NoError(t, err)
	_, err = store.BeginExternal(ctx, claim, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	require.NoError(t, store.Park(ctx, claim, raw, time.Hour))
	monitors := &runMonitors{pool: pool, reader: host}
	callsBeforeRead := len(host.calls)
	served, err := monitors.read(ctx, repo.ID, "lane-1:run-1", nil)
	require.NoError(t, err)
	require.Len(t, host.calls, callsBeforeRead, "terminal archives must not resolve a stopped or replacement host")
	var monitor map[string]any
	require.NoError(t, json.Unmarshal(served, &monitor))
	require.Equal(t, "lane-1:run-1", monitor["id"])
	require.Equal(t, strings.Repeat("a", 64), monitor["version"])
	require.Equal(t, "done", monitor["state"])
	require.Equal(t, 0.0, monitor["cost_usd"])
	require.NotContains(t, monitor, "journal")
	// The journal tab of a sleeping branch is the archived journal.
	traced, err := monitors.read(ctx, repo.ID, "lane-1:run-1", nil, true)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(traced, &monitor))
	require.Equal(t, map[string]any{"at": 8.0, "last": 8.0}, monitor["replay"])
	require.Equal(t, []any{
		map[string]any{"seq": 2.0, "at": "2026-10-07T00:00:02.000Z", "type": "control.engine.event", "text": `{"n": 2}`},
		map[string]any{"seq": 4.0, "at": "2026-10-07T00:00:04.000Z", "type": "control.engine.event", "text": `{"n": 4}`},
		map[string]any{"seq": 6.0, "at": "2026-10-07T00:00:06.000Z", "type": "control.run.completed", "text": `{"n": 6}`},
		map[string]any{"seq": 8.0, "at": "2026-10-07T00:00:08.000Z", "type": "control.run.running", "text": `{"n": 8}`},
	}, monitor["journal"])
	at := int64(1)
	replayedArchive, err := monitors.read(ctx, repo.ID, "lane-1:run-1", &at)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(replayedArchive, &monitor))
	require.Equal(t, []any{}, monitor["journal"])
	require.Equal(t, map[string]any{"at": 1.0, "last": 8.0}, monitor["replay"])
	require.Equal(t, map[string]any{"run_id": "run-1"}, monitor["archive_replay"])

	// The browser relay serves a stopped box's run from the archive, for the
	// box's own repository only.
	browser := &browserFlowAPI{installTransactions: pool}
	answer, ok := browser.archivedSnapshot(ctx, db.Workspace{ID: "lane-1", RepositoryID: repo.ID}, json.RawMessage(`{"selector":{"_tag":"run-summary","runId":"run-1"}}`))
	require.True(t, ok)
	require.JSONEq(t, summary, string(answer))
	_, ok = browser.archivedSnapshot(ctx, db.Workspace{ID: "lane-1", RepositoryID: repo.ID + 1}, json.RawMessage(`{"selector":{"_tag":"run-summary","runId":"run-1"}}`))
	require.False(t, ok)
	_, ok = browser.archivedSnapshot(ctx, db.Workspace{ID: "lane-2", RepositoryID: repo.ID}, json.RawMessage(`{"selector":{"_tag":"run-summary","runId":"run-1"}}`))
	require.False(t, ok)
}

// finishedRunHost is the coding host of a run the dispatcher observed: the
// live topic's host and the archive's source are the same answers.
type finishedRunHost struct{ *liveRunFixture }

func (finishedRunHost) Monitor(context.Context, flowruntime.Target, string, *int64) (json.RawMessage, error) {
	return json.RawMessage(`{"id":"fixture-run","flow":"fixture","state":"done","attempts":[],"waits":[]}`), nil
}

// A finished TODO's lane is retired with its machine (releaseLane), so its
// branch grants no read. The run:<id> topic then serves the run under the
// monitor command, from the archive alone: an open Run View stays
// subscribed, one opened later mounts, and neither reaches the host. A
// session that may not run monitor, or a run nothing archived, is refused.
func TestLiveRunFinishedTodoPostgres(t *testing.T) {
	f := presenceInstall(t)
	ctx := t.Context()
	q := db.New(f.pool)
	host := finishedRunHost{&liveRunFixture{head: 8}}
	f.p.dispatcher = host
	// The fixture's lane machine is on its TODO's item branch.
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET target_bookmark='smithers/retry-webhooks' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID)}
	admit := func(run string) flowdispatch.RuntimeCheckpoint {
		checkpoint := flowdispatch.RuntimeCheckpoint{Version: 1, RunID: run, FlowID: "fixture",
			Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: f.row.ID, BindingKind: "mythical-item", BindingID: "fixture"}}
		store, err := jobs.NewStore(f.pool)
		require.NoError(t, err)
		receipt, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: run, Payload: json.RawMessage(`{}`),
			AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile, EffectKey: run})
		require.NoError(t, err)
		raw, err := json.Marshal(checkpoint)
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, receipt.OperationID, raw)
		require.NoError(t, err)
		return checkpoint
	}
	checkpoint := admit("fixture-run")
	admit("unobserved-run")

	// While the lane is bound, its member follows the run on the live host.
	_, err = f.p.branches.PresenceBranch(ctx, f.row.ID, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	open := f.dial(t)
	sendPresenceFrame(t, open, `{"t":"sub","id":1,"topic":"run:fixture-run"}`)
	followed := readPresenceFrame(t, open)
	require.Equal(t, "snap", followed.T)
	require.EqualValues(t, 8, *followed.Cursor)

	// The dispatcher's observation retains the run while its host answers.
	archive := &runArchive{pool: f.pool, host: host}
	offset := int64(1)
	require.NoError(t, archive.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{Scope: scope, Checkpoint: checkpoint, Events: []flowruntime.Event{
		{RunID: "fixture-run", Sequence: 1, Kind: "control.run.running", OccurredAt: 1000, Payload: json.RawMessage(`{}`)},
		{RunID: "fixture-run", Sequence: 4, Kind: "step.started", OccurredAt: 1000, Payload: json.RawMessage(`{}`)},
		{RunID: "fixture-run", Sequence: 4, Kind: "step.output", OccurredAt: 1000, Payload: json.RawMessage(`{}`), Cursor: &flowruntime.EventCursor{Sequence: 4, Offset: &offset}},
		{RunID: "fixture-run", Sequence: 8, Kind: "control.run.completed", OccurredAt: 1000, Payload: json.RawMessage(`{}`)},
	}}))
	_, err = readRunArchive(ctx, f.pool, f.row.RepositoryID, f.row.ID, "fixture-run")
	require.NoError(t, err)

	// The TODO finishes and its lane retires: the branch grants no read. Any
	// later answer of the host would name another flow.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=clock_timestamp() WHERE workspace_id=$1`, f.row.ID)
	require.NoError(t, err)
	host.mu.Lock()
	host.flowID = "read-after-retirement"
	host.mu.Unlock()
	_, err = f.p.branches.PresenceBranch(ctx, f.row.ID, f.row.RepositoryID, f.user.ID)
	require.ErrorContains(t, err, "no lane of the stack")

	// A Run View opened after the merge mounts from the archive, and replays
	// the archived journal after a cursor it held.
	later := f.dial(t)
	sendPresenceFrame(t, later, fmt.Sprintf(`{"t":"sub","id":1,"topic":"run:%s:fixture-run"}`, f.row.ID))
	archived := readPresenceFrame(t, later)
	require.Equal(t, "snap", archived.T, archived.Code)
	require.EqualValues(t, 8, *archived.Cursor)
	require.JSONEq(t, `{"summary":{"runId":"fixture-run","flowId":"fixture","status":"completed"},
		"steps":[{"nodeId":"step","label":"Read","status":"completed","startedAt":1000}],"events":[]}`, string(archived.Data))
	sendPresenceFrame(t, later, `{"t":"sub","id":2,"topic":"run:fixture-run","cursor":4}`)
	replayed := readPresenceFrame(t, later)
	require.Equal(t, "delta", replayed.T, replayed.Code)
	require.EqualValues(t, 8, *replayed.Cursor)
	require.Contains(t, string(replayed.Data), `"control.run.completed"`)
	require.NotContains(t, string(replayed.Data), `"step.started"`)
	require.Contains(t, string(replayed.Data), `"flowId":"fixture"`)

	// The Run View that was open through the retirement stays subscribed: its
	// next polls refuse nothing, so the next frame answers the next request.
	time.Sleep(time.Second)
	sendPresenceFrame(t, open, `{"t":"sub","id":2,"topic":"run:unknown"}`)
	next := readPresenceFrame(t, open)
	require.EqualValues(t, 2, next.ID, "the open subscription was refused: %s %s", next.T, next.Code)
	require.Equal(t, "unknown_topic", next.Code)

	// A run nothing archived is not served past its branch.
	sendPresenceFrame(t, later, `{"t":"sub","id":3,"topic":"run:unobserved-run"}`)
	require.Equal(t, "forbidden", readPresenceFrame(t, later).Code)

	// A credential that may not run monitor reads no finished run, and one
	// that loses monitor is refused at its next poll.
	topics := &liveTopics{changePool: f.pool, queries: q, presence: f.p}
	_, refusal := topics.runSource(ctx, "fixture-run", f.row.RepositoryID, f.user.ID, func() error { return errors.New("permission") })
	require.Equal(t, live.Forbidden, refusal)
	permitted := true
	source, refusal := topics.runSource(ctx, "fixture-run", f.row.RepositoryID, f.user.ID, func() error {
		if permitted {
			return nil
		}
		return errors.New("permission")
	})
	require.Empty(t, refusal)
	page, err := source.Log.Page(ctx, nil)
	require.NoError(t, err)
	require.EqualValues(t, 8, page.Cursor)
	permitted = false
	_, err = source.Log.Page(ctx, nil)
	require.ErrorContains(t, err, "no lane of the stack")
}
