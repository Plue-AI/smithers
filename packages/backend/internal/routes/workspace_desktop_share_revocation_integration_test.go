package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

// A real relay must close both a member's WebSocket when their share goes
// away and that same socket when the workspace owner loses access. Each case
// uses an immutable authorization target, avoiding races with live handlers.
func TestDesktopRelayEstablishedWebSocketFollowsMemberAndOwnerRevocation(t *testing.T) {
	member := services.WorkspaceDesktopRelayTarget{
		WorkspaceID: "ws1", Domain: "smithers-desk-vm.preview.jjhub.tech",
		UserID: 2, OwnerUserID: 1, RepositoryID: 9,
	}
	owner := member
	owner.UserID = 1
	for _, tc := range []struct {
		name        string
		target      services.WorkspaceDesktopRelayTarget
		unrelated   []revocation.Event
		terminating revocation.Event
	}{
		{
			name:   "member share removed",
			target: member,
			unrelated: []revocation.Event{
				{Kind: revocation.KindWorkspaceShareRemoved, WorkspaceID: "ws1", UserID: 3, SandboxIDs: []string{"vm"}},
			},
			terminating: revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, WorkspaceID: "ws1", UserID: 2, SandboxIDs: []string{"vm"}},
		},
		{
			name:   "owner disabled closes member",
			target: member,
			unrelated: []revocation.Event{
				{Kind: revocation.KindUserDisabled, UserID: 3},
			},
			terminating: revocation.Event{Kind: revocation.KindUserDisabled, UserID: 1},
		},
		{
			name:   "owner collaborator removed closes member",
			target: member,
			unrelated: []revocation.Event{
				{Kind: revocation.KindCollaboratorRemoved, UserID: 1, RepositoryID: 10, SandboxIDs: []string{"other-vm"}},
				{Kind: revocation.KindCollaboratorRemoved, UserID: 3, RepositoryID: 9, SandboxIDs: []string{"other-vm"}},
			},
			terminating: revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: 1, RepositoryID: 9, SandboxIDs: []string{"vm"}},
		},
		{
			name:   "owner stream survives member share removal",
			target: owner,
			unrelated: []revocation.Event{
				{Kind: revocation.KindWorkspaceShareRemoved, WorkspaceID: "ws1", UserID: 2, SandboxIDs: []string{"vm"}},
			},
			terminating: revocation.Event{Kind: revocation.KindUserDisabled, UserID: 1},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			previous := currentRevocationSource()
			SetRevocationSource(bus)
			t.Cleanup(func() { SetRevocationSource(previous) })

			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer ws.CloseNow()
				for {
					kind, data, err := ws.Read(r.Context())
					if err != nil {
						return
					}
					if err := ws.Write(r.Context(), kind, data); err != nil {
						return
					}
				}
			}))
			defer guest.Close()
			gateway := previewgateway.NewHandler(loopbackPortDialer(strings.TrimPrefix(guest.URL, "http://")), []string{".preview.jjhub.tech"}, nil)
			gateway.SetRelayToken("relay-secret")
			hop := httptest.NewServer(gateway)
			defer hop.Close()
			service := &stubDesktopService{token: "desktop-token", target: tc.target}
			api := httptest.NewServer(newDesktopRelayRouter(&WorkspaceDesktopHandler{Service: service, RelayServiceURL: hop.URL, RelayToken: "relay-secret"}))
			defer api.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, _, err := websocket.Dial(ctx, api.URL+"/api/workspaces/ws1/desktop/desktop-token/websockify", nil)
			require.NoError(t, err)
			defer ws.CloseNow()
			echoDesktopRelay(t, ws, "before-revocation")
			for _, event := range tc.unrelated {
				bus.Deliver(event)
				echoDesktopRelay(t, ws, "after-unrelated-revocation")
			}
			bus.Deliver(tc.terminating)
			readCtx, readCancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer readCancel()
			_, _, err = ws.Read(readCtx)
			require.Error(t, err, "matching revocation must close the WebSocket")
			require.NoError(t, readCtx.Err(), "WebSocket must close before the read deadline")
		})
	}
}

func echoDesktopRelay(t *testing.T, ws *websocket.Conn, value string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	require.NoError(t, ws.Write(ctx, websocket.MessageBinary, []byte(value)))
	kind, data, err := ws.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Equal(t, value, string(data))
}
