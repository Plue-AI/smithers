package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// relayAuthorizationQuerier supplies the extra account and repository queries
// needed by a fresh desktop bearer request. The workspace mock alone cannot
// stand in for the production query set at this boundary.
type relayAuthorizationQuerier struct {
	*mockWorkspaceQuerier
	userFn         func(int64) (db.User, error)
	repoFn         func(int64) (db.Repository, error)
	orgOwnerFn     func(int64) (bool, error)
	teamFn         func(int64) (string, error)
	collaboratorFn func(int64) (string, error)
}

func (q *relayAuthorizationQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	if q.userFn != nil {
		return q.userFn(id)
	}
	return db.User{ID: id, IsActive: true}, nil
}

func (q *relayAuthorizationQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if q.repoFn != nil {
		return q.repoFn(id)
	}
	return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
}

func (q *relayAuthorizationQuerier) IsOrgOwnerForRepoUser(_ context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if q.orgOwnerFn != nil {
		return q.orgOwnerFn(arg.UserID)
	}
	return false, nil
}

func (q *relayAuthorizationQuerier) GetHighestTeamPermissionForRepoUser(_ context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if q.teamFn != nil {
		return q.teamFn(arg.UserID)
	}
	return "", nil
}

func (q *relayAuthorizationQuerier) GetCollaboratorPermissionForRepoUser(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if q.collaboratorFn != nil {
		return q.collaboratorFn(arg.UserID.Int64)
	}
	if arg.UserID.Int64 != 1 {
		return "write", nil
	}
	return "", nil
}

func TestAuthorizeDesktopRelayRechecksCurrentAccountsAndOwnerRepository(t *testing.T) {
	for _, tc := range []struct {
		name            string
		creator         int64
		ownerState      func(*db.User)
		creatorState    func(*db.User)
		ownerUserErr    error
		creatorErr      error
		repoErr         error
		repoOwner       int64
		repoPublic      bool
		repoOrg         bool
		orgOwner        bool
		orgErr          error
		teamGrant       string
		teamErr         error
		collaborator    string
		creatorGrant    string
		creatorNoGrant  bool
		creatorGrantErr error
		permissionErr   error
		shareLevel      string
		wantStatus      int
	}{
		{name: "owner has repository ownership", creator: 1, repoOwner: 1},
		{name: "owner suspended", creator: 1, repoOwner: 1, ownerState: func(u *db.User) { u.ProhibitLogin = true }, wantStatus: 403},
		{name: "owner deactivated", creator: 1, repoOwner: 1, ownerState: func(u *db.User) { u.IsActive = false }, wantStatus: 403},
		{name: "owner deleted", creator: 1, repoOwner: 1, ownerState: func(u *db.User) { u.DeletedAt = pgtype.Timestamptz{Valid: true} }, wantStatus: 403},
		{name: "owner missing", creator: 1, repoOwner: 1, ownerUserErr: pgx.ErrNoRows, wantStatus: 403},
		{name: "owner lookup fails", creator: 1, repoOwner: 1, ownerUserErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "shared creator has write grant", creator: 2, repoOwner: 1, shareLevel: "write"},
		{name: "creator suspended", creator: 2, repoOwner: 1, shareLevel: "write", creatorState: func(u *db.User) { u.ProhibitLogin = true }, wantStatus: 403},
		{name: "creator deactivated", creator: 2, repoOwner: 1, shareLevel: "write", creatorState: func(u *db.User) { u.IsActive = false }, wantStatus: 403},
		{name: "creator deleted", creator: 2, repoOwner: 1, shareLevel: "write", creatorState: func(u *db.User) { u.DeletedAt = pgtype.Timestamptz{Valid: true} }, wantStatus: 403},
		{name: "creator missing", creator: 2, repoOwner: 1, shareLevel: "write", creatorErr: pgx.ErrNoRows, wantStatus: 403},
		{name: "creator lookup fails", creator: 2, repoOwner: 1, shareLevel: "write", creatorErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "creator has share but owner suspended", creator: 2, repoOwner: 1, shareLevel: "write", ownerState: func(u *db.User) { u.ProhibitLogin = true }, wantStatus: 403},
		{name: "owner repository grant revoked", creator: 2, repoOwner: 3, shareLevel: "write", wantStatus: 403},
		{name: "owner repository collaborator read remains", creator: 2, repoOwner: 3, collaborator: "read", shareLevel: "write"},
		{name: "owner repository public read remains", creator: 2, repoOwner: 3, repoPublic: true, shareLevel: "write"},
		{name: "owner repository org owner remains", creator: 2, repoOrg: true, orgOwner: true, shareLevel: "write"},
		{name: "owner repository team read remains", creator: 2, repoOrg: true, teamGrant: "read", shareLevel: "write"},
		{name: "owner bearer repository collaborator read insufficient", creator: 1, repoOwner: 3, collaborator: "read", wantStatus: 403},
		{name: "owner bearer repository public read insufficient", creator: 1, repoOwner: 3, repoPublic: true, wantStatus: 403},
		{name: "owner bearer repository team read insufficient", creator: 1, repoOrg: true, teamGrant: "read", wantStatus: 403},
		{name: "owner bearer repository collaborator write remains", creator: 1, repoOwner: 3, collaborator: "write"},
		{name: "owner bearer repository org owner remains", creator: 1, repoOrg: true, orgOwner: true},
		{name: "owner bearer repository team write remains", creator: 1, repoOrg: true, teamGrant: "write"},
		{name: "owner bearer repository grant revoked", creator: 1, repoOwner: 3, wantStatus: 403},
		{name: "shared creator repository grant revoked", creator: 2, repoOwner: 1, shareLevel: "write", creatorNoGrant: true, wantStatus: 403},
		{name: "shared creator repository grant downgraded", creator: 2, repoOwner: 1, shareLevel: "write", creatorGrant: "read", wantStatus: 403},
		{name: "shared creator repository permission lookup fails", creator: 2, repoOwner: 1, shareLevel: "write", creatorGrantErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "repository missing", creator: 1, repoErr: pgx.ErrNoRows, wantStatus: 403},
		{name: "repository lookup fails", creator: 1, repoErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "permission lookup fails", creator: 1, repoOwner: 3, permissionErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "distinct owner permission lookup fails", creator: 2, repoOwner: 3, shareLevel: "write", permissionErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "org owner lookup fails", creator: 1, repoOrg: true, orgErr: errors.New("db unavailable"), wantStatus: 500},
		{name: "team permission lookup fails", creator: 1, repoOrg: true, teamErr: errors.New("db unavailable"), wantStatus: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, hash := generateDesktopSessionToken(tc.creator)
			workspace := sampleDBWorkspace("ws-desktop-current-access")
			workspace.Kind = "desktop"
			workspace.DesktopSessionTokenHash = hash
			workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
			lookups := map[int64]int{}
			touches := 0
			q := &relayAuthorizationQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
				getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return workspace, nil },
				getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
					require.Equal(t, tc.creator, arg.GranteeUserID)
					return db.WorkspaceShare{Level: tc.shareLevel}, nil
				},
				touchWorkspaceActivityFn: func(context.Context, string) error { touches++; return nil },
			}}
			q.userFn = func(id int64) (db.User, error) {
				lookups[id]++
				user := db.User{ID: id, IsActive: true}
				switch id {
				case 1:
					if tc.ownerState != nil {
						tc.ownerState(&user)
					}
					return user, tc.ownerUserErr
				case 2:
					if tc.creatorState != nil {
						tc.creatorState(&user)
					}
					return user, tc.creatorErr
				default:
					t.Fatalf("unexpected user lookup %d", id)
					return db.User{}, pgx.ErrNoRows
				}
			}
			q.repoFn = func(id int64) (db.Repository, error) {
				require.Equal(t, workspace.RepositoryID, id)
				return db.Repository{
					ID:       id,
					UserID:   pgtype.Int8{Int64: tc.repoOwner, Valid: tc.repoOwner != 0},
					OrgID:    pgtype.Int8{Int64: 10, Valid: tc.repoOrg},
					IsPublic: tc.repoPublic,
				}, tc.repoErr
			}
			q.orgOwnerFn = func(id int64) (bool, error) {
				if id != 1 {
					return false, nil
				}
				return tc.orgOwner, tc.orgErr
			}
			q.teamFn = func(id int64) (string, error) {
				if id != 1 {
					return "", nil
				}
				return tc.teamGrant, tc.teamErr
			}
			q.collaboratorFn = func(id int64) (string, error) {
				if id == 2 {
					if tc.creatorNoGrant {
						return "", tc.creatorGrantErr
					}
					if tc.creatorGrant != "" {
						return tc.creatorGrant, tc.creatorGrantErr
					}
					return "write", tc.creatorGrantErr
				}
				require.Equal(t, int64(1), id)
				return tc.collaborator, tc.permissionErr
			}
			target, err := NewWorkspaceService(q).AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
			if tc.wantStatus != 0 {
				assertAPIStatus(t, err, tc.wantStatus)
				require.Zero(t, touches, "denial must not extend desktop activity")
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.creator, target.UserID)
			require.Equal(t, 1, touches)
			require.Equal(t, 1, lookups[1], "owner account should be read once even when owner created the token")
			if tc.creator == 2 {
				require.Equal(t, 1, lookups[2])
			}
		})
	}
}

