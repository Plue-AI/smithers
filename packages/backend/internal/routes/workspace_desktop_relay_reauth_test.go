package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The first token check can become stale before the relay starts watching
// revocations. A second check must run after Watch and before any upstream
// request; an event delivered during that check must also stop the request.
func TestDesktopRelayReauthorizesAfterWatchBeforeProxy(t *testing.T) {
	initial := services.WorkspaceDesktopRelayTarget{
		WorkspaceID: "ws1", Domain: "smithers-desk-vm.preview.jjhub.tech", UserID: 2, OwnerUserID: 1, RepositoryID: 9,
	}
	for _, tc := range []struct {
		name        string
		beforeWatch bool
		second      func(*desktopReauthWatch, services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error)
		status      int
		body        string
		upstream    int32
	}{
		{
			name:        "share removed before watch registration",
			beforeWatch: true,
			second: func(_ *desktopReauthWatch, _ services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error) {
				return services.WorkspaceDesktopRelayTarget{}, pkgerrors.Forbidden("desktop access revoked")
			},
			status: http.StatusForbidden, body: `"code":"forbidden"`,
		},
		{
			name: "target changes during reauthorization",
			second: func(_ *desktopReauthWatch, target services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error) {
				target.UserID = 1
				return target, nil
			},
			status: http.StatusUnauthorized, body: "desktop session changed",
		},
		{
			name: "revocation delivered during reauthorization",
			second: func(source *desktopReauthWatch, target services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error) {
				source.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, WorkspaceID: target.WorkspaceID, UserID: target.UserID})
				return target, nil
			},
			status: http.StatusForbidden, body: "desktop access revoked",
		},
		{
			name: "unchanged authorization proceeds",
			second: func(_ *desktopReauthWatch, target services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error) {
				return target, nil
			},
			status: http.StatusOK, body: "viewer", upstream: 1,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := &desktopReauthWatch{Bus: revocation.NewBus(nil, nil)}
			previous := currentRevocationSource()
			SetRevocationSource(source)
			t.Cleanup(func() { SetRevocationSource(previous) })

			var upstreamHits atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				upstreamHits.Add(1)
				_, _ = w.Write([]byte("viewer"))
			}))
			defer upstream.Close()

			service := &desktopReauthService{target: initial}
			if tc.beforeWatch {
				service.afterFirst = func() {
					require.False(t, source.watched.Load(), "the share was removed before the watch existed")
					source.Deliver(revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, WorkspaceID: initial.WorkspaceID, UserID: initial.UserID})
				}
			}
			service.second = func(target services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error) {
				require.True(t, source.watched.Load(), "watch must precede the second authorization")
				require.Equal(t, revocation.Principal{WorkspaceID: "ws1", UserID: 2, OwnerUserID: 1, RepositoryID: 9}, source.principal)
				return tc.second(source, target)
			}
			handler := &WorkspaceDesktopHandler{Service: service, RelayServiceURL: upstream.URL}
			rec := httptest.NewRecorder()
			newDesktopRelayRouter(handler).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/ws1/desktop/token/vnc.html", nil))

			require.Equal(t, tc.status, rec.Code)
			require.Contains(t, rec.Body.String(), tc.body)
			require.Equal(t, int32(2), service.calls.Load(), "both token checks must run")
			require.Equal(t, tc.upstream, upstreamHits.Load(), "relay must not dial upstream after revoked authorization")
			if tc.status != http.StatusOK {
				for key, value := range desktopRelayResponseHeaders {
					require.Equal(t, value, rec.Header().Get(key), key)
				}
			}
		})
	}
}

type desktopReauthWatch struct {
	*revocation.Bus
	watched   atomic.Bool
	principal revocation.Principal
}

func (s *desktopReauthWatch) Watch(ctx context.Context, principal revocation.Principal) <-chan revocation.Event {
	s.principal = principal
	s.watched.Store(true)
	return s.Bus.Watch(ctx, principal)
}

type desktopReauthService struct {
	WorkspaceDesktopRouteService
	target     services.WorkspaceDesktopRelayTarget
	afterFirst func()
	second     func(services.WorkspaceDesktopRelayTarget) (services.WorkspaceDesktopRelayTarget, error)
	calls      atomic.Int32
}

func (s *desktopReauthService) AuthorizeDesktopRelay(_ context.Context, _, _ string) (services.WorkspaceDesktopRelayTarget, error) {
	if s.calls.Add(1) == 1 {
		if s.afterFirst != nil {
			s.afterFirst()
		}
		return s.target, nil
	}
	return s.second(s.target)
}
