package services

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type recordingPublisher struct {
	mu     sync.Mutex
	events []revocation.Event
}

func (p *recordingPublisher) Publish(_ context.Context, event revocation.Event) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, event)
	return nil
}

func (p *recordingPublisher) all() []revocation.Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]revocation.Event(nil), p.events...)
}

// hashReadingAuthQuerier adds the optional hash lookup the publisher uses to
// name the token live consumers were authorized under.
type hashReadingAuthQuerier struct {
	*mockAuthQuerier
	hash string
}

func (q *hashReadingAuthQuerier) GetAccessTokenHashByID(_ context.Context, id int64) (db.GetAccessTokenHashByIDRow, error) {
	return db.GetAccessTokenHashByIDRow{TokenHash: q.hash, UserID: 42}, nil
}

func TestAuthService_DeleteTokenPublishesRevocationWithHash(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	q := &hashReadingAuthQuerier{mockAuthQuerier: &mockAuthQuerier{
		deleteAccessTokenByIDAndUserIDFn: func(context.Context, db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) { return 1, nil },
	}, hash: "sha256-of-token"}
	svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(publisher))
	require.NoError(t, svc.DeleteToken(context.Background(), 42, 7))
	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindTokenRevoked, events[0].Kind)
	require.Equal(t, int64(42), events[0].UserID)
	require.Equal(t, int64(7), events[0].TokenID)
	require.Equal(t, "sha256-of-token", events[0].TokenHash)
}

func TestAuthService_DeleteTokenDoesNotPublishWhenNothingWasDeleted(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	q := &mockAuthQuerier{
		deleteAccessTokenByIDAndUserIDFn: func(context.Context, db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) { return 0, nil },
	}
	svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(publisher))
	require.Error(t, svc.DeleteToken(context.Background(), 42, 7))
	require.Empty(t, publisher.all())
}

func TestOAuth2Service_RevokeAccessTokenPublishesHash(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	app := testOAuth2Application(true)
	tokenHash := hashOAuth2Secret("oauth-access-token")
	q := &oauth2HQuerier{
		getApplicationByClientIDFn: func(context.Context, string) (db.Oauth2Application, error) {
			return app, nil
		},
		getAccessTokenByHashFn: func(_ context.Context, got string) (db.Oauth2AccessToken, error) {
			require.Equal(t, tokenHash, got)
			return db.Oauth2AccessToken{ID: 91, AppID: app.ID, UserID: 42, TokenHash: got}, nil
		},
	}
	svc := NewOAuth2Service(q)
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.RevokeToken(context.Background(), app.ClientID, "secret-123", "oauth-access-token"))
	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindTokenRevoked, events[0].Kind)
	require.Equal(t, int64(91), events[0].TokenID)
	require.Equal(t, int64(42), events[0].UserID)
	require.Equal(t, tokenHash, events[0].TokenHash)
}

type orgWorkspaceRevocationQuerier struct {
	*mockOrgQuerier
	workspaces map[int64][]db.Workspace
}

func (q *orgWorkspaceRevocationQuerier) ListWorkspacesByRepo(_ context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
	rows := q.workspaces[arg.RepositoryID]
	start := int(arg.PageOffset)
	if start >= len(rows) {
		return nil, nil
	}
	end := start + int(arg.PageSize)
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end], nil
}

func TestOrgService_RemoveMemberPublishesEveryWorkspaceVM(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	base := ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
		q.countOrgOwnersFn = func(context.Context, int64) (int64, error) { return 2, nil }
		q.listOrgReposFn = func(_ context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
			require.Equal(t, pgtype.Int8{Int64: 7, Valid: true}, arg.OrgID)
			return []db.Repository{{ID: 10}, {ID: 11}}, nil
		}
	})
	q := &orgWorkspaceRevocationQuerier{
		mockOrgQuerier: base,
		workspaces: map[int64][]db.Workspace{
			10: {{VmID: "vm-one"}, {VmID: "vm-two"}},
			11: {{VmID: "vm-two"}, {VmID: "vm-three"}, {VmID: ""}},
		},
	}
	svc := NewOrgService(q)
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob"))
	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindOrgMemberRemoved, events[0].Kind)
	require.Equal(t, []string{"vm-one", "vm-two", "vm-three"}, events[0].SandboxIDs)
}

