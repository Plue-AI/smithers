package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
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
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The source calls the manager first and holds the guard's callback. This
// reproduces a manager cancellation racing ahead of route notification.
type managerFirstRevocationSource struct {
	*revocation.Bus
	onEvent func(revocation.Event)
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *managerFirstRevocationSource) Subscribe(fn func(revocation.Event)) func() {
	return s.Bus.Subscribe(func(event revocation.Event) {
		s.once.Do(func() {
			s.onEvent(event)
			close(s.entered)
		})
		<-s.release
		fn(event)
	})
}

func TestWorkspaceSocketManagerFirstRevocationRejectsStartup(t *testing.T) {
	for _, kind := range []string{"lsp", "terminal"} {
		for _, revocationCase := range []struct {
			name  string
			event revocation.Event
		}{
			{"share", revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "workspace-1"}},
			{"organization", revocation.Event{Kind: revocation.KindOrgMemberRemoved, UserID: 7, OrganizationID: 33}},
		} {
			t.Run(kind+"/"+revocationCase.name, func(t *testing.T) {
				bus := revocation.NewBus(nil, nil)
				dialEntered := make(chan struct{})
				var handler *WorkspaceTerminalHandler
				var revokeManager func(revocation.Event)
				if kind == "lsp" {
					manager := NewLSPSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
						close(dialEntered)
						<-ctx.Done()
						return nil, nil, ctx.Err()
					})
					t.Cleanup(manager.Close)
					revokeManager = manager.RevokeMatching
					handler = &WorkspaceTerminalHandler{Service: lspTestService("running"), AllowedOrigins: []string{"https://smithers.sh"}, LSPSessions: manager}
				} else {
					manager := NewTerminalSessionManager(func(ctx context.Context, _ services.WorkspaceSSHConnectionInfo, _, _ int32) (terminalSSHClient, terminalSSHSession, error) {
						close(dialEntered)
						<-ctx.Done()
						return nil, nil, ctx.Err()
					})
					t.Cleanup(manager.Close)
					revokeManager = manager.RevokeMatching
					service := lspTestService("running")
					service.getSessionFunc = func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
						row := lspTestSession("s1", 11, 7, "running")
						row.Kind = services.WorkspaceSessionKindTerminal
						return row, nil
					}
					handler = &WorkspaceTerminalHandler{Service: service, AllowedOrigins: []string{"https://smithers.sh"}, TerminalSessions: manager}
				}
				source := &managerFirstRevocationSource{Bus: bus, onEvent: revokeManager, entered: make(chan struct{}), release: make(chan struct{})}
				var releaseOnce sync.Once
				t.Cleanup(func() { releaseOnce.Do(func() { close(source.release) }) })
				withSocketRevocationSource(t, source)
				router := chi.NewRouter()
				router.Use(func(next http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenHash: "token-7"})
						ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
							Owner: "acme", Repository: &db.Repository{ID: 11, Name: "repo", OrgID: pgtype.Int8{Int64: 33, Valid: true}},
						}, middleware.PermissionWrite)
						next.ServeHTTP(w, r.WithContext(ctx))
					})
				})
				path := "/repos/{owner}/{repo}/workspace/sessions/{id}/" + kind
				if kind == "lsp" {
					router.Get(path, handler.LSPWebSocket)
				} else {
					router.Get(path, handler.TerminalWebSocket)
				}
				server := httptest.NewServer(router)
				t.Cleanup(server.Close)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				result := make(chan *http.Response, 1)
				go func() {
					ws, response, _ := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/"+kind, &websocket.DialOptions{Subprotocols: []string{kind}})
					if ws != nil {
						ws.CloseNow()
					}
					result <- response
				}()
				select {
				case <-dialEntered:
				case <-ctx.Done():
					t.Fatal("startup did not enter dialer")
				}
				delivered := make(chan struct{})
				go func() { bus.Deliver(revocationCase.event); close(delivered) }()
				select {
				case <-source.entered:
				case <-ctx.Done():
					t.Fatal("manager-first revocation callback did not run")
				}
				var response *http.Response
				select {
				case response = <-result:
				case <-ctx.Done():
					t.Fatal("canceled startup did not answer while guard callback was delayed")
				}
				require.NotNil(t, response)
				defer response.Body.Close()
				require.Equal(t, http.StatusForbidden, response.StatusCode)
				releaseOnce.Do(func() { close(source.release) })
				select {
				case <-delivered:
				case <-ctx.Done():
					t.Fatal("bus delivery did not finish")
				}
			})
		}
	}
}

