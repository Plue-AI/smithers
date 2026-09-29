//go:build integration
// +build integration

package routes

import (
	"context"
	"crypto/sha256"
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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// sseTicketRevocationFixture wires the production pieces of the database
// SSE-ticket path end to end: the real ticket service over the lane
// database, the real AuthLoader resolving a real PAT row, the real ticket
// middleware, the real notification stream handler over a started broker,
// and a real revocation bus installed as the package-wide revocation source.
type sseTicketRevocationFixture struct {
	pool    *pgxpool.Pool
	queries *db.Queries
	auth    *services.AuthService
	server  *httptest.Server
	client  *http.Client
}

func setupSSETicketRevocationFixture(t *testing.T) *sseTicketRevocationFixture {
	t.Helper()

	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	bus := revocation.NewBus(pool, queries)
	require.NoError(t, bus.Start(ctx))
	t.Cleanup(func() { cancel(); <-bus.Done() })
	SetRevocationSource(bus)
	t.Cleanup(func() { SetRevocationSource(nil) })
	publisher := revocation.NewDBPublisher(queries, bus)

	authService := services.NewAuthService(queries, config.AuthConfig{}, nil, nil, services.WithAuthRevocationPublisher(publisher))

	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(ctx))
	t.Cleanup(broker.Stop)

	ticketService := services.NewSSETicketService(queries)
	ticketHandler := &SSETicketHandler{Service: ticketService}
	notificationHandler := &NotificationHandler{
		Service: services.NewNotificationService(queries),
		Broker:  broker,
	}
	issueHandler := &IssueEventHandler{Service: services.NewIssueEventService(queries), Broker: broker}

	r := chi.NewRouter()
	r.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	r.Use(middleware.SSETicketAuth(ticketService, nil))
	r.With(middleware.RequireAuth).Post("/api/auth/sse-ticket", ticketHandler.PostSSETicket)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/api/notifications", notificationHandler.NotificationStream)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/api/notifications/events", notificationHandler.ListNotificationFacts)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/api/notifications/events/stream", notificationHandler.NotificationFactsStream)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Patch("/api/notifications/{id}", notificationHandler.MarkNotificationRead)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Put("/api/notifications/mark-read", notificationHandler.MarkAllNotificationsRead)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/api/repos/{owner}/{repo}/issues/state-events", issueHandler.ListIssueStateFacts)
	r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/api/repos/{owner}/{repo}/issues/state-events/stream", issueHandler.IssueStateFactsStream)

	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	return &sseTicketRevocationFixture{
		pool:    pool,
		queries: queries,
		auth:    authService,
		server:  server,
		client:  server.Client(),
	}
}

func (f *sseTicketRevocationFixture) createPAT(t *testing.T, user routesIntegrationUser) services.CreateTokenResult {
	t.Helper()
	created, err := f.auth.CreateToken(context.Background(), user.ID, services.CreateTokenRequest{
		Name:   "sse-ticket-revocation",
		Scopes: []string{string(middleware.ScopeReadUser)},
	})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "token "+created.Token)
	require.Equal(t, created.Token, middleware.ExtractToken(req), "minted PAT must have accepted wire format")
	sum := sha256.Sum256([]byte(created.Token))
	_, err = f.queries.GetAuthInfoByTokenHash(context.Background(), hex.EncodeToString(sum[:]))
	require.NoError(t, err, "minted PAT must resolve through production auth query")
	return created
}

