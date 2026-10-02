package db

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFCov_OAuth2_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	clientID := "cid-" + randSlug(t)
	app, err := q.CreateOAuth2Application(ctx, CreateOAuth2ApplicationParams{
		ClientID: clientID, ClientSecretHash: "sh", Name: "App",
		RedirectUris: []string{"https://example.com/cb"}, Scopes: []string{"read"},
		OwnerID: userID, Confidential: true,
	})
	require.NoError(t, err)

	byClient, err := q.GetOAuth2ApplicationByClientID(ctx, clientID)
	require.NoError(t, err)
	assert.Equal(t, app.ID, byClient.ID)
	// Access tokens.
	atHash := "at-" + randSlug(t)
	_, err = q.CreateOAuth2AccessToken(ctx, CreateOAuth2AccessTokenParams{
		TokenHash: atHash, AppID: app.ID, UserID: userID, Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	gotAT, err := q.GetOAuth2AccessTokenByHash(ctx, atHash)
	require.NoError(t, err)
	assert.Equal(t, atHash, gotAT.TokenHash)
	atList, err := q.ListOAuth2AccessTokensByUser(ctx, userID)
	require.NoError(t, err)
	require.Len(t, atList, 1)
	deletedAT, err := q.DeleteOAuth2AccessTokenByHash(ctx, atHash)
	require.NoError(t, err)
	assert.Equal(t, int64(1), deletedAT)

	// Second access token, deleted by app+user.
	_, err = q.CreateOAuth2AccessToken(ctx, CreateOAuth2AccessTokenParams{
		TokenHash: "at2-" + randSlug(t), AppID: app.ID, UserID: userID, Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteOAuth2AccessTokensByAppAndUser(ctx, DeleteOAuth2AccessTokensByAppAndUserParams{AppID: app.ID, UserID: userID}))

	// Refresh tokens.
	rtHash := "rt-" + randSlug(t)
	_, err = q.CreateOAuth2RefreshToken(ctx, CreateOAuth2RefreshTokenParams{
		TokenHash: rtHash, AppID: app.ID, UserID: userID, Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	gotRT, err := q.GetOAuth2RefreshTokenByHash(ctx, rtHash)
	require.NoError(t, err)
	assert.Equal(t, rtHash, gotRT.TokenHash)
	consumedRT, err := q.ConsumeOAuth2RefreshToken(ctx, rtHash)
	require.NoError(t, err)
	assert.Equal(t, rtHash, consumedRT.TokenHash)

	rt2Hash := "rt2-" + randSlug(t)
	_, err = q.CreateOAuth2RefreshToken(ctx, CreateOAuth2RefreshTokenParams{
		TokenHash: rt2Hash, AppID: app.ID, UserID: userID, Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	deletedRT, err := q.DeleteOAuth2RefreshTokenByHash(ctx, rt2Hash)
	require.NoError(t, err)
	assert.Equal(t, int64(1), deletedRT)
	_, err = q.CreateOAuth2RefreshToken(ctx, CreateOAuth2RefreshTokenParams{
		TokenHash: "rt3-" + randSlug(t), AppID: app.ID, UserID: userID, Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.DeleteOAuth2RefreshTokensByAppAndUser(ctx, DeleteOAuth2RefreshTokensByAppAndUserParams{AppID: app.ID, UserID: userID}))

	// Authorization code.
	codeHash := "code-" + randSlug(t)
	require.NoError(t, q.CreateOAuth2AuthorizationCode(ctx, CreateOAuth2AuthorizationCodeParams{
		CodeHash: codeHash, AppID: app.ID, UserID: userID, Scopes: []string{"read"},
		RedirectUri: "https://example.com/cb", CodeChallenge: "chal", CodeChallengeMethod: "S256",
		ExpiresAt: time.Now().Add(time.Hour),
	}))
	consumedCode, err := q.ConsumeOAuth2AuthorizationCode(ctx, codeHash)
	require.NoError(t, err)
	assert.Equal(t, codeHash, consumedCode.CodeHash)

	// Expiry sweeps.
	_, err = q.DeleteExpiredOAuth2AccessTokens(ctx)
	require.NoError(t, err)
	require.NoError(t, q.DeleteExpiredOAuth2AuthorizationCodes(ctx))
	require.NoError(t, q.DeleteExpiredOAuth2RefreshTokens(ctx))

}
