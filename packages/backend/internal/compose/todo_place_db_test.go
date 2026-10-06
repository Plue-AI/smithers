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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Placement through the install router, auth, CSRF, catalog dispatch and the
// canonical service, with migrated PostgreSQL. No worker or guest is launched.
func TestTodoPlacementComposedInstall(t *testing.T) {
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
	service := services.NewMythicalService(pool, nil)
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	bearerToken := ""
	call := func(method, path, body, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "placement-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "placement-csrf"})
		if bearerToken == "" {
			req.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: "placement-session"})
		} else {
			req.Header.Set("Authorization", "Bearer "+bearerToken)
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var result map[string]any
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &result), res.Body.String())
		return res.Code, result
	}
	order := func() []int64 {
		rows, err := pool.Query(ctx, `SELECT number FROM mythical_items WHERE repository_id=$1 AND state NOT IN ('landed','cancelled','rejected','declined') ORDER BY stack_position`, repo)
		require.NoError(t, err)
		defer rows.Close()
		result := []int64{}
		for rows.Next() {
			var n int64
			require.NoError(t, rows.Scan(&n))
			result = append(result, n)
		}
		require.NoError(t, rows.Err())
		return result
	}
	for _, title := range []string{"One", "Two", "Three"} {
		code, body := call("POST", "/api/todos", fmt.Sprintf(`{"title":%q,"prompt":"Add a line","place":{"mode":"append"}}`, title), title)
		require.Equal(t, 202, code, body)
	}
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, repo, strings.Repeat("a", 40))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposing',candidate_verified=true,candidate_base=CASE number WHEN 1 THEN $2 WHEN 2 THEN $3 ELSE $4 END,candidate_head=CASE number WHEN 1 THEN $3 WHEN 2 THEN $4 ELSE $5 END WHERE repository_id=$1`, repo, strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40), strings.Repeat("d", 40))
	require.NoError(t, err)
	code, body := call("POST", "/api/todos", `{"title":"Four","prompt":"Add another line","place":{"mode":"before","n":2}}`, "before")
	require.Equal(t, 202, code, body)
	require.Equal(t, []int64{1, 4, 2, 3}, order())
	second, err := q.GetMythicalItemByNumber(ctx, repo, 2)
	require.NoError(t, err)
	require.False(t, second.CandidateVerified)
	require.Equal(t, "rebase_pending", second.Reason)
	require.Equal(t, strings.Repeat("c", 40), second.CandidateHead)
	third, err := q.GetMythicalItemByNumber(ctx, repo, 3)
	require.NoError(t, err)
	require.False(t, third.CandidateVerified)
	require.Equal(t, "rebase_pending", third.Reason)

	code, body = call("POST", "/api/todos/3", `{"op":"move","direction":"up"}`, "move")
	require.Equal(t, 202, code, body)
	require.Equal(t, []int64{1, 4, 3, 2}, order())
	code, body = call("POST", "/api/todos/3", `{"op":"move","direction":"up"}`, "move")
	require.Equal(t, 202, code, body)
	require.Equal(t, []int64{1, 4, 3, 2}, order())
	code, body = call("POST", "/api/todos/1", `{"op":"move","direction":"up"}`, "first")
	require.Equal(t, 409, code, body)
	require.Equal(t, "conflict", body["code"])
	// Failed TODOs stay dependencies at their actual position even though
	// the legacy snapshot groups their rows after moving items.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked' WHERE repository_id=$1 AND number=4`, repo)
	require.NoError(t, err)
	first, err := q.GetMythicalItemByNumber(ctx, repo, 1)
	require.NoError(t, err)
	fourth, err := q.GetMythicalItemByNumber(ctx, repo, 4)
	require.NoError(t, err)
	code, body = call("GET", "/api/repos/maya/app/mythical", "", "")
	require.Equal(t, 200, code, body)
	foundDependencies := false
	for _, entry := range body["items"].([]any) {
		row := entry.(map[string]any)
		if row["number"] == float64(2) {
			require.Equal(t, []any{uuid.UUID(first.ID.Bytes).String(), uuid.UUID(fourth.ID.Bytes).String(), uuid.UUID(third.ID.Bytes).String()}, row["dependsOn"])
			foundDependencies = true
		}
	}
	require.True(t, foundDependencies)
	// A fenced target refuses both doors without shifting the order.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op='{"kind":"merge","target":"4","desired":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"intended"}' WHERE repository_id=$1 AND number=4`, repo)
	require.NoError(t, err)
	code, body = call("POST", "/api/todos/3", `{"op":"move","direction":"up"}`, "fenced-move")
	require.Equal(t, 409, code, body)
	require.Equal(t, "merging", body["code"])
	code, body = call("POST", "/api/todos", `{"title":"Five","prompt":"Add a line","place":{"mode":"before","n":4}}`, "fenced-before")
	require.Equal(t, 409, code, body)
	require.Equal(t, "merging", body["code"])
	require.Equal(t, []int64{1, 4, 3, 2}, order())
	code, body = call("POST", "/api/todos", `{"title":"Five","prompt":"Add a line","place":{"mode":"before","n":1}}`, "fenced-successor")
	require.Equal(t, 409, code, body)
	require.Equal(t, "merging", body["code"])
	// Storage itself rejects a duplicate even outside the command service.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET stack_position=1 WHERE repository_id=$1 AND number=2`, repo)
	require.Error(t, err)
	// Removing a predecessor cannot change the order under a merge fence.
	code, body = call("POST", "/api/todos/1", `{"op":"drop"}`, "fenced-drop")
	require.Equal(t, 409, code, body)
	require.Equal(t, "merging", body["code"])
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL WHERE repository_id=$1 AND number=4`, repo)
	require.NoError(t, err)
	// Drop uses the same ordering path and compacts its successors.
	code, body = call("POST", "/api/todos/1", `{"op":"drop"}`, "drop")
	require.Equal(t, 202, code, body)
	require.Equal(t, []int64{4, 3, 2}, order())
	var positions []int64
	rows, err := pool.Query(ctx, `SELECT stack_position FROM mythical_items WHERE repository_id=$1 AND state!='cancelled' ORDER BY stack_position`, repo)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var p int64
		require.NoError(t, rows.Scan(&p))
		positions = append(positions, p)
	}
	require.Equal(t, []int64{1, 2, 3}, positions)
	// Both HTTP presses read one revision before acquiring the placement lock.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repo)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	outcomes := make(chan int, 2)
	for _, key := range []string{"race-a", "race-b"} {
		go func() {
			code, _ := call("POST", "/api/todos/2", `{"op":"move","direction":"up"}`, key)
			outcomes <- code
		}()
	}
	require.Eventually(t, func() bool {
		var waiting int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`).Scan(&waiting)
		return err == nil && waiting == 2
	}, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, tx.Commit(ctx))
	codes := []int{<-outcomes, <-outcomes}
	require.ElementsMatch(t, []int{202, 409}, codes)
	require.Equal(t, []int64{4, 2, 3}, order())

	// Two presses commit Before once, taking the first slot. Distinct append
	// requests serialize into two distinct tail slots under the same lock.
	outcomes = make(chan int, 2)
	for range 2 {
		go func() {
			code, _ := call("POST", "/api/todos", `{"title":"Five","prompt":"Add a line","place":{"mode":"before","n":4}}`, "concurrent-before")
			outcomes <- code
		}()
	}
	require.Equal(t, 202, <-outcomes)
	require.Equal(t, 202, <-outcomes)
	require.Equal(t, []int64{5, 4, 2, 3}, order())
	for _, key := range []string{"append-a", "append-b"} {
		go func() {
			code, _ := call("POST", "/api/todos", `{"title":"Tail","prompt":"Add a line","place":{"mode":"append"}}`, key)
			outcomes <- code
		}()
	}
	require.Equal(t, 202, <-outcomes)
	require.Equal(t, 202, <-outcomes)
	require.Equal(t, []int64{5, 4, 2, 3, 6, 7}, order())

	// A full-scope delegated member moves immediately through the real
	// dispatcher and service, without acquiring confirmation authority.
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, member.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, member.ID)
	require.NoError(t, err)
	mint := func(raw, scopes string, system bool) string {
		digest := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: member.ID, Name: raw, TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: scopes, SystemIssued: system, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return raw
	}
	delegated := mint("smithers_"+strings.Repeat("e", 40), "write:repository,"+middleware.RepositoryRestrictionScope(repo)+",via:cli", true)
	bearerToken = delegated
	code, body = call("POST", "/api/todos/7", `{"op":"move","direction":"up"}`, "delegated-move")
	require.Equal(t, 202, code, body)
	require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())
	code, body = call("POST", "/api/todos/7", `{"op":"move","direction":"up"}`, "delegated-move")
	require.Equal(t, 202, code, body)
	require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())
	code, body = call("POST", "/api/todos", `{"title":"Delegated","prompt":"Add a line","place":{"mode":"before","n":7}}`, "delegated-create")
	require.Equal(t, 403, code, body)
	require.Equal(t, "confirm_in_app", body["code"])
	require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())
	code, body = call("POST", "/api/todos/7", `{"op":"drop"}`, "delegated-drop")
	require.Equal(t, 503, code, body)
	require.Equal(t, "infra", body["class"])
	require.Equal(t, "confirmation_unavailable", body["code"])
	require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())
	for _, credential := range []string{
		mint("smithers_"+strings.Repeat("f", 40), "read:repository,via:cli", true),
		mint("smithers_"+strings.Repeat("a", 40), "write:repository", true),
		mint("smithers_"+strings.Repeat("b", 40), "write:repository,via:cli,"+middleware.RepositoryRestrictionScope(repo+1), true),
		mint("smithers_"+strings.Repeat("c", 40), "write:repository,workspace:5a1b0000-0000-4000-8000-0000000000b1", true),
		mint("smithers_"+strings.Repeat("d", 40), "write:repository,via:cli,"+middleware.PathRestrictionScopes([]string{"src/**"})[0], true),
	} {
		bearerToken = credential
		var eventsBefore, eventsAfter int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&eventsBefore))
		code, body = call("POST", "/api/todos/7", `{"op":"move","direction":"up"}`, "denied-move")
		require.Equal(t, 403, code, "credential %s: %v", credential[len(credential)-8:], body)
		require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())
		for _, place := range []string{`{"mode":"append"}`, `{"mode":"before","n":7}`} {
			code, body = call("POST", "/api/todos", `{"title":"Denied","prompt":"Add a line","place":`+place+`}`, "denied-create-"+place)
			require.Equal(t, 403, code, body)
			require.Equal(t, "permission", body["class"])
		}
		require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&eventsAfter))
		require.Equal(t, eventsBefore, eventsAfter)
	}

	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo, member.ID)
	require.NoError(t, err)
	bearerToken = delegated
	code, body = call("POST", "/api/todos/7", `{"op":"move","direction":"up"}`, "suspended-move")
	require.Equal(t, 403, code, body)
	require.Equal(t, []int64{5, 4, 2, 3, 7, 6}, order())

}
