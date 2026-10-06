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
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The missing dispatcher/consumer cannot authorize execution. This is the
// storage, audience and missing-provider portion of C-ACC-02, not its merge
// or dispatch acceptance receipt.
func TestConfirmationsInstallBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo.ID))}))
	for _, u := range []db.User{owner, other} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, u.ID)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		raw := u.Username + "-confirmation-session"
		sum := sha256.Sum256([]byte(raw))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return raw
	}
	ownerCookie, otherCookie := session(owner), session(other)
	token := "smithers_" + strings.Repeat("c", 40)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "cli", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository,write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{"http://127.0.0.1:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, nil)
	call := func(method, path, cookie, bearer, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:4000"+path, strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:51900"
		r.Header.Set("Origin", "http://127.0.0.1:4000")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", key)
		r.Header.Set("X-CSRF-Token", "csrf")
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	seed := func(kind, command string, expired bool) string {
		id := uuid.NewString()
		expires := time.Now().Add(24 * time.Hour)
		if expired {
			expires = time.Now().Add(-time.Minute)
		}
		_, err := pool.Exec(ctx, `INSERT INTO approvals(id,repository_id,state,kind,title,member_id,credential_id,command,subject,revision,generation,reviewed_head_sha,payload,expires_at) VALUES($1,$2,'pending',$3,'Drop T1',$4,$5,$6,'{"kind":"todo","ref":"T1"}','revision-1',1,'h1','{"private":"reviewed-head-secret"}',$7)`, id, repo.ID, kind, owner.ID, hash, command, expires)
		require.NoError(t, err)
		return id
	}
	id := seed("one_click", "todo.drop", false)
	expired := seed("review_merge", "merge", true)
	// Listing another member's confirmations must not settle the owner's rows.
	w := call("GET", "/api/confirmations", otherCookie, "", "")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.JSONEq(t, `[]`, w.Body.String())
	var beforeList string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, expired).Scan(&beforeList))
	require.Equal(t, "pending", beforeList)
	w = call("GET", "/api/confirmations", ownerCookie, "", "")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "reviewed-head-secret")
	var fullRows []map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &fullRows))
	require.Len(t, fullRows, 2)
	for _, row := range fullRows {
		if row["id"] == expired {
			require.Equal(t, "expired", row["state"])
		} else {
			require.Equal(t, id, row["id"])
			require.Equal(t, "pending", row["state"])
		}
	}
	w = call("GET", "/api/confirmations", otherCookie, "", "")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.JSONEq(t, `[]`, w.Body.String())
	w = call("GET", "/api/confirmations", "", token, "")
	require.Equal(t, 200, w.Code, w.Body.String())
	var projection []map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &projection))
	require.Len(t, projection, 2)
	for _, row := range projection {
		require.Len(t, row, 2)
		if row["id"] == expired {
			require.Equal(t, "expired", row["state"])
		} else {
			require.Equal(t, id, row["id"])
			require.Equal(t, "pending", row["state"])
		}
	}
	for _, pair := range []struct{ cookie, bearer string }{{otherCookie, ""}, {"", token}, {ownerCookie, token}} {
		w = call("POST", "/api/confirmations/"+id+"/approve", pair.cookie, pair.bearer, "press")
		require.Equal(t, 403, w.Code, w.Body.String())
	}
	w = call("POST", "/api/confirmations/"+id+"/approve", ownerCookie, "", "press")
	require.Equal(t, 503, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"code":"confirmation_unavailable"`)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, id).Scan(&state))
	require.Equal(t, "pending", state)
	w = call("POST", "/api/confirmations/"+expired+"/approve", ownerCookie, "", "expire")
	require.Equal(t, 409, w.Code, w.Body.String())
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, expired).Scan(&state))
	require.Equal(t, "expired", state)
	w = call("POST", "/api/confirmations/"+id+"/deny", ownerCookie, "", "deny")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.JSONEq(t, fmt.Sprintf(`{"id":%q,"state":"rejected"}`, id), w.Body.String())
	w = call("POST", "/api/confirmations/"+id+"/deny", ownerCookie, "", "deny")
	require.Equal(t, 200, w.Code, w.Body.String())
	w = call("POST", "/api/confirmations/"+id+"/approve", ownerCookie, "", "deny")
	require.Equal(t, 409, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "idempotency_mismatch")
	w = call("POST", "/api/confirmations/"+id+"/approve", ownerCookie, "", "after-deny")
	require.Equal(t, 409, w.Code, w.Body.String())
	w = call("POST", "/api/confirmations", ownerCookie, "", "create")
	require.Equal(t, 403, w.Code, w.Body.String())
	w = call("POST", "/api/confirmations", "", token, "create")
	require.Equal(t, 503, w.Code, w.Body.String())
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&count))
	require.Equal(t, 2, count)
	legacy, err := q.ListApprovalsByRepo(ctx, db.ListApprovalsByRepoParams{RepositoryID: repo.ID, PageSize: 100})
	require.NoError(t, err)
	require.Empty(t, legacy)
	_, err = q.GetApproval(ctx, id)
	require.Error(t, err)
	// The store CAS must enforce the deadline too: a request can read a live
	// row and then wait until its deadline before committing the decision.
	// An elapsed row cannot acquire a rejection or consume a press key.
	for _, kind := range []string{"one_click", "review_merge"} {
		elapsed := seed(kind, "todo.drop", true)
		changed, err := q.DenyMemberConfirmation(ctx, elapsed, owner.ID, "deadline-session", "deadline-"+kind)
		require.NoError(t, err)
		require.False(t, changed)
		var decisionKey *string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state, decision_key FROM approvals WHERE id=$1`, elapsed).Scan(&state, &decisionKey))
		require.Equal(t, "pending", state)
		require.Nil(t, decisionKey)
		w = call("POST", "/api/confirmations/"+elapsed+"/deny", ownerCookie, "", "deadline-"+kind)
		require.Equal(t, 409, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), `"code":"confirmation_resolved"`)
		require.NoError(t, pool.QueryRow(ctx, `SELECT state, decision_key FROM approvals WHERE id=$1`, elapsed).Scan(&state, &decisionKey))
		require.Equal(t, "expired", state)
		require.Nil(t, decisionKey)
	}
	liveExpired := seed("one_click", "todo.drop", true)
	topics := &liveTopics{queries: q}
	source, status := topics.resolve(ctx, fmt.Sprintf("confirmations:%d", owner.ID), repo.ID, "maya/demo", owner.ID)
	require.Empty(t, status)
	payload, err := source.Build(ctx)
	require.NoError(t, err)
	require.Contains(t, string(payload), "reviewed-head-secret")
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, liveExpired).Scan(&state))
	require.Equal(t, "expired", state)
	// A read never revives a denied confirmation, even when its deadline passes.
	_, err = pool.Exec(ctx, `UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1`, id)
	require.NoError(t, err)
	_, err = source.Build(ctx)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, id).Scan(&state))
	require.Equal(t, "rejected", state)
	_, status = topics.resolve(ctx, fmt.Sprintf("confirmations:%d", owner.ID), repo.ID, "maya/demo", other.ID)
	require.Equal(t, live.Forbidden, status)
	_, status = topics.resolve(ctx, fmt.Sprintf("confirmations:%d:extra", owner.ID), repo.ID, "maya/demo", owner.ID)
	require.Equal(t, live.Forbidden, status)
	// A fresh bound-command role check precedes denial, even after listing.
	merge := seed("review_merge", "merge", false)
	_, err = pool.Exec(ctx, `DELETE FROM self_host_owners`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	w = call("POST", "/api/confirmations/"+merge+"/deny", ownerCookie, "", "downgraded")
	require.Equal(t, 403, w.Code, w.Body.String())
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, merge).Scan(&state))
	require.Equal(t, "pending", state)
}
