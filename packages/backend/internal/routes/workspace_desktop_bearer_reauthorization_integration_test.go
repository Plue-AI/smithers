//go:build integration

package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

func TestDesktopRelayBearerReauthorizationAfterAccountOrRepositoryRevocation(t *testing.T) {
	for _, tc := range []struct {
		name          string
		ownerToken    bool
		revokeOwner   bool
		revokeRepo    bool
		revokeCreator bool
		downgrade     bool
	}{
		{name: "member bearer creator suspended"},
		{name: "member bearer owner suspended", revokeOwner: true},
		{name: "owner bearer owner suspended", ownerToken: true, revokeOwner: true},
		{name: "member bearer owner loses repository", revokeRepo: true},
		{name: "owner bearer loses repository", ownerToken: true, revokeRepo: true},
		{name: "member bearer creator loses repository", revokeRepo: true, revokeCreator: true},
		{name: "member bearer creator loses repository write", revokeRepo: true, revokeCreator: true, downgrade: true},
		{name: "owner bearer creator loses repository write", ownerToken: true, revokeRepo: true, downgrade: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := setupRoutesIntegrationPool(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			queries := db.New(pool)

			repoOwner := routesIntegrationCreateUser(t, pool, "relay_repo_owner")
			owner := routesIntegrationCreateUser(t, pool, "relay_workspace_owner")
			member := routesIntegrationCreateUser(t, pool, "relay_member")
			other := routesIntegrationCreateUser(t, pool, "relay_other")
			repo := routesIntegrationCreateRepo(t, pool, repoOwner, "relay_private", false)
			otherRepo := routesIntegrationCreateRepo(t, pool, other, "relay_other_private", false)
			for _, user := range []routesIntegrationUser{owner, member} {
				_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, user.ID)
				require.NoError(t, err)
			}
			creator := member
			if tc.ownerToken {
				creator = owner
			}
			workspaceID, token := seedDesktopBearerWorkspace(t, ctx, pool, repo.ID, owner.ID, creator.ID, "relay-vm")
			if !tc.ownerToken {
				_, err := queries.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
					WorkspaceID: workspaceID, OwnerUserID: owner.ID, GranteeUserID: member.ID, Level: "write",
				})
				require.NoError(t, err)
			}
			otherWorkspaceID, otherToken := seedDesktopBearerWorkspace(t, ctx, pool, otherRepo.ID, other.ID, other.ID, "other-relay-vm")
			controls := []struct{ id, token string }{{otherWorkspaceID, otherToken}}
			if tc.revokeRepo {
				// The event is scoped to both this user and this repository.
				revoked := owner
				if tc.revokeCreator {
					revoked = member
				}
				_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, otherRepo.ID, revoked.ID)
				require.NoError(t, err)
				id, bearer := seedDesktopBearerWorkspace(t, ctx, pool, otherRepo.ID, revoked.ID, revoked.ID, "revoked-user-other-repo-vm")
				controls = append(controls, struct{ id, token string }{id, bearer})
				id, bearer = seedDesktopBearerWorkspace(t, ctx, pool, repo.ID, repoOwner.ID, repoOwner.ID, "other-owner-same-repo-vm")
				controls = append(controls, struct{ id, token string }{id, bearer})
			}

			busCtx, stopBus := context.WithCancel(ctx)
			bus := revocation.NewBus(pool, queries)
			require.NoError(t, bus.Start(busCtx))
			t.Cleanup(func() {
				stopBus()
				select {
				case <-bus.Done():
				case <-time.After(5 * time.Second):
					t.Error("revocation bus did not stop")
				}
			})
			require.Eventually(t, bus.Positioned, 5*time.Second, 10*time.Millisecond)
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
					kind, payload, err := ws.Read(r.Context())
					if err != nil {
						return
					}
					if err := ws.Write(r.Context(), kind, payload); err != nil {
						return
					}
				}
			}))
			t.Cleanup(guest.Close)
			gateway := previewgateway.NewHandler(loopbackPortDialer(strings.TrimPrefix(guest.URL, "http://")), []string{".preview.jjhub.tech"}, nil)
			gateway.SetRelayToken("relay-secret")
			hop := httptest.NewServer(gateway)
			t.Cleanup(hop.Close)
			api := httptest.NewServer(newDesktopRelayRouter(&WorkspaceDesktopHandler{
				Service: services.NewWorkspaceService(queries), RelayServiceURL: hop.URL, RelayToken: "relay-secret",
			}))
			t.Cleanup(api.Close)

			url := func(id, bearer string) string {
				return api.URL + "/api/workspaces/" + id + "/desktop/" + bearer + "/websockify"
			}
			active, response, err := websocket.Dial(ctx, url(workspaceID, token), nil)
			require.NoError(t, err, "initial bearer must authorize: %v", response)
			defer active.CloseNow()
			echoDesktopRelay(t, active, "before-revocation")
			controlSockets := make([]*websocket.Conn, 0, len(controls))
			for _, control := range controls {
				unaffected, response, err := websocket.Dial(ctx, url(control.id, control.token), nil)
				require.NoError(t, err, "control bearer must authorize: %v", response)
				defer unaffected.CloseNow()
				echoDesktopRelay(t, unaffected, "before-revocation")
				controlSockets = append(controlSockets, unaffected)
			}

			if tc.revokeRepo {
				revoked := owner
				if tc.revokeCreator {
					revoked = member
				}
				if tc.downgrade {
					_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='read' WHERE repository_id=$1 AND user_id=$2`, repo.ID, revoked.ID)
				} else {
					_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, revoked.ID)
				}
				require.NoError(t, err)
				require.NoError(t, revocation.NewDBPublisher(queries, bus).Publish(ctx, revocation.Event{
					Kind: revocation.KindCollaboratorRemoved, RepositoryID: repo.ID, UserID: revoked.ID, SandboxIDs: []string{"relay-vm"},
				}))
			} else {
				disabled := member
				if tc.revokeOwner {
					disabled = owner
				}
				_, err = services.NewAdminUserService(queries).SetSuspended(ctx, disabled.Username, true)
				require.NoError(t, err)
			}

			readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
			defer readCancel()
			_, _, err = active.Read(readCtx)
			require.Error(t, err, "revocation must close the established socket")
			require.NoError(t, readCtx.Err(), "socket closure must precede the deadline")
			for _, unaffected := range controlSockets {
				echoDesktopRelay(t, unaffected, "after-revocation")
			}

			fresh, rejected, err := websocket.Dial(ctx, url(workspaceID, token), nil)
			if fresh != nil {
				fresh.CloseNow()
			}
			require.Error(t, err, "the same unexpired bearer must not reconnect")
			require.NotNil(t, rejected)
			require.Equal(t, http.StatusForbidden, rejected.StatusCode)
			for _, control := range controls {
				unaffectedFresh, response, err := websocket.Dial(ctx, url(control.id, control.token), nil)
				require.NoError(t, err, "control bearer must still reconnect: %v", response)
				defer unaffectedFresh.CloseNow()
				echoDesktopRelay(t, unaffectedFresh, "still-authorized")
			}
		})
	}
}

func seedDesktopBearerWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repositoryID, ownerID, creatorID int64, vmID string) (string, string) {
	t.Helper()
	workspaceID := uuid.NewString()
	token := fmt.Sprintf("smithers_desk_v1_%d_%s", creatorID, strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")[:48])
	sum := sha256.Sum256([]byte(token))
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,kind,status,vm_id,desktop_session_token_hash,desktop_session_expires_at)
		VALUES($1::uuid,$2,$3,'relay test','desktop','running',$4,$5,$6)`, workspaceID, repositoryID, ownerID, vmID, hex.EncodeToString(sum[:]), time.Now().Add(time.Hour))
	require.NoError(t, err)
	return workspaceID, token
}
