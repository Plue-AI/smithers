package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The credential originates in the authenticated terminal lifecycle. Vary only
// its persisted issuer attribution; forged request metadata never chooses it.
// PostgreSQL, TODO authorization, confirmation and signal admission are real.
func exerciseTerminalRealServiceMatrix(t *testing.T, ctx context.Context, pool *pgxpool.Pool, member db.User, repository int64, token string,
	invoke func(...string) (int, map[string]any), call func(string, string, string, string, string, string) (int, []byte), missing func(string, string) (int, []byte)) {
	t.Helper()
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	var original string
	require.NoError(t, pool.QueryRow(ctx, `SELECT scopes FROM access_tokens WHERE token_hash=$1`, hash).Scan(&original))
	var branch string
	for _, entry := range strings.Split(original, ",") {
		if strings.HasPrefix(entry, "branch:") {
			branch = strings.TrimPrefix(entry, "branch:")
		}
	}
	require.NotEmpty(t, branch)
	defer func() {
		_, err := pool.Exec(ctx, `UPDATE access_tokens SET scopes=$1 WHERE token_hash=$2`, original, hash)
		require.NoError(t, err)
	}()
	count := func(table string) int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	signals := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&n))
		return n
	}
	var own, foreign int64
	var ownID string
	for i, workspace := range []string{branch, ""} {
		var n int64
		var id string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,owner_id,created_by,revisions,checks,paused_at,attempt,workspace_id) VALUES($1,'todo','proposed','Terminal matrix','Terminal matrix',$2,$2,'[{"text":"Original","acceptance":[]}]','{}',now(),1,$3) RETURNING number,id::text`, repository, member.ID, workspace).Scan(&n, &id))
		if i == 0 {
			own = n
			ownID = id
		} else {
			foreign = n
		}
	}
	for _, via := range []string{"terminal", "cli", "claude-code", "codex"} {
		t.Run("real services via "+via, func(t *testing.T) {
			scopes := strings.Replace(original, "via:terminal", "via:"+via, 1)
			_, err := pool.Exec(ctx, `UPDATE access_tokens SET scopes=$1 WHERE token_hash=$2`, scopes, hash)
			require.NoError(t, err)
			var stored string
			var system bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT scopes,system_issued FROM access_tokens WHERE token_hash=$1`, hash).Scan(&stored, &system))
			require.True(t, system)
			require.Equal(t, scopes, stored)
			beforeTodos, beforeConfirm := count("mythical_items"), count("approvals")
			beforeJobs := count("product_job_requests")
			status, raw := missing(`{"title":"Missing card","prompt":"Delegated append"}`, "matrix-missing-"+via)
			require.Equal(t, 403, status, string(raw))
			var refusal map[string]any
			require.NoError(t, json.Unmarshal(raw, &refusal))
			require.Equal(t, "permission", refusal["class"])
			require.Equal(t, "confirm_in_app", refusal["code"])
			require.Equal(t, "Confirm in the app", refusal["message"])
			require.Equal(t, beforeTodos, count("mythical_items"))
			require.Equal(t, beforeConfirm, count("approvals"))
			require.Equal(t, beforeJobs, count("product_job_requests"))
			path := "/api/todos"
			status, raw = call("POST", path, `{"title":"Matrix","prompt":"Delegated append"}`, "", token, "matrix-append-"+via)
			require.Equal(t, 202, status, string(raw))
			require.Equal(t, beforeTodos, count("mythical_items"))
			require.Equal(t, beforeConfirm+1, count("approvals"))
			var pending map[string]any
			require.NoError(t, json.Unmarshal(raw, &pending))
			require.Equal(t, "pending", pending["state"])
			for range 2 {
				status, raw = call("POST", "/api/confirmations/"+pending["confirmation"].(string)+"/approve", `{}`, "replacement-cookie", "", "matrix-approve-"+via)
				require.Equal(t, 200, status, string(raw))
				require.Equal(t, beforeTodos+1, count("mythical_items"))
			}
			code, result := invoke("todo", "steer", fmt.Sprintf("T%d", own), "Feedback "+via, "--idempotencyKey", "matrix-steer-"+via)
			require.Zero(t, code, result)
			require.NotContains(t, result, "confirmation")
			var feedback string
			require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'steers'->-1->>'text' FROM mythical_items WHERE number=$1`, own).Scan(&feedback))
			require.Equal(t, "Feedback "+via, feedback)
			for _, kind := range []string{"question", "approval"} {
				waitID := "matrix-" + via + "-" + kind
				scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", member.ID)}
				target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: branch, BindingKind: "mythical-item", BindingID: ownID}
				wait := services.TodoWait{ID: waitID, Kind: kind, Prompt: "Choose", Signal: &services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "matrix-run", Name: waitID}}
				waits, err := json.Marshal([]services.TodoWait{wait})
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}',$1::jsonb) WHERE number=$2`, waits, own)
				require.NoError(t, err)
				before := signals()
				code, result = invoke("todo", "answer", fmt.Sprintf("T%d", own), "Use A", "--wait", waitID)
				if kind == "question" {
					require.Zero(t, code, result)
					require.Equal(t, before+1, signals())
					var answer, by string
					require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'waits'->0->>'answer',checks->'waits'->0->>'answered_by' FROM mythical_items WHERE number=$1`, own).Scan(&answer, &by))
					require.Equal(t, "Use A", answer)
					require.Equal(t, member.Username, by)
				} else {
					require.Equal(t, 1, code, result)
					require.Equal(t, "permission", result["code"])
					require.Equal(t, before, signals())
				}
			}
			beforeJobs = count("product_job_requests")
			for _, argv := range [][]string{
				{"todo", "steer", fmt.Sprintf("T%d", foreign), "Forbidden"},
				{"todo", "answer", fmt.Sprintf("T%d", foreign), "Forbidden", "--wait", "matrix"},
				{"todo", "drop", fmt.Sprintf("T%d", own)},
				{"merge", fmt.Sprintf("T%d", own), "--reviewed_head_sha", strings.Repeat("a", 40)},
			} {
				code, result = invoke(argv...)
				require.Equal(t, 1, code, result)
				require.Equal(t, "permission", result["class"])
				require.Equal(t, "permission", result["code"])
			}
			require.Equal(t, beforeJobs, count("product_job_requests"))
		})
	}
}
