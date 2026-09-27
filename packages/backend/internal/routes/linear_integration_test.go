package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockRouteLinearQuerier struct {
	createLinearIntegrationFn       func(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error)
	getLinearIntegrationFn          func(ctx context.Context, id int64) (db.LinearIntegration, error)
	getLinearIntegrationByUserAndID func(ctx context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error)
	getLinearIntegrationByTeamIDFn  func(ctx context.Context, linearTeamID string) (db.LinearIntegration, error)
	listLinearIntegrationsByUserFn  func(ctx context.Context, userID int64) ([]db.LinearIntegration, error)
	listLinearIntegrationsByRepoFn  func(ctx context.Context, repoID int64) ([]db.LinearIntegration, error)
	listActiveLinearIntegrationsFn  func(ctx context.Context) ([]db.LinearIntegration, error)
	updateLinearIntegrationTokensFn func(ctx context.Context, arg db.UpdateLinearIntegrationTokensParams) error
	updateLinearIntegrationLastSync func(ctx context.Context, id int64) error
	updateLinearIntegrationActiveFn func(ctx context.Context, arg db.UpdateLinearIntegrationActiveParams) error
	deleteLinearIntegrationFn       func(ctx context.Context, arg db.DeleteLinearIntegrationParams) error
	createOAuthStateFn              func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error)
	consumeOAuthStateFn             func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error)
	createLinearOAuthSetupFn        func(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error)
	deleteLinearOAuthSetupsByUserFn func(ctx context.Context, userID int64) error
	getLinearOAuthSetupByUserFn     func(ctx context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error)
	consumeLinearOAuthSetupByUserFn func(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error)
	getRepoByIDFn                   func(ctx context.Context, id int64) (db.Repository, error)
	getRepoByOwnerAndLowerNameFn    func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	getUserByIDFn                   func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                    func(ctx context.Context, id int64) (db.Organization, error)
	listUserReposFn                 func(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error)
	listUserOrgsFn                  func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error)
	listOrgReposFn                  func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error)
	isOrgOwnerForRepoUserFn         func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionFn      func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionFn     func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

func (m *mockRouteLinearQuerier) CreateLinearIntegration(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
	return m.createLinearIntegrationFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) GetLinearIntegration(ctx context.Context, id int64) (db.LinearIntegration, error) {
	return m.getLinearIntegrationFn(ctx, id)
}

func (m *mockRouteLinearQuerier) GetLinearIntegrationByUserAndID(ctx context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
	return m.getLinearIntegrationByUserAndID(ctx, arg)
}

func (m *mockRouteLinearQuerier) GetLinearIntegrationByLinearTeamID(ctx context.Context, linearTeamID string) (db.LinearIntegration, error) {
	return m.getLinearIntegrationByTeamIDFn(ctx, linearTeamID)
}

func (m *mockRouteLinearQuerier) ListLinearIntegrationsByUser(ctx context.Context, userID int64) ([]db.LinearIntegration, error) {
	return m.listLinearIntegrationsByUserFn(ctx, userID)
}

func (m *mockRouteLinearQuerier) ListLinearIntegrationsByRepo(ctx context.Context, repoID int64) ([]db.LinearIntegration, error) {
	return m.listLinearIntegrationsByRepoFn(ctx, repoID)
}

func (m *mockRouteLinearQuerier) ListActiveLinearIntegrations(ctx context.Context) ([]db.LinearIntegration, error) {
	return m.listActiveLinearIntegrationsFn(ctx)
}

func (m *mockRouteLinearQuerier) UpdateLinearIntegrationTokens(ctx context.Context, arg db.UpdateLinearIntegrationTokensParams) error {
	return m.updateLinearIntegrationTokensFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) UpdateLinearIntegrationLastSync(ctx context.Context, id int64) error {
	return m.updateLinearIntegrationLastSync(ctx, id)
}

func (m *mockRouteLinearQuerier) UpdateLinearIntegrationActive(ctx context.Context, arg db.UpdateLinearIntegrationActiveParams) error {
	return m.updateLinearIntegrationActiveFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) DeleteLinearIntegration(ctx context.Context, arg db.DeleteLinearIntegrationParams) error {
	return m.deleteLinearIntegrationFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) CreateOAuthState(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
	return m.createOAuthStateFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) ConsumeOAuthState(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
	return m.consumeOAuthStateFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) CreateLinearOAuthSetup(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
	return m.createLinearOAuthSetupFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) DeleteLinearOAuthSetupsByUser(ctx context.Context, userID int64) error {
	if m.deleteLinearOAuthSetupsByUserFn == nil {
		return nil
	}
	return m.deleteLinearOAuthSetupsByUserFn(ctx, userID)
}

