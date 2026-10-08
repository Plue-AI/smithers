package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Admission uses the real jobs store and database trigger; the deliberately
// unavailable resolver proves admission never starts a machine.
func TestFactoryIssueIsolatedReviewKeepsOneOwner(t *testing.T) {
	for _, mode := range []string{"current", "settled_review", "old_head", "old_candidate", "other_phase", "other_flow", "retired", "other_workspace", "other_actor"} {
		t.Run(mode, func(t *testing.T) {
			pool := reviewDatabase(t, 0)
			ctx := t.Context()
			repo := reviewRepo(t, pool)
			coding, review, item := uuid.NewString(), uuid.NewString(), uuid.NewString()
			_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status,name,target_bookmark) VALUES($1,$3,1001,'running','coding','coding'),($2,$3,1001,'running','review','review')`, coding, review, repo)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,1001,'active')`, repo)
			require.NoError(t, err)
			head, candidate := strings.Repeat("a", 40), strings.Repeat("b", 40)
			checks, _ := json.Marshal(map[string]any{"review": map[string]string{"lane": review, "head": head, "candidate": candidate}})
			_, err = pool.Exec(ctx, `INSERT INTO mythical_items(id,repository_id,issue_number,source,state,workspace_id,generation,issue_digest,approved_digest,pr_head,candidate_head,checks) VALUES($1,$2,42,'issue','proposed',$3,1,'approved','approved',$4,$5,$6)`, item, repo, coding, head, candidate, checks)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'TODO 1 review g1')`, review, repo, item)
			require.NoError(t, err)
			store, err := jobs.NewStore(pool)
			require.NoError(t, err)
			dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
				return nil, errors.New("admission must not execute")
			})})
			require.NoError(t, err)
			scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: "user:1001"}
			auth := func(workspace string, user int) json.RawMessage {
				raw, e := json.Marshal(map[string]any{"repositoryId": repo, "userId": user, "workspaceId": workspace, "itemId": item, "generation": 1})
				require.NoError(t, e)
				return raw
			}
			_, err = dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: "coding", Target: flowruntime.Target{WorkspaceID: coding, BindingKind: "mythical-item", BindingID: item}, FlowID: "coding/request", Payload: json.RawMessage(`{}`), AuthorizationContext: auth(coding, 1001)})
			require.NoError(t, err)
			flow, phase, workspace, user := "review/change", "review", review, 1001
			switch mode {
			case "settled_review":
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{review,verdict}','"approve"'::jsonb) WHERE id=$1`, item)
				require.NoError(t, err)
			case "old_head":
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_head=$2 WHERE id=$1`, item, strings.Repeat("c", 40))
			case "old_candidate":
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET candidate_head=$2 WHERE id=$1`, item, strings.Repeat("c", 40))
			case "other_phase":
				phase = "verify"
			case "other_flow":
				flow = "coding/request"
			case "retired":
				_, err = pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=clock_timestamp() WHERE workspace_id=$1`, review)
			case "other_workspace":
				workspace = uuid.NewString()
			case "other_actor":
				user = 2
				scope.PrincipalID = "user:2"
			}
			require.NoError(t, err)
			projection, _ := json.Marshal(map[string]string{"kind": "mythical-item", "phase": phase, "itemId": item})
			receipt, err := dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: "review", Target: flowruntime.Target{WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: item}, FlowID: flow, Payload: json.RawMessage(`{}`), Projection: projection, AuthorizationContext: auth(workspace, user)})
			if mode == "current" {
				require.NoError(t, err)
				require.NotEmpty(t, receipt.OperationID)
			} else {
				var denied *pgconn.PgError
				require.ErrorAs(t, err, &denied)
				require.Equal(t, "P2082", denied.Code)
			}
			var count int
			var owner string
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*),min(owner_id) FROM factory_issue_claims WHERE repository_id=$1 AND issue_number=42 AND released_at IS NULL`, repo).Scan(&count, &owner))
			require.Equal(t, 1, count)
			require.Equal(t, item, owner)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&count))
			if mode == "current" {
				require.Equal(t, 2, count)
			} else {
				require.Equal(t, 1, count, "rejected reviewer admits no operation")
			}
		})
	}
}
