package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Admission must not await repository transport. The real native host remains
// underneath; any attempt to fetch during the HTTP request is refused here.
type rebaseAdmissionHost struct {
	*repohost.Client
	touched atomic.Bool
}

func (h *rebaseAdmissionHost) InfoRefs(context.Context, string, string, string, io.Writer) (string, error) {
	h.touched.Store(true)
	return "", errors.New("repository transport held")
}

func TestBranchRebaseNowComposedAdmission(t *testing.T) {
	testBranchRebaseNowComposedAdmission(t, false)
}

func TestTodoRebaseSourceTransitionLiteralCases(t *testing.T) {
	testBranchRebaseNowComposedAdmission(t, true)
}

func testBranchRebaseNowComposedAdmission(t *testing.T, sources bool) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pin-owner", LowerUsername: "pin-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	access := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "running", Checks: []byte(fmt.Sprintf(`{"todo":true,"run_launched":true,"run_attached":true,"flowSource":"%s"}`, source))})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,flow_digest=$3,request_run_id='pinned-run',workspace_id='11111111-1111-4111-8111-111111111111',revisions='[{"text":"Original","acceptance":[],"reason":"create"}]',title='Pinned source' WHERE id=$1`, item.ID, owner.ID, digest)
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("pin-cookie"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'pin-owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Server.PublicURL, cfg.Server.AllowedOrigins = "selfhost", origin, []string{origin}
	storage := t.TempDir()
	local, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "rebase-test", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	require.NoError(t, local.Client().InitRepo(ctx, owner.Username, "app", "main", true))
	base, err := local.Client().GetBookmark(ctx, owner.Username, "app", "main")
	require.NoError(t, err)
	source = base.TargetCommitID
	git := func(args ...string) string {
		t.Helper()
		argv := append([]string{"-C", filepath.Join(storage, owner.Username, "app", ".jj", "repo", "store", "git"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"}, args...)
		out, err := exec.CommandContext(ctx, "git", argv...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	tree := git("rev-parse", source+"^{tree}")
	onto := git("commit-tree", tree, "-p", source, "-m", "Main moved")
	head := git("commit-tree", tree, "-p", source, "-m", "Candidate")
	git("update-ref", "refs/smithers/test/candidate", head)
	git("update-ref", "refs/smithers/test/onto", onto)
	git("update-ref", "refs/heads/main", onto)
	require.NoError(t, local.Client().ImportRefs(ctx, owner.Username, "app"))
	host := &rebaseAdmissionHost{Client: local.Client()}
	service := services.NewMythicalService(pool, host)
	service.SetLauncher(&conflictDoorProvider{})

	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',landed_main=$2 WHERE repository_id=$1`, repo.ID, source)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='integrating',reason='rebase_pending',stack_position=1,candidate_base=$2,candidate_head=$3,checks=checks || jsonb_build_object('branch','smithers/test','rebase',jsonb_build_object('onto',$4::text,'name','main')) WHERE id=$1`, item.ID, source, head, onto)
	require.NoError(t, err)
	callBody := func(key, body string) (int, map[string]any) {
		req, err := http.NewRequest("POST", origin+"/api/branches/smithers%2Ftest", strings.NewReader(body))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var data map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&data))
		return res.StatusCode, data
	}
	call := func(key string) (int, map[string]any) { return callBody(key, `{"rebase":true}`) }
	if sources {
		for _, c := range []struct {
			state, engine                        string
			launched, attached, paused, wait, pr bool
			status                               int
		}{
			{"queued", "queued", false, false, false, false, false, 409},
			{"starting", "integrating", true, false, false, false, false, 202},
			{"working", "integrating", true, true, false, false, false, 202},
			{"needs_you", "integrating", true, true, false, true, false, 202},
			{"paused", "integrating", true, true, true, false, false, 409},
			{"failed", "blocked", true, true, false, false, false, 409},
			{"in_review", "integrating", true, true, false, false, true, 202},
			{"merged", "landed", true, true, false, false, false, 409},
			{"dropped", "cancelled", true, true, false, false, false, 409},
		} {
			t.Run(c.state, func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached, "branch": "smithers/test", "rebase": map[string]any{"onto": onto, "name": "main"}}
				if c.wait {
					checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				pr := ""
				if c.pr {
					pr = "open"
				}
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_number=1,pr_state=$4,paused_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`, item.ID, c.engine, raw, pr, c.paused)
				require.NoError(t, err)
				before, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				read := func() map[string]any {
					req, err := http.NewRequest("GET", origin+"/api/todos/1", nil)
					require.NoError(t, err)
					req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
					res, err := http.DefaultClient.Do(req)
					require.NoError(t, err)
					defer res.Body.Close()
					require.Equal(t, 200, res.StatusCode)
					var card map[string]any
					require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
					return card
				}
				require.Equal(t, c.state, read()["state"])
				var facts int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.rebase-requested'`).Scan(&facts))
				code, data := call("literal-rebase-" + c.state)
				require.Equal(t, c.status, code, data)
				after, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				require.Equal(t, c.state, read()["state"])
				var n int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.rebase-requested'`).Scan(&n))
				if c.status != 202 {
					require.Equal(t, before, after)
					require.Equal(t, facts, n)
					return
				}
				require.Equal(t, facts+1, n)
				require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.rebase-requested' ORDER BY sequence DESC LIMIT 1`).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, c.state, fact["from"])
				require.Equal(t, c.state, fact["to"])
				require.Equal(t, map[string]any{"kind": "system", "id": "stack"}, fact["actor"])
				code, replay := call("literal-rebase-" + c.state)
				require.Equal(t, 202, code)
				require.Equal(t, data, replay)
				replayed, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replayed)
			})
		}
		return
	}
	// An event write failure rolls back the scheduling override and receipt.
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_rebase_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.rebase-requested' THEN RAISE EXCEPTION 'injected rebase fact failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_rebase_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_rebase_fact()`)
	require.NoError(t, err)
	code, data := call("rebase-press")
	require.Equal(t, 503, code, data)
	var pendingRequest []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'rebase'->'request' FROM mythical_items WHERE id=$1`, item.ID).Scan(&pendingRequest))
	require.Nil(t, pendingRequest)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_rebase_fact ON product_job_events; DROP FUNCTION refuse_rebase_fact()`)
	require.NoError(t, err)
	// The mirrored main has advanced while the stack fold receipt is old.
	for range 2 {
		code, data := call("rebase-press")
		require.Equal(t, 202, code, data)
		require.Equal(t, "accepted", data["state"])
		require.Equal(t, onto, data["onto"])
	}
	read := func(key, cookie string) (int, map[string]any) {
		req, err := http.NewRequest("GET", origin+"/api/todos/1?rebase_request="+key, nil)
		require.NoError(t, err)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		return res.StatusCode, body
	}
	status, observed := read("rebase-press", "pin-cookie")
	require.Equal(t, 200, status, observed)
	require.Equal(t, map[string]any{"onto": "main", "onto_revision": onto}, observed["rebase_pending"], "pending target binds the actual main commit, not its display label")
	require.Equal(t, map[string]any{"onto": onto, "state": "running"}, observed["rebase_execution"])
	// A persisted request observes only its exact rewrite, even when other
	// committed completion facts arrive before it. Exercise the public receipt
	// door against the real durable event store, not a mocked receipt provider.
	recordCompletion := func(principal, target string, generation int64, beforeAdmission bool) {
		t.Helper()
		require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			event, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: principal}, uuid.NewString(), "todo.rebased", "working",
				json.RawMessage(fmt.Sprintf(`{"onto":%q,"generation":%d}`, target, generation)))
			if err != nil {
				return err
			}
			if beforeAdmission {
				_, err = tx.Exec(ctx, `UPDATE product_job_events SET recorded_at='2020-01-01T00:00:00Z' WHERE event_id=$1`, event.EventID)
			}
			return err
		}))
	}
	for _, other := range []struct {
		name, principal, target string
		generation              int64
		beforeAdmission         bool
	}{
		{"another TODO", "todo:22222222-2222-4222-8222-222222222222", onto, 1, false},
		{"another target", "todo:" + uuid.UUID(item.ID.Bytes).String(), "another-main", 1, false},
		{"earlier generation", "todo:" + uuid.UUID(item.ID.Bytes).String(), onto, 0, false},
		{"later generation", "todo:" + uuid.UUID(item.ID.Bytes).String(), onto, 2, false},
		{"before admission", "todo:" + uuid.UUID(item.ID.Bytes).String(), onto, 1, true},
	} {
		t.Run("receipt ignores "+other.name, func(t *testing.T) {
			recordCompletion(other.principal, other.target, other.generation, other.beforeAdmission)
			status, observed := read("rebase-press", "pin-cookie")
			require.Equal(t, 200, status, observed)
			require.Equal(t, map[string]any{"onto": onto, "state": "running"}, observed["rebase_execution"])
		})
	}
	status, observed = read("unknown-key", "pin-cookie")
	require.Equal(t, 404, status, observed)
	otherHash := sha256.Sum256([]byte("other-owner-cookie"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'pin-owner',NOW()+interval '1 hour')`, hex.EncodeToString(otherHash[:]), owner.ID)
	require.NoError(t, err)
	status, observed = read("rebase-press", "other-owner-cookie")
	require.Equal(t, 404, status, observed, "even the same member's other credential cannot read a private request")
	status, observed = read("rebase-press", "")
	require.Equal(t, 401, status, observed)
	current, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, head, current.CandidateHead, "the request returns before execution")
	var checks map[string]any
	require.NoError(t, json.Unmarshal(current.Checks, &checks))
	request := checks["rebase"].(map[string]any)["request"].(map[string]any)
	require.Equal(t, head, request["head"])
	require.Equal(t, map[string]any{"person": "pin-owner"}, request["by"])
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.rebase-requested'`).Scan(&count))
	require.Equal(t, 1, count)
	var system, requester string
	require.NoError(t, pool.QueryRow(ctx, `SELECT data->'actor'->>'id', data->'by'->>'person' FROM product_job_events WHERE event_type='todo.rebase-requested' AND (data->>'n')::bigint=1`).Scan(&system, &requester))
	require.Equal(t, "stack", system)
	require.Equal(t, "pin-owner", requester)
	require.False(t, host.touched.Load(), "the press returned without waiting for Git")
	// Reload observes terminal execution failures from committed source facts,
	// rather than mistaking an accepted launch for successful execution. Each
	// refusal leaves the private admission receipt intact and schedules no work.
	for _, failure := range []struct{ name, update string }{
		{"conflict needs resolution", `reason='rebase_conflict_pending',checks=jsonb_set(checks,'{waits}','[{"id":"native-conflict","kind":"conflict","prompt":"Resolve","since":"2026-10-02T12:00:00Z"}]')`},
		{"item dropped", `state='cancelled'`},
		{"pending rewrite removed", `checks=checks-'rebase'`},
		{"rewrite has no completion fact", `checks=jsonb_set(checks,'{rebase,rebased}','true')`},
		{"candidate changed", `candidate_head='cccccccccccccccccccccccccccccccccccccccc'`},
	} {
		t.Run("receipt reports "+failure.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET `+failure.update+` WHERE id=$1`, item.ID)
			require.NoError(t, err)
			for range 2 {
				status, observed := read("rebase-press", "pin-cookie")
				require.Equal(t, 200, status, observed)
				require.Equal(t, map[string]any{"onto": onto, "state": "failed"}, observed["rebase_execution"])
			}
			var requests int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.rebase-requested'`).Scan(&requests))
			require.Equal(t, 1, requests, "observation never submits another rewrite")
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,reason=$3,checks=$4,candidate_head=$5 WHERE id=$1`, item.ID, current.State, current.Reason, current.Checks, current.CandidateHead)
			require.NoError(t, err)
			status, observed := read("rebase-press", "pin-cookie")
			require.Equal(t, 200, status, observed)
			require.Equal(t, map[string]any{"onto": onto, "state": "running"}, observed["rebase_execution"])
		})
	}
	// A new press cannot supersede a merge/publication fence.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op='{"kind":"push"}' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	code, data = call("new-press")
	require.Equal(t, 409, code, data)
	require.Equal(t, "merging", data["code"])
	// The original receipt still replays while the state advances.
	code, data = call("rebase-press")
	require.Equal(t, 202, code, data)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL,checks=jsonb_set(checks,'{rebase,onto}','"changed"') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	code, data = call("new-press")
	require.Equal(t, 409, code, data)
	require.Equal(t, "rebase_target_changed", data["code"])
	status, observed = read("rebase-press", "pin-cookie")
	require.Equal(t, 200, status, observed)
	require.Equal(t, map[string]any{"onto": onto, "state": "failed"}, observed["rebase_execution"])

	// Completion survives a changed current target and a fresh HTTP reader,
	// so a reloaded app can settle the original toast without another launch.
	recordCompletion("todo:"+uuid.UUID(item.ID.Bytes).String(), onto, 1, false)
	for range 2 {
		status, observed = read("rebase-press", "pin-cookie")
		require.Equal(t, 200, status, observed)
		require.Equal(t, map[string]any{"onto": onto, "state": "completed"}, observed["rebase_execution"])
	}
	status, observed = read("rebase-press", "other-owner-cookie")
	require.Equal(t, 404, status, observed)

	retained, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, TargetBookmark: "smithers/test", Status: "stopped"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: retained.ID, RepositoryID: repo.ID, ItemID: item.ID, Name: "TODO 1 coding"})
	require.NoError(t, err)
	// The fold receipt catches up before the independent Bring in scenario.
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, repo.ID, onto)
	require.NoError(t, err)
	// The same composed Branch door admits Bring in without waiting for Git.
	// The worker receives the displayed foreign SHA, not an unbound target.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id='',state='proposed',checks=jsonb_set(checks,'{foreignHead}',to_jsonb($2::text)) || jsonb_build_object('waits',jsonb_build_array(jsonb_build_object('id','foreign-1','kind','foreign_push','sha',$2::text,'since','2026-10-08T00:00:00Z','by',jsonb_build_object('kind','github','login','alice')))) WHERE id=$1`, item.ID, onto)
	require.NoError(t, err)
	body := fmt.Sprintf(`{"op":"bring-in","id":"foreign-1","revision":%q}`, onto)
	for range 2 {
		code, data = callBody("bring-in-press", body)
		require.Equal(t, 202, code, data)
	}
	current, err = q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, head, current.CandidateHead)
	require.NoError(t, json.Unmarshal(current.Checks, &checks))
	bring := checks["foreignBring"].(map[string]any)
	require.Equal(t, onto, bring["sha"])
	require.Equal(t, onto, bring["onto"])
	require.Equal(t, head, bring["request"].(map[string]any)["head"])
	require.Equal(t, map[string]any{"person": "pin-owner"}, bring["request"].(map[string]any)["by"])
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.foreign_bring-in'`).Scan(&count))
	require.Equal(t, 1, count)
	require.False(t, host.touched.Load())

}
