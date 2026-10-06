package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The guest's measured output is the only fixture. Authentication, storage,
// catalog projection and the install router are real; this is not a microVM receipt.
func TestInstallFlowCatalogShowsReservedDeclarationRefusal(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "flow-owner", LowerUsername: "flow-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES ($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES ($1,'app','app','main') RETURNING id`, owner.ID).Scan(&repo))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: json.RawMessage(`{"owner_login":"flow-owner","repository_name":"app"}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: json.RawMessage(`{"owner_login":"flow-owner","repository_name":"app","last_access_check_at":"2026-10-06T17:00:00Z"}`)}))
	cookie := "flow-reserved-owner-session"
	digest := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(digest[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 100, false)
	require.NoError(t, err)
	load, err := q.EnsureFlowLoad(ctx, repo)
	require.NoError(t, err)
	load.CommitID, load.LoadedCommit = strings.Repeat("a", 40), strings.Repeat("a", 40)
	load.Versions = json.RawMessage(`[{"name":"merge","path":"flows/merge/flow.ts","digest":"` + strings.Repeat("b", 64) + `","status":"failed","error":"flows/merge/flow.ts: reserved_name"},{"name":"custom","path":"flows/custom/flow.ts","digest":"` + strings.Repeat("c", 64) + `","status":"failed","error":"invalid type"}]`)
	load, err = q.SaveFlowLoad(ctx, load)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	router := buildRouterCompat(cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	read := func() []services.FlowCard {
		request := httptest.NewRequest(http.MethodGet, cfg.Server.PublicURL+"/api/flows", nil)
		request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, 200, response.Code, response.Body.String())
		var cards []services.FlowCard
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &cards))
		return cards
	}
	cards := read()
	var refused, custom, builtin bool
	for _, card := range cards {
		switch card.Name {
		case "merge":
			refused = true
			require.True(t, card.System)
			require.Equal(t, "flows/merge/flow.ts", card.Source.Path)
			require.Len(t, card.Versions, 1)
			require.Equal(t, "merged-failed", card.Versions[0].State)
			require.Equal(t, "reserved_name", card.Versions[0].Error)
			require.Empty(t, card.Versions[0].Steps)
		case "custom":
			custom = true
			require.False(t, card.System)
			require.Equal(t, "invalid type", card.Versions[0].Error)
		case "todo":
			builtin = true
			require.Equal(t, "active", card.Versions[0].State)
		}
	}
	require.True(t, refused)
	require.True(t, custom, "failed-only declarations must remain visible")
	require.True(t, builtin)
	_, err = services.ActiveFlowDigest(ctx, q, repo, "merge")
	require.ErrorContains(t, err, "install-owned")
	// Removing the declaration removes the refusal without changing the builtin.
	load.Versions = json.RawMessage(`[]`)
	load, err = q.SaveFlowLoad(ctx, load)
	require.NoError(t, err)
	for _, card := range read() {
		require.NotEqual(t, "merge", card.Name)
	}
}