func (m *mockRouteLinearQuerier) GetLinearOAuthSetupByUser(ctx context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
	return m.getLinearOAuthSetupByUserFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) ConsumeLinearOAuthSetupByUser(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
	return m.consumeLinearOAuthSetupByUserFn(ctx, arg)
}

func (m *mockRouteLinearQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, nil
}

func (m *mockRouteLinearQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockRouteLinearQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id}, nil
}

func (m *mockRouteLinearQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{ID: id}, nil
}

func (m *mockRouteLinearQuerier) ListUserRepos(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
	if m.listUserReposFn != nil {
		return m.listUserReposFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockRouteLinearQuerier) ListUserOrgs(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
	if m.listUserOrgsFn != nil {
		return m.listUserOrgsFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockRouteLinearQuerier) ListOrgRepos(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
	if m.listOrgReposFn != nil {
		return m.listOrgReposFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockRouteLinearQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockRouteLinearQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionFn != nil {
		return m.getHighestTeamPermissionFn(ctx, arg)
	}
	return "", nil
}

func (m *mockRouteLinearQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionFn != nil {
		return m.getCollaboratorPermissionFn(ctx, arg)
	}
	return "", nil
}

type mockRouteLinearClient struct {
	exchangeCodeFn func(ctx context.Context, code string) (services.LinearTokenResult, error)
	fetchViewerFn  func(ctx context.Context, accessToken string) (services.LinearViewer, error)
	fetchTeamsFn   func(ctx context.Context, accessToken string) ([]services.LinearTeam, error)
}

func (m mockRouteLinearClient) AuthorizationURL(state string) string {
	return "https://linear.example/oauth?state=" + state
}
func (m mockRouteLinearClient) ExchangeCode(ctx context.Context, code string) (services.LinearTokenResult, error) {
	return m.exchangeCodeFn(ctx, code)
}
func (m mockRouteLinearClient) RefreshToken(ctx context.Context, refreshToken string) (services.LinearTokenResult, error) {
	return services.LinearTokenResult{}, nil
}
func (m mockRouteLinearClient) FetchViewer(ctx context.Context, accessToken string) (services.LinearViewer, error) {
	return m.fetchViewerFn(ctx, accessToken)
}
func (m mockRouteLinearClient) FetchTeams(ctx context.Context, accessToken string) ([]services.LinearTeam, error) {
	return m.fetchTeamsFn(ctx, accessToken)
}

func withUser(req *http.Request, user *db.User) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user}))
}