func (f *sseTicketRevocationFixture) mintTicket(t *testing.T, rawToken string) (string, time.Time) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.server.URL+"/api/auth/sse-ticket", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "token "+rawToken)
	resp, err := f.client.Do(req)
	require.NoError(t, err)
	body := routesIntegrationReadBody(t, resp)
	require.Equal(t, http.StatusOK, resp.StatusCode, "mint ticket: %s", body)

	var payload struct {
		Ticket    string    `json:"ticket"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	require.NoError(t, json.Unmarshal(body, &payload))
	require.NotEmpty(t, payload.Ticket)
	return payload.Ticket, payload.ExpiresAt
}

func (f *sseTicketRevocationFixture) openStream(t *testing.T, ctx context.Context, ticket string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/api/notifications?ticket="+url.QueryEscape(ticket), nil)
	require.NoError(t, err)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := f.client.Do(req)
	require.NoError(t, err)
	return resp
}

func TestSSETicket_DBTicketStreamEndsWhenSourceTokenIsRevoked(t *testing.T) {
	f := setupSSETicketRevocationFixture(t)
	user := routesIntegrationCreateUser(t, f.pool, "sse_ticket_revoke")
	pat := f.createPAT(t, user)

	ticket, _ := f.mintTicket(t, pat.Token)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp := f.openStream(t, ctx, ticket)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("Content-Type"), "text/event-stream")

	// The real deletion path publishes KindTokenRevoked with the PAT's hash.
	require.NoError(t, f.auth.DeleteToken(context.Background(), user.ID, pat.ID))

	// Read through EOF: observing an event alone does not prove the transport ends.
	type result struct {
		body []byte
		err  error
	}
	done := make(chan result, 1)
	go func() { body, err := io.ReadAll(resp.Body); done <- result{body, err} }()
	select {
	case got := <-done:
		require.NoError(t, got.err)
		require.Contains(t, string(got.body), "event: "+sse.RevokedEventType)
		var event revocation.Event
		for _, line := range strings.Split(string(got.body), "\n") {
			if strings.HasPrefix(line, "data: ") {
				require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event))
			}
		}
		assert.Equal(t, revocation.KindTokenRevoked, event.Kind)
		assert.Equal(t, pat.ID, event.TokenID)
	case <-time.After(5 * time.Second):
		t.Fatal("stream must emit revoked and reach EOF within 5s")
	}
}

func TestSSETicket_DBTicketRedemptionRefusedAfterSourceTokenRevoked(t *testing.T) {
	f := setupSSETicketRevocationFixture(t)
	user := routesIntegrationCreateUser(t, f.pool, "sse_ticket_stale")
	pat := f.createPAT(t, user)

	ticket, _ := f.mintTicket(t, pat.Token)
	require.NoError(t, f.auth.DeleteToken(context.Background(), user.ID, pat.ID))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := f.openStream(t, ctx, ticket)
	defer resp.Body.Close()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode, "a ticket minted by a since-revoked PAT must not open a stream")
}

// InvokeWorkflow completes the existing workflow integration spy's interface.

func TestSSETicket_DBTicketResponseCarriesExpiresAt(t *testing.T) {
	f := setupSSETicketRevocationFixture(t)
	user := routesIntegrationCreateUser(t, f.pool, "sse_ticket_expiry")
	pat := f.createPAT(t, user)

	_, expiresAt := f.mintTicket(t, pat.Token)
	require.False(t, expiresAt.IsZero(), "database tickets must report expires_at so the /v1/sse/ticket alias keeps its documented shape")
	assert.WithinDuration(t, time.Now().Add(services.SSETicketTTL), expiresAt, 5*time.Second)
}

func (f *sseTicketRevocationFixture) createBrowserSession(t *testing.T, user routesIntegrationUser) (string, string) {
	t.Helper()
	raw := uuid.NewString()
	sum := sha256.Sum256([]byte(raw))
	stored := hex.EncodeToString(sum[:])
	_, err := f.queries.CreateAuthSession(context.Background(), db.CreateAuthSessionParams{
		SessionKey: stored, UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	return raw, stored
}

func (f *sseTicketRevocationFixture) mintSessionTicket(t *testing.T, cookie string) (string, int) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.server.URL+"/api/auth/sse-ticket", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
	resp, err := f.client.Do(req)
	require.NoError(t, err)
	body := routesIntegrationReadBody(t, resp)
	var payload struct {
		Ticket string `json:"ticket"`
	}
	if resp.StatusCode == http.StatusOK {
		require.NoError(t, json.Unmarshal(body, &payload))
	}
	return payload.Ticket, resp.StatusCode
}

func TestSSETicket_SessionTicketStreamEndsOnlyForRevokedBrowserSession(t *testing.T) {
	for _, operation := range []string{"logout", "session_deleted"} {
		t.Run(operation, func(t *testing.T) {
			f := setupSSETicketRevocationFixture(t)
			user := routesIntegrationCreateUser(t, f.pool, "sse_session_revoke")
			revokedCookie, revokedStored := f.createBrowserSession(t, user)
			liveCookie, _ := f.createBrowserSession(t, user)

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			open := func(cookie string) *http.Response {
				ticket, status := f.mintSessionTicket(t, cookie)
				require.Equal(t, http.StatusOK, status)
				resp := f.openStream(t, ctx, ticket)
				t.Cleanup(func() { resp.Body.Close() })
				require.Equal(t, http.StatusOK, resp.StatusCode)
				return resp
			}
			revokedStream := open(revokedCookie)
			liveStream := open(liveCookie)

			switch operation {
			case "logout":
				require.NoError(t, f.auth.Logout(context.Background(), revokedCookie))
			case "session_deleted":
				require.NoError(t, f.auth.RevokeUserSession(context.Background(), user.ID, services.SessionPublicID(revokedStored)))
			}

			type result struct {
				body []byte
				err  error
			}
			done := make(chan result, 1)
			go func() { body, err := io.ReadAll(revokedStream.Body); done <- result{body, err} }()
			select {
			case got := <-done:
				require.NoError(t, got.err)
				require.Contains(t, string(got.body), "event: "+sse.RevokedEventType)
				var event revocation.Event
				for _, line := range strings.Split(string(got.body), "\n") {
					if strings.HasPrefix(line, "data: ") {
						_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event)
					}
				}
				assert.Equal(t, revocation.KindBrowserSessionRevoked, event.Kind)
				assert.Equal(t, revokedStored, event.TokenHash, "the event names the session digest, never the raw key")
			case <-time.After(5 * time.Second):
				t.Fatal("revoked session stream must emit revoked and reach EOF within 5s")
			}

			// The other session of the same user keeps its stream and can mint again.
			liveEnded := make(chan struct{})
			go func() { _, _ = io.Copy(io.Discard, liveStream.Body); close(liveEnded) }()
			select {
			case <-liveEnded:
				t.Fatal("revoking one browser session ended another session's stream")
			case <-time.After(500 * time.Millisecond):
			}
			_, status := f.mintSessionTicket(t, liveCookie)
			require.Equal(t, http.StatusOK, status)
			_, status = f.mintSessionTicket(t, revokedCookie)
			require.Equal(t, http.StatusUnauthorized, status)
		})
	}
}
