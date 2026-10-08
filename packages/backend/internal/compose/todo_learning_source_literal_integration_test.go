package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Literal ten-source learning_done permissions. The immutable dispatch receipt,
// production Learning consumer, real wiki/blob writes and installed card all
// participate; neither a helper transition nor a fake receipt store is used.
func TestTodoLearningSourceGuardPairAccountingComposedInstall(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	store, err := jobs.NewStore(h.pool)
	require.NoError(t, err)
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://127.0.0.1:4000", SigningKey: []byte("learning-test-key-with-32-bytes!!")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	wiki := services.NewWikiService(h.q, nil, services.WithWikiContent(content))
	consumer := services.NewLearningRuntime(service, wiki)
	sources := []struct {
		from, engine string
		allowed      bool
	}{
		{"draft", "queued", false}, {"queued", "queued", false}, {"starting", "running", false},
		{"working", "running", false}, {"needs_you", "running", false}, {"paused", "running", false},
		{"failed", "blocked", false}, {"in_review", "proposed", false}, {"merged", "landed", true}, {"dropped", "cancelled", false},
	}
	allowed, refused := 0, 0
	for _, s := range sources {
		t.Run(s.from, func(t *testing.T) {
			checks := map[string]any{"todo": true, "run_launched": s.from != "queued", "run_attached": s.from != "starting"}
			if s.from == "needs_you" {
				checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_state=CASE WHEN $4 THEN 'merged' ELSE '' END,pr_url='https://github.com/maya/app/pull/41',pr_merge_commit=$5,lessons=NULL,learning_receipt=NULL,paused_at=CASE WHEN $6 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, s.engine, raw, s.allowed, strings.Repeat("c", 40), s.from == "paused")
			require.NoError(t, err)
			id := uuid.UUID(h.item.ID.Bytes).String()
			if s.from == "draft" {
				id = "99999999-9999-4999-8999-999999999999"
			}
			scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
			target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "learning-machine", BindingKind: "learning", BindingID: id}
			pin := flowruntime.Pin{Flow: "learning", SourceCommit: strings.Repeat("c", 40), ExecutionDigest: strings.Repeat("d", 64)}
			launch, err := json.Marshal(map[string]any{"target": target, "flowId": "learning", "payload": map[string]int{"todo": 1}, "pin": pin})
			require.NoError(t, err)
			admitted, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "learning-pair-" + s.from, Payload: launch, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning-pair-" + s.from})
			require.NoError(t, err)
			run := "learning-" + s.from
			output, err := json.Marshal(map[string]any{"repository": "maya/app", "todo": 1, "run": run, "pages": []map[string]string{{"title": "Learned " + s.from, "body": "Keep the retry helper. Change: https://github.com/maya/app/pull/41; commit " + pin.SourceCommit}}, "proposals": []any{}})
			require.NoError(t, err)
			text := string(output)
			cp := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: "learning", RunID: run, ExecutionDigest: pin.ExecutionDigest, Identity: flowruntime.Identity{SourceRevision: pin.SourceCommit}, Run: &flowruntime.Run{RunID: run, FlowID: "learning", Status: "completed", FinalOutput: &text}}
			saved, err := json.Marshal(cp)
			require.NoError(t, err)
			_, err = h.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, saved)
			require.NoError(t, err)
			before, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			count := func(table string) int {
				var n int
				require.NoError(t, h.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
				return n
			}
			facts, pages := count("product_job_events"), count("wiki_page_revisions")
			update := flowdispatch.ProjectionUpdate{OperationID: admitted.OperationID, Scope: scope, State: jobs.StateCompleted, Checkpoint: cp}
			err = consumer.ProjectFlowRuntime(ctx, update)
			after, readErr := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, readErr)
			recordTodoGuardPair(t, s.from, "learning_done", func() string {
				if s.allowed && err == nil {
					return "merged"
				}
				return ""
			}())
			if !s.allowed {
				refused++
				require.ErrorIs(t, err, services.ErrLearningBinding)
				require.Equal(t, before, after)
				require.Equal(t, facts, count("product_job_events"))
				require.Equal(t, pages, count("wiki_page_revisions"))
			} else {
				allowed++
				require.NoError(t, err)
				require.Equal(t, before.State, after.State)
				require.Equal(t, facts+2, count("product_job_events"), "one proposal-stream receipt and one item fact")
				require.Equal(t, pages+1, count("wiki_page_revisions"))
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status)
				require.Equal(t, "merged", card["state"])
				require.EqualValues(t, 1, card["lessons"])
				require.NoError(t, consumer.ProjectFlowRuntime(ctx, update))
				require.Equal(t, facts+2, count("product_job_events"))
				require.Equal(t, pages+1, count("wiki_page_revisions"))
			}
		})
	}
	require.Equal(t, 1, allowed)
	require.Equal(t, 9, refused)
	t.Logf("literal learning_done pairs: %d allowed, %d refused; 10 sources", allowed, refused)
}
