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
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// archiveHost answers as a live coding host does, until it stops.
type archiveHost struct {
	stopped bool
	calls   []string
}

const archivedMonitorJSON = `{"id":"run-1","flow":"todo","version":"","title":"todo","state":"done",
	"attempts":[{"n":1,"run_id":"run-1","state":"done","graph":[],"steps":[{"key":"edit#1","id":"edit","k":1,"label":"Edited the files","state":"completed"}],"phases":[]}],
	"waits":[],"tokens":0,"time_s":2,"cost_usd":0,"engine":[],
	"journal":[{"seq":1,"at":"2026-10-07T00:00:01Z","type":"control.run.accepted","text":"{\"runId\":\"run-1\"}"},
		{"seq":3,"at":"2026-10-07T00:00:03Z","type":"control.run.completed","text":"{}"}]}`

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
		return json.RawMessage(`{"ok":true,"payload":{"rows":[{"runId":"run-1","flowId":"todo","status":"completed","turns":2,"statusRollup":{"freshness":"stale"}}]}}`), nil
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
	page := func(kinds ...string) flowdispatch.ProjectionUpdate {
		update := flowdispatch.ProjectionUpdate{Scope: scope, Checkpoint: checkpoint}
		for n, kind := range kinds {
			update.Events = append(update.Events, flowruntime.Event{RunID: "run-1", Sequence: int64(n + 1), Kind: kind, Payload: json.RawMessage(`{}`)})
		}
		return update
	}
	archived := func() (archivedRun, error) { return readRunArchive(ctx, pool, repo.ID, "lane-1", "run-1") }

	// Only lifecycle pages capture; a page of engine events reads nothing.
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.engine.event")))
	require.Empty(t, host.calls)
	_, err = archived()
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.engine.event", "control.run.completed")))
	row, err := archived()
	require.NoError(t, err)
	require.Equal(t, "todo", row.FlowID)
	require.Equal(t, "completed", row.Status)
	require.JSONEq(t, `[{"nodeId":"edit","state":"done"}]`, string(row.Tree))

	// A capture on a stopped host never fails the observation, and keeps the
	// answers the live host gave.
	host.stopped = true
	require.NoError(t, archive.ProjectFlowRuntime(ctx, page("control.run.running")))
	kept, err := archived()
	require.NoError(t, err)
	require.JSONEq(t, string(row.Monitor), string(kept.Monitor))

	// Snapshots: the summary and tree rows as retained, the journal as events.
	snapshot := func(payload string) (string, bool) {
		answer, ok, err := kept.snapshot("run-1", json.RawMessage(payload))
		require.NoError(t, err)
		return string(answer), ok
	}
	summary, ok := snapshot(`{"selector":{"_tag":"run-summary","runId":"run-1"}}`)
	require.True(t, ok)
	require.JSONEq(t, `{"ok":true,"payload":{"selector":{"_tag":"run-summary","runId":"run-1"},
		"cursor":{"selector":{"_tag":"run-summary","runId":"run-1"},"projection":"run-summary","runId":"run-1","value":3,"offset":0},
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
		{"sequence": 1.0, "kind": "control.run.accepted", "runId": "run-1", "occurredAt": 1791331201000.0, "payload": map[string]any{"runId": "run-1"}},
		{"sequence": 3.0, "kind": "control.run.completed", "runId": "run-1", "occurredAt": 1791331203000.0, "payload": map[string]any{}},
	}, journal.Payload.Rows)
	for _, refused := range []string{
		`{"selector":{"_tag":"run-summary","runId":"run-2"}}`,
		`{"selector":{"_tag":"run-events","runId":"run-1"},"after":{"value":1}}`,
		`{"selector":{"_tag":"approvals","runId":"run-1"}}`,
		`{"selector":{"_tag":"run-summary","runId":"run-1","extra":"x"}}`,
		`not json`,
	} {
		_, ok := snapshot(refused)
		require.False(t, ok, refused)
	}

	// The run:<id> topic: the summary without its wall-clock rollup, and only
	// the journal after the subscriber's cursor.
	livePage, projection, err := kept.livePage("run-1", nil)
	require.NoError(t, err)
	require.Equal(t, int64(3), livePage.Cursor)
	require.Empty(t, projection["events"])
	require.NotContains(t, projection["summary"], "statusRollup")
	after := int64(1)
	_, projection, err = kept.livePage("run-1", &after)
	require.NoError(t, err)
	require.Len(t, projection["events"], 1)
	beyond := int64(9)
	gap, _, err := kept.livePage("run-1", &beyond)
	require.NoError(t, err)
	require.True(t, gap.Gap)

	// The monitor of a stopped host is the archived one, priced and named as
	// the install names it. Replay needs the live host.
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
	served, err := monitors.read(ctx, repo.ID, "lane-1:run-1", nil)
	require.NoError(t, err)
	var monitor map[string]any
	require.NoError(t, json.Unmarshal(served, &monitor))
	require.Equal(t, "lane-1:run-1", monitor["id"])
	require.Equal(t, strings.Repeat("a", 64), monitor["version"])
	require.Equal(t, "done", monitor["state"])
	require.Equal(t, 0.0, monitor["cost_usd"])
	at := int64(1)
	_, err = monitors.read(ctx, repo.ID, "lane-1:run-1", &at)
	require.Error(t, err)

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
