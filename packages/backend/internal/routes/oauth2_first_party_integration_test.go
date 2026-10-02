package routes

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestOAuth2IntegrationRetiredGrantCannotAuthenticateButCanBeRevoked(t *testing.T) {
	e := newPATGrantEnv(t)
	ctx := context.Background()
	user := grantSecurityCreateUser(t, e.pool(), "legacy-grant-user")
	legacy, err := e.q.CreateOAuth2Application(ctx, db.CreateOAuth2ApplicationParams{ClientID: "historical-hosted-client", ClientSecretHash: sha256Hex("old-secret"), Name: "Historical client", RedirectUris: []string{"https://old.example/callback"}, Scopes: []string{"read:repository"}, OwnerID: user.ID, Confidential: true})
	require.NoError(t, err)
	firstParty, err := e.q.GetOAuth2ApplicationByClientID(ctx, services.FirstPartyClientID)
	require.NoError(t, err)
	legacyRaw := "smithers_oat_" + sha256Hex("old-grant")
	firstPartyRaw := "smithers_oat_" + sha256Hex("first-party-grant")
	for _, grant := range []struct {
		app int64
		raw string
	}{{legacy.ID, legacyRaw}, {firstParty.ID, firstPartyRaw}} {
		_, err = e.q.CreateOAuth2AccessToken(ctx, db.CreateOAuth2AccessTokenParams{TokenHash: sha256Hex(grant.raw), AppID: grant.app, UserID: user.ID, Scopes: []string{"read:repository"}, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}

	// Persisted tickets from the retired client are refused on reconnect, while
	// first-party tickets retain their source identity and still authenticate.
	ticketService := services.NewSSETicketService(e.q)
	oldTicket, err := ticketService.CreateTicket(ctx, user.ID, true, "read:repository", sha256Hex(legacyRaw))
	require.NoError(t, err)
	_, err = ticketService.ValidateTicket(ctx, oldTicket.Ticket)
	require.Error(t, err)
	firstPartyTicket, err := ticketService.CreateTicket(ctx, user.ID, true, "read:repository", sha256Hex(firstPartyRaw))
	require.NoError(t, err)
	principal, err := ticketService.ValidateTicket(ctx, firstPartyTicket.Ticket)
	require.NoError(t, err)
	require.Equal(t, user.ID, principal.User.ID)
	legacyRefresh := "smithers_ort_" + sha256Hex("old-refresh-grant")
	_, err = e.q.CreateOAuth2RefreshToken(ctx, db.CreateOAuth2RefreshTokenParams{TokenHash: sha256Hex(legacyRefresh), AppID: legacy.ID, UserID: user.ID, Scopes: []string{"read:repository"}, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	tokenResp, tokenBody := e.do(t, http.MethodPost, "/api/oauth2/token", "", url.Values{"grant_type": {"refresh_token"}, "client_id": {legacy.ClientID}, "client_secret": {"old-secret"}, "refresh_token": {legacyRefresh}})
	require.Equal(t, http.StatusUnauthorized, tokenResp.StatusCode, tokenBody)
	_, err = e.q.GetOAuth2RefreshTokenByHash(ctx, sha256Hex(legacyRefresh))
	require.NoError(t, err, "retired issuance leaves history intact")
	resp, body := e.do(t, http.MethodGet, "/api/probe", legacyRaw, nil)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode, body)
	resp, body = e.do(t, http.MethodGet, "/api/probe", firstPartyRaw, nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode, body)
	// Refusing authentication does not destroy an installed grant's record.
	_, err = e.q.GetOAuth2AccessTokenByHash(ctx, sha256Hex(legacyRaw))
	require.NoError(t, err)
	_, err = e.q.GetFirstPartyOAuth2AccessTokenByHash(ctx, sha256Hex(legacyRaw))
	require.Error(t, err)
	resp, body = e.do(t, http.MethodPost, "/api/oauth2/revoke", "", url.Values{"client_id": {legacy.ClientID}, "client_secret": {"old-secret"}, "token": {legacyRaw}})
	require.Equal(t, http.StatusOK, resp.StatusCode, body)
	_, err = e.q.GetOAuth2AccessTokenByHash(ctx, sha256Hex(legacyRaw))
	require.Error(t, err)
	resp, body = e.do(t, http.MethodGet, "/api/probe", firstPartyRaw, nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode, body)
	// Login sessions and ordinary CLI PATs retain their shared boundary.
	session, err := e.q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: "mvp-first-party-session", UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodGet, e.srv.URL+"/api/probe", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: session.SessionKey})
	sessionResp, err := e.client.Do(req)
	require.NoError(t, err)
	sessionResp.Body.Close()
	require.Equal(t, http.StatusNoContent, sessionResp.StatusCode)
	pat, _ := e.mintPAT(t, user.ID, "read:repository", time.Hour, false)
	resp, body = e.do(t, http.MethodGet, "/api/probe", pat, nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode, body)
}