// The upgrade succeeds, then the manager revokes before addSink while the
// route guard's callback remains blocked. No replay or usable socket may escape.
func TestWorkspaceSocketManagerFirstBetweenUpgradeAndAttach(t *testing.T) {
	for _, kind := range []string{"terminal", "lsp"} {
		t.Run(kind, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			var terminalManager *TerminalSessionManager
			var lspManager *LSPSessionManager
			var revokeManager func(revocation.Event)
			if kind == "terminal" {
				fake := newFakeTerminalSSH()
				terminalManager = NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
					return fake.client, fake.session, nil
				})
				terminalManager.keepaliveInterval = 0
				t.Cleanup(terminalManager.Close)
				revokeManager = terminalManager.RevokeMatching
			} else {
				lspManager, _ = newLSPRelayManager(t, 0, true)
				revokeManager = lspManager.RevokeMatching
			}
			source := &managerFirstRevocationSource{Bus: bus, onEvent: revokeManager, entered: make(chan struct{}), release: make(chan struct{})}
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(source.release) }) })
			withSocketRevocationSource(t, source)
			service := lspTestService("running")
			service.getSessionFunc = func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
				row := lspTestSession("s1", 11, 7, "running")
				row.Kind = kind
				return row, nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			delivered := make(chan struct{})
			revokeBeforeAttach := func() {
				go func() {
					bus.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "workspace-1", Reason: "share removed"})
					close(delivered)
				}()
				select {
				case <-source.entered:
				case <-ctx.Done():
					t.Error("manager-first revocation did not run")
				}
			}
			handler := &WorkspaceTerminalHandler{Service: service, TerminalSessions: terminalManager, LSPSessions: lspManager,
				beforeTerminalAttach: func(*terminalSession) { revokeBeforeAttach() },
				beforeLSPAttach:      func(*lspSession) { revokeBeforeAttach() },
			}
			server := httptest.NewServer(managerFirstSocketRouter(handler, kind))
			defer server.Close()
			ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/"+kind, &websocket.DialOptions{Subprotocols: []string{kind}})
			require.NoError(t, err)
			defer ws.CloseNow()
			_, _, err = ws.Read(ctx)
			require.Error(t, err)
			require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
			releaseOnce.Do(func() { close(source.release) })
			select {
			case <-delivered:
			case <-ctx.Done():
				t.Fatal("bus delivery did not finish")
			}
		})
	}
}

func managerFirstSocketRouter(handler *WorkspaceTerminalHandler, kind string) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenHash: "token-7"})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "acme", Repository: &db.Repository{ID: 11, Name: "repo"}}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	path := "/repos/{owner}/{repo}/workspace/sessions/{id}/" + kind
	if kind == "lsp" {
		router.Get(path, handler.LSPWebSocket)
	} else {
		router.Get(path, handler.TerminalWebSocket)
	}
	return router
}

// Retain the dying session in the manager until teardown completes, so a
// reconnect exercises getOrCreate's existing-but-dead path before upgrade.
func TestWorkspaceSocketManagerFirstRevokedTerminalReuseForbidden(t *testing.T) {
	withSocketRevocationSource(t, revocation.NewBus(nil, nil))
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	t.Cleanup(manager.Close)
	session, created, err := manager.getOrCreate(context.Background(), "s1", services.WorkspaceSSHConnectionInfo{Kind: "container"}, 80, 24, revocation.Principal{UserID: 7, WorkspaceID: "workspace-1"})
	require.NoError(t, err)
	require.True(t, created)
	teardownEntered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); <-finished })
	onDone := session.onDone
	session.onDone = func() { close(teardownEntered); <-release; onDone() }
	go func() {
		manager.RevokeMatching(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: 7, WorkspaceID: "workspace-1"})
		close(finished)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	select {
	case <-teardownEntered:
	case <-ctx.Done():
		t.Fatal("revocation teardown did not run")
	}
	service := lspTestService("running")
	service.getSessionFunc = func(context.Context, string, int64, int64) (services.WorkspaceSessionResponse, error) {
		row := lspTestSession("s1", 11, 7, "running")
		row.Kind = services.WorkspaceSessionKindTerminal
		return row, nil
	}
	server := httptest.NewServer(managerFirstSocketRouter(&WorkspaceTerminalHandler{Service: service, TerminalSessions: manager}, "terminal"))
	defer server.Close()
	ws, response, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/repos/acme/repo/workspace/sessions/s1/terminal", &websocket.DialOptions{Subprotocols: []string{"terminal"}})
	if ws != nil {
		defer ws.CloseNow()
	}
	require.Error(t, err)
	require.NotNil(t, response)
	defer response.Body.Close()
	require.Equal(t, http.StatusForbidden, response.StatusCode)
	once.Do(func() { close(release) })
}
