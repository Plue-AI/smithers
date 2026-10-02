package services

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestOAuth2_Cov_AuthorizeExchangeRefreshAndRevokeWithDB(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	user := oauth2CovSeedUser(t, ctx, "token-user")
	svc := NewOAuth2Service(queries)

	confidential := true
	app, err := oauth2CovProvisionClient(t, queries, ctx, user.ID, oauth2CovClientRequest{
		Name:         "Token App",
		RedirectURIs: []string{"https://app.example/callback"},
		Scopes:       []string{"read:user", "write:user"},
		Confidential: &confidential,
	})
	require.NoError(t, err)
	otherApp, err := oauth2CovProvisionClient(t, queries, ctx, user.ID, oauth2CovClientRequest{
		Name:         "Other App",
		RedirectURIs: []string{"https://other.example/callback"},
		Scopes:       []string{"read:user"},
		Confidential: &confidential,
	})
	require.NoError(t, err)

	_, err = svc.Authorize(ctx, user.ID, app.ClientID, "https://app.example/callback", "read:user write:user", "", "", []string{"read:user"})
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 400)
	assert.Contains(t, err.Error(), "caller")

	authz, err := svc.Authorize(ctx, user.ID, app.ClientID, "https://app.example/callback", "read:user read:user", "", "", nil)
	require.NoError(t, err)
	assert.NotEmpty(t, authz.Code)

	_, err = svc.ExchangeCode(ctx, app.ClientID, "wrong-secret", authz.Code, "https://app.example/callback", "")
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 401)

	tokens, err := svc.ExchangeCode(ctx, app.ClientID, app.ClientSecret, authz.Code, "https://app.example/callback", "")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(tokens.AccessToken, "smithers_oat_"))
	assert.True(t, strings.HasPrefix(tokens.RefreshToken, "smithers_ort_"))
	assert.Equal(t, "read:user", tokens.Scope)

	_, err = svc.ExchangeCode(ctx, app.ClientID, app.ClientSecret, authz.Code, "https://app.example/callback", "")
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 400)

	_, err = svc.RefreshToken(ctx, otherApp.ClientID, otherApp.ClientSecret, tokens.RefreshToken)
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 401)
	assert.Contains(t, err.Error(), "invalid client_id")

	refreshed, err := svc.RefreshToken(ctx, app.ClientID, app.ClientSecret, tokens.RefreshToken)
	require.NoError(t, err)
	assert.NotEqual(t, tokens.RefreshToken, refreshed.RefreshToken)
	assert.Equal(t, "read:user", refreshed.Scope)

	_, err = svc.RefreshToken(ctx, app.ClientID, app.ClientSecret, tokens.RefreshToken)
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 400)

	// RFC 7009 §2.1 — a token value alone must never be enough to revoke it.
	err = svc.RevokeToken(ctx, "", "", refreshed.AccessToken)
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 401)
	require.NoError(t, svc.RevokeToken(ctx, app.ClientID, app.ClientSecret, refreshed.AccessToken))
	require.NoError(t, svc.RevokeToken(ctx, app.ClientID, app.ClientSecret, "unknown-token"))
	require.NoError(t, svc.RevokeToken(ctx, app.ClientID, app.ClientSecret, refreshed.RefreshToken))
	_, err = svc.RefreshToken(ctx, app.ClientID, app.ClientSecret, refreshed.RefreshToken)
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 400)

	pair, err := svc.issueTokenPair(ctx, svc.queries, app.ID, user.ID, []string{"read:user"}, grantSource{})
	require.NoError(t, err)
	assert.NotEmpty(t, pair.AccessToken)
	require.NoError(t, svc.RevokeAllByAppAndUser(ctx, app.ID, user.ID))

	var accessCount, refreshCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM oauth2_access_tokens WHERE app_id = $1 AND user_id = $2`, app.ID, user.ID).Scan(&accessCount))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM oauth2_refresh_tokens WHERE app_id = $1 AND user_id = $2`, app.ID, user.ID).Scan(&refreshCount))
	assert.Equal(t, 0, accessCount)
	assert.Equal(t, 0, refreshCount)
}

