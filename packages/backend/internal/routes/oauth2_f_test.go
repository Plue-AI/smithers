package routes

import (
	"context"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type oauth2FAuditQuerier struct{}

func (oauth2FAuditQuerier) InsertAuditLog(context.Context, db.InsertAuditLogParams) error { return nil }

func oauth2FAudit() *services.AuditService { return services.NewAuditService(oauth2FAuditQuerier{}) }

// TestOAuth2_F_ApplicationBranches covers the application-management guards that
// remain uncovered: create service error + audit, list/get/delete unauth,
// delete bad id + audit.
func TestOAuth2_F_ApplicationBranches(t *testing.T) {
	t.Run("PostApplication service error", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			createApplicationFn: func(context.Context, int64, services.CreateOAuth2ApplicationRequest) (services.CreateOAuth2ApplicationResult, error) {
				return services.CreateOAuth2ApplicationResult{}, stderrors.New("db down")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/applications", strings.NewReader(`{"name":"x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostApplication(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("PostApplication success logs audit event", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, AuditService: oauth2FAudit()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/applications", strings.NewReader(`{"name":"x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostApplication(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("GetApplications requires auth", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications", nil)
		rec := httptest.NewRecorder()
		h.GetApplications(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("GetApplication requires auth", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/applications/1", nil)
		rec := httptest.NewRecorder()
		h.GetApplication(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("DeleteApplication requires auth", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/oauth2/applications/1", nil)
		rec := httptest.NewRecorder()
		h.DeleteApplication(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("DeleteApplication invalid id", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/oauth2/applications/nope", nil)
		req = withRouteParams(req, map[string]string{"id": "nope"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteApplication(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DeleteApplication success logs audit event", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, AuditService: oauth2FAudit()}
		req := httptest.NewRequest(http.MethodDelete, "/api/oauth2/applications/42", nil)
		req = withRouteParams(req, map[string]string{"id": "42"})
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteApplication(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})
}

// TestOAuth2_F_AuthorizeBranches covers the remaining GetAuthorize branches.
func TestOAuth2_F_AuthorizeBranches(t *testing.T) {
	t.Run("missing client_id", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code", nil)
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("missing redirect_uri", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id=c", nil)
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("dev auto authorize mints code without a session", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, DevAutoAuthorizeUserID: 42}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id="+services.FirstPartyClientID+"&redirect_uri=smithers://cb&state=s&code_challenge=c&code_challenge_method=S256", nil)
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusFound, rec.Code)
	})

	t.Run("first-party token collects caller scopes", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id="+services.FirstPartyClientID+"&redirect_uri=smithers://cb&state=s&code_challenge=c&code_challenge_method=S256", nil)
		req = withTokenAuth(req, 7, "alice", middleware.TokenScope("repo"))
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusFound, rec.Code)
	})

	t.Run("authorize service error", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			authorizeFn: func(context.Context, int64, string, string, string, string, string, []string) (services.OAuth2AuthorizeResult, error) {
				return services.OAuth2AuthorizeResult{}, stderrors.New("mint failed")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id="+services.FirstPartyClientID+"&redirect_uri=smithers://cb&state=s&code_challenge=c&code_challenge_method=S256", nil)
		req = withTokenAuth(req, 7, "alice", middleware.TokenScope("repo"))
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("unparsable minted redirect uri", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			authorizeFn: func(context.Context, int64, string, string, string, string, string, []string) (services.OAuth2AuthorizeResult, error) {
				return services.OAuth2AuthorizeResult{Code: "c", RedirectURI: "http://a\x7fb/cb"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id="+services.FirstPartyClientID+"&redirect_uri=smithers://cb&state=s&code_challenge=c&code_challenge_method=S256", nil)
		req = withTokenAuth(req, 7, "alice", middleware.TokenScope("repo"))
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("session GET renders consent instead of minting", func(t *testing.T) {
		minted := false
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			authorizeFn: func(context.Context, int64, string, string, string, string, string, []string) (services.OAuth2AuthorizeResult, error) {
				minted = true
				return services.OAuth2AuthorizeResult{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?response_type=code&client_id="+services.FirstPartyClientID+"&redirect_uri=smithers://cb&state=s&code_challenge=c&code_challenge_method=S256", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.GetAuthorize(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		require.Contains(t, rec.Header().Get("Content-Type"), "text/html")
		require.False(t, minted, "session GET must never mint an authorization code")
	})

	t.Run("consent POST without csrf nonce is refused", func(t *testing.T) {
		minted := false
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			authorizeFn: func(context.Context, int64, string, string, string, string, string, []string) (services.OAuth2AuthorizeResult, error) {
				minted = true
				return services.OAuth2AuthorizeResult{}, nil
			},
		}}
		body := "response_type=code&client_id=" + services.FirstPartyClientID + "&redirect_uri=smithers://cb&state=s&code_challenge=c&code_challenge_method=S256&decision=approve"
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/authorize", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostAuthorizeDecision(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
		require.False(t, minted, "a forged cross-site POST must never mint an authorization code")
	})
}

// TestOAuth2_F_DevAutoAuthorizeAllowed covers devAutoAuthorizeAllowed directly.
func TestOAuth2_F_DevAutoAuthorizeAllowed(t *testing.T) {
	disabled := &OAuth2Handler{}
	require.False(t, disabled.devAutoAuthorizeAllowed(httptest.NewRequest(http.MethodGet, "/x", nil)))

	anyClient := &OAuth2Handler{DevAutoAuthorizeUserID: 5}
	require.True(t, anyClient.devAutoAuthorizeAllowed(httptest.NewRequest(http.MethodGet, "/x", nil)))

	pinned := &OAuth2Handler{DevAutoAuthorizeUserID: 5, DevAutoAuthorizeClientID: "cli"}
	require.False(t, pinned.devAutoAuthorizeAllowed(httptest.NewRequest(http.MethodGet, "/x?client_id=other", nil)))
	require.True(t, pinned.devAutoAuthorizeAllowed(httptest.NewRequest(http.MethodGet, "/x?client_id=cli", nil)))
}

// TestOAuth2_F_TokenBranches covers the token endpoint's form/JSON decode and
// grant-type validation guards.
func TestOAuth2_F_TokenBranches(t *testing.T) {
	newForm := func(body string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/token", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return req
	}

	t.Run("invalid form data", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=%zz"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("invalid json body", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/token", strings.NewReader(`not-json`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.PostToken(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("authorization_code missing code", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=authorization_code&client_id=c"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("authorization_code missing client_id", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=authorization_code&code=abc"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("refresh_token missing refresh_token", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=refresh_token&client_id=c"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("refresh_token missing client_id", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=refresh_token&refresh_token=r"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("unsupported grant_type", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=client_credentials"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("exchange service error", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			exchangeCodeFn: func(context.Context, string, string, string, string, string) (services.OAuth2TokenResponse, error) {
				return services.OAuth2TokenResponse{}, stderrors.New("bad code")
			},
		}, Metrics: NewSmithersMetrics()}
		rec := httptest.NewRecorder()
		h.PostToken(rec, newForm("grant_type=authorization_code&code=abc&client_id=c"))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// TestOAuth2_F_RevokeBranches covers the revoke/revoke-all guards.
func TestOAuth2_F_RevokeBranches(t *testing.T) {
	t.Run("invalid form data", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke", strings.NewReader("token=%zz"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		h.PostRevoke(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("invalid json body", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke", strings.NewReader(`not-json`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.PostRevoke(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("basic auth supplies client credentials", func(t *testing.T) {
		var gotClientID, gotSecret string
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			revokeTokenFn: func(_ context.Context, clientID, clientSecret, token string) error {
				gotClientID = clientID
				gotSecret = clientSecret
				return nil
			},
		}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke", strings.NewReader(`{"token":"t1"}`))
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth("cid", "csec")
		rec := httptest.NewRecorder()
		h.PostRevoke(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		require.Equal(t, "cid", gotClientID)
		require.Equal(t, "csec", gotSecret)
	})

	t.Run("revoke all service error", func(t *testing.T) {
		h := &OAuth2Handler{Service: &oauth2CovRouteService{
			revokeAllByAppAndUserFn: func(context.Context, int64, int64) error {
				return stderrors.New("db down")
			},
		}, Metrics: NewSmithersMetrics()}
		req := httptest.NewRequest(http.MethodPost, "/api/oauth2/revoke-all", nil)
		req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
			User:        &db.User{ID: 7, Username: "alice"},
			IsTokenAuth: true,
			TokenSource: middleware.TokenSourceOAuth2AccessToken,
			OAuth2AppID: 55,
		}))
		rec := httptest.NewRecorder()
		h.PostRevokeAll(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}
