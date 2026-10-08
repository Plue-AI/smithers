package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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

// S1 policy is enforced by the install command authorizer, including routes
// whose browser policy bypasses command admission. No guest is needed to prove
// these host refusals; credential-file and uid-drop receipts need the mini.
func TestTerminalRootInputsValidated(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "fixture", LowerName: "fixture", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"fixture","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + fmt.Sprintf(`,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339)))}))
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "terminal", TargetBookmark: "scratch/ben/terminal", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	session, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: branch.ID, RepositoryID: repo.ID, UserID: owner.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	raw := "smithers_" + strings.Repeat("7", 40)
	sum := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(sum[:])
	scopes := fmt.Sprintf("read:repository,read:user,repo:%d,via:terminal,branch:%s,profile:terminal_s1,terminal-session:%s", repo.ID, branch.ID, session.ID)
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "terminal-root-input-fixture", TokenHash: hash, TokenLastEight: hash[56:], Scopes: scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: pool, user: &routes.UserHandler{ProfileService: services.NewUserService(q)}})
	for _, cell := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/api/user", "", 200},
		{"GET", "/api/members", "", 403},
		{"GET", "/api/secrets", "", 403},
		{"GET", "/api/install", "", 403},
		{"GET", "/api/user/emails", "", 403},
		{"GET", "/api/notifications", "", 403},
		{"GET", "/api/confirmations", "", 403},
		{"GET", "/api/user/tokens", "", 403},
		{"POST", "/api/terminals", `{"branch":"T1","owner":0,"uid":0}`, 403},
		{"POST", "/api/user/tokens", `{"name":"forged","scopes":["repo","user"]}`, 403},
		{"POST", "/api/todos", `{"title":"forged","prompt":"root","place":{"mode":"append"}}`, 403},
	} {
		t.Run(cell.method+cell.path, func(t *testing.T) {
			req := httptest.NewRequest(cell.method, cfg.Server.PublicURL+cell.path, strings.NewReader(cell.body))
			req.RemoteAddr = "127.0.0.1:1234"
			req.Header.Set("Authorization", "Bearer "+raw)
			req.Header.Set("Origin", cfg.Server.PublicURL)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Smithers-Actor", "person")
			req.Header.Set("Smithers-Profile", "full")
			req.Header.Set("Smithers-Branch", "main")
			req.Header.Set("Smithers-Via", "browser")
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			if cell.status == 403 {
				require.Contains(t, out.Body.String(), `"class":"permission"`)
			}
		})
	}
	var tokens, todos, confirmations int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&tokens))
	require.Equal(t, 1, tokens)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&todos))
	require.Zero(t, todos)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&confirmations))
	require.Zero(t, confirmations)
}
