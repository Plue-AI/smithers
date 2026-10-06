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
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Production install composition and auth, real PostgreSQL; no stub review
// consumer or fabricated successful execution. Missing integrations allocate
// nothing and the old workspace invocation remains closed.
func TestInstallReviewHTTPAdmissionWithoutRuntime(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "review-owner", LowerUsername: "review-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"review-owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-06T10:00:00Z"}`)}))
	sum := sha256.Sum256([]byte("review-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	service := services.NewMythicalService(pool, nil)
	router := buildRouterCompat(
		cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Mythical: &routes.MythicalHandler{Service: service}},
	)
	for _, tc := range []struct {
		name, body, key string
		cookie          bool
		status          int
		code            string
	}{
		{"signed out", `{"number":50,"conversation":"ben"}`, "review", false, 401, "unauthenticated"},
		{"missing key", `{"number":50,"conversation":"ben"}`, "", true, 400, "invalid_review"},
		{"missing conversation", `{"number":50}`, "review", true, 400, "invalid_review"},
		{"invalid number", `{"number":0,"conversation":"ben"}`, "review", true, 400, "invalid_review"},
		{"caller pin refused", `{"number":50,"conversation":"ben","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, "review", true, 400, "invalid_review"},
		{"trailing JSON", `{"number":50,"conversation":"ben"}{}`, "review", true, 400, "invalid_review"},
		{"no GitHub", `{"number":50,"conversation":"ben"}`, "review", true, 503, "github_unavailable"},
		{"retry no GitHub", `{"number":50,"conversation":"ben"}`, "review", true, 503, "github_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(tc.body))
			req.RemoteAddr = "127.0.0.1:61000"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://localhost:4000")
			req.Header.Set("Idempotency-Key", tc.key)
			if tc.cookie {
				req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
				req.Header.Set("X-CSRF-Token", "review-csrf")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), `"code":"`+tc.code+`"`)
		})
	}
	var count int
	for _, table := range []string{"workspaces", "product_job_dispatches", "mythical_items"} {
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, table)
	}
}
