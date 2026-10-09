package compose

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The mounted proxy verifies real host credentials and the committed TODO
// binding in PostgreSQL. Issue intake retains source=issue and a prompt revision.
func TestTodoInputFenceIssueAndOwnerComposedProxy(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "fence-owner", LowerUsername: "fence-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	otherRepo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
	require.NoError(t, err)
	var workspace string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id) VALUES($1,$2) RETURNING id::text`, repo.ID, owner.ID).Scan(&workspace))
	binding, secret := uuid.NewString(), "test-input-fence-control"
	hash := sha256.Sum256([]byte(secret))
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state)
 VALUES($1,$2,$3,'agent-session','fence-session',$4,$5,$6,'coding','smithers-coding-host',$7,$8,1,$9,$10,'running')`, binding, fmt.Sprintf("repository:%d", repo.ID), fmt.Sprintf("user:%d", owner.ID), repo.ID, owner.ID, workspace, strings.Repeat("a", 64), strings.Repeat("b", 40), secret, hash[:])
	require.NoError(t, err)
	const run = "dispatch:issue-todo"
	var item string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,request_run_id,revisions,number) VALUES($1,'todo','running',$2,$3,'[]',1) RETURNING id::text`, repo.ID, workspace, run).Scan(&item))
	handler := &modelproxy.Handler{Callers: services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}), FenceInputs: fenceTodoInputs(pool)}
	router := chi.NewRouter()
	mountModelProxy(router, q, testConfigAllFlagsOn(), handler)
	for _, tc := range []struct {
		name, source, revisions, state, role, run, workspace, hostState string
		status                                                          int
	}{
		{"owner TODO", "todo", "[]", "running", "implementer", run, workspace, "running", 200},
		{"Make TODO from issue", "issue", `[{"text":"Greet visitors"}]`, "running", "implementer", run, workspace, "running", 200},
		{"issue TODO in review", "issue", `[{"text":"Greet visitors"}]`, "proposed", "implementer", run, workspace, "running", 200},
		{"unnumbered item", "todo", "[]", "running", "implementer", run, workspace, "running", 403},
		{"legacy issue", "issue", "[]", "running", "implementer", run, workspace, "running", 403},
		{"chat item", "chat", `[{"text":"Greet visitors"}]`, "running", "implementer", run, workspace, "running", 403},
		{"wrong repository", "issue", `[{"text":"Greet visitors"}]`, "running", "implementer", run, workspace, "running", 403},
		{"wrong run", "issue", `[{"text":"Greet visitors"}]`, "running", "implementer", "other-run", workspace, "running", 403},
		{"empty run", "todo", "[]", "running", "implementer", "", workspace, "running", 403},
		{"wrong workspace", "todo", "[]", "running", "implementer", run, uuid.NewString(), "running", 403},
		{"planner credential", "todo", "[]", "running", "planner", run, workspace, "running", 403},
		{"unscoped credential", "todo", "[]", "running", "", run, workspace, "running", 403},
		{"retired credential", "todo", "[]", "running", "implementer", run, workspace, "retired", 403},
		{"landed", "todo", "[]", "landed", "implementer", run, workspace, "running", 403},
		{"cancelled", "todo", "[]", "cancelled", "implementer", run, workspace, "running", 403},
		{"rejected", "todo", "[]", "rejected", "implementer", run, workspace, "running", 403},
		{"declined", "todo", "[]", "declined", "implementer", run, workspace, "running", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repository := repo.ID
			if tc.name == "wrong repository" {
				repository = otherRepo.ID
			}
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET source=$2,revisions=$3::jsonb,state=$4,workspace_id=$5,repository_id=$6,number=CASE WHEN $7 THEN NULL ELSE 1 END WHERE id=$1`, item, tc.source, tc.revisions, tc.state, tc.workspace, repository, tc.name == "unnumbered item")
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state=$2 WHERE id=$1::uuid`, binding, tc.hostState)
			require.NoError(t, err)
			credential := flowhost.RoleModelCredential(binding, secret, tc.role)
			if tc.role == "" {
				credential = flowhost.ModelCredential(binding, secret)
			}
			req := httptest.NewRequest(http.MethodGet, modelproxy.Path+"/input-fence?run="+url.QueryEscape(tc.run), nil)
			req.Header.Set("Authorization", "Bearer "+credential)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, tc.status, response.Code, response.Body.String())
		})
	}
	// These requests cross the mounted HTTP boundary with genuine host credentials.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',revisions='[]',state='running',workspace_id=$2,repository_id=$3,number=1 WHERE id=$1`, item, workspace, repo.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='running' WHERE id=$1::uuid`, binding)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	for _, tc := range []struct {
		name, operation, signal, projection, state string
		status                                     int
	}{
		{"pending informational signal", "flow.runtime.signal", "outside_change", "{}", "accepted", 200},
		{"refused informational signal", "flow.runtime.signal", "outside_change", "{}", "failed", 200},
		{"uncertain informational signal", "flow.runtime.signal", "outside_change", "{}", "uncertain", 200},
		{"refused person steer", "flow.runtime.steer", "", "{}", "failed", 503},
		{"refused named steer", "flow.runtime.signal", "steer", "{}", "failed", 503},
		{"refused person answer", "flow.runtime.signal", "coding-clarification", `{"kind":"mythical-answer"}`, "failed", 503},
		{"cancelled person answer", "flow.runtime.signal", "choice", `{"kind":"mythical-answer"}`, "cancelled", 503},
		{"completed person answer", "flow.runtime.signal", "choice", `{"kind":"mythical-answer"}`, "completed", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{"runId": run, "name": tc.signal, "projection": json.RawMessage(tc.projection)})
			require.NoError(t, err)
			receipt, err := store.Admit(ctx, jobs.Admission{Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}, Operation: tc.operation, RequestID: uuid.NewString(), Payload: payload, EffectPolicy: jobs.EffectReconcile, EffectKey: uuid.NewString()})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state=$2,terminal_receipt=CASE WHEN $2='accepted' THEN NULL ELSE '{}'::jsonb END WHERE id=$1::uuid`, receipt.OperationID, tc.state)
			require.NoError(t, err)
			// Reproduce a dark host refusing the note after the fence starts waiting.
			done := make(chan error, 1)
			if tc.state == "accepted" {
				go func() {
					time.Sleep(100 * time.Millisecond)
					_, err := pool.Exec(ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{}'::jsonb WHERE id=$1::uuid`, receipt.OperationID)
					done <- err
				}()
			} else {
				done <- nil
			}
			req := httptest.NewRequest(http.MethodGet, modelproxy.Path+"/input-fence?run="+url.QueryEscape(run), nil)
			req.Header.Set("Authorization", "Bearer "+flowhost.RoleModelCredential(binding, secret, "implementer"))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.NoError(t, <-done)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='completed',terminal_receipt='{}'::jsonb WHERE id=$1::uuid`, receipt.OperationID)
			require.NoError(t, err)
		})
	}
}
