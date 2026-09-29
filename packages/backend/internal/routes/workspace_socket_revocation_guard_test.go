package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

func socketRevocationRequest() *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 7}, IsTokenAuth: true, TokenHash: "token-7",
	})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
		Repository: &db.Repository{ID: 11},
	}, middleware.PermissionWrite)
	return r.WithContext(ctx)
}

func withSocketRevocationSource(t *testing.T, source RevocationSource) {
	t.Helper()
	previous := currentRevocationSource()
	SetRevocationSource(source)
	t.Cleanup(func() { SetRevocationSource(previous) })
}

type delayedSocketRevocationSource struct {
	*revocation.Bus
	entered     chan struct{}
	release     <-chan struct{}
	enteredOnce sync.Once
}

func (s *delayedSocketRevocationSource) Subscribe(fn func(revocation.Event)) func() {
	return s.Bus.Subscribe(func(event revocation.Event) {
		s.enteredOnce.Do(func() { close(s.entered) })
		<-s.release
		fn(event)
	})
}

func TestWorkspaceSocketRevocationGuardCachedCredential(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"token", revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"}},
		{"user", revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			bus.Deliver(tc.event)
			withSocketRevocationSource(t, bus)
			guard := watchWorkspaceSocket(socketRevocationRequest())
			defer guard.close()
			response := httptest.NewRecorder()
			require.True(t, guard.reject(response))
			require.Equal(t, http.StatusForbidden, response.Code)
			select {
			case <-guard.ctx.Done():
			default:
				t.Fatal("cached revocation left startup active")
			}
		})
	}
}

func TestWorkspaceSocketRevocationMiddlewareRejectsCachedTokenBeforeNext(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
	withSocketRevocationSource(t, bus)
	called := false
	next := WorkspaceSocketRevocations(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	response := httptest.NewRecorder()
	next.ServeHTTP(response, socketRevocationRequest())
	require.Equal(t, http.StatusForbidden, response.Code)
	require.False(t, called, "cached revocation must stop repository lookup")
}

func TestWorkspaceSocketRevocationGuardRechecksCacheBeforeUpgrade(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	withSocketRevocationSource(t, &delayedSocketRevocationSource{Bus: bus, entered: entered, release: release})
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	delivered := make(chan struct{})
	go func() {
		bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
		close(delivered)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("bus did not cache the event before the delayed callback")
	}
	response := httptest.NewRecorder()
	require.True(t, guard.reject(response), "cached credential deletion must stop upgrade before its subscriber runs")
	require.Equal(t, http.StatusForbidden, response.Code)
	select {
	case <-guard.ctx.Done():
	default:
		t.Fatal("cache recheck did not cancel startup")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-delivered:
	case <-time.After(5 * time.Second):
		t.Fatal("delayed bus delivery did not complete")
	}
}

func TestWorkspaceSocketRevocationGuardAdoptsAlreadyRevokedMiddlewareContext(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	request := socketRevocationRequest()
	guard := watchWorkspaceSocket(request)
	defer guard.close()
	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
	request = request.WithContext(context.WithValue(request.Context(), workspaceSocketRevocationKey{}, guard))
	require.Same(t, guard, watchWorkspaceSocket(request))
	require.True(t, guard.reject(httptest.NewRecorder()))
	select {
	case <-guard.ctx.Done():
	default:
		t.Fatal("adopted guard lost its cancellation")
	}
}

func TestWorkspaceSocketRevocationGuardScopeAndUnrelatedEvents(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()

	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "someone-else"})
	bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 8, WorkspaceID: "workspace"})
	bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "workspace"})
	require.False(t, guard.reject(httptest.NewRecorder()), "scope is unresolved before session lookup")
	principal := guard.scope("workspace", "vm", true)
	require.Equal(t, int64(11), principal.RepositoryID)
	require.Equal(t, "workspace", principal.WorkspaceID)
	require.True(t, guard.reject(httptest.NewRecorder()), "the matching share removal must survive the lookup window")
}

