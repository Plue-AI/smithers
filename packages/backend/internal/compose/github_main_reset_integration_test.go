package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This is refusal evidence through the real install router and persisted
// credentials. Successful reset activation still requires STK-04/STK-08.
func TestMainResetInstallOwnerOnlyAndMissingSerialization(t *testing.T) {
	ctx := t.Context()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	users := make([]db.User, 3)
	sessions := make([]string, 3)
	tokens := make([]string, 3)
	for i, name := range []string{"reset-owner", "reset-maintainer", "reset-member"} {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		users[i] = user
		sessions[i] = name + "-session"
		sum := sha256.Sum256([]byte(sessions[i]))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: name, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		tokens[i] = fmt.Sprintf("smithers_%040x", user.ID+9200)
		sum = sha256.Sum256([]byte(tokens[i]))
		hash := hex.EncodeToString(sum[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: "reset-codex", TokenHash: hash, TokenLastEight: hash[56:], Scopes: "write:repository,read:user,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	for i, user := range users {
		role := "admin"
		if i == 2 {
			role = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, user.ID, role)
		require.NoError(t, err)
	}
	binding := fmt.Sprintf(`{"owner_login":"reset-owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)}))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	main := services.NewGitHubMainPullService(q, nil, nil, nil)
	main.UseInstallPolicy()
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{GitHubSync: main})
	for i := range users {
		for _, person := range []bool{true, false} {
			t.Run(fmt.Sprintf("%d/person=%t", i, person), func(t *testing.T) {
				request := httptest.NewRequest("POST", "http://example.com/api/stack/attention/force-19", strings.NewReader(`{"old":"1111111111111111111111111111111111111111","new":"2222222222222222222222222222222222222222"}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Origin", "http://example.com")
				if person {
					request.AddCookie(&http.Cookie{Name: "session", Value: sessions[i]})
					request.Header.Set("X-CSRF-Token", "reset-csrf")
					request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "reset-csrf"})
				} else {
					request.Header.Set("Authorization", "Bearer "+tokens[i])
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if i == 0 && person {
					require.Equal(t, 503, response.Code, response.Body.String())
					require.Contains(t, response.Body.String(), `"code":"github_sync_unavailable"`)
				} else {
					require.Equal(t, 403, response.Code, response.Body.String())
					if i == 0 {
						require.Contains(t, response.Body.String(), `"code":"never"`)
					} else {
						require.Contains(t, response.Body.String(), `"code":"permission"`)
					}
				}
			})
		}
	}
	var requests int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_main_pulls`).Scan(&requests))
	require.Zero(t, requests, "refused resets do not queue a pull")
}
