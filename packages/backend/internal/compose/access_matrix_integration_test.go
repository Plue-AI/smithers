package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-ACC-02's persisted TODO path crosses the composed install router, stored
// credentials, real confirmation transactions and the real TODO consumer.
// No GitHub transport or machine is needed before the durable TODO is filed.
func TestAccessMatrixConfirmationDispatchComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	users := make([]db.User, 3)
	for i, name := range []string{"maya", "ben", "alice"} {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		users[i] = u
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	for key, value := range map[string]string{"github.repository": binding, "owner.access": binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-06T12:00:00Z"}`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, users[0].ID)
	require.NoError(t, err)
	sessions, tokens, hashes := make([]string, 3), make([]string, 3), make([]string, 3)
	for i, u := range users {
		role := "admin"
		if i == 2 {
			role = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, role)
		require.NoError(t, err)
		sessions[i] = u.Username + "-matrix-session"
		sum := sha256.Sum256([]byte(sessions[i]))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		tokens[i] = fmt.Sprintf("smithers_%040x", u.ID+900)
		sum = sha256.Sum256([]byte(tokens[i]))
		hashes[i] = hex.EncodeToString(sum[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: "matrix-codex", TokenHash: hashes[i], TokenLastEight: hashes[i][56:], Scopes: "write:repository,read:user,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
	}
	todos := services.NewMythicalService(pool, nil)
	confirmations := services.NewApprovalsService(q, services.WithConfirmationTodos(pool, todos))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: confirmations})
	call := func(i int, person bool, path, key, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest("POST", "http://example.com"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		req.Header.Set("Idempotency-Key", key)
		if person {
			req.AddCookie(&http.Cookie{Name: "session", Value: sessions[i]})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "matrix-csrf"})
			req.Header.Set("X-CSRF-Token", "matrix-csrf")
		} else {
			req.Header.Set("Authorization", "Bearer "+tokens[i])
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var result map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result), w.Body.String())
		return w.Code, result
	}
	count := func(table string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	for i := range users {
		key := "new-" + users[i].Username
		payload := `{"title":"Keep greeting","prompt":"Keep greeting","acceptance":[]}`
		status, result := call(i, false, "/api/todos", key, payload)
		require.Equal(t, 202, status, result)
		require.Equal(t, "pending", result["state"])
		id := result["confirmation"].(string)
		require.Equal(t, i, count("mythical_items"), "delegated requests must not create TODOs")
		status, repeated := call(i, false, "/api/todos", key, payload)
		require.Equal(t, 202, status, repeated)
		require.Equal(t, result, repeated)
		status, changed := call(i, false, "/api/todos", key, `{"title":"Other","prompt":"Other"}`)
		require.Equal(t, 409, status, changed)
		require.Equal(t, "idempotency_mismatch", changed["code"])
		status, refused := call(i, false, "/api/confirmations/"+id+"/approve", "press", "{}")
		require.Equal(t, 403, status, refused)
		status, approved := call(i, true, "/api/confirmations/"+id+"/approve", "press", "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, "approved", approved["state"])
		status, approved = call(i, true, "/api/confirmations/"+id+"/approve", "press", "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, i+1, count("mythical_items"))
		status, repeated = call(i, false, "/api/todos", key, payload)
		require.Equal(t, 202, status, repeated)
		require.Equal(t, "approved", repeated["state"])
		// A catalog-authorized full delegated member lifts a typed stop;
		// no later person-only helper may replace the bound retry decision.
		var n int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT max(number) FROM mythical_items`).Scan(&n))
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked', checks=jsonb_set(checks,'{fault}','{"class":"factory","tag":"defect"}'::jsonb) WHERE number=$1`, n)
		require.NoError(t, err)
		path := fmt.Sprintf("/api/todos/%d", n)
		status, retry := call(i, false, path, "retry-"+users[i].Username, `{"op":"retry","steer":"Use the shared helper"}`)
		require.Equal(t, 202, status, retry)
		require.Equal(t, "accepted", retry["state"])
		status, again := call(i, false, path, "retry-"+users[i].Username, `{"op":"retry","steer":"Use the shared helper"}`)
		require.Equal(t, 202, status, again)
		require.Equal(t, retry, again)
		var state string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE number=$1`, n).Scan(&state))
		require.Equal(t, "queued", state)

	}
	// The body-bound Make TODO command has its own catalog id. Its missing
	// snapshot consumer must not silently file an ordinary TODO instead.
	statusIssue, issueRefusal := call(2, false, "/api/todos", "from-issue", `{"title":"From issue","prompt":"Resolve issue","issue":23,"issue_digest":"`+strings.Repeat("a", 64)+`"}`)
	require.Equal(t, 503, statusIssue, issueRefusal)
	require.Equal(t, "confirmation_unavailable", issueRefusal["code"])
	require.Equal(t, 3, count("approvals"))
	for _, tc := range []struct {
		command  string
		statuses [3]int
		codes    [3]string
	}{
		{"members.write", [3]int{403, 403, 403}, [3]string{"never", "never", "permission"}},
		{"secrets.write", [3]int{403, 403, 403}, [3]string{"never", "never", "permission"}},
		{"settings.parallel", [3]int{403, 403, 403}, [3]string{"never", "permission", "permission"}},
		{"merge", [3]int{503, 503, 403}, [3]string{"confirmation_unavailable", "confirmation_unavailable", "permission"}},
		{"branch.bring-in", [3]int{403, 403, 403}, [3]string{"permission", "permission", "permission"}},
	} {
		for i := range users {
			status, result := call(i, false, "/api/confirmations", "refuse-"+tc.command, fmt.Sprintf(`{"command":%q}`, tc.command))
			require.Equal(t, tc.statuses[i], status, result)
			require.Equal(t, tc.codes[i], result["code"])
		}
	}
	// Issue filing consumes the same person-bound immutable read receipt as
	// direct Make TODO. This adapter performs no network IO for that receipt.
	todos.SetOrchestration(services.NewMythicalGitHub(q, nil, nil, nil), nil, nil)
	for i := range users {
		for _, number := range []int64{23, 24} {
			thread := services.InstallIssueThread{Issue: services.InstallIssue{Number: number, Title: "Keep issue context", Body: "Exact issue body", State: "open", HTMLURL: "https://github.com/maya/demo/issues/23"}}
			read, err := json.Marshal(map[string]any{"issue": number, "digest": strings.Repeat("a", 64), "thread": thread, "outsider": number == 23})
			require.NoError(t, err)
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: fmt.Sprintf("issue-read:%d", users[i].ID)}, uuid.NewString(), "issue.read", "completed", read)
			require.NoError(t, err)
			require.NoError(t, tx.Commit(ctx))
		}
	}
	payloadIssue := func(number int) string {
		return fmt.Sprintf(`{"title":"From issue","prompt":"Resolve issue","issue":%d,"issue_digest":"%s"}`, number, strings.Repeat("a", 64))
	}
	status, mismatched := call(1, false, "/api/confirmations", "issue-mismatch", fmt.Sprintf(`{"command":"todo.new","payload":%s}`, payloadIssue(23)))
	require.Equal(t, 400, status, mismatched)
	require.Equal(t, "invalid_confirmation", mismatched["code"])
	status, mismatched = call(1, false, "/api/confirmations", "missing-issue", `{"command":"todo.from-issue","payload":{"title":"No issue","prompt":"No issue"}}`)
	require.Equal(t, 400, status, mismatched)
	require.Equal(t, "invalid_confirmation", mismatched["code"])
	require.Equal(t, 3, count("approvals"))
	status, deniedIssue := call(2, false, "/api/todos", "outsider-alice", payloadIssue(23))
	require.Equal(t, 403, status, deniedIssue)
	require.Equal(t, "permission", deniedIssue["code"])
	require.Equal(t, 3, count("approvals"))
	status, unknownIssue := call(1, false, "/api/todos", "unknown-issue", payloadIssue(25))
	require.Equal(t, 409, status, unknownIssue)
	require.Equal(t, "issue_snapshot_unknown", unknownIssue["code"])
	for _, tc := range []struct {
		member, number int
		key            string
	}{{1, 23, "outsider-ben"}, {2, 24, "team-alice"}} {
		before := count("mythical_items")
		status, requested := call(tc.member, false, "/api/todos", tc.key, payloadIssue(tc.number))
		require.Equal(t, 202, status, requested)
		require.Equal(t, "pending", requested["state"])
		require.Equal(t, before, count("mythical_items"))
		id := requested["confirmation"].(string)
		status, replay := call(tc.member, false, "/api/todos", tc.key, payloadIssue(tc.number))
		require.Equal(t, 202, status, replay)
		require.Equal(t, requested, replay)
		status, changed := call(tc.member, false, "/api/todos", tc.key, strings.Replace(payloadIssue(tc.number), "Resolve issue", "Other prompt", 1))
		require.Equal(t, 409, status, changed)
		require.Equal(t, "idempotency_mismatch", changed["code"])
		status, wrong := call(0, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
		require.Equal(t, 403, status, wrong)
		if tc.number == 23 {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
			status, refused := call(tc.member, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
			require.Equal(t, 403, status, refused)
			require.Equal(t, before, count("mythical_items"))
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
		}
		status, approved := call(tc.member, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, "approved", approved["state"])
		status, approved = call(tc.member, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, before+1, count("mythical_items"))
		var source, digest, revisions string
		require.NoError(t, pool.QueryRow(ctx, `SELECT source,issue_digest,revisions::text FROM mythical_items WHERE issue_number=$1`, tc.number).Scan(&source, &digest, &revisions))
		require.Equal(t, "issue", source)
		require.Equal(t, strings.Repeat("a", 64), digest)
		require.Contains(t, revisions, `"reason": "from-issue"`)
		if tc.number == 23 {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
			status, refused := call(tc.member, false, "/api/todos", tc.key, payloadIssue(tc.number))
			require.Equal(t, 403, status, refused)
			require.Equal(t, "permission", refused["code"])
			require.NotContains(t, refused, "confirmation")
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
		}
	}
	// Revoke the exact credential after router admission, while its replay
	// waits on the stack lock. The bound decision cannot disclose its receipt.
	locked, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer locked.Rollback(ctx)
	_, err = locked.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repo.ID)
	require.NoError(t, err)
	type reply struct {
		status int
		body   map[string]any
	}
	done := make(chan reply, 1)
	go func() {
		status, body := call(1, false, "/api/todos/2", "retry-ben", `{"op":"retry","steer":"Use the shared helper"}`)
		done <- reply{status, body}
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objid=$1)`, repo.ID).Scan(&waiting)
		return err == nil && waiting
	}, 5*time.Second, 10*time.Millisecond)
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE token_hash=$1`, hashes[1])
	require.NoError(t, err)
	require.NoError(t, locked.Commit(ctx))
	select {
	case denied := <-done:
		require.Equal(t, 401, denied.status, denied.body)
		require.Equal(t, "unauthenticated", denied.body["code"])
		require.NotContains(t, denied.body, "attempt")
	case <-time.After(5 * time.Second):
		t.Fatal("revoked replay did not finish")
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes='write:repository,read:user,via:unlisted-tool' WHERE token_hash=$1`, hashes[0])
	require.NoError(t, err)
	status, unknown := call(0, false, "/api/todos", "unknown-actor", `{"title":"No new TODO","prompt":"No new TODO"}`)
	require.Equal(t, 403, status, unknown)
	require.Equal(t, "permission", unknown["code"])
	require.Equal(t, 5, count("approvals"))
	require.Equal(t, 5, count("mythical_items"))
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE token_hash=$1`, hashes[2])
	require.NoError(t, err)
	status, result := call(2, false, "/api/todos", "new-alice", `{"title":"Keep greeting","prompt":"Keep greeting","acceptance":[]}`)
	require.Equal(t, 401, status, result)
	require.Equal(t, "unauthenticated", result["code"])
	require.Equal(t, 5, count("approvals"))
	require.Equal(t, 5, count("mythical_items"))
}