func TestWorkspaceSocketRevocationGuardBuffersSandboxEvent(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	bus.Deliver(revocation.Event{Kind: revocation.KindCollaboratorRemoved, SandboxIDs: []string{"vm-1"}})
	require.False(t, guard.reject(httptest.NewRecorder()))
	guard.scope("workspace", "vm-1", true)
	require.True(t, guard.reject(httptest.NewRecorder()))
}

func TestWorkspaceSocketRevocationGuardRepeatEventIsIdempotent(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	event := revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"}
	bus.Deliver(event)
	bus.Deliver(event)
	require.True(t, guard.reject(httptest.NewRecorder()))
}

func TestWorkspaceSocketRevocationGuardUnrelatedScopeStaysUsable(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "another"})
	guard.scope("workspace", "vm", true)
	require.False(t, guard.reject(httptest.NewRecorder()))
	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "someone-else"})
	require.False(t, guard.reject(httptest.NewRecorder()))
}

func TestWorkspaceSocketRevocationGuardOverfullAdmissionRetryable(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	for i := 0; i < 65; i++ {
		bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "unknown-" + strconv.Itoa(i)})
	}
	response := httptest.NewRecorder()
	require.True(t, guard.reject(response))
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	require.False(t, guard.revoked)
	require.Len(t, guard.pending, 64)
}

func TestWorkspaceSocketRevocationGuardDuplicateScopeEventsDoNotExhaustAdmission(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"same share", revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "other"}},
		{"same sandbox", revocation.Event{Kind: revocation.KindCollaboratorRemoved, SandboxIDs: []string{"other-vm"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			withSocketRevocationSource(t, bus)
			guard := watchWorkspaceSocket(socketRevocationRequest())
			defer guard.close()
			for i := 0; i < 100; i++ {
				bus.Deliver(tc.event)
			}
			guard.scope("workspace", "vm", true)
			require.False(t, guard.reject(httptest.NewRecorder()), "one repeated unknown resource must not exhaust admission")
			require.NoError(t, guard.ctx.Err())
		})
	}
}

func TestWorkspaceSocketRevocationGuardDistinctSandboxEventsRetryable(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	for i := 0; i < 65; i++ {
		bus.Deliver(revocation.Event{Kind: revocation.KindCollaboratorRemoved, SandboxIDs: []string{"unknown-vm-" + strconv.Itoa(i)}})
	}
	response := httptest.NewRecorder()
	require.True(t, guard.reject(response))
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	require.False(t, guard.revoked)
	require.Len(t, guard.pendingSandboxes, 64)
	guard.scope("workspace", "unknown-vm-0", true)
	response = httptest.NewRecorder()
	require.True(t, guard.reject(response))
	require.Equal(t, http.StatusForbidden, response.Code, "a retained matching sandbox revocation takes priority over overflow")
}

func TestWorkspaceSocketRevocationGuardUnrelatedBurstDoesNotExhaustAdmission(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	withSocketRevocationSource(t, bus)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	for i := 0; i < 100; i++ {
		bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 8, WorkspaceID: "other"})
		bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "another-token"})
	}
	guard.scope("workspace", "vm", true)
	require.False(t, guard.reject(httptest.NewRecorder()))
}

func TestWorkspaceSocketRevocationGuardBindBeforeAndAfterEvent(t *testing.T) {
	for _, phase := range []string{"before_bind", "after_bind"} {
		t.Run(phase, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			withSocketRevocationSource(t, bus)
			guard := watchWorkspaceSocket(socketRevocationRequest())
			defer guard.close()
			guard.scope("workspace", "vm", true)
			serverWS, clientWS, cleanup := terminalSessionManagerHWebsocketPair(t)
			defer cleanup()
			bound := make(chan bool, 1)
			if phase == "before_bind" {
				bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
				go func() { bound <- guard.bind(serverWS) }()
			} else {
				bound <- guard.bind(serverWS)
				bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _, err := clientWS.Read(ctx)
			require.Error(t, err)
			require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
			require.Equal(t, phase == "after_bind", <-bound)
		})
	}
}