func TestAuthorizeDesktopRelayFailsClosedWithoutCurrentAccessQueries(t *testing.T) {
	token, hash := generateDesktopSessionToken(1)
	workspace := sampleDBWorkspace("ws-desktop-missing-auth-store")
	workspace.Kind = "desktop"
	workspace.DesktopSessionTokenHash = hash
	workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
	touches := 0
	q := &mockWorkspaceQuerier{
		getWorkspaceFn:           func(context.Context, string) (db.Workspace, error) { return workspace, nil },
		touchWorkspaceActivityFn: func(context.Context, string) error { touches++; return nil },
	}
	_, err := NewWorkspaceService(q).AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
	assertAPIStatus(t, err, 500)
	require.Zero(t, touches)
}

func TestAuthorizeDesktopRelayUnavailableService(t *testing.T) {
	for _, tc := range []struct {
		name string
		svc  *WorkspaceService
	}{
		{name: "nil service"},
		{name: "nil store", svc: NewWorkspaceService(nil)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.svc.AuthorizeDesktopRelay(context.Background(), "ws-desktop", "smithers_desk_token")
			assertAPIStatus(t, err, 500)
		})
	}
}

func TestAuthorizeDesktopRelayWorkspaceLookupFailure(t *testing.T) {
	storeFailure := errors.New("workspace store unavailable")
	q := &mockWorkspaceQuerier{
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, storeFailure
		},
		touchWorkspaceActivityFn: func(context.Context, string) error {
			t.Fatal("failed authorization touched workspace activity")
			return nil
		},
	}
	_, err := NewWorkspaceService(q).AuthorizeDesktopRelay(context.Background(), "ws-desktop", "smithers_desk_token")
	assertAPIStatus(t, err, 500)
}
