package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Literal expectations are committed here, independently of production code
// and spec/TSV files. Inputs are stored facts; assertions enter the same HTTP
// route that supplies the installed TODO card. No worker or guest is simulated.
type todoLiteralInstall struct {
	pool  *pgxpool.Pool
	q     *db.Queries
	item  db.MythicalItem
	owner int64
	call  func(*testing.T, string, string, string, ...string) (int, map[string]any)
}

func newTodoLiteralInstall(t *testing.T, configure ...func(*services.MythicalService, *pgxpool.Pool)) todoLiteralInstall {
	t.Helper()
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
	service := services.NewMythicalService(pool, nil, services.WithMythicalNow(func() time.Time { return time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC) }))
	for _, apply := range configure {
		apply(service, pool)
	}
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})

	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, State: "queued", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,title='Literal projection',stack_position=1 WHERE id=$1`, item.ID, owner.ID)
	require.NoError(t, err)

	call := func(t *testing.T, method, body, key string, suffix ...string) (int, map[string]any) {
		t.Helper()
		path := cfg.Server.PublicURL + "/api/todos/1"
		if len(suffix) > 0 {
			if strings.HasPrefix(suffix[0], "/") {
				path = cfg.Server.PublicURL + suffix[0]
			} else {
				path += "/" + suffix[0]
			}
		}
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: "placement-session"})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "literal-csrf"})
		req.Header.Set("X-CSRF-Token", "literal-csrf")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var card map[string]any
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &card), res.Body.String())
		return res.Code, card
	}
	return todoLiteralInstall{pool, q, item, owner.ID, call}
}

func TestTodoLiteralProjectionComposedInstall(t *testing.T) {
	h := newTodoLiteralInstall(t)
	ctx, pool, q, item := t.Context(), h.pool, h.q, h.item
	// Columns: idle, launched-not-attached, attached, open PR; within each,
	// no waits/question/branch/both, then those same four with paused_at.
	cases := []struct {
		engine   string
		expected [4][8]string
	}{
		{"queued", [4][8]string{
			{"queued", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"queued", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"in_review", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"skipped", [4][8]string{
			{"queued", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"queued", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"queued", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"queued", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"running", [4][8]string{
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"delivering", [4][8]string{
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"integrating", [4][8]string{
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"verifying", [4][8]string{
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"proposing", [4][8]string{
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"waiting", [4][8]string{
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"starting", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"working", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"retrying", [4][8]string{
			{"retrying", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"retrying", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"retrying", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"retrying", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"proposed", [4][8]string{
			{"in_review", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"in_review", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"in_review", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"in_review", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"landed", [4][8]string{
			{"merged", "merged", "merged", "merged", "merged", "merged", "merged", "merged"},
			{"merged", "merged", "merged", "merged", "merged", "merged", "merged", "merged"},
			{"merged", "merged", "merged", "merged", "merged", "merged", "merged", "merged"},
			{"merged", "merged", "merged", "merged", "merged", "merged", "merged", "merged"},
		}},
		{"blocked", [4][8]string{
			{"failed", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"failed", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"failed", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
			{"failed", "needs_you", "needs_you", "needs_you", "paused", "needs_you", "needs_you", "needs_you"},
		}},
		{"cancelled", [4][8]string{
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
		}},
		{"rejected", [4][8]string{
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
		}},
		{"declined", [4][8]string{
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
			{"dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "dropped"},
		}},
	}
	modes := []struct {
		name               string
		launched, attached bool
		pr                 string
	}{
		{"idle", false, false, ""}, {"launch", true, false, ""},
		{"attached", true, true, ""}, {"open-pr", false, false, "open"},
	}
	waits := []struct {
		name string
		rows []map[string]any
		ids  []string
	}{
		{"none", []map[string]any{}, []string{}},
		{"question", []map[string]any{{"id": "q", "kind": "question", "prompt": "Which?", "since": "2026-10-02T12:00:00Z"}}, []string{"q"}},
		{"branch", []map[string]any{{"id": "f", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:01Z"}}, []string{"f"}},
		{"both", []map[string]any{{"id": "q", "kind": "question", "prompt": "Which?", "since": "2026-10-02T12:00:00Z"}, {"id": "f", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:01Z"}}, []string{"f", "q"}},
	}
	count := 0
	for _, c := range cases {
		for m, mode := range modes {
			for p := 0; p < 2; p++ {
				for w, wait := range waits {
					t.Run(fmt.Sprintf("%s/%s/paused=%d/%s", c.engine, mode.name, p, wait.name), func(t *testing.T) {
						facts := map[string]any{"todo": true, "run_launched": mode.launched, "run_attached": mode.attached, "waits": wait.rows}
						if p == 1 {
							facts["pause"] = map[string]any{"requested": true, "at": "2026-10-02T12:00:00Z", "failure": "Resume failed", "failureOp": "resume"}
						}
						checks, err := json.Marshal(facts)
						require.NoError(t, err)
						_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_state=$4,paused_at=CASE WHEN $5 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, item.ID, c.engine, checks, mode.pr, p == 1)
						require.NoError(t, err)
						before, err := q.GetMythicalItem(ctx, item.ID)
						require.NoError(t, err)
						status, card := h.call(t, "GET", "", "")
						require.Equal(t, http.StatusOK, status, card)
						require.Equal(t, c.expected[m][p*4+w], card["state"])
						ids := []string{}
						for _, row := range card["waits"].([]any) {
							ids = append(ids, row.(map[string]any)["id"].(string))
						}
						if c.expected[m][p*4+w] == "merged" || c.expected[m][p*4+w] == "dropped" {
							require.Empty(t, ids, "terminal cards expose no waits")
							require.NotContains(t, card, "pause")
							require.NotContains(t, card, "stop")
							require.NotContains(t, card, "control_failure")
						} else {
							require.Equal(t, wait.ids, ids, "primary branch wait precedes the older question")
						}
						after, err := q.GetMythicalItem(ctx, item.ID)
						require.NoError(t, err)
						require.Equal(t, before, after, "card reads cannot change committed facts")
						count++
					})
				}
			}
		}
	}
	require.Equal(t, 480, count)
	t.Logf("literal composed projection inputs: %d", count)
	var events int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&events))
	require.Zero(t, events, "read-only projection publishes no lifecycle events")
}

// This full engine-state cross-product supplements the ten-source inventory with Drop through the installed HTTP command door,
// not Transition or a guard helper. A fixture has no executing pinned writer;
// stopped-writer final capture and guest cancellation have separate proofs.
func TestTodoDropEngineTransitionLiteralCases(t *testing.T) {
	h := newTodoLiteralInstall(t)
	ctx := t.Context()
	cases := []struct {
		engine string
		from   [3]string
		status int
	}{
		{"queued", [3]string{"queued", "paused", "needs_you"}, 202},
		{"skipped", [3]string{"queued", "paused", "needs_you"}, 202},
		{"running", [3]string{"working", "paused", "needs_you"}, 202},
		{"delivering", [3]string{"working", "paused", "needs_you"}, 202},
		{"integrating", [3]string{"working", "paused", "needs_you"}, 202},
		{"verifying", [3]string{"working", "paused", "needs_you"}, 202},
		{"proposing", [3]string{"working", "paused", "needs_you"}, 202},
		{"waiting", [3]string{"working", "paused", "needs_you"}, 202},
		{"retrying", [3]string{"retrying", "paused", "needs_you"}, 202},
		{"proposed", [3]string{"in_review", "paused", "needs_you"}, 202},
		{"blocked", [3]string{"failed", "paused", "needs_you"}, 202},
		{"landed", [3]string{"merged", "merged", "merged"}, 409},
		{"cancelled", [3]string{"dropped", "dropped", "dropped"}, 409},
		{"rejected", [3]string{"dropped", "dropped", "dropped"}, 409},
		{"declined", [3]string{"dropped", "dropped", "dropped"}, 409},
	}
	modes := []struct {
		name   string
		paused bool
		waits  []map[string]any
	}{
		{"plain", false, []map[string]any{}},
		{"paused", true, []map[string]any{}},
		{"question-and-branch", true, []map[string]any{
			{"id": "q", "kind": "question", "prompt": "Which?", "since": "2026-10-02T12:00:00Z"},
			{"id": "f", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:01Z"},
		}},
	}
	accepted, refused := 0, 0
	eventCount := func() int {
		t.Helper()
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&n))
		return n
	}
	for _, c := range cases {
		for m, mode := range modes {
			t.Run(c.engine+"/drop/"+mode.name, func(t *testing.T) {
				facts := map[string]any{"todo": true, "waits": mode.waits}
				if mode.paused {
					facts["pause"] = map[string]any{"requested": true, "at": "2026-10-02T12:00:00Z", "run": "old-run"}
				}
				checks, err := json.Marshal(facts)
				require.NoError(t, err)
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_state='',paused_at=CASE WHEN $4 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, checks, mode.paused)
				require.NoError(t, err)
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, c.from[m], card["state"])
				events := eventCount()
				key := "literal-" + c.engine + "-" + mode.name
				status, receipt := h.call(t, "POST", `{"op":"drop"}`, key)
				require.Equal(t, c.status, status, receipt)
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				if c.status == 409 {
					require.Equal(t, "todo_transition_refused", receipt["code"])
					require.Equal(t, c.from[m], receipt["from"])
					require.Equal(t, "drop", receipt["trigger"])
					require.Equal(t, before, after)
					require.Equal(t, events, eventCount())
					refused++
					return
				}
				require.Equal(t, "cancelled", after.State)
				require.False(t, after.PausedAt.Valid)
				var saved struct {
					Waits []struct {
						SettledAt *time.Time `json:"settled_at"`
					} `json:"waits"`
				}
				require.NoError(t, json.Unmarshal(after.Checks, &saved))
				require.Len(t, saved.Waits, len(mode.waits))
				for _, wait := range saved.Waits {
					require.NotNil(t, wait.SettledAt, "Drop settles each stored wait")
				}
				require.Equal(t, events+1, eventCount(), "one state change, one fact")
				var data []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.dropped' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, c.from[m], fact["from"])
				require.Equal(t, "dropped", fact["to"])
				require.Equal(t, map[string]any{"kind": "person", "id": float64(h.owner), "login": "maya"}, fact["actor"])
				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, "dropped", card["state"])
				require.NotContains(t, card, "pause")
				require.NotContains(t, card, "stop")
				var settled map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(after.Checks, &settled))
				require.NotContains(t, settled, "pause")
				require.Empty(t, card["waits"])
				replayStatus, replay := h.call(t, "POST", `{"op":"drop"}`, key)
				require.Equal(t, 202, replayStatus, replay)
				require.Equal(t, receipt, replay)
				require.Equal(t, events+1, eventCount(), "duplicate input adds no fact")
				status, refusal := h.call(t, "POST", `{"op":"drop"}`, key+"-again")
				require.Equal(t, 409, status, refusal)
				require.Equal(t, "todo_transition_refused", refusal["code"])
				require.Equal(t, "dropped", refusal["from"])
				require.Equal(t, events+1, eventCount())
				accepted++
			})
		}
	}
	require.Equal(t, 33, accepted)
	require.Equal(t, 12, refused)
	t.Logf("literal Drop cases: %d accepted, %d refused; other trigger matrices remain separate", accepted, refused)
}

// Retry reads failure facts, even when a pause or independent branch wait
// masks Failed. The public command must not reuse the broader engine helper's
// historical rejected/declined retry permissions for a dropped TODO.
func TestTodoRetryTransitionLiteralCases(t *testing.T) {
	testTodoRetrySourceMatrix(t, "retry")
}

func TestTodoRetryCurrentFlowTransitionLiteralCases(t *testing.T) {
	testTodoRetrySourceMatrix(t, "retry-current-flow")
}

func testTodoRetrySourceMatrix(t *testing.T, op string) {
	activeReads := 0
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, pool *pgxpool.Pool) {
		s.SetTodoFlow(func(ctx context.Context, repository int64, source string) (string, error) {
			activeReads++
			return services.ActiveFlowDigest(ctx, db.New(pool), repository, "todo")
		})
	})
	activeSource, activeDigest := strings.Repeat("d", 40), strings.Repeat("e", 64)
	_, err := h.pool.Exec(t.Context(), `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,$2,$3,'loaded')`, h.item.RepositoryID, activeSource, activeDigest)
	require.NoError(t, err)
	body := fmt.Sprintf(`{"op":%q}`, op)
	ctx := t.Context()
	cases := []struct {
		engine string
		from   [4]string
		status int
	}{
		{"queued", [4]string{"queued", "paused", "needs_you", "starting"}, 409},
		{"skipped", [4]string{"queued", "paused", "needs_you", "queued"}, 409},
		{"running", [4]string{"working", "paused", "needs_you", "starting"}, 409},
		{"delivering", [4]string{"working", "paused", "needs_you", "starting"}, 409},
		{"integrating", [4]string{"working", "paused", "needs_you", "starting"}, 409},
		{"verifying", [4]string{"working", "paused", "needs_you", "starting"}, 409},
		{"proposing", [4]string{"working", "paused", "needs_you", "starting"}, 409},
		{"waiting", [4]string{"working", "paused", "needs_you", "starting"}, 409},
		{"retrying", [4]string{"retrying", "paused", "needs_you", "retrying"}, 409},
		{"proposed", [4]string{"in_review", "paused", "needs_you", "in_review"}, 409},
		{"blocked", [4]string{"failed", "paused", "needs_you", "failed"}, 202},
		{"landed", [4]string{"merged", "merged", "merged", "merged"}, 409},
		{"cancelled", [4]string{"dropped", "dropped", "dropped", "dropped"}, 409},
		{"rejected", [4]string{"dropped", "dropped", "dropped", "dropped"}, 409},
		{"declined", [4]string{"dropped", "dropped", "dropped", "dropped"}, 409},
	}
	modes := []struct {
		name   string
		paused bool
		waits  []map[string]any
		after  string
	}{
		{"plain", false, []map[string]any{}, "queued"},
		{"paused", true, []map[string]any{}, "queued"},
		{"branch-wait", true, []map[string]any{{"id": "f", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:01Z"}}, "needs_you"},
		{"unattached", false, []map[string]any{}, "queued"},
	}
	eventCount := func() int {
		t.Helper()
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&n))
		return n
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		for m, mode := range modes {
			t.Run(c.engine+"/"+op+"/"+mode.name, func(t *testing.T) {
				retained := []map[string]any{{"attempt": 1, "revision": "old-head", "items": []any{}, "run_id": "old-run", "outcome": "failed"}}
				checks, err := json.Marshal(map[string]any{"todo": true, "waits": mode.waits, "attempts": retained, "run_launched": mode.name == "unattached", "run_attached": false})
				require.NoError(t, err)
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,pr_state='',paused_at=CASE WHEN $4 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, checks, mode.paused)
				require.NoError(t, err)
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, c.from[m], card["state"])
				events := eventCount()
				reads := activeReads
				key := "literal-" + op + "-" + c.engine + "-" + mode.name
				status, receipt := h.call(t, "POST", body, key)
				require.Equal(t, c.status, status, receipt)
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				if c.status == 409 {
					require.Equal(t, "todo_transition_refused", receipt["code"])
					require.Equal(t, c.from[m], receipt["from"])
					require.Equal(t, op, receipt["trigger"])
					require.Equal(t, before, after)
					require.Equal(t, events, eventCount())
					require.Equal(t, reads, activeReads, "refusal must precede Active resolution")
					refused++
					return
				}
				require.Equal(t, reads+boolQuestionInt(op == "retry-current-flow"), activeReads)
				require.Equal(t, "queued", after.State)
				require.False(t, after.PausedAt.Valid)
				require.EqualValues(t, 1, after.Attempt, "admission, rather than the request, advances the attempt")
				require.Equal(t, float64(2), receipt["attempt"])
				var saved, original map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(after.Checks, &saved))
				require.NoError(t, json.Unmarshal(before.Checks, &original))
				require.JSONEq(t, string(original["attempts"]), string(saved["attempts"]), "Retry preserves the ended attempt")
				var retries []struct {
					Pin *struct {
						Source string `json:"sourceCommit"`
						Digest string `json:"executionDigest"`
					} `json:"pin"`
				}
				require.NoError(t, json.Unmarshal(saved["retries"], &retries))
				require.Len(t, retries, 1)
				if op == "retry-current-flow" {
					require.NotNil(t, retries[0].Pin)
					require.Equal(t, activeSource, retries[0].Pin.Source)
					require.Equal(t, activeDigest, retries[0].Pin.Digest)
				} else {
					require.Nil(t, retries[0].Pin)
				}
				if len(mode.waits) > 0 {
					require.JSONEq(t, string(original["waits"]), string(saved["waits"]), "Retry settles no independent branch wait")
				} else {
					var waits []json.RawMessage
					if len(saved["waits"]) > 0 {
						require.NoError(t, json.Unmarshal(saved["waits"], &waits))
					}
					require.Empty(t, waits)
				}
				require.Equal(t, events+1, eventCount())
				var data []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.retried' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, c.from[m], fact["from"])
				require.Equal(t, mode.after, fact["to"])
				actor := fact["actor"].(map[string]any)
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "maya", actor["login"])
				require.Equal(t, "maya", actor["name"])
				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, mode.after, card["state"])
				replayStatus, replay := h.call(t, "POST", body, key)
				require.Equal(t, 202, replayStatus, replay)
				require.Equal(t, receipt, replay)
				require.Equal(t, events+1, eventCount())
				status, refusal := h.call(t, "POST", body, key+"-again")
				require.Equal(t, 409, status, refusal)
				require.Equal(t, "todo_transition_refused", refusal["code"])
				require.Equal(t, mode.after, refusal["from"])
				require.Equal(t, events+1, eventCount())
				require.Equal(t, reads+boolQuestionInt(op == "retry-current-flow"), activeReads, "replay and second request do not resolve Active")
				accepted++
			})
		}
	}
	require.Equal(t, 4, accepted)
	require.Equal(t, 56, refused)
	t.Logf("literal Retry cases: %d accepted, %d refused", accepted, refused)
}
