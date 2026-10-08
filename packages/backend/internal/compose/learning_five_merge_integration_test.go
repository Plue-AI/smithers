package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Production guest extraction reads the composed run-bound HTTP evidence door,
// then the persisted completion consumer writes real wiki/notes/receipts. The
// machine lifecycle and confirmed merges are fixtures here; the separate served
// merge/poll test covers admission. This is not reference-host isolation proof.
func TestLearningFiveMergeProposalComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "fiveowner", LowerUsername: "fiveowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1;`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"fiveowner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-08T12:00:00Z"}`, repo))}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	session := sha256.Sum256([]byte("five-session"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(session[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	defer server.Close()
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: server.URL, SigningKey: []byte("learning-test-key-with-32-bytes!!")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	consumer := services.NewLearningRuntime(service, services.NewWikiService(q, nil, services.WithWikiContent(content)))
	call := func(method, path, key string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, server.URL+path, strings.NewReader("{}"))
		req.RemoteAddr = "127.0.0.1:51900"
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "five-session"})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "five-csrf"})
		req.Header.Set("Origin", server.URL)
		req.Header.Set("X-CSRF-Token", "five-csrf")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res := httptest.NewRecorder()
		server.Config.Handler.ServeHTTP(res, req)
		return res.Code, res.Body.Bytes()
	}
	var proposalID string
	var fifthNote []byte
	for n := 1; n <= 6; n++ {
		var workspace string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,status,vm_id) VALUES($1,$2,$3,'running',$3) RETURNING id::text`, repo, owner.ID, fmt.Sprintf("learning-%d", n)).Scan(&workspace))
		checks := `{"attempts":[]}`
		if n == 1 || n == 3 || n == 5 || n == 6 {
			checks = `{"attempts":[{"attempt":1,"run_id":"attempt-first","failures":[{"signature":"check:lint@review","text":"Run lint before review to catch unused imports."}],"items":[]},{"attempt":2,"run_id":"attempt-fixed","items":[]}],"steers":[{"text":"Use the existing retry helper because it already backs off.","attempt":1}]}`
		}
		var item string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,owner_id,source,state,pr_state,pr_merge_commit,pr_url,checks) VALUES($1,$2,'todo','landed','merged',$3,$4,$5) RETURNING id::text`, repo, owner.ID, strings.Repeat("a", 40), fmt.Sprintf("https://github.com/fiveowner/app/pull/%d", n), checks).Scan(&item))
		run := fmt.Sprintf("learning-%d", n)
		target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID), WorkspaceID: workspace, BindingKind: "learning", BindingID: item}
		scope := jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}
		pin := flowruntime.Pin{Flow: "learning", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: strings.Repeat("1", 64)}
		host := uuid.NewString()
		bearer := "five-host-secret"
		hash := sha256.Sum256([]byte(bearer))
		_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state) VALUES($1,$2,$3,'learning',$4,$5,$6,$7,'coding','smithers-coding-host',$8,$9,1,'fixture-only',$10,'running')`, host, target.TenantID, target.PrincipalID, item, repo, owner.ID, workspace, strings.Repeat("f", 64), pin.SourceCommit, hash[:])
		require.NoError(t, err)
		launch, _ := json.Marshal(map[string]any{"target": target, "flowId": "learning", "pin": pin, "payload": map[string]int{"todo": n}})
		admitted, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: run, Payload: launch, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: run})
		require.NoError(t, err)
		cp := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: "learning", RunID: run, ExecutionDigest: pin.ExecutionDigest, Identity: flowruntime.Identity{SourceRevision: pin.SourceCommit, RuntimeArtifactDigest: strings.Repeat("f", 64), OwnerGeneration: 1}}
		saved, _ := json.Marshal(cp)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, saved)
		require.NoError(t, err)
		script, err := filepath.Abs("../../../../flows/test/fixtures/learning-extraction.ts")
		require.NoError(t, err)
		command := exec.CommandContext(ctx, "node", "--experimental-strip-types", script, server.URL, host, run, fmt.Sprint(n))
		command.Env = append(os.Environ(), "SMITHERS_LEARNING_TEST_CREDENTIAL="+bearer)
		var stderr strings.Builder
		command.Stderr = &stderr
		extracted, err := command.Output()
		require.NoError(t, err, stderr.String())
		output := string(extracted)
		cp.Run = &flowruntime.Run{RunID: run, FlowID: "learning", Status: "completed", FinalOutput: &output}
		saved, _ = json.Marshal(cp)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, saved)
		require.NoError(t, err)
		update := flowdispatch.ProjectionUpdate{OperationID: admitted.OperationID, Scope: scope, State: jobs.StateCompleted, Checkpoint: cp}
		require.NoError(t, consumer.ProjectFlowRuntime(ctx, update))
		require.NoError(t, consumer.ProjectFlowRuntime(ctx, update))
		code, raw := call("GET", "/api/proposals", "")
		require.Equal(t, 200, code, string(raw))
		var cards []map[string]any
		require.NoError(t, json.Unmarshal(raw, &cards))
		lessons := 1
		if n == 2 || n == 4 {
			lessons = 0
		}
		if n < 5 {
			require.Empty(t, cards)
		} else {
			require.Len(t, cards, 1)
			require.Equal(t, "open", cards[0]["state"])
			if n == 5 {
				lessons = 2
				require.Equal(t, []any{"3 of the last 5 failed check:lint@review"}, cards[0]["evidence"])
				refs := cards[0]["refs"].([]any)
				require.Len(t, refs, 3)
				require.Equal(t, "T1", refs[0].(map[string]any)["label"])
				require.Equal(t, "T3", refs[1].(map[string]any)["label"])
				require.Equal(t, "T5", refs[2].(map[string]any)["label"])
				proposalID = cards[0]["id"].(string)
				require.NoError(t, pool.QueryRow(ctx, `SELECT provenance_json FROM memory_notes WHERE id=$1`, proposalID).Scan(&fifthNote))
				var note services.LearningProposalNote
				require.NoError(t, json.Unmarshal(fifthNote, &note))
				require.Equal(t, "check:lint@review", note.Signature)
				require.Contains(t, note.Diff, "--- a/flows/todo/flow.ts")
				require.Contains(t, note.Diff, "Require lint as a fast required check")
				require.Equal(t, []int64{1, 3, 5}, note.Todos)
			} else {
				var unchanged []byte
				require.NoError(t, pool.QueryRow(ctx, `SELECT provenance_json FROM memory_notes WHERE id=$1`, proposalID).Scan(&unchanged))
				require.JSONEq(t, string(fifthNote), string(unchanged), "an open signature is suppressed without rewriting its evidence")
			}
		}
		code, raw = call("GET", fmt.Sprintf("/api/todos/%d", n), "")
		require.Equal(t, 200, code, string(raw))
		var card map[string]any
		require.NoError(t, json.Unmarshal(raw, &card))
		require.Equal(t, "merged", card["state"])
		require.Equal(t, float64(lessons), card["lessons"])
	}
	code, raw := call("POST", "/api/proposals/"+proposalID+"/accept", "five-accept")
	require.Equal(t, 202, code, string(raw))
	code, raw = call("POST", "/api/proposals/"+proposalID+"/accept", "five-repeat")
	require.Equal(t, 202, code, string(raw))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 7, count)
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT issue_body FROM mythical_items WHERE repository_id=$1 AND number=7`, repo).Scan(&prompt))
	require.Contains(t, prompt, "3 of the last 5 failed check:lint@review")
	require.Contains(t, prompt, "--- a/flows/todo/flow.ts")
	require.Contains(t, prompt, "Require lint as a fast required check")
}
