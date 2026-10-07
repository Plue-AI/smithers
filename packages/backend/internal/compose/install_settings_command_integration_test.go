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

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// PUT /api/install carries several owner settings. memberCommands binds the
// command the body names, and the handler's own authorization of that command
// reuses the decision. The Obsidian folder (C-J8-03) was bound as plain
// "settings", so InstallObsidianSettings.Set's "settings.obsidian" was refused
// as a substituted command: 403 "Not your confirmation" on every install.
func TestInstallSettingsBodyBindsItsCommandPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya", DisplayName: "maya"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	digest := sha256.Sum256([]byte("maya-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	for _, row := range []struct{ body, command string }{
		{`{"wiki_sync.obsidian":{"path":"/Users/maya/Vault"}}`, "settings.obsidian"},
		{`{"parallel":3}`, "settings.parallel"},
		{`{"capacity":4}`, "settings"},
	} {
		t.Run(row.command, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(authLoader(q, cfg.Auth))
			router.Use(memberCommands(q))
			var refusals []string
			router.Put("/api/install", func(w http.ResponseWriter, r *http.Request) {
				// The handler's command reuses the bound decision; any other
				// command is a substitution.
				for _, command := range []string{"settings", "settings.parallel", "settings.obsidian"} {
					if _, err := services.Authorize(r.Context(), nil, command); err != nil {
						refusals = append(refusals, command)
					}
				}
				w.WriteHeader(http.StatusOK)
			})
			request := httptest.NewRequest("PUT", "/api/install", strings.NewReader(row.body))
			request.AddCookie(&http.Cookie{Name: "session", Value: "maya-cookie"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var want []string
			for _, command := range []string{"settings", "settings.parallel", "settings.obsidian"} {
				if command != row.command {
					want = append(want, command)
				}
			}
			require.Equal(t, want, refusals)
		})
	}
}