func TestWorkspaceSocketRevocationGuardWithoutBus(t *testing.T) {
	withSocketRevocationSource(t, nil)
	guard := watchWorkspaceSocket(socketRevocationRequest())
	defer guard.close()
	guard.scope("workspace", "vm", true)
	require.False(t, guard.reject(httptest.NewRecorder()))
}

func TestWorkspaceSocketRevocationMiddlewareCoversRepositoryLookup(t *testing.T) {
	for _, kind := range []string{"terminal", "lsp"} {
		for _, event := range []struct {
			name  string
			value revocation.Event
		}{
			{"collaborator", revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: 7, RepositoryID: 11}},
			{"organization", revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: 7, OrganizationID: 33}},
		} {
			t.Run(kind+"/"+event.name, func(t *testing.T) {
				bus := revocation.NewBus(nil, nil)
				withSocketRevocationSource(t, bus)
				handler := &WorkspaceTerminalHandler{Service: &mockWorkspaceTerminalService{}, AllowedOrigins: []string{"https://smithers.sh"}}
				router := chi.NewRouter()
				router.Use(func(next http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
							User: &db.User{ID: 7}, IsTokenAuth: true, TokenHash: "token-7",
						})
						next.ServeHTTP(w, r.WithContext(ctx))
					})
				})
				router.Use(WorkspaceSocketRevocations)
				router.Use(func(next http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						// The revocation lands while repo authorization is loading,
						// before the handler can learn the repository and organization.
						bus.Deliver(event.value)
						ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{
							Owner: "acme", Repository: &db.Repository{ID: 11, Name: "repo", OrgID: pgtype.Int8{Int64: 33, Valid: true}},
						}, middleware.PermissionWrite)
						next.ServeHTTP(w, r.WithContext(ctx))
					})
				})
				path := "/repos/{owner}/{repo}/workspace/sessions/{id}/" + kind
				if kind == "terminal" {
					router.Get(path, handler.TerminalWebSocket)
				} else {
					router.Get(path, handler.LSPWebSocket)
				}
				server := httptest.NewServer(router)
				defer server.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				ws, response, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/"+kind, &websocket.DialOptions{Subprotocols: []string{kind}})
				if ws != nil {
					ws.CloseNow()
				}
				require.Error(t, err)
				require.NotNil(t, response)
				defer response.Body.Close()
				require.Equal(t, http.StatusForbidden, response.StatusCode)
			})
		}
	}
}

func TestWorkspaceSocketRevocationMiddlewareOverflowRetry(t *testing.T) {
	for _, matching := range []bool{false, true} {
		t.Run(strconv.FormatBool(matching), func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			withSocketRevocationSource(t, bus)
			response := httptest.NewRecorder()
			WorkspaceSocketRevocations(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for i := 0; i < 65; i++ {
					bus.Deliver(revocation.Event{Kind: revocation.KindAgentSessionCancelled, SandboxIDs: []string{"other-" + strconv.Itoa(i)}})
				}
				guard := watchWorkspaceSocket(r)
				require.ErrorIs(t, guard.ctx.Err(), context.Canceled)
				require.False(t, guard.revoked)
				require.Len(t, guard.pendingSandboxes, 64)
				if matching {
					bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-7"})
				}
				require.True(t, guard.reject(w))
			})).ServeHTTP(response, socketRevocationRequest())
			if matching {
				require.Equal(t, http.StatusForbidden, response.Code)
				require.Empty(t, response.Header().Get("Retry-After"))
			} else {
				require.Equal(t, http.StatusServiceUnavailable, response.Code)
				require.Equal(t, "1", response.Header().Get("Retry-After"))
				require.Contains(t, response.Body.String(), `"code":"service_unavailable"`)
				require.Contains(t, response.Body.String(), `"retry_after":1`)
			}
		})
	}
}
