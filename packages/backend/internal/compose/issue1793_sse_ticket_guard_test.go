package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// A ticket is resolved after AuthLoader. Exercise the mounted router so the
// revocation check must see the principal installed by ticket auth.
func TestIssue1793SSETicketRouterChecksRevocationAfterTicketAuth(t *testing.T) {
	queries, principal := sseTicketRouterQueries(t)
	service := services.NewSSETicketService(queries)
	bus := revocation.NewBus(nil, queries)
	previous := revocationChecker
	t.Cleanup(func() { revocationChecker = previous })
	revocationChecker = bus

	sum := sha256.Sum256([]byte(principal.rawToken))
	tokenHash := hex.EncodeToString(sum[:])
	router := issue1793SSETicketRouter(queries)
	// The same mounted route first accepts a live ticket and reaches the
	// notification handler. This fixture has no broker, so that handler
	// reports its own configuration error after authentication succeeds.
	liveTicket, err := service.CreateTicket(context.Background(), principal.userID, true, "read:user", tokenHash)
	require.NoError(t, err)
	liveReq := httptest.NewRequest(http.MethodGet, "/api/notifications/events/stream?ticket="+url.QueryEscape(liveTicket.Ticket), nil)
	liveRec := httptest.NewRecorder()
	router.ServeHTTP(liveRec, liveReq)
	require.Equal(t, http.StatusInternalServerError, liveRec.Code, liveRec.Body.String())
	require.Contains(t, liveRec.Body.String(), "SSE not configured: broker is nil")

	// A session-minted ticket names its session digest; the row must exist
	// because redemption revalidates the session in the database.
	newSession := func() string {
		sum := sha256.Sum256([]byte(uuid.NewString()))
		hash := hex.EncodeToString(sum[:])
		_, createErr := queries.CreateAuthSession(context.Background(), db.CreateAuthSessionParams{
			SessionKey: hash, UserID: principal.userID, Username: "sse-ticket-session", ExpiresAt: time.Now().Add(time.Hour),
		})
		require.NoError(t, createErr)
		return hash
	}
	sessionHash, otherSessionHash := newSession(), newSession()

	for _, tc := range []struct {
		name           string
		tokenAuth      bool
		credentialHash string
		event          revocation.Event
		want           int
		wantBody       string
	}{
		{"revoked minting token", true, tokenHash, revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: tokenHash}, http.StatusUnauthorized, `"code":"unauthenticated"`},
		{"revoked minting browser session", false, sessionHash, revocation.Event{Kind: revocation.KindBrowserSessionRevoked, TokenHash: sessionHash}, http.StatusUnauthorized, `"code":"unauthenticated"`},
		{"disabled session user", false, otherSessionHash, revocation.Event{Kind: revocation.KindUserDisabled, UserID: principal.userID}, http.StatusForbidden, "account is suspended"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bus.Deliver(tc.event)
			ticket, err := service.CreateTicket(context.Background(), principal.userID, tc.tokenAuth, "read:user", tc.credentialHash)
			require.NoError(t, err)
			req := httptest.NewRequest(http.MethodGet, "/api/notifications/events/stream?ticket="+url.QueryEscape(ticket.Ticket), nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, tc.want, rec.Code)
			require.Contains(t, rec.Body.String(), tc.wantBody)
		})
	}
}

func issue1793SSETicketRouter(queries *db.Queries) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(), queries, nil,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{},
		&routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{}, nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		&routes.NotificationHandler{Service: &mockRouterNotificationService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}