// TestOrgService_RemoveMemberEventAffectsRepositoryStreamPrincipal is the
// producer side of the contract with internal/routes.requestPrincipal: the
// event RemoveOrgMember publishes must match a repository stream principal
// that carries the organization, and must not match one that omits it, other
// members, or other organizations.
func TestOrgService_RemoveMemberEventAffectsRepositoryStreamPrincipal(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	q := ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
		q.countOrgOwnersFn = func(context.Context, int64) (int64, error) { return 2, nil }
		q.listOrgReposFn = func(context.Context, db.ListOrgReposParams) ([]db.Repository, error) {
			return []db.Repository{{ID: 10, OrgID: pgtype.Int8{Int64: 7, Valid: true}}}, nil
		}
	})
	svc := NewOrgService(q)
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob"))
	events := publisher.all()
	require.Len(t, events, 1)
	event := events[0]
	require.Equal(t, revocation.KindOrgMemberRemoved, event.Kind)
	require.Equal(t, int64(2), event.UserID)
	require.Equal(t, int64(7), event.OrganizationID)

	streamPrincipal := revocation.Principal{UserID: 2, RepositoryID: 10, OrganizationID: 7}
	require.True(t, event.Affects(streamPrincipal), "the removed member's stream on the organization's repository must end")
	require.False(t, event.Affects(revocation.Principal{UserID: 2, RepositoryID: 10}), "a repository-only principal cannot match; consumers must carry the organization")
	require.False(t, event.Affects(revocation.Principal{UserID: 3, RepositoryID: 10, OrganizationID: 7}), "other members keep their streams")
	require.False(t, event.Affects(revocation.Principal{UserID: 2, RepositoryID: 11, OrganizationID: 8}), "other organizations are untouched")
}

func TestAdminUserService_TokenPublishesAndSuspensionUsesDatabaseTrigger(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	target := db.User{ID: 5, Username: "alice", LowerUsername: "alice"}
	q := &mockAdminUserQuerier{
		getUserByLowerUsernameFn:    func(context.Context, string) (db.User, error) { return target, nil },
		adminGetUserForSuspensionFn: func(context.Context, string) (db.User, error) { return target, nil },
		setUserSuspendedFn: func(_ context.Context, arg db.SetUserSuspendedParams) (db.User, error) {
			target.IsActive = !arg.Suspended
			return target, nil
		},
		getAccessTokenByIDFn: func(context.Context, int64) (db.AccessToken, error) {
			return db.AccessToken{ID: 9, UserID: 5, TokenHash: "h9"}, nil
		},
		deleteAccessTokenByIDAndUserID: func(context.Context, db.DeleteAccessTokenByIDAndUserIDParams) (int64, error) { return 1, nil },
	}
	svc := NewAdminUserService(q, WithAdminRevocationPublisher(publisher))

	require.NoError(t, svc.RevokeToken(context.Background(), "alice", 9))
	_, err := svc.SetSuspended(context.Background(), "alice", true)
	require.NoError(t, err)
	_, err = svc.SetSuspended(context.Background(), "alice", false)
	require.NoError(t, err)

	events := publisher.all()
	require.Len(t, events, 1, "user-state events belong to the update transaction, not a later service publication")
	require.Equal(t, revocation.KindTokenRevoked, events[0].Kind)
	require.Equal(t, "h9", events[0].TokenHash)
}

func TestPublishBestEffort_NilPublisherIsANoop(t *testing.T) {
	t.Parallel()
	revocation.PublishBestEffort(context.Background(), nil, revocation.Event{Kind: revocation.KindUserDisabled, UserID: 1})
}

