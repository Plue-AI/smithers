package services_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/stretchr/testify/require"
)

// Replaces the retired CLI/GitHub-issue creation loop with the install HTTP
// boundary. Authentication is injected at its middleware boundary; owner,
// repository binding, transactions, numbering and replay use real PostgreSQL.
func TestTodoInstallHTTPRealPostgres(t *testing.T) {
	ctx := context.Background()
	database := testdb.New(t)
	pool, err := postgresfixture.Open(ctx, database.URL, 0)
	require.NoError(t, err)
	defer pool.Close()
	require.NoError(t, product.Apply(ctx, pool))
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(9001,'owner','owner'),(9002,'other','other');
 INSERT INTO self_host_owners(singleton,user_id) VALUES(true,9001);
 INSERT INTO repositories(id,user_id,name,lower_name) VALUES(9001,9001,'repo','repo');
 INSERT INTO install_settings(key,value) VALUES('github.repository','{"owner_login":"owner","repository_name":"repo"}');
 INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES(9001,9001,'active');`)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	handler := &routes.TodoHandler{Queries: db.New(pool), Service: service}
	router := chi.NewRouter()
	router.Post("/api/todos", handler.Create)
	router.Get("/api/todos", handler.List)
	router.Get("/api/todos/{n}", handler.Get)
	request := func(method, path, body, key string, info *middleware.AuthInfo) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Idempotency-Key", key)
		r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), info))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	owner := &middleware.AuthInfo{User: &db.User{ID: 9001}, SessionHash: "owner-session"}
	// No credential is unauthenticated (spec §5.2.1); a credential that may
	// not file a TODO is permission.
	w := request("POST", "/api/todos", `{"title":"One","prompt":"Change README"}`, "key", nil)
	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
	require.JSONEq(t, `{"class":"permission","code":"unauthenticated","message":"Sign in"}`, w.Body.String())
	for _, info := range []*middleware.AuthInfo{{User: &db.User{ID: 9002}, SessionHash: "other-session"}, {User: &db.User{ID: 9001}, IsTokenAuth: true}, {User: &db.User{ID: 9001}, IsTokenAuth: true, TokenSystemIssued: true}} {
		w := request("POST", "/api/todos", `{"title":"One","prompt":"Change README"}`, "key", info)
		require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), `"class":"permission"`)
	}
	for _, body := range []string{`{}`, `{"title":"One","prompt":"Change README","extra":true}`, `{} {}`} {
		w := request("POST", "/api/todos", body, "key", owner)
		require.Equal(t, 400, w.Code, w.Body.String())
	}
	// The app's Draft sends place as {mode, n?} (packages/rpc/src/DraftCard.ts).
	body := `{"title":"One","prompt":"Change README","acceptance":[],"place":{"mode":"append"}}`
	w = request("POST", "/api/todos", body, "", owner)
	require.Equal(t, 400, w.Code)
	for place, message := range map[string]string{
		`{"mode":"before","n":1}`: "T-STK-02", `{"mode":"amend","n":1}`: "T-STK-02",
		`"append"`: "{mode, n?}", `{"mode":"append","n":1}`: "{mode, n?}", `{"mode":"sideways"}`: "{mode, n?}",
		`{}`: "{mode, n?}", `null`: "{mode, n?}", `{"mode":"append","extra":true}`: "{mode, n?}", `{"mode":"before","n":1.5}`: "{mode, n?}",
	} {
		w = request("POST", "/api/todos", `{"title":"One","prompt":"Change README","place":`+place+`}`, "place "+place, owner)
		require.Equal(t, 400, w.Code, place)
		require.Contains(t, w.Body.String(), `"code":"invalid_place"`, place)
		require.Contains(t, w.Body.String(), message, place)
	}
	w = request("POST", "/api/todos", body, "key", owner)
	require.Equal(t, 202, w.Code, w.Body.String())
	require.JSONEq(t, `{"state":"accepted","n":1,"rev":1}`, w.Body.String(), "a refused place consumes no number")
	w = request("POST", "/api/todos", body, "key", owner)
	require.Equal(t, 202, w.Code)
	require.JSONEq(t, `{"state":"accepted","n":1,"rev":1}`, w.Body.String())
	// An absent place appends, so it is the same request as the explicit append.
	w = request("POST", "/api/todos", `{"title":"One","prompt":"Change README","acceptance":[]}`, "key", owner)
	require.Equal(t, 202, w.Code, w.Body.String())
	require.JSONEq(t, `{"state":"accepted","n":1,"rev":1}`, w.Body.String())
	w = request("POST", "/api/todos", `{"title":"Other","prompt":"Other"}`, "key", owner)
	require.Equal(t, 409, w.Code)
	require.Contains(t, w.Body.String(), "idempotency_mismatch")
	w = request("GET", "/api/todos/1", "", "", owner)
	require.Equal(t, 200, w.Code, w.Body.String())
	var card map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &card))
	require.Equal(t, "queued", card["state"])
	require.Equal(t, "One", card["title"])
	require.NotContains(t, card, "branch")
	revisions := card["prompt_revisions"].([]any)
	require.Equal(t, "Change README", revisions[0].(map[string]any)["text"])
	w = request("GET", "/api/todos", "", "", owner)
	require.Equal(t, 200, w.Code)
	var cards []any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &cards))
	require.Len(t, cards, 1)
	w = request("GET", "/api/todos/2", "", "", owner)
	require.Equal(t, 404, w.Code)
	w = request("GET", "/api/todos/no", "", "", owner)
	require.Equal(t, 400, w.Code)

	t.Run("runtime evidence is atomic and attempt scoped", func(t *testing.T) {
		q := db.New(pool)
		item, err := q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		// Literal persisted attempt/candidate fixtures replace
		// a machine here. No guest or GitHub action is executed by this HTTP proof.
		// Each attempt pins (todo, source commit, digest); a launch of the
		// attempt carries that pin and its run names an execution identity.
		pinOne, pinTwo, source := strings.Repeat("f1", 32), strings.Repeat("f2", 32), strings.Repeat("c", 40)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=1,generation=1,state='verifying',candidate_head=$1,flow_digest=$3,checks=jsonb_set(checks,'{flowSource}',to_jsonb($4::text)) WHERE id=$2`,
			strings.Repeat("a", 40), item.ID, pinOne, source)
		require.NoError(t, err)
		current := pinOne
		project := func(attempt int, generation int, run string, state jobs.State, output *string) error {
			projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": item.ID, "attempt": attempt, "generation": generation, "phase": "verify",
				"flowDigest": current, "flowSource": source})
			return service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{
				FlowID: "coding/verify", ExecutionDigest: strings.Repeat("e", 64),
				Projection: projection, RunID: run, Run: &flowruntime.Run{RunID: run, FinalOutput: output}}})
		}
		readCard := func() map[string]any {
			w := request("GET", "/api/todos/1", "", "", owner)
			require.Equal(t, 200, w.Code, w.Body.String())
			var card map[string]any
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &card))
			return card
		}
		require.NoError(t, project(1, 1, "verify-one", jobs.StateRunning, nil))
		steps := readCard()["steps"].([]any)
		require.Len(t, steps, 1)
		require.Equal(t, map[string]any{"id": "verify", "label": "Verify", "state": "current"}, steps[0])
		output := fmt.Sprintf(`{"status":"passed","receipts":[{"checkId":"unit","tier":"fast","status":"passed","commitId":%q,"startedAt":1000,"finishedAt":3500}]}`, strings.Repeat("a", 40))
		// Concurrent redelivery commits exactly one terminal evidence update.
		var wg sync.WaitGroup
		errors := make(chan error, 20)
		for range 20 {
			wg.Add(1)
			go func() { defer wg.Done(); errors <- project(1, 1, "verify-one", jobs.StateCompleted, &output) }()
		}
		wg.Wait()
		close(errors)
		for err := range errors {
			require.NoError(t, err)
		}
		card := readCard()
		require.Equal(t, "working", card["state"])
		require.Equal(t, "done", card["steps"].([]any)[0].(map[string]any)["state"])
		evidence := card["evidence"].([]any)
		require.Len(t, evidence, 1)
		first, _ := json.Marshal(evidence[0])
		checks := evidence[0].(map[string]any)["items"].([]any)
		require.Equal(t, map[string]any{"kind": "check", "name": "unit", "state": "passed", "took_s": 2.5}, checks[0])
		require.Equal(t, map[string]any{"kind": "flow", "name": "todo", "version": pinOne}, checks[1])
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&count))
		require.Equal(t, 2, count, "running and completed, once each")
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		facts, err := store.Replay(ctx, jobs.Scope{TenantID: "9001", PrincipalID: "todo:" + item.ID.String()}, 0, 100)
		require.NoError(t, err)
		require.Len(t, facts.Events, 3)
		require.Equal(t, "todo.created", facts.Events[0].Type)
		require.Equal(t, "todo.run_updated", facts.Events[2].Type)
		require.Less(t, facts.Events[0].Sequence, facts.Events[1].Sequence)
		require.Less(t, facts.Events[1].Sequence, facts.Events[2].Sequence)
		var fact map[string]any
		require.NoError(t, json.Unmarshal(facts.Events[2].Data, &fact))
		require.Equal(t, float64(1), fact["attempt"])
		require.Equal(t, "verify", fact["phase"])
		require.Equal(t, "working", fact["from"])
		require.Equal(t, "working", fact["to"])
		require.Equal(t, map[string]any{"kind": "run", "id": "verify-one"}, fact["actor"])
		private, err := store.Replay(ctx, jobs.Scope{TenantID: "9001", PrincipalID: "unrelated"}, 0, 100)
		require.NoError(t, err)
		require.Empty(t, private.Events)
		// Stale attempts/generations, empty bindings and replacement runs are inert.
		before, err := q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		for _, stale := range []struct {
			attempt, generation int
			run                 string
		}{{0, 1, "verify-one"}, {2, 1, "verify-one"}, {1, 2, "verify-one"}, {1, 1, "other"}, {1, 1, ""}} {
			require.NoError(t, project(stale.attempt, stale.generation, stale.run, jobs.StateCompleted, &output))
		}
		after, err := q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		require.Equal(t, before, after)
		// Start attempt 2 at the fixture's launch boundary, preserving checks.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=2,generation=2,verify_run_id='',verify_outcome='',candidate_head=$1,flow_digest=$3,checks=checks-'receipts' WHERE id=$2`, strings.Repeat("b", 40), item.ID, pinTwo)
		require.NoError(t, err)
		current = pinTwo
		// Inject failure after the item/evidence save, before event insertion.
		_, err = pool.Exec(ctx, `CREATE FUNCTION reject_runtime_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END $$; CREATE TRIGGER reject_runtime_event BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_runtime_event();`)
		require.NoError(t, err)
		before, err = q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		require.ErrorContains(t, project(2, 2, "verify-two", jobs.StateRunning, nil), "injected event failure")
		after, err = q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		require.Equal(t, before, after, "item, evidence and event roll back together")
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.run_updated'`).Scan(&count))
		require.Equal(t, 2, count, "the fact request also rolls back")
		_, err = pool.Exec(ctx, `DROP TRIGGER reject_runtime_event ON product_job_events; DROP FUNCTION reject_runtime_event();`)
		require.NoError(t, err)
		require.NoError(t, project(2, 2, "verify-two", jobs.StateRunning, nil))
		output = strings.ReplaceAll(output, strings.Repeat("a", 40), strings.Repeat("b", 40))
		output = strings.ReplaceAll(output, `"passed"`, `"failed"`)
		require.NoError(t, project(2, 2, "verify-two", jobs.StateCompleted, &output))
		card = readCard()
		evidence = card["evidence"].([]any)
		require.Len(t, evidence, 2)
		retained, _ := json.Marshal(evidence[0])
		require.True(t, bytes.Equal(first, retained), "attempt 1 is byte-identical after attempt 2")
		require.Equal(t, "failed", card["steps"].([]any)[0].(map[string]any)["state"])
		// A prior attempt cannot alter either archive or current evidence.
		before, err = q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		require.NoError(t, project(1, 1, "verify-one", jobs.StateCompleted, &output))
		after, err = q.GetMythicalItemByNumber(ctx, 9001, 1)
		require.NoError(t, err)
		require.Equal(t, before, after)
		// Current GitHub facts, rather than a candidate or receipt, govern review.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='queued',pr_number=7,pr_url='https://github.com/owner/repo/pull/7',pr_head=$1,pr_state='open' WHERE id=$2`, strings.Repeat("b", 40), item.ID)
		require.NoError(t, err)
		card = readCard()
		require.Equal(t, "in_review", card["state"])
		require.Equal(t, "https://github.com/owner/repo/pull/7", card["pr"].(map[string]any)["url"])
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_state='closed' WHERE id=$1`, item.ID)
		require.NoError(t, err)
		require.Equal(t, "queued", readCard()["state"])
	})
}
