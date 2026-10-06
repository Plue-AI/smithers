package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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

// Learning proposal actions through the composed install router, real auth,
// CSRF and migrated PostgreSQL. Notes stand in for the pending learning output;
// this proof does not qualify merge admission or isolated machine execution.
func TestLearningProposalsComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo))}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("placement-session"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	note := `{"signature":"check:lint@review","title":"Run lint","prompt":"Run lint before review","diff":"+pnpm lint","evidence":["3 of the last 5 failed lint at review"],"todos":[1,3,5],"repository":"maya/app","run":"learning-5"}`
	_, err = pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,text,tags_json,provenance_json,status,created_at_ms) VALUES('lint','flow',$1,'Run lint','[]',$2,'pending',1),('check:lint@review/%2F','flow',$1,'Run lint','[]',$2,'pending',2),('fail','flow',$1,'Run lint','[]',$2,'pending',4),('other','flow','learning:999','Run lint','[]',$2,'pending',3)`, fmt.Sprintf("learning:%d", repo), note)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	call := func(method, path, body, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "placement-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "placement-csrf"})
		req.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: "placement-session"})
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var result map[string]any
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &result), res.Body.String())
		return res.Code, result
	}
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='frozen' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	failedCode, failedBody := call("POST", "/api/proposals/fail/accept", "{}", "failed")
	require.Equal(t, 503, failedCode, failedBody)
	var noteStatus string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM memory_notes WHERE id='fail'`).Scan(&noteStatus))
	require.Equal(t, "pending", noteStatus)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	code, body := call("POST", "/api/proposals/lint/accept", "{}", "accept")
	require.Equal(t, 202, code, body)
	require.Equal(t, "accepted", body["state"])
	require.Equal(t, float64(1), body["todo"].(map[string]any)["n"])
	code, body = call("POST", "/api/proposals/lint/accept", "{}", "retry")
	require.Equal(t, 202, code, body)
	require.Equal(t, float64(1), body["todo"].(map[string]any)["n"])
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 1, count)
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT issue_body FROM mythical_items WHERE repository_id=$1`, repo).Scan(&prompt))
	require.Contains(t, prompt, "3 of the last 5 failed lint at review")
	require.Contains(t, prompt, "+pnpm lint")
	code, body = call("POST", "/api/proposals/check%3Alint%40review%2F%252F/dismiss", "{}", "dismiss")
	require.Equal(t, 202, code, body)
	require.Equal(t, "dismissed", body["state"])
	var dismissed int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT status_at_ms FROM memory_notes WHERE id='check:lint@review/%2F'`).Scan(&dismissed))
	code, body = call("POST", "/api/proposals/check%3Alint%40review%2F%252F/dismiss", "{}", "replay")
	require.Equal(t, 202, code, body)
	var replay int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT status_at_ms FROM memory_notes WHERE id='check:lint@review/%2F'`).Scan(&replay))
	require.Equal(t, dismissed, replay)
	code, body = call("POST", "/api/proposals/check%3Alint%40review%2F%252F/accept", "{}", "wrong")
	require.Equal(t, 409, code, body)
	code, body = call("POST", "/api/proposals/other/accept", "{}", "other")
	require.Equal(t, 404, code, body)
	source, refusal := (&liveTopics{todos: service}).resolve(ctx, "proposals", repo, "maya/app", owner.ID)
	require.Empty(t, refusal)
	payload, err := source.Build(ctx)
	require.NoError(t, err)
	var cards []map[string]any
	require.NoError(t, json.Unmarshal(payload, &cards))
	require.Len(t, cards, 3)
	for _, card := range cards {
		require.NotEqual(t, "other", card["id"])
	}
	get := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/proposals", nil)
	get.RemoteAddr = "127.0.0.1:51900"
	get.Header.Set("Origin", cfg.Server.PublicURL)
	get.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: "placement-session"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, get)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &cards))
	require.Len(t, cards, 3)

	// A note accidentally stored in this namespace must not carry another
	// repository's output into this install's TODO/context path.
	for _, bad := range []struct{ id, raw string }{
		{"wrong-repository", `{"repository":"other/app","run":"learning-5","signature":"check:lint@review","title":"Foreign","prompt":"Foreign prompt","evidence":["foreign"],"todos":[1]}`},
		{"missing-run", `{"repository":"maya/app","signature":"check:lint@review","title":"Unbound","prompt":"Unbound prompt","evidence":["unbound"],"todos":[1]}`},
		{"invalid-json", `[]`},
	} {
		_, err = pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,text,tags_json,provenance_json,status,created_at_ms) VALUES($1,'flow',$2,'Bad','[]',$3,'pending',5)`, bad.id, fmt.Sprintf("learning:%d", repo), bad.raw)
		require.NoError(t, err)
		for _, action := range []string{"accept", "dismiss"} {
			code, body = call("POST", "/api/proposals/"+bad.id+"/"+action, "{}", bad.id+action)
			require.Equal(t, 409, code, body)
			require.Equal(t, "proposal_invalid", body["code"])
		}
		require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM memory_notes WHERE id=$1`, bad.id).Scan(&noteStatus))
		require.Equal(t, "pending", noteStatus)
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 1, count)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, get)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &cards))
	require.Len(t, cards, 3, "invalid output must not hide valid proposals or be published")

	t.Run("transactional machine receipt", func(t *testing.T) {
		// Supplemental output-consumer proof: merge admission and machine
		// execution are not forged into an acceptance-check claim by this fixture.
		var itemID string
		require.NoError(t, pool.QueryRow(ctx, `UPDATE mythical_items SET state='landed',pr_state='merged',pr_number=41,pr_url='https://github.com/maya/app/pull/41',pr_merge_commit=repeat('c',40) WHERE repository_id=$1 AND number=1 RETURNING id::text`, repo).Scan(&itemID))
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
		target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "learning-machine-1", BindingKind: "learning", BindingID: itemID}
		pin := flowruntime.Pin{Flow: "learning", SourceCommit: strings.Repeat("c", 40), ExecutionDigest: strings.Repeat("d", 64)}
		launch, _ := json.Marshal(map[string]any{"target": target, "flowId": "learning", "payload": map[string]any{"todo": 1}, "pin": pin})
		admitted, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "learning:" + itemID, Payload: launch, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning:" + itemID})
		require.NoError(t, err)
		output := `{"repository":"maya/app","todo":1,"run":"learning-1","pages":[{"title":"Retry helper","body":"Use the existing retry helper because it already backs off. Change: https://github.com/maya/app/pull/41; commit cccccccccccccccccccccccccccccccccccccccc; attempt-1; attempt-2"}],"proposals":[{"signature":"check:test@verify","title":"Run tests","prompt":"Run tests before review","evidence":["1 of the last 1 failed tests"],"todos":[1]}]}`
		cp := flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, FlowID: "learning", RunID: "learning-1", ExecutionDigest: pin.ExecutionDigest, Identity: flowruntime.Identity{SourceRevision: pin.SourceCommit}, Run: &flowruntime.Run{RunID: "learning-1", FlowID: "learning", Status: "completed", FinalOutput: &output}}
		saved, _ := json.Marshal(cp)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, saved)
		require.NoError(t, err)
		content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: cfg.Server.PublicURL, SigningKey: []byte("learning-test-key-with-32-bytes!!")})
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, content.Close()) })
		wiki := services.NewWikiService(q, nil, services.WithWikiContent(content))
		runtime := services.NewLearningRuntime(service, wiki)
		update := flowdispatch.ProjectionUpdate{OperationID: admitted.OperationID, Scope: scope, State: jobs.StateCompleted, Checkpoint: cp}
		wrong := update
		wrong.Checkpoint.Target.WorkspaceID = "another-machine"
		require.ErrorIs(t, runtime.ProjectFlowRuntime(ctx, wrong), services.ErrLearningBinding)
		wrong = update
		wrong.Checkpoint.RunID = "another-run"
		require.ErrorIs(t, runtime.ProjectFlowRuntime(ctx, wrong), services.ErrLearningBinding)
		badOutput := strings.Replace(output, "https://github.com/maya/app/pull/41", "https://github.com/other/app/pull/41", 1)
		badUpdate := update
		badRun := *cp.Run
		badRun.FinalOutput = &badOutput
		badUpdate.Checkpoint.Run = &badRun
		badSaved, _ := json.Marshal(badUpdate.Checkpoint)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, badSaved)
		require.NoError(t, err)
		require.ErrorIs(t, runtime.ProjectFlowRuntime(ctx, badUpdate), services.ErrLearningBinding)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admitted.OperationID, saved)
		require.NoError(t, err)
		// Fail after page and note insertion, before the receipt commits.
		_, err = pool.Exec(ctx, `CREATE FUNCTION reject_learning_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lessons IS NOT NULL THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_learning_receipt BEFORE UPDATE ON mythical_items FOR EACH ROW EXECUTE FUNCTION reject_learning_receipt()`)
		require.NoError(t, err)
		require.ErrorContains(t, runtime.ProjectFlowRuntime(ctx, update), "injected receipt failure")
		var pages, notes int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1`, repo).Scan(&pages))
		require.Zero(t, pages)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM memory_notes WHERE namespace_id=$1 AND provenance_json::jsonb->>'signature'='check:test@verify'`, fmt.Sprintf("learning:%d", repo)).Scan(&notes))
		require.Zero(t, notes)
		_, err = pool.Exec(ctx, `DROP TRIGGER reject_learning_receipt ON mythical_items; DROP FUNCTION reject_learning_receipt()`)
		require.NoError(t, err)
		var facts int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='learning.receipt' AND data->>'itemId'=$1`, itemID).Scan(&facts))
		require.Zero(t, facts)
		// Several completion deliveries race the same immutable dispatch
		// receipt. Only one may create lessons, a wiki revision and a fact.
		var deliveries sync.WaitGroup
		results := make(chan error, 20)
		for range 20 {
			deliveries.Add(1)
			go func() {
				defer deliveries.Done()
				results <- runtime.ProjectFlowRuntime(ctx, update)
			}()
		}
		deliveries.Wait()
		close(results)
		for err := range results {
			require.NoError(t, err)
		}
		require.NoError(t, runtime.ProjectFlowRuntime(ctx, update))
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='learning.receipt' AND data->>'itemId'=$1`, itemID).Scan(&facts))
		require.Equal(t, 1, facts)
		var fact []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='learning.receipt' AND data->>'itemId'=$1`, itemID).Scan(&fact))
		require.Contains(t, string(fact), `"topics": ["todo:1", "home", "proposals"]`)

		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions WHERE repository_id=$1`, repo).Scan(&pages))
		require.Equal(t, 1, pages)
		var author []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT learning_author FROM wiki_page_revisions WHERE repository_id=$1`, repo).Scan(&author))
		require.JSONEq(t, `{"agent":"coding","run":"learning-1"}`, string(author))
		status, body := call("GET", "/api/todos/1", "", "read-receipt")
		require.Equal(t, 200, status, body)
		require.Equal(t, "merged", body["state"])
		require.Equal(t, float64(2), body["lessons"])
		receipt := body["lessons_receipt"].(map[string]any)
		require.Len(t, receipt["lessons"], 2)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, get)
		require.Equal(t, 200, response.Code, response.Body.String())
		var all []map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &all))
		require.Len(t, all, 4)
		source, refusal := (&liveTopics{todos: service, queries: q}).resolve(ctx, "todo:1", repo, "maya/app", owner.ID)
		require.Empty(t, refusal)
		raw, err := source.Build(ctx)
		require.NoError(t, err)
		require.Contains(t, string(raw), `"lessons":2`)
	})
	_, err = pool.Exec(ctx, `DELETE FROM self_host_owners`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	code, body = call("POST", "/api/proposals/lint/accept", "{}", "revoked")
	require.Equal(t, 403, code, body)
}