func TestLinearIntegrationHandler_GetLinearOAuthCallback_RedirectsWithOpaqueSetupHandle(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	var storedPayload []byte
	var storedSetupKey string

	queries := &mockRouteLinearQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			assert.Equal(t, "issued-state", arg.State)
			return 1, nil
		},
		deleteLinearOAuthSetupsByUserFn: func(ctx context.Context, userID int64) error {
			assert.Equal(t, int64(7), userID)
			return nil
		},
		createLinearOAuthSetupFn: func(ctx context.Context, arg db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
			storedPayload = append([]byte(nil), arg.PayloadEncrypted...)
			storedSetupKey = arg.SetupKey
			return db.LinearOauthSetup{
				SetupKey:         arg.SetupKey,
				UserID:           arg.UserID,
				PayloadEncrypted: arg.PayloadEncrypted,
				CreatedAt:        now,
				ExpiresAt:        arg.ExpiresAt,
			}, nil
		},
	}
	service := services.NewLinearIntegrationService(queries, mockRouteLinearClient{
		exchangeCodeFn: func(ctx context.Context, code string) (services.LinearTokenResult, error) {
			assert.Equal(t, "code-123", code)
			return services.LinearTokenResult{
				AccessToken:  "linear-access-secret",
				RefreshToken: "linear-refresh-secret",
				ExpiresAt:    now.Add(time.Hour),
			}, nil
		},
		fetchViewerFn: func(ctx context.Context, accessToken string) (services.LinearViewer, error) {
			assert.Equal(t, "linear-access-secret", accessToken)
			return services.LinearViewer{ID: "viewer-1", Name: "Alice", Email: "alice@example.com"}, nil
		},
		fetchTeamsFn: func(ctx context.Context, accessToken string) ([]services.LinearTeam, error) {
			assert.Equal(t, "linear-access-secret", accessToken)
			return []services.LinearTeam{{ID: "team-1", Name: "Platform", Key: "PLT"}}, nil
		},
	}, "test-session-secret")

	handler := &LinearIntegrationHandler{
		Service:    service,
		AuthConfig: NewLinearAuthConfig(true),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/linear/callback?code=code-123&state=issued-state", nil)
	req.AddCookie(&http.Cookie{Name: linearOAuthStateCookieName, Value: "browser-verifier"})
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.GetLinearOAuthCallback(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	location := rec.Header().Get("Location")
	assert.Equal(t, "/integrations/linear?setup="+storedSetupKey, location)
	assert.NotContains(t, location, "access_token")
	assert.NotContains(t, location, "refresh_token")
	assert.NotContains(t, location, "actor_email")
	assert.NotContains(t, location, "teams")
	assert.NotEmpty(t, storedSetupKey)
	assert.Contains(t, rec.Header().Get("Set-Cookie"), linearOAuthStateCookieName+"=")
	assert.NotEmpty(t, storedPayload)
	assert.NotContains(t, string(storedPayload), "linear-access-secret")
	assert.NotContains(t, string(storedPayload), "linear-refresh-secret")
}

func TestLinearIntegrationHandler_ConfigureLinearIntegration_ConsumesSetupKey(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	setupPayload := services.LinearOAuthCallbackResult{
		AccessToken:  "linear-access-secret",
		RefreshToken: "linear-refresh-secret",
		ExpiresAt:    now.Add(time.Hour),
		Viewer: services.LinearViewer{
			ID:    "viewer-1",
			Name:  "Alice",
			Email: "alice@example.com",
		},
		Teams: []services.LinearTeam{
			{ID: "team-1", Name: "Platform", Key: "PLT"},
		},
	}
	setupJSON, err := json.Marshal(setupPayload)
	require.NoError(t, err)
	encryptedSetup, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey("test-session-secret"), setupJSON)
	require.NoError(t, err)

	var createdArg db.CreateLinearIntegrationParams
	queries := &mockRouteLinearQuerier{
		consumeLinearOAuthSetupByUserFn: func(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			assert.Equal(t, "setup-opaque", arg.SetupKey)
			assert.Equal(t, int64(7), arg.UserID)
			return db.ConsumeLinearOAuthSetupByUserRow{
				SetupKey:         arg.SetupKey,
				UserID:           arg.UserID,
				PayloadEncrypted: encryptedSetup,
				CreatedAt:        now,
				ExpiresAt:        now.Add(10 * time.Minute),
				UsedAt:           pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
			}, nil
		},
		createLinearIntegrationFn: func(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			createdArg = arg
			return db.LinearIntegration{
				ID:               9,
				UserID:           arg.UserID,
				LinearTeamID:     arg.LinearTeamID,
				LinearTeamName:   arg.LinearTeamName,
				LinearTeamKey:    arg.LinearTeamKey,
				JjhubRepoID:      arg.JjhubRepoID,
				JjhubRepoOwner:   arg.JjhubRepoOwner,
				JjhubRepoName:    arg.JjhubRepoName,
				LinearActorID:    arg.LinearActorID,
				LinearActorName:  arg.LinearActorName,
				LinearActorEmail: arg.LinearActorEmail,
				IsActive:         true,
			}, nil
		},
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "will", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return db.Repository{
				ID:     42,
				UserID: pgtype.Int8{Int64: 7, Valid: true},
				Name:   "demo",
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			assert.Equal(t, int64(7), id)
			return db.User{ID: 7, Username: "will"}, nil
		},
	}
	service := services.NewLinearIntegrationService(queries, nil, "test-session-secret")

	handler := &LinearIntegrationHandler{
		Service: service,
		Repos:   queries,
	}

	body := []byte(`{"setup_key":"setup-opaque","linear_team_id":"team-1","repo":"will/demo"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/linear", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.ConfigureLinearIntegration(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, "team-1", createdArg.LinearTeamID)
	assert.Equal(t, "Platform", createdArg.LinearTeamName)
	assert.Equal(t, "PLT", createdArg.LinearTeamKey)
	assert.Equal(t, int64(42), createdArg.JjhubRepoID)
	assert.Equal(t, "will", createdArg.JjhubRepoOwner)
	assert.Equal(t, "demo", createdArg.JjhubRepoName)
	assert.Equal(t, "viewer-1", createdArg.LinearActorID)
	assert.Equal(t, "Alice", createdArg.LinearActorName)
	assert.Equal(t, "alice@example.com", createdArg.LinearActorEmail)
	assert.Contains(t, rec.Body.String(), `"linear_actor":{"id":"viewer-1","email":"alice@example.com","name":"Alice"}`)
	require.NotEmpty(t, createdArg.AccessTokenEncrypted)

	decryptedAccess, err := smitherscrypto.Decrypt(smitherscrypto.DeriveKey("test-session-secret"), createdArg.AccessTokenEncrypted)
	require.NoError(t, err)
	assert.Equal(t, "linear-access-secret", string(decryptedAccess))

	decryptedRefresh, err := smitherscrypto.Decrypt(smitherscrypto.DeriveKey("test-session-secret"), createdArg.RefreshTokenEncrypted)
	require.NoError(t, err)
	assert.Equal(t, "linear-refresh-secret", string(decryptedRefresh))
}

func TestLinearIntegrationHandler_ConfigureLinearIntegration_AllowsOrgOwnedRepoForAdminUser(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	setupPayload := services.LinearOAuthCallbackResult{
		AccessToken:  "linear-access-secret",
		RefreshToken: "linear-refresh-secret",
		ExpiresAt:    now.Add(time.Hour),
		Viewer: services.LinearViewer{
			ID:    "viewer-1",
			Name:  "Alice",
			Email: "alice@example.com",
		},
		Teams: []services.LinearTeam{
			{ID: "team-1", Name: "Platform", Key: "PLT"},
		},
	}
	setupJSON, err := json.Marshal(setupPayload)
	require.NoError(t, err)
	encryptedSetup, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey("test-session-secret"), setupJSON)
	require.NoError(t, err)

	queries := &mockRouteLinearQuerier{
		consumeLinearOAuthSetupByUserFn: func(ctx context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{
				SetupKey:         arg.SetupKey,
				UserID:           arg.UserID,
				PayloadEncrypted: encryptedSetup,
				CreatedAt:        now,
				ExpiresAt:        now.Add(10 * time.Minute),
				UsedAt:           pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
			}, nil
		},
		createLinearIntegrationFn: func(ctx context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			assert.Equal(t, int64(55), arg.JjhubRepoID)
			assert.Equal(t, "acme", arg.JjhubRepoOwner)
			assert.Equal(t, "demo", arg.JjhubRepoName)
			return db.LinearIntegration{
				ID:             9,
				UserID:         arg.UserID,
				LinearTeamID:   arg.LinearTeamID,
				LinearTeamName: arg.LinearTeamName,
				LinearTeamKey:  arg.LinearTeamKey,
				JjhubRepoID:    arg.JjhubRepoID,
				JjhubRepoOwner: arg.JjhubRepoOwner,
				JjhubRepoName:  arg.JjhubRepoName,
				LinearActorID:  arg.LinearActorID,
				IsActive:       true,
			}, nil
		},
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			assert.Equal(t, int64(55), id)
			return db.Repository{
				ID:    55,
				OrgID: pgtype.Int8{Int64: 99, Valid: true},
				Name:  "demo",
			}, nil
		},
		getOrgByIDFn: func(ctx context.Context, id int64) (db.Organization, error) {
			assert.Equal(t, int64(99), id)
			return db.Organization{ID: 99, Name: "acme"}, nil
		},
		isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			assert.Equal(t, int64(55), arg.RepositoryID)
			assert.Equal(t, int64(7), arg.UserID)
			return false, nil
		},
		getHighestTeamPermissionFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, int64(55), arg.RepositoryID)
			assert.Equal(t, int64(7), arg.UserID)
			return "admin", nil
		},
		getCollaboratorPermissionFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, int64(55), arg.RepositoryID)
			assert.Equal(t, int64(7), arg.UserID.Int64)
			return "", nil
		},
	}
	service := services.NewLinearIntegrationService(queries, nil, "test-session-secret")
	handler := &LinearIntegrationHandler{
		Service: service,
		Repos:   queries,
	}

	body := []byte(`{"setup_key":"setup-opaque","linear_team_id":"team-1","repo_owner":"acme","repo_name":"demo","repo_id":55}`)
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/linear", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.ConfigureLinearIntegration(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
}

func TestLinearIntegrationHandler_ListLinearRepositoryOptions_FiltersToAdminRepos(t *testing.T) {
	t.Parallel()

	queries := &mockRouteLinearQuerier{
		listUserReposFn: func(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
			assert.Equal(t, int64(7), arg.UserID.Int64)
			assert.Equal(t, int32(0), arg.PageOffset)
			return []db.Repository{
				{ID: 1, UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "personal", Description: "Personal repo"},
			}, nil
		},
		listUserOrgsFn: func(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
			assert.Equal(t, int64(7), arg.UserID)
			assert.Equal(t, int32(0), arg.PageOffset)
			return []db.Organization{
				{ID: 99, Name: "acme"},
			}, nil
		},
		listOrgReposFn: func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
			assert.Equal(t, int64(99), arg.OrgID.Int64)
			assert.Equal(t, int32(0), arg.PageOffset)
			return []db.Repository{
				{ID: 2, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "team-admin", Description: "Team admin repo"},
				{ID: 3, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "collab-admin", Description: "Collaborator admin repo"},
				{ID: 4, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "write-only", Description: "Should be filtered"},
			}, nil
		},
		isOrgOwnerForRepoUserFn: func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			switch arg.RepositoryID {
			case 2:
				return "admin", nil
			case 3:
				return "", nil
			case 4:
				return "write", nil
			default:
				return "", nil
			}
		},
		getCollaboratorPermissionFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			switch arg.RepositoryID {
			case 3:
				return "admin", nil
			default:
				return "", nil
			}
		},
	}
	handler := &LinearIntegrationHandler{Repos: queries}

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/linear/repositories", nil)
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.ListLinearRepositoryOptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var body []linearRepositoryOption
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 3)
	assert.Equal(t, []linearRepositoryOption{
		{ID: 3, Owner: "acme", Name: "collab-admin", Description: "Collaborator admin repo"},
		{ID: 2, Owner: "acme", Name: "team-admin", Description: "Team admin repo"},
		{ID: 1, Owner: "will", Name: "personal", Description: "Personal repo"},
	}, body)
}

func TestLinearIntegrationHandler_ConfigureLinearIntegration_RejectsRawTokens(t *testing.T) {
	t.Parallel()

	handler := &LinearIntegrationHandler{
		Service: services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, nil, "test-session-secret"),
	}

	// Attempt to configure with raw access_token and no setup_key — must be rejected.
	body := []byte(`{"access_token":"stolen-token","refresh_token":"stolen-refresh","linear_team_id":"team-1","repo_owner":"will","repo_name":"demo","repo_id":42}`)
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/linear", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.ConfigureLinearIntegration(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "setup_key is required")
}

func TestLinearIntegrationHandler_ConfigureLinearIntegration_RejectsEmptySetupKey(t *testing.T) {
	t.Parallel()

	handler := &LinearIntegrationHandler{
		Service: services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, nil, "test-session-secret"),
	}

	body := []byte(`{"setup_key":"","linear_team_id":"team-1","repo_owner":"will","repo_name":"demo","repo_id":42}`)
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/linear", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.ConfigureLinearIntegration(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "setup_key is required")
}

func TestLinearIntegrationHandler_ConfigureLinearIntegration_RejectsRawTokenEvenWithFields(t *testing.T) {
	t.Parallel()

	handler := &LinearIntegrationHandler{
		Service: services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, nil, "test-session-secret"),
	}

	// Even if someone sends all the old fields that used to be accepted, without
	// a valid setup_key, the handler must reject the request.
	body := []byte(`{
		"access_token":"stolen-token",
		"refresh_token":"stolen-refresh",
		"expires_at":"2026-04-01T00:00:00Z",
		"linear_actor_id":"actor-1",
		"linear_team_id":"team-1",
		"linear_team_name":"Platform",
		"linear_team_key":"PLT",
		"repo_owner":"will",
		"repo_name":"demo",
		"repo_id":42
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/linear", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withUser(req, &db.User{ID: 7, Username: "will", LowerUsername: "will", IsActive: true})
	rec := httptest.NewRecorder()

	handler.ConfigureLinearIntegration(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "setup_key is required")
}
