//go:build integration

package routes

import (
	"context"
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

// desktopRelayOrgWithWriters creates an organization whose private repository
// grants write to members through a team.
func desktopRelayOrgWithWriters(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgOwner routesIntegrationUser, writers ...routesIntegrationUser) (db.Organization, routesIntegrationRepo) {
	t.Helper()
	queries := db.New(pool)
	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	org, err := queries.CreateOrganization(ctx, db.CreateOrganizationParams{
		Name: "desk_org_" + unique, LowerName: "desk_org_" + unique, Visibility: "private",
	})
	require.NoError(t, err)
	_, err = queries.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: orgOwner.ID, Role: "owner"})
	require.NoError(t, err)
	repo := routesIntegrationCreateOrgRepo(t, pool, org, "desk_org_repo")
	team, err := queries.CreateTeam(ctx, db.CreateTeamParams{
		OrganizationID: org.ID, Name: "writers", LowerName: "writers", Permission: "write",
	})
	require.NoError(t, err)
	_, err = queries.AddTeamRepo(ctx, db.AddTeamRepoParams{TeamID: team.ID, RepositoryID: repo.ID})
	require.NoError(t, err)
	for _, writer := range writers {
		_, err = queries.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: writer.ID, Role: "member"})
		require.NoError(t, err)
		_, err = queries.AddTeamMember(ctx, db.AddTeamMemberParams{TeamID: team.ID, UserID: writer.ID})
		require.NoError(t, err)
	}
	return org, repo
}

// Organization removal through OrgService must close an established desktop
// relay socket whose owner or bearer creator lost the organization grant, and
// the same unexpired bearer must then be refused. Desktops of other members
// and of the removed user in another organization stay connected.
func TestDesktopRelayClosesOnOrganizationMembershipRemoval(t *testing.T) {
	for _, tc := range []struct {
		name          string
		ownerToken    bool
		removeCreator bool
	}{
		{name: "owner bearer owner removed", ownerToken: true},
		{name: "shared bearer creator removed", removeCreator: true},
		{name: "shared bearer owner removed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := setupRoutesIntegrationPool(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			queries := db.New(pool)

			orgOwner := routesIntegrationCreateUser(t, pool, "desk_org_owner")
			owner := routesIntegrationCreateUser(t, pool, "desk_ws_owner")
			member := routesIntegrationCreateUser(t, pool, "desk_member")
			bystander := routesIntegrationCreateUser(t, pool, "desk_bystander")
			org, repo := desktopRelayOrgWithWriters(t, ctx, pool, orgOwner, owner, member, bystander)

			creator := member
			if tc.ownerToken {
				creator = owner
			}
			removed := owner
			if tc.removeCreator {
				removed = member
			}
			workspaceID, token := seedDesktopBearerWorkspace(t, ctx, pool, repo.ID, owner.ID, creator.ID, "org-relay-vm")
			if !tc.ownerToken {
				_, err := queries.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
					WorkspaceID: workspaceID, OwnerUserID: owner.ID, GranteeUserID: member.ID, Level: "write",
				})
				require.NoError(t, err)
			}
			controls := []struct{ id, token string }{}
			id, bearer := seedDesktopBearerWorkspace(t, ctx, pool, repo.ID, bystander.ID, bystander.ID, "org-bystander-vm")
			controls = append(controls, struct{ id, token string }{id, bearer})
			_, otherRepo := desktopRelayOrgWithWriters(t, ctx, pool, orgOwner, removed)
			id, bearer = seedDesktopBearerWorkspace(t, ctx, pool, otherRepo.ID, removed.ID, removed.ID, "org-removed-user-other-org-vm")
			controls = append(controls, struct{ id, token string }{id, bearer})

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
			echoDesktopRelay(t, active, "before-removal")
			controlSockets := make([]*websocket.Conn, 0, len(controls))
			for _, control := range controls {
				unaffected, response, err := websocket.Dial(ctx, url(control.id, control.token), nil)
				require.NoError(t, err, "control bearer must authorize: %v", response)
				defer unaffected.CloseNow()
				echoDesktopRelay(t, unaffected, "before-removal")
				controlSockets = append(controlSockets, unaffected)
			}

			orgService := services.NewOrgServiceWithPool(queries, pool)
			orgService.SetRevocationPublisher(revocation.NewDBPublisher(queries, bus))
			require.NoError(t, orgService.RemoveOrgMember(ctx,
				&db.User{ID: orgOwner.ID, Username: orgOwner.Username, LowerUsername: orgOwner.Username},
				org.Name, removed.Username))

			readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
			defer readCancel()
			_, _, err = active.Read(readCtx)
			require.Error(t, err, "organization removal must close the established socket")
			require.NoError(t, readCtx.Err(), "socket closure must precede the deadline")
			for _, unaffected := range controlSockets {
				echoDesktopRelay(t, unaffected, "after-removal")
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
