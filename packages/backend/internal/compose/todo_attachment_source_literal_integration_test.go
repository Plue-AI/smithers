package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Literal attachment sources reach the production runtime consumer and installed
// card. Draft has no stored attempt and cannot receive a machine checkpoint.
func TestTodoAttachmentSourceTransitionLiteralCases(t *testing.T) {
	const digest = "e274ce85c2e7f9fdef2bb4de75700e9847920893d24e6f69d692a573ff11ed3d"
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const workspace = "11111111-1111-4111-8111-111111111111"
	cases := []struct {
		from, engine, to                           string
		launched, attached, paused, wait, accepted bool
	}{
		{"queued", "queued", "queued", false, false, false, false, false},
		{"starting", "running", "working", true, false, false, false, true},
		{"working", "running", "working", true, true, false, false, true},
		{"needs_you", "running", "needs_you", true, true, false, true, true},
		{"paused", "running", "paused", true, true, true, false, true},
		{"failed", "blocked", "failed", true, true, false, false, false},
		{"in_review", "proposed", "in_review", true, true, false, false, true},
		{"merged", "landed", "merged", true, true, false, false, false},
		{"dropped", "cancelled", "dropped", true, true, false, false, false},
	}
	for _, c := range cases {
		t.Run(c.from, func(t *testing.T) {
			var service *services.MythicalService
			h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
			ctx := t.Context()
			checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached, "flowSource": source}
			if c.wait {
				checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,attempt=1,request_run_id='run-1',flow_digest=$3,workspace_id=$4,checks=$5,paused_at=CASE WHEN $6 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, digest, workspace, raw, c.paused)
			require.NoError(t, err)
			before, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			status, card := h.call(t, "GET", "", "")
			require.Equal(t, 200, status)
			require.Equal(t, c.from, card["state"])
			projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(h.item.ID.Bytes).String(), "attempt": 1, "generation": before.Generation, "phase": "todo", "flowDigest": digest, "flowSource": source})
			require.NoError(t, err)
			scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", before.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
			update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", RunID: "run-1", ExecutionDigest: digest, Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}, Run: &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: "running"}}}
			count := func() int {
				var n int
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&n))
				return n
			}
			facts := count()
			require.NoError(t, service.ProjectFlowRuntime(ctx, update))
			after, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			status, card = h.call(t, "GET", "", "")
			require.Equal(t, 200, status)
			require.Equal(t, c.to, card["state"])
			require.Equal(t, before.RequestRunID, after.RequestRunID)
			require.Equal(t, before.Attempt, after.Attempt)
			require.Equal(t, before.FlowDigest, after.FlowDigest)
			require.Equal(t, before.PausedAt, after.PausedAt)
			if !c.accepted {
				require.Equal(t, before, after)
				require.Equal(t, facts, count())
				return
			}
			{
				require.Equal(t, facts+1, count())
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, c.from, fact["from"])
				require.Equal(t, c.to, fact["to"])
				require.Equal(t, map[string]any{"kind": "run", "id": "run-1"}, fact["actor"])
			}
			require.NoError(t, service.ProjectFlowRuntime(ctx, update))
			replayed, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			require.Equal(t, after, replayed)
		})
	}
}
