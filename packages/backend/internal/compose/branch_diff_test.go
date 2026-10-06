package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTODOBranchDiffInstallComposition(t *testing.T) {
	for _, mode := range []string{config.AuthModeSelfHosted, config.AuthModeMultitenant} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = mode
			served := map[string]servedRoute{}
			walkServedRoutes(t, openAPIConformanceRouter(cfg), served)
			for _, route := range []string{"get /api/branches/{b}/diff", "post /api/branches/{b}"} {
				_, mounted := served[route]
				require.Equal(t, mode == config.AuthModeSelfHosted, mounted, route)
			}
		})
	}
}

// Person-facing install router, live cookie authorization and real PostgreSQL.
// The persisted observation is seeded; native retention and GitHub transport
// are covered separately by the fetched consumer tests.
func TestForeignPushAnswersComposedInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pushowner", LowerUsername: "pushowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"pushowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, member.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	session := func(u db.User) string {
		cookie := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(cookie))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return cookie
	}
	ownerCookie, memberCookie := session(owner), session(member)
	head := strings.Repeat("a", 40)
	checks := fmt.Sprintf(`{"todo":true,"branch":"smithers/retry","foreignHead":"%s","fault":{"kind":"fixture"},"waits":[{"id":"question","kind":"question","prompt":"Keep?","since":"2026-10-05T08:00:00Z"},{"id":"foreign","kind":"foreign_push","sha":"%s","by":{"kind":"github","login":"Alice","color_index":7},"prompt":"Alice pushed","since":"2026-10-05T08:01:00Z"}]}`, head, head)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "blocked", Checks: []byte(checks)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=4,owner_id=$2,pr_number=4,pr_state='open',pr_head=$3,candidate_head=$4,candidate_verified=true,paused_at=now(),reason='retain failure' WHERE id=$1`, item.ID, owner.ID, strings.Repeat("b", 40), strings.Repeat("c", 40))
	require.NoError(t, err)
	before, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: unusedChatHost{}}))
	defer server.Close()
	call := func(cookie, body, key string, status int) string {
		req, err := http.NewRequest("POST", server.URL+"/api/branches/smithers%2Fretry", strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, status, res.StatusCode, string(raw))
		return string(raw)
	}
	body := fmt.Sprintf(`{"op":"discard-foreign","id":"foreign","revision":"%s"}`, head)
	require.Contains(t, call(memberCookie, body, "member", 403), `"class":"permission"`)
	require.Contains(t, call(ownerCookie, strings.Replace(body, head, strings.Repeat("d", 40), 1), "stale", 409), `"class":"conflict"`)
	call(ownerCookie, strings.Replace(body, `"foreign"`, `"question"`, 1), "wrong-wait", 409)
	call(ownerCookie, strings.Replace(body, "discard-foreign", "bring-in", 1), "bring", 503)
	call(ownerCookie, body, "", 400)
	untouched, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, before, untouched)
	call(ownerCookie, body, "discard", 202)
	after, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, head, after.PRHead)
	require.Equal(t, before.CandidateHead, after.CandidateHead)
	require.Equal(t, before.CandidateVerified, after.CandidateVerified)
	require.Equal(t, before.PausedAt, after.PausedAt)
	require.Equal(t, before.State, after.State)
	require.Equal(t, before.Reason, after.Reason)
	var stored struct {
		ForeignHead string
		Waits       []map[string]any
		Fault       map[string]any
	}
	require.NoError(t, json.Unmarshal(after.Checks, &stored))
	require.Empty(t, stored.ForeignHead)
	require.Len(t, stored.Waits, 2)
	require.Nil(t, stored.Waits[0]["settled_at"])
	require.Equal(t, "Alice", stored.Waits[1]["by"].(map[string]any)["login"])
	require.Equal(t, "pushowner", stored.Waits[1]["answered_by"])
	require.NotNil(t, stored.Fault)
	call(ownerCookie, body, "discard", 202)
	call(ownerCookie, body, "another-answer", 409)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
	require.Equal(t, 1, count)
	call(ownerCookie, strings.Replace(body, `"id":"foreign"`, `"id":"changed"`, 1), "discard", 409)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	call(ownerCookie, body, "discard", 202)
	call(ownerCookie, body, "after-merge", 409)
	// Literal C-STK-08 precedence cases through the install's served doors.
	// Only the foreign wait settles; the phase, pause and question survive.
	readCard := func() map[string]any {
		req, err := http.NewRequest("GET", server.URL+"/api/todos/4", nil)
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: ownerCookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var card map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
		require.Equal(t, 200, res.StatusCode, card)
		return card
	}
	cases := []struct {
		name, engine, after string
		paused, question    bool
	}{
		{"working", "running", "working", false, false},
		{"paused", "running", "paused", true, false},
		{"failed", "blocked", "failed", false, false},
		{"question", "running", "needs_you", false, true},
		{"paused-question", "running", "needs_you", true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var fixture map[string]any
			require.NoError(t, json.Unmarshal([]byte(checks), &fixture))
			fixture["run_launched"], fixture["run_attached"] = true, true
			if !c.question {
				fixture["waits"].([]any)[0].(map[string]any)["settled_at"] = "2026-10-05T09:00:00Z"
			}
			raw, err := json.Marshal(fixture)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='retained-run',
			 paused_at=CASE WHEN $4 THEN NOW() ELSE NULL END,pending_op=NULL,pr_state='open' WHERE id=$1`, item.ID, c.engine, raw, c.paused)
			require.NoError(t, err)
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, "needs_you", readCard()["state"])
			var prior int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&prior))
			call(ownerCookie, body, "discard-"+c.name, 202)
			require.Equal(t, c.after, readCard()["state"])
			after, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, before.State, after.State)
			require.Equal(t, before.PausedAt, after.PausedAt)
			require.Equal(t, before.RequestRunID, after.RequestRunID)
			require.Equal(t, before.CandidateHead, after.CandidateHead)
			var waits struct {
				Waits []struct {
					SettledAt *string `json:"settled_at"`
				} `json:"waits"`
			}
			require.NoError(t, json.Unmarshal(after.Checks, &waits))
			require.Len(t, waits.Waits, 2)
			require.NotNil(t, waits.Waits[1].SettledAt)
			require.Equal(t, !c.question, waits.Waits[0].SettledAt != nil)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
			require.Equal(t, prior+1, count)
			if c.name == "failed" {
				req, err := http.NewRequest("POST", server.URL+"/api/todos/4", strings.NewReader(`{"op":"retry"}`))
				require.NoError(t, err)
				req.Host = "127.0.0.1:4000"
				req.Header.Set("Origin", "http://127.0.0.1:4000")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", "csrf-fixture")
				req.Header.Set("Idempotency-Key", "retry-after-discard")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: ownerCookie})
				res, err := server.Client().Do(req)
				require.NoError(t, err)
				defer res.Body.Close()
				var receipt map[string]any
				require.NoError(t, json.NewDecoder(res.Body).Decode(&receipt))
				require.Equal(t, 202, res.StatusCode, receipt)
				require.EqualValues(t, 2, receipt["attempt"])
				require.Equal(t, "queued", readCard()["state"])
			}
		})
	}

}
