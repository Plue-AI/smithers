package routes

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

type patGrantEnv struct {
	db     *pgxpool.Pool
	q      *db.Queries
	srv    *httptest.Server
	client *http.Client
}

func (e *patGrantEnv) pool() *pgxpool.Pool { return e.db }

func newPATGrantEnv(t *testing.T) *patGrantEnv {
	t.Helper()
	pool := newGrantSecurityPool(t)
	q := db.New(pool)
	owner := grantSecurityCreateUser(t, pool, "fpowner")
	_, err := pool.Exec(context.Background(), `DELETE FROM oauth2_applications WHERE client_id=$1`, services.FirstPartyClientID)
	require.NoError(t, err)
	_, err = q.CreateOAuth2Application(context.Background(), db.CreateOAuth2ApplicationParams{
		ClientID:         services.FirstPartyClientID,
		ClientSecretHash: "public-client-no-secret",
		Name:             "first-party apps",
		RedirectUris:     []string{"http://127.0.0.1/callback"},
		Scopes:           []string{"read:user", "read:repository"},
		OwnerID:          owner.ID,
		Confidential:     false,
	})
	require.NoError(t, err)

	h := &OAuth2Handler{Service: services.NewOAuth2ServiceWithPool(q, pool)}
	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	r.Post("/api/oauth2/token", h.PostToken)
	r.Post("/api/oauth2/revoke", h.PostRevoke)
	r.Get("/api/oauth2/authorize", h.GetAuthorize)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/api/probe", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	client := *srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &patGrantEnv{db: pool, q: q, srv: srv, client: &client}
}

func (e *patGrantEnv) do(t *testing.T, method, path, bearer string, form url.Values) (*http.Response, string) {
	t.Helper()
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequest(method, e.srv.URL+path, body)
	require.NoError(t, err)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := e.client.Do(req)
	require.NoError(t, err)
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp, string(b)
}

func (e *patGrantEnv) mintPAT(t *testing.T, userID int64, scopes string, ttl time.Duration, systemIssued bool) (string, db.AccessToken) {
	t.Helper()
	raw := "smithers_" + sha256Hex(t.Name() + time.Now().String())[:40]
	hash := sha256Hex(raw)
	tok, err := e.q.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
		UserID: userID, Name: "t", TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
		Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(ttl), Valid: true},
		SystemIssued: systemIssued,
	})
	require.NoError(t, err)
	return raw, tok
}

func (e *patGrantEnv) authorize(t *testing.T, bearer string) (*http.Response, string, string) {
	t.Helper()
	verifier := "verifier-" + sha256Hex(bearer)[:32]
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type": {"code"}, "client_id": {services.FirstPartyClientID},
		"redirect_uri": {"http://127.0.0.1:1/callback"}, "scope": {"read:repository"},
		"state": {"x"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
	}
	resp, body := e.do(t, http.MethodGet, "/api/oauth2/authorize?"+q.Encode(), bearer, nil)
	return resp, body, verifier
}

