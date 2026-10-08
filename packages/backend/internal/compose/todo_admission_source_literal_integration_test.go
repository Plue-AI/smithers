package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Admission runs the production stack worker, real Git/GitHub transport and
// PostgreSQL. The machine contract qualifies orchestration only: no guest or
// first step runs here. Literal source permissions do not read guard metadata.
func TestTodoAdmissionSourceTransitionLiteralCases(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	f := newMergeFaultFixture(t)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `UPDATE mythical_stacks SET max_parallel=8 WHERE repository_id=$1`, f.repo)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='cancelled',pr_number=NULL,pr_state='',workspace_id='',checks='{}' WHERE id=$1`, f.item.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,'4f098b2e90ef23159043fd5dfecbc305e0017549',$2,'loaded')`, f.repo, startFaultDigest)
	require.NoError(t, err)
	service := startFaultService(t, f.pool, f.host, false)
	server := mergeFaultServer(t, f.pool, service)
	sources := []struct {
		name, engine                         string
		launched, attached, paused, question bool
		admit                                bool
	}{
		{"queued", "queued", false, false, false, false, true},
		{"starting", "running", true, false, false, false, false},
		{"working", "running", true, true, false, false, false},
		{"needs_you", "running", true, true, false, true, false},
		{"paused", "running", true, true, true, false, false},
		{"failed", "blocked", true, true, false, false, false},
		{"in_review", "proposed", true, true, false, false, false},
		{"merged", "landed", true, true, false, false, false},
		{"dropped", "cancelled", true, true, false, false, false},
		{"queued-with-branch-wait", "queued", false, false, false, true, false},
		{"queued-paused", "queued", false, false, true, false, false},
		{"queued-conflict", "queued", false, false, false, true, false},
		{"queued-moved_off", "queued", false, false, false, true, false},
		{"queued-question", "queued", false, false, false, true, false},
		{"queued-approval", "queued", false, false, false, true, false},
	}
	type fixture struct {
		item     db.MythicalItem
		from, to string
		admit    bool
	}
	var rows []fixture
	for _, source := range sources {
		checks := map[string]any{"todo": true, "run_launched": source.launched, "run_attached": source.attached}
		if source.question {
			kind := "foreign_push"
			switch source.name {
			case "queued-conflict":
				kind = "conflict"
			case "queued-moved_off":
				kind = "moved_off"
			case "queued-question":
				kind = "question"
			case "queued-approval":
				kind = "approval"
			}
			checks["waits"] = []map[string]any{{"id": "foreign", "kind": kind, "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
		}
		raw, err := json.Marshal(checks)
		require.NoError(t, err)
		item, _, err := f.q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: f.repo, Source: "todo", State: source.engine, Title: pgtype.Text{String: source.name, Valid: true}, Checks: raw})
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET source='todo',next_attempt_at='2026-10-02T00:00:00Z',title=$6,owner_id=$2,attempt=CASE WHEN $3 THEN 1 ELSE 0 END,request_run_id=CASE WHEN $3 THEN 'existing-run' ELSE '' END,paused_at=CASE WHEN $4 THEN now() ELSE NULL END,flow_digest=CASE WHEN $3 THEN $5 ELSE NULL END WHERE id=$1`, item.ID, f.item.OwnerID.Int64, source.launched, source.paused, startFaultDigest, source.name)
		require.NoError(t, err)
		item, err = f.q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		from, to := source.name, source.name
		if source.question {
			from, to = "needs_you", "needs_you"
		}
		if source.name == "queued-paused" {
			from, to = "paused", "paused"
		}
		if source.admit {
			to = "starting"
		}
		rows = append(rows, fixture{item, from, to, source.admit})
	}
	_, err = f.q.RequestMythicalStack(ctx, f.repo)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(ctx))
	accepted, refused := 0, 0
	for _, row := range rows {
		t.Run(row.item.Title.String, func(t *testing.T) {
			item, err := f.q.GetMythicalItem(ctx, row.item.ID)
			require.NoError(t, err)
			var events int
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.started' AND data->>'n'=$1`, fmt.Sprint(row.item.Number.Int64)).Scan(&events))
			if row.admit {
				accepted++
				require.Equal(t, 1, events, "item=%+v checks=%s", item, item.Checks)
				require.EqualValues(t, 1, item.Attempt)
				require.Equal(t, startFaultDigest, item.FlowDigest.String)
				require.Empty(t, item.RequestRunID)
				var raw []byte
				require.NoError(t, f.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.started' AND data->>'n'=$1`, fmt.Sprint(row.item.Number.Int64)).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, row.from, fact["from"])
				require.Equal(t, "starting", fact["to"])
				require.Equal(t, map[string]any{"kind": "system", "id": "stack"}, fact["actor"])
			} else {
				refused++
				require.Zero(t, events)
				require.Equal(t, row.item.Attempt, item.Attempt)
				require.Equal(t, row.item.RequestRunID, item.RequestRunID)
			}
			request, err := http.NewRequest("GET", fmt.Sprintf("%s/api/todos/%d", server.URL, row.item.Number.Int64), nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			var card map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
			require.Equal(t, 200, response.StatusCode, card)
			require.Equal(t, row.to, card["state"])
		})
	}
	var launches int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='todo'`).Scan(&launches))
	require.Equal(t, 1, launches)
	require.NoError(t, service.PollOnce(ctx))
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='todo'`).Scan(&launches))
	require.Equal(t, 1, launches, "replay does not re-admit the pinned attempt")
	require.Equal(t, 1, accepted)
	require.Equal(t, 14, refused)
	t.Logf("literal admission: %d grants, %d source/overlay no-ops", accepted, refused)
}