func oauth2CovSeedUser(t *testing.T, ctx context.Context, suffix string) db.User {
	t.Helper()
	username := oauth2CovSlug(t, suffix)
	var user db.User
	err := getAgentTestPool(t).QueryRow(ctx, `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1)
		RETURNING id, username, lower_username, email, lower_email, display_name, bio, avatar_url, user_type, is_active, is_admin, prohibit_login, email_notifications_enabled, created_at, updated_at
	`, username, username+"@example.com").Scan(
		&user.ID,
		&user.Username,
		&user.LowerUsername,
		&user.Email,
		&user.LowerEmail,
		&user.DisplayName,
		&user.Bio,
		&user.AvatarUrl,
		&user.UserType,
		&user.IsActive,
		&user.IsAdmin,
		&user.ProhibitLogin,
		&user.EmailNotificationsEnabled,
		&user.CreatedAt,
		&user.UpdatedAt,
	)
	require.NoError(t, err)
	return user
}

func oauth2CovSlug(t *testing.T, suffix string) string {
	t.Helper()
	replacer := strings.NewReplacer("/", "-", "_", "-", " ", "-", ".", "-")
	value := strings.ToLower(replacer.Replace(t.Name() + "-" + suffix))
	if len(value) > 60 {
		value = value[len(value)-60:]
	}
	return strings.Trim(value, "-")
}

func oauth2CovAssertAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, status, apiErr.Status)
}

// TestOAuth2_Cov_AuthorizeEmptyCallerScopesGrantNothing pins the nil-vs-empty
// contract the authorize route relies on (release review 2026-09-13, R006):
// a non-nil empty callerScopes slice is a token caller with no scopes and
// must be refused for every requested scope without persisting a code, while
// nil is a session caller and stays unrestricted.
func TestOAuth2_Cov_AuthorizeEmptyCallerScopesGrantNothing(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	queries := db.New(pool)
	user := oauth2CovSeedUser(t, ctx, "empty-scopes")
	svc := NewOAuth2Service(queries)

	confidential := true
	app, err := oauth2CovProvisionClient(t, queries, ctx, user.ID, oauth2CovClientRequest{
		Name:         "Empty Scopes App",
		RedirectURIs: []string{"https://app.example/callback"},
		Scopes:       []string{"read:user", "write:user"},
		Confidential: &confidential,
	})
	require.NoError(t, err)

	countCodes := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM oauth2_authorization_codes WHERE app_id = $1 AND user_id = $2`, app.ID, user.ID).Scan(&n))
		return n
	}

	// Explicit scope request from a scope-less token caller.
	_, err = svc.Authorize(ctx, user.ID, app.ClientID, "https://app.example/callback", "read:user", "", "", []string{})
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 400)
	assert.Contains(t, err.Error(), "caller")
	assert.Equal(t, 0, countCodes(), "no authorization code may be stored for a caller with no scopes")

	// Omitted scope falls back to the app's registered scopes, which the
	// scope-less caller must not be able to obtain either.
	_, err = svc.Authorize(ctx, user.ID, app.ClientID, "https://app.example/callback", "", "", "", []string{})
	require.Error(t, err)
	oauth2CovAssertAPIStatus(t, err, 400)
	assert.Equal(t, 0, countCodes())

	// Session caller (nil) is unchanged.
	authz, err := svc.Authorize(ctx, user.ID, app.ClientID, "https://app.example/callback", "read:user", "", "", nil)
	require.NoError(t, err)
	assert.NotEmpty(t, authz.Code)
	assert.Equal(t, 1, countCodes())
}

// Fixture registration is deployment configuration, not a public hosting API.
type oauth2CovClientRequest struct {
	Name                 string
	RedirectURIs, Scopes []string
	Confidential         *bool
}
type oauth2CovClient struct {
	OAuth2ApplicationResponse
	ClientSecret string
}

func oauth2CovProvisionClient(t *testing.T, q *db.Queries, ctx context.Context, owner int64, req oauth2CovClientRequest) (oauth2CovClient, error) {
	t.Helper()
	id := FirstPartyClientID
	if req.Name == "Other App" {
		id = "historical_third_party"
	}
	secret := "integration-secret"
	app, err := q.CreateOAuth2Application(ctx, db.CreateOAuth2ApplicationParams{ClientID: id, ClientSecretHash: hashOAuth2Secret(secret), Name: req.Name, RedirectUris: req.RedirectURIs, Scopes: req.Scopes, OwnerID: owner, Confidential: *req.Confidential})
	if err == nil {
		t.Cleanup(func() {
			_, cleanupErr := getAgentTestPool(t).Exec(context.Background(), "DELETE FROM oauth2_applications WHERE id = $1", app.ID)
			require.NoError(t, cleanupErr)
		})
	}
	return oauth2CovClient{toOAuth2ApplicationResponse(app), secret}, err
}