// A personal access token may authorize a first-party grant, but the grant
// is bound to it: deleting the PAT deletes the derived access and refresh
// tokens (DB cascade) and refresh can never revive them.
func TestOAuth2Integration_PATGrantDiesWithThePAT(t *testing.T) {
	e := newPATGrantEnv(t)
	ctx := context.Background()
	user := grantSecurityCreateUser(t, e.pool(), "victim")
	pat, patRow := e.mintPAT(t, user.ID, "read:repository", time.Hour, false)

	resp, body, verifier := e.authorize(t, pat)
	require.Equal(t, http.StatusFound, resp.StatusCode, body)
	loc, err := url.Parse(resp.Header.Get("Location"))
	require.NoError(t, err)
	code := loc.Query().Get("code")
	require.NotEmpty(t, code)

	resp, body = e.do(t, http.MethodPost, "/api/oauth2/token", "", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {"http://127.0.0.1:1/callback"},
		"client_id": {services.FirstPartyClientID}, "code_verifier": {verifier},
	})
	require.Equal(t, http.StatusOK, resp.StatusCode, body)
	var tr services.OAuth2TokenResponse
	require.NoError(t, json.Unmarshal([]byte(body), &tr))

	resp, _ = e.do(t, http.MethodGet, "/api/probe", tr.AccessToken, nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode, "derived access token works while the PAT lives")

	var refreshExpiry time.Time
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT expires_at FROM oauth2_refresh_tokens WHERE token_hash=$1`, sha256Hex(tr.RefreshToken)).Scan(&refreshExpiry))
	require.WithinDuration(t, patRow.ExpiresAt.Time, refreshExpiry, time.Second, "refresh token capped at the PAT expiry")

	require.NoError(t, e.q.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: patRow.ID, UserID: user.ID}))

	resp, _ = e.do(t, http.MethodGet, "/api/probe", tr.AccessToken, nil)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode, "derived access token dies with the PAT")
	resp, body = e.do(t, http.MethodPost, "/api/oauth2/token", "", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {tr.RefreshToken}, "client_id": {services.FirstPartyClientID},
	})
	require.NotEqual(t, http.StatusOK, resp.StatusCode, "refresh must not revive a grant whose PAT was deleted: %s", body)
}

// A platform-minted token (sandbox clone token) cannot authorize at all.
func TestOAuth2Integration_SystemIssuedTokenCannotAuthorize(t *testing.T) {
	e := newPATGrantEnv(t)
	user := grantSecurityCreateUser(t, e.pool(), "victim")
	clone, _ := e.mintPAT(t, user.ID, "read:repository", time.Hour, true)

	resp, _ := e.do(t, http.MethodGet, "/api/probe", clone, nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode, "the clone token still works for its own purpose")

	resp, body, _ := e.authorize(t, clone)
	require.Equal(t, http.StatusForbidden, resp.StatusCode, body)
	require.Contains(t, body, "system-issued tokens cannot authorize oauth2 grants")
}

func newGrantSecurityPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}
func grantSecurityCreateUser(t *testing.T, pool *pgxpool.Pool, name string) db.User {
	t.Helper()
	user, err := db.New(pool).CreateUser(context.Background(), db.CreateUserParams{
		Username: name, LowerUsername: name, Email: pgtype.Text{String: name + "@example.com", Valid: true}, LowerEmail: pgtype.Text{String: name + "@example.com", Valid: true}, DisplayName: name,
	})
	require.NoError(t, err)
	return user
}

func (e *patGrantEnv) exchange(t *testing.T, code, verifier string) (*http.Response, string) {
	return e.do(t, http.MethodPost, "/api/oauth2/token", "", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {"http://127.0.0.1:1/callback"}, "client_id": {services.FirstPartyClientID}, "code_verifier": {verifier},
	})
}
func (e *patGrantEnv) refresh(t *testing.T, token string) (*http.Response, string) {
	return e.do(t, http.MethodPost, "/api/oauth2/token", "", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {services.FirstPartyClientID},
	})
}

func TestOAuth2Integration_PATRevocationBeforeExchange(t *testing.T) {
	e := newPATGrantEnv(t)
	user := grantSecurityCreateUser(t, e.pool(), "revoked")
	pat, row := e.mintPAT(t, user.ID, "read:repository", time.Hour, false)
	resp, body, verifier := e.authorize(t, pat)
	require.Equal(t, http.StatusFound, resp.StatusCode, body)
	loc, err := url.Parse(resp.Header.Get("Location"))
	require.NoError(t, err)
	require.NoError(t, e.q.DeleteAccessToken(context.Background(), db.DeleteAccessTokenParams{ID: row.ID, UserID: user.ID}))
	resp, body = e.exchange(t, loc.Query().Get("code"), verifier)
	require.Equal(t, http.StatusBadRequest, resp.StatusCode, body)
	var n int
	require.NoError(t, e.pool().QueryRow(context.Background(), `SELECT count(*) FROM oauth2_access_tokens`).Scan(&n))
	require.Zero(t, n)
}

func TestOAuth2Integration_PATSourceAndAtomicRotation(t *testing.T) {
	e := newPATGrantEnv(t)
	ctx := context.Background()
	user := grantSecurityCreateUser(t, e.pool(), "atomic")
	pat, patRow := e.mintPAT(t, user.ID, "read:repository", 20*time.Minute, false)
	resp, body, verifier := e.authorize(t, pat)
	require.Equal(t, http.StatusFound, resp.StatusCode, body)
	loc, err := url.Parse(resp.Header.Get("Location"))
	require.NoError(t, err)
	code := loc.Query().Get("code")
	// A real database failure after the access-token insert must roll back the
	// entire redemption, including one-time code consumption.
	_, err = e.pool().Exec(ctx, `CREATE FUNCTION reject_oauth_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refresh write failure'; END $$; CREATE TRIGGER reject_refresh BEFORE INSERT ON oauth2_refresh_tokens FOR EACH ROW EXECUTE FUNCTION reject_oauth_refresh()`)
	require.NoError(t, err)
	resp, body = e.exchange(t, code, verifier)
	require.Equal(t, http.StatusInternalServerError, resp.StatusCode, body)
	var used bool
	var n int
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT used_at IS NOT NULL FROM oauth2_authorization_codes WHERE code_hash=$1`, sha256Hex(code)).Scan(&used))
	require.False(t, used)
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT count(*) FROM oauth2_access_tokens`).Scan(&n))
	require.Zero(t, n)
	_, err = e.pool().Exec(ctx, `ALTER TABLE oauth2_refresh_tokens DISABLE TRIGGER reject_refresh`)
	require.NoError(t, err)
	resp, body = e.exchange(t, code, verifier)
	require.Equal(t, http.StatusOK, resp.StatusCode, body)
	var first services.OAuth2TokenResponse
	require.NoError(t, json.Unmarshal([]byte(body), &first))
	_, err = e.pool().Exec(ctx, `ALTER TABLE oauth2_refresh_tokens ENABLE TRIGGER reject_refresh`)
	require.NoError(t, err)
	resp, body = e.refresh(t, first.RefreshToken)
	require.Equal(t, http.StatusInternalServerError, resp.StatusCode, body)
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT count(*) FROM oauth2_refresh_tokens WHERE token_hash=$1`, sha256Hex(first.RefreshToken)).Scan(&n))
	require.Equal(t, 1, n)
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT count(*) FROM oauth2_access_tokens`).Scan(&n))
	require.Equal(t, 1, n)
	_, err = e.pool().Exec(ctx, `ALTER TABLE oauth2_refresh_tokens DISABLE TRIGGER reject_refresh`)
	require.NoError(t, err)
	resp, body = e.refresh(t, first.RefreshToken)
	require.Equal(t, http.StatusOK, resp.StatusCode, body)
	var next services.OAuth2TokenResponse
	require.NoError(t, json.Unmarshal([]byte(body), &next))
	require.NotEqual(t, first.RefreshToken, next.RefreshToken)
	var source int64
	var expires time.Time
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT source_access_token_id,expires_at FROM oauth2_refresh_tokens WHERE token_hash=$1`, sha256Hex(next.RefreshToken)).Scan(&source, &expires))
	require.Equal(t, patRow.ID, source)
	require.WithinDuration(t, patRow.ExpiresAt.Time, expires, time.Millisecond)
	resp, body = e.refresh(t, first.RefreshToken)
	require.Equal(t, http.StatusBadRequest, resp.StatusCode, body)
	require.NoError(t, e.q.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: patRow.ID, UserID: user.ID}))
	resp, _ = e.do(t, http.MethodGet, "/api/probe", next.AccessToken, nil)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp, body = e.refresh(t, next.RefreshToken)
	require.Equal(t, http.StatusBadRequest, resp.StatusCode, body)
}

func TestOAuth2Integration_ExpiredSourceCannotBeExchanged(t *testing.T) {
	e := newPATGrantEnv(t)
	ctx := context.Background()
	user := grantSecurityCreateUser(t, e.pool(), "expired")
	pat, row := e.mintPAT(t, user.ID, "read:repository", time.Hour, false)
	resp, body, verifier := e.authorize(t, pat)
	require.Equal(t, http.StatusFound, resp.StatusCode, body)
	loc, err := url.Parse(resp.Header.Get("Location"))
	require.NoError(t, err)
	_, err = e.pool().Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	resp, body = e.exchange(t, loc.Query().Get("code"), verifier)
	require.Equal(t, http.StatusBadRequest, resp.StatusCode, body)
	var used bool
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT used_at IS NOT NULL FROM oauth2_authorization_codes WHERE code_hash=$1`, sha256Hex(loc.Query().Get("code"))).Scan(&used))
	require.False(t, used, "source rejection must roll back one-time consumption")
}
