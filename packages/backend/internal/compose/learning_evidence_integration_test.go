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

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The real install callback, bearer fence and PostgreSQL reads; a literal
// dispatch fixture stands in for the as-yet unavailable Learning guest target.
func TestLearningEvidenceComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "evidenceowner", LowerUsername: "evidenceowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	var workspace string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,status,vm_id) VALUES($1,$2,'Learning','running','learning-fixture') RETURNING id::text`, repo, owner.ID).Scan(&workspace))
	var item string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,owner_id,source,state,pr_state,pr_merge_commit,pr_url,checks) VALUES($1,$2,'todo','landed','merged',$3,'https://github.com/evidenceowner/app/pull/41',
 '{"attempts":[{"attempt":1,"run_id":"attempt-1","items":[{"kind":"check","name":"lint","state":"failed","tier":"slow","evidence":"Run lint before review to catch unused imports."}]},{"attempt":2,"run_id":"attempt-2","items":[]}],"steers":[{"text":"Use the existing retry helper because it already backs off.","attempt":1}],"githubInputs":[{"text":"Keep retries bounded because the provider can remain unavailable.","review_state":"COMMENTED"}]}') RETURNING id::text`, repo, owner.ID, strings.Repeat("a", 40)).Scan(&item))
	host := uuid.NewString()
	bearer := "learning-host-secret"
	hash := sha256.Sum256([]byte(bearer))
	target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID), WorkspaceID: workspace, BindingKind: "learning", BindingID: item}
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state) VALUES($1,$2,$3,'learning',$4,$5,$6,$7,'coding','smithers-coding-host',$8,$9,1,'fixture-only',$10,'running')`, host, target.TenantID, target.PrincipalID, item, repo, owner.ID, workspace, strings.Repeat("f", 64), strings.Repeat("a", 40), hash[:])
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	pin := flowruntime.Pin{Flow: "learning", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: strings.Repeat("1", 64)}
	intent, _ := json.Marshal(map[string]any{"item": item, "todo": 1, "repository": repo, "actor": owner.ID, "commit": strings.Repeat("a", 40), "pin": pin})
	_, err = store.Admit(ctx, jobs.Admission{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, Operation: services.LearningAdmissionOperation, RequestID: "learning:" + item, Payload: intent, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning:" + item})
	require.NoError(t, err)

	payload, _ := json.Marshal(map[string]any{"flowId": "learning", "target": target, "pin": pin, "payload": map[string]int{"todo": 1}})
	admitted, err := store.Admit(ctx, jobs.Admission{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, Operation: flowdispatch.OperationLaunch, RequestID: "learning-run:" + item, Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning-fixture"})
	require.NoError(t, err)
	checkpoint := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: "learning", RunID: "learning-1", ExecutionDigest: pin.ExecutionDigest, Identity: flowruntime.Identity{SourceRevision: pin.SourceCommit, RuntimeArtifactDigest: strings.Repeat("f", 64), OwnerGeneration: 1}}
	raw, _ := json.Marshal(checkpoint)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, raw)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	authority, err := service.LearningRuntime().ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, workspace, authority.WorkspaceID)
	require.Equal(t, strings.Repeat("a", 40), authority.SourceRevision)
	require.Equal(t, &pin, authority.ExecutionPin)
	forged := target
	forged.WorkspaceID = uuid.NewString()
	_, err = service.LearningRuntime().ResolveFlowHostTarget(ctx, forged)
	require.Error(t, err)

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	call := func(token, run string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, cfg.Server.PublicURL+"/api/gateways/"+host+"/learning/"+strings.ReplaceAll(url.PathEscape(run), ":", "%3A")+"/evidence", nil)
		req.RemoteAddr = "127.0.0.1:51900"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res.Code, res.Body.String()
	}
	code, body := call(bearer, "learning-1")
	require.Equal(t, 200, code, body)
	var result services.LearningEvidence
	require.NoError(t, json.Unmarshal([]byte(body), &result))
	require.Equal(t, "evidenceowner/app", result.Repository)
	require.Equal(t, int64(1), result.Todo)
	require.Equal(t, "learning-1", result.Run)
	require.Equal(t, "merged", result.State)
	require.Equal(t, []string{"attempt-1", "attempt-2"}, result.Attempts)
	require.Equal(t, []services.LearningOutcome{{Todo: 1, Failures: []services.LearningFailure{{Signature: "check:lint@review", Text: "Run lint before review to catch unused imports."}}}}, result.Outcomes)
	require.Len(t, result.Journal, 3)
	require.Equal(t, "control.agent.steering-drained", result.Journal[0].EventType)
	require.Contains(t, body, "because it already backs off")
	require.Contains(t, body, "because the provider can remain unavailable")

	// The dispatcher reserves colon-prefixed IDs. The machine's HTTP client
	// escapes them; decode exactly once, including literal percent characters.
	for _, runID := range []string{"dispatch:reserved", "percent%literal", "dispatch:percent%literal"} {
		checkpoint.RunID = runID
		encoded, e := json.Marshal(checkpoint)
		require.NoError(t, e)
		_, e = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, encoded)
		require.NoError(t, e)
		code, body = call(bearer, runID)
		require.Equal(t, 200, code, body)
		require.NoError(t, json.Unmarshal([]byte(body), &result))
		require.Equal(t, runID, result.Run)
	}
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, raw)
	require.NoError(t, err)
	for _, row := range []struct{ token, run string }{{"", "learning-1"}, {"wrong", "learning-1"}, {bearer, "another-run"}} {
		code, body = call(row.token, row.run)
		require.Equal(t, 403, code, body)
		require.NotContains(t, body, "retry helper")
	}
	for _, row := range []struct{ name, change, restore string }{
		{"wrong repository", `UPDATE flow_runtime_host_bindings SET tenant_id='repository:999' WHERE id=$1`, `UPDATE flow_runtime_host_bindings SET tenant_id=$2 WHERE id=$1`},
		{"rotated generation", `UPDATE flow_runtime_host_bindings SET owner_generation=2 WHERE id=$1`, `UPDATE flow_runtime_host_bindings SET owner_generation=1 WHERE id=$1`},
		{"retired host", `UPDATE flow_runtime_host_bindings SET state='retired' WHERE id=$1`, `UPDATE flow_runtime_host_bindings SET state='running' WHERE id=$1`},
	} {
		t.Run(row.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, row.change, host)
			require.NoError(t, err)
			code, body := call(bearer, "learning-1")
			require.Equal(t, 403, code, body)
			require.NotContains(t, body, "unused imports")
			if strings.Contains(row.restore, "$2") {
				_, err = pool.Exec(ctx, row.restore, host, target.TenantID)
			} else {
				_, err = pool.Exec(ctx, row.restore, host)
			}
			require.NoError(t, err)
		})
	}
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='completed',terminal_receipt='{}' WHERE id=$1`, admitted.OperationID)
	require.NoError(t, err)
	code, body = call(bearer, "learning-1")
	require.Equal(t, 403, code, body)
}
