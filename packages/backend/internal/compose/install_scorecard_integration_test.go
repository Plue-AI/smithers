package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallScorecardOwnerReadsRealCreationReceipts(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('scorecard-owner','scorecard-owner') RETURNING id`).Scan(&owner))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner).Scan(&repo))
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"scorecard-owner","repository_name":"app","repository_id":%d}`, repo)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	person := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "scorecard-session"})
	service := services.NewMythicalService(pool, nil)
	input := services.MythicalTodoInput{Title: "One", Prompt: "Change README", Request: "scorecard-create"}
	_, err = service.FileTodo(person, repo, owner, input)
	require.NoError(t, err)
	_, err = service.FileTodo(person, repo, owner, input)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("scorecard-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner, Username: "scorecard-owner", SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{InstallScorecard: composeInstallScorecard(cfg, q, pool)})
	for _, signedIn := range []bool{false, true} {
		req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2020-01-01T23:30:00-07:00&to=2030-01-01T23:30:00-07:00", nil)
		req.RemoteAddr = "127.0.0.1:61000"
		if signedIn {
			req.AddCookie(&http.Cookie{Name: "session", Value: "scorecard-cookie"})
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if !signedIn {
			require.Equal(t, 401, w.Code)
			continue
		}
		require.Equal(t, 200, w.Code, w.Body.String())
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
		var out services.Scorecard
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		require.Equal(t, float64(1), out.Measures["accepted"].Value)
		require.Equal(t, float64(0), out.Measures["dropped"].Value)
		require.Equal(t, "between", out.Measures["accepted"].Verdict)
		require.Equal(t, "source_missing", out.Measures["merged"].Verdict)
		require.Equal(t, "source_missing", out.Measures["multiplayer"].Verdict)
		require.Equal(t, services.ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, out.PersonMinutes)
		require.Equal(t, "2020-01-02T06:30:00Z", out.Window.From.Format(time.RFC3339))
	}
	// The composed handler uses the shared person-only authorizer. Refuse
	// eligible delegated credentials with never; run and machine authority
	// cannot become owner-person authority.
	for _, tc := range []struct {
		name string
		info *middleware.AuthInfo
		code string
	}{
		{"delegated", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "via:claude-code"}, "never"},
		{"personal token", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true}, "never"},
		{"run", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true}, "permission"},
		{"machine", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "credential:sync"}, "permission"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seed := sha256.Sum256([]byte(tc.name))
			raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
			hash := sha256.Sum256([]byte(raw))
			token, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner, Name: tc.name, TokenHash: hex.EncodeToString(hash[:]), TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: tc.info.RawScopes, SystemIssued: tc.info.TokenSystemIssued, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			var before string
			require.NoError(t, pool.QueryRow(ctx, `SELECT row_to_json(t)::text FROM access_tokens t WHERE id=$1`, token.ID).Scan(&before))
			var auditsBefore int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&auditsBefore))
			req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z", nil)
			req.RemoteAddr = "127.0.0.1:61000"
			req.Header.Set("Authorization", "Bearer "+raw)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			require.Equal(t, 403, w.Code, w.Body.String())
			var refusal struct {
				Code  string `json:"code"`
				Class string `json:"class"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &refusal))
			require.Equal(t, tc.code, refusal.Code)
			require.Equal(t, tc.code, refusal.Class)
			var after string
			require.NoError(t, pool.QueryRow(ctx, `SELECT row_to_json(t)::text FROM access_tokens t WHERE id=$1`, token.ID).Scan(&after))
			require.Equal(t, before, after)
			var auditsAfter int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&auditsAfter))
			require.Equal(t, auditsBefore, auditsAfter)
		})
	}

	for _, permission := range []string{"write", "admin"} {
		t.Run(permission, func(t *testing.T) {
			var user int64
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, "scorecard-"+permission).Scan(&user))
			_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo, user, permission)
			require.NoError(t, err)
			raw := "scorecard-" + permission + "-cookie"
			hash := sha256.Sum256([]byte(raw))
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user, Username: "scorecard-" + permission, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z", nil)
			req.RemoteAddr = "127.0.0.1:61000"
			req.AddCookie(&http.Cookie{Name: "session", Value: raw})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			require.Equal(t, 403, w.Code, w.Body.String())
			var refusal struct {
				Code  string `json:"code"`
				Class string `json:"class"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &refusal))
			require.Equal(t, "permission", refusal.Code)
			require.Equal(t, "permission", refusal.Class)
		})
	}

}