func TestAuthService_LogoutPublishesBrowserSessionRevocationBeforeDeleting(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	var deleted []string
	q := &mockAuthQuerier{deleteAuthSessionFn: func(_ context.Context, key string) error {
		require.Len(t, publisher.all(), 1, "the revocation is recorded before the session row disappears")
		deleted = append(deleted, key)
		return nil
	}}
	svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(publisher))
	raw := "123e4567-e89b-12d3-a456-426614174000"
	require.NoError(t, svc.Logout(context.Background(), raw))
	require.Equal(t, []string{sessionStorageKey(raw), raw}, deleted)
	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindBrowserSessionRevoked, events[0].Kind)
	require.Equal(t, sessionStorageKey(raw), events[0].TokenHash, "the event names the digest, never the raw key")
}

func TestAuthService_RevokeUserSessionKeepsSessionWhenRecordFails(t *testing.T) {
	t.Parallel()
	stored := sessionStorageKey("current-raw")
	publisher := &failingPublisher{}
	q := &mockAuthQuerier{
		deleteAuthSessionFn: func(context.Context, string) error {
			t.Fatal("an unrecorded revocation must leave the session for a retry")
			return nil
		},
		listUserSessionsFn: func(context.Context, int64) ([]db.AuthSession, error) {
			return []db.AuthSession{{SessionKey: stored}}, nil
		},
	}
	svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(publisher))
	require.Error(t, svc.RevokeUserSession(context.Background(), 42, SessionPublicID(stored)))
	require.Equal(t, 1, publisher.calls)
}

func TestAuthService_LogoutDeletesSessionAndReportsFailedRecord(t *testing.T) {
	t.Parallel()
	raw := "123e4567-e89b-12d3-a456-426614174000"
	var deleted []string
	q := &mockAuthQuerier{deleteAuthSessionFn: func(_ context.Context, key string) error {
		deleted = append(deleted, key)
		return nil
	}}
	svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(&failingPublisher{}))
	require.Error(t, svc.Logout(context.Background(), raw), "the browser cannot retry, so the failure is reported")
	require.Equal(t, []string{sessionStorageKey(raw), raw}, deleted, "the session still ends for fresh requests")
}

func TestAuthService_LogoutPublishesEveryPresentedCookieAndIgnoresBlank(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	q := &mockAuthQuerier{deleteAuthSessionFn: func(context.Context, string) error { return nil }}
	svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(publisher))
	require.NoError(t, svc.Logout(context.Background(), " "))
	require.Empty(t, publisher.all(), "a blank cookie names no session")
	require.NoError(t, svc.Logout(context.Background(), "not-a-uuid"))
	events := publisher.all()
	require.Len(t, events, 1, "auth accepts a non-UUID cookie, so logout revokes it")
	require.Equal(t, sessionStorageKey("not-a-uuid"), events[0].TokenHash)
}

func TestAuthService_RevokeUserSessionPublishesItsDigest(t *testing.T) {
	t.Parallel()
	legacy := "123e4567-e89b-12d3-a456-426614174000"
	current := sessionStorageKey("current-raw")
	for _, tc := range []struct {
		name, stored, want string
	}{
		{"hashed row", current, current},
		{"legacy raw row", legacy, sessionStorageKey(legacy)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			publisher := &recordingPublisher{}
			q := &mockAuthQuerier{
				listUserSessionsFn: func(context.Context, int64) ([]db.AuthSession, error) {
					return []db.AuthSession{{SessionKey: sessionStorageKey("other")}, {SessionKey: tc.stored}}, nil
				},
				deleteAuthSessionFn: func(_ context.Context, key string) error {
					require.Equal(t, tc.stored, key)
					return nil
				},
			}
			svc := NewAuthService(q, config.AuthConfig{}, nil, nil, WithAuthRevocationPublisher(publisher))
			require.NoError(t, svc.RevokeUserSession(context.Background(), 42, SessionPublicID(tc.stored)))
			events := publisher.all()
			require.Len(t, events, 1)
			require.Equal(t, revocation.KindBrowserSessionRevoked, events[0].Kind)
			require.Equal(t, tc.want, events[0].TokenHash)
			require.Equal(t, int64(42), events[0].UserID)
		})
	}
}
