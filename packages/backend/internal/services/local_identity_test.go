package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type localIdentityTestQueries struct {
	*mockAuthQuerier
	owner       *db.User
	credential  *db.GetSelfHostLocalCredentialRow
	bootstrapFn func(context.Context, db.BootstrapSelfHostOwnerParams) (db.BootstrapSelfHostOwnerRow, error)
	deletedAll  int

	deletedSessionKeys []string
}

func (q *localIdentityTestQueries) GetSelfHostOwner(context.Context) (db.User, error) {
	if q.owner == nil {
		return db.User{}, pgx.ErrNoRows
	}
	return *q.owner, nil
}

func (q *localIdentityTestQueries) GetSelfHostLocalCredential(context.Context) (db.GetSelfHostLocalCredentialRow, error) {
	if q.credential == nil {
		return db.GetSelfHostLocalCredentialRow{}, pgx.ErrNoRows
	}
	return *q.credential, nil
}

func (q *localIdentityTestQueries) BootstrapSelfHostOwner(ctx context.Context, arg db.BootstrapSelfHostOwnerParams) (db.BootstrapSelfHostOwnerRow, error) {
	return q.bootstrapFn(ctx, arg)
}

func (q *localIdentityTestQueries) UpdateSelfHostOwnerPassword(_ context.Context, arg db.UpdateSelfHostOwnerPasswordParams) (int64, error) {
	if q.credential == nil || q.credential.ID != arg.UserID {
		return 0, nil
	}
	q.credential.PasswordHash = arg.PasswordHash
	return 1, nil
}

func (q *localIdentityTestQueries) DeleteUserSessions(context.Context, int64) ([]string, error) {
	q.deletedAll++
	return q.deletedSessionKeys, nil
}

func newLocalIdentityTestService(q *localIdentityTestQueries) *AuthService {
	cfg := defaultAuthConfig()
	cfg.Mode = config.AuthModeSelfHosted
	cfg.BootstrapToken = "bootstrap-secret-value"
	return NewAuthService(q, cfg, nil, nil)
}

func TestValidateLocalIdentityStartupRequiresBootstrapOnlyUntilOwnerExists(t *testing.T) {
	cfg := defaultAuthConfig()
	cfg.Mode = config.AuthModeSelfHosted
	q := &localIdentityTestQueries{mockAuthQuerier: &mockAuthQuerier{}}

	err := ValidateLocalIdentityStartup(context.Background(), q, cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "bootstrap_token")

	cfg.BootstrapToken = "one-time-bootstrap-secret"
	require.NoError(t, ValidateLocalIdentityStartup(context.Background(), q, cfg))

	q.owner = &db.User{ID: 7, Username: "owner"}
	cfg.BootstrapToken = ""
	require.NoError(t, ValidateLocalIdentityStartup(context.Background(), q, cfg))

	cfg.Mode = config.AuthModeMultitenant
	q.owner = nil
	require.NoError(t, ValidateLocalIdentityStartup(context.Background(), q, cfg))
}

func localCredentialRow(user db.User, passwordHash string) db.GetSelfHostLocalCredentialRow {
	return db.GetSelfHostLocalCredentialRow{
		ID: user.ID, Username: user.Username, LowerUsername: user.LowerUsername,
		DisplayName: user.DisplayName, IsActive: user.IsActive, IsAdmin: user.IsAdmin,
		PasswordHash: passwordHash, CreatedAt: user.CreatedAt, UpdatedAt: user.UpdatedAt,
	}
}

func TestLocalIdentityBootstrapPersistsHashedCredentialAndSession(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	var bootstrap db.BootstrapSelfHostOwnerParams
	var session db.CreateAuthSessionParams
	base := &mockAuthQuerier{
		createAuthSessionFn: func(_ context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			session = arg
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
	}
	q := &localIdentityTestQueries{mockAuthQuerier: base}
	q.bootstrapFn = func(_ context.Context, arg db.BootstrapSelfHostOwnerParams) (db.BootstrapSelfHostOwnerRow, error) {
		bootstrap = arg
		return db.BootstrapSelfHostOwnerRow{
			ID: 7, Username: arg.Username, LowerUsername: arg.LowerUsername,
			Email: arg.Email, LowerEmail: arg.LowerEmail, DisplayName: arg.DisplayName,
			IsActive: true, IsAdmin: true, UserType: "user", CreatedAt: now, UpdatedAt: now,
		}, nil
	}
	svc := newLocalIdentityTestService(q)
	svc.now = func() time.Time { return now }
	svc.generateSession = func() string { return "550e8400-e29b-41d4-a716-446655440000" }

	result, err := svc.BootstrapLocalOwner(context.Background(), LocalBootstrapRequest{
		Username: "owner", Email: "owner@example.test", Password: "a strong local password", BootstrapToken: "bootstrap-secret-value",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(7), result.User.ID)
	assert.True(t, result.User.IsAdmin)
	assert.NotEqual(t, "a strong local password", bootstrap.PasswordHash)
	assert.True(t, verifyLocalPassword(bootstrap.PasswordHash, "a strong local password"))
	assert.Equal(t, sessionStorageKey(result.SessionKey), session.SessionKey)
	assert.Equal(t, now.Add(720*time.Hour), result.ExpiresAt)
}

func TestLocalIdentityRestartLoginAndScopedNativeToken(t *testing.T) {
	passwordHash, err := hashLocalPassword("a strong local password")
	require.NoError(t, err)
	user := db.User{ID: 9, Username: "owner", LowerUsername: "owner", DisplayName: "owner", IsActive: true, IsAdmin: true}
	var tokenParams db.CreateAccessTokenParams
	q := &localIdentityTestQueries{
		mockAuthQuerier: &mockAuthQuerier{
			createAuthSessionFn: func(_ context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
				return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
			},
			createAccessTokenFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
				tokenParams = arg
				return db.AccessToken{ID: 3, UserID: arg.UserID, Name: arg.Name, TokenLastEight: arg.TokenLastEight, Scopes: arg.Scopes, ExpiresAt: arg.ExpiresAt}, nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) { return user, nil },
		},
		owner: &user,
	}
	credential := localCredentialRow(user, passwordHash)
	q.credential = &credential

	// A newly constructed service proves identity survives process restart.
	svc := newLocalIdentityTestService(q)
	login, err := svc.LoginLocalOwner(context.Background(), "OWNER", "a strong local password")
	require.NoError(t, err)
	assert.Equal(t, user.ID, login.User.ID)

	token, tokenUser, err := svc.CreateLocalOwnerToken(context.Background(), "owner", "a strong local password", "native", nil)
	require.NoError(t, err)
	assert.Equal(t, user.ID, tokenUser.ID)
	assert.NotEmpty(t, token.Token)
	assert.NotContains(t, tokenParams.Scopes, string(middleware.ScopeWriteOrganization))
	assert.Contains(t, tokenParams.Scopes, string(middleware.ScopeWriteRepository))

	_, _, err = svc.CreateLocalOwnerToken(context.Background(), "owner", "a strong local password", "overbroad", []string{"all"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "administrative scopes")
}

func TestLocalIdentityRejectsSecondOwnerAndWrongBootstrapSecret(t *testing.T) {
	called := false
	q := &localIdentityTestQueries{mockAuthQuerier: &mockAuthQuerier{}}
	q.bootstrapFn = func(context.Context, db.BootstrapSelfHostOwnerParams) (db.BootstrapSelfHostOwnerRow, error) {
		called = true
		return db.BootstrapSelfHostOwnerRow{}, pgx.ErrNoRows
	}
	svc := newLocalIdentityTestService(q)

	_, err := svc.BootstrapLocalOwner(context.Background(), LocalBootstrapRequest{
		Username: "owner", Password: "a strong local password", BootstrapToken: "wrong-secret",
	})
	require.Error(t, err)
	assert.False(t, called)

	_, err = svc.BootstrapLocalOwner(context.Background(), LocalBootstrapRequest{
		Username: "owner", Password: "a strong local password", BootstrapToken: "bootstrap-secret-value",
	})
	require.Error(t, err)
	assert.True(t, called)
}

func TestLocalIdentityBootstrapReportsUsernameCollision(t *testing.T) {
	q := &localIdentityTestQueries{mockAuthQuerier: &mockAuthQuerier{}}
	q.bootstrapFn = func(context.Context, db.BootstrapSelfHostOwnerParams) (db.BootstrapSelfHostOwnerRow, error) {
		return db.BootstrapSelfHostOwnerRow{}, &pgconn.PgError{Code: "23505", ConstraintName: "users_lower_username_key"}
	}

	_, err := newLocalIdentityTestService(q).BootstrapLocalOwner(context.Background(), LocalBootstrapRequest{
		Username: "owner", Password: "a strong local password", BootstrapToken: "bootstrap-secret-value",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "username is already in use")
}

func TestLocalIdentityOwnerAdminFlagCannotBrickLogin(t *testing.T) {
	passwordHash, err := hashLocalPassword("a strong local password")
	require.NoError(t, err)
	owner := db.User{ID: 10, Username: "owner", LowerUsername: "owner", IsActive: true, IsAdmin: false}
	q := &localIdentityTestQueries{
		mockAuthQuerier: &mockAuthQuerier{createAuthSessionFn: func(_ context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		}},
		owner: &owner,
	}
	credential := localCredentialRow(owner, passwordHash)
	q.credential = &credential

	login, err := newLocalIdentityTestService(q).LoginLocalOwner(context.Background(), "owner", "a strong local password")
	require.NoError(t, err)
	assert.Equal(t, owner.ID, login.User.ID)
}

func TestLocalPasswordArgonWorkIsConcurrencyBounded(t *testing.T) {
	releaseOne := acquireLocalArgonSlot()
	releaseTwo := acquireLocalArgonSlot()
	third := make(chan func(), 1)
	go func() { third <- acquireLocalArgonSlot() }()

	select {
	case releaseThree := <-third:
		releaseThree()
		releaseOne()
		releaseTwo()
		t.Fatal("third Argon2 operation acquired a slot above the configured cap")
	case <-time.After(50 * time.Millisecond):
	}

	releaseOne()
	var releaseThree func()
	select {
	case releaseThree = <-third:
	case <-time.After(time.Second):
		releaseTwo()
		t.Fatal("waiting Argon2 operation did not acquire a released slot")
	}
	releaseThree()
	releaseTwo()
}

func TestSelfHostedKeyAuthCannotProvisionUser(t *testing.T) {
	q := &localIdentityTestQueries{mockAuthQuerier: &mockAuthQuerier{}}
	_, err := newLocalIdentityTestService(q).VerifyKeyAuth(context.Background(), "message", "signature")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not available in single-owner mode")
}

func TestLocalIdentityPasswordRotationRevokesBrowserSessions(t *testing.T) {
	oldHash, err := hashLocalPassword("old strong password")
	require.NoError(t, err)
	user := db.User{ID: 11, Username: "owner", LowerUsername: "owner", IsActive: true, IsAdmin: true}
	legacyKey := "123e4567-e89b-12d3-a456-426614174000"
	q := &localIdentityTestQueries{mockAuthQuerier: &mockAuthQuerier{
		createAuthSessionFn: func(_ context.Context, arg db.CreateAuthSessionParams) (db.AuthSession, error) {
			return db.AuthSession{SessionKey: arg.SessionKey, UserID: arg.UserID, Username: arg.Username, ExpiresAt: arg.ExpiresAt}, nil
		},
		listUserSessionsFn: func(_ context.Context, userID int64) ([]db.AuthSession, error) {
			require.Equal(t, user.ID, userID)
			return []db.AuthSession{{SessionKey: sessionStorageKey("current-raw")}, {SessionKey: legacyKey}}, nil
		},
	}, owner: &user, deletedSessionKeys: []string{sessionStorageKey("current-raw"), legacyKey, sessionStorageKey("minted-during-rotation")}}
	credential := localCredentialRow(user, oldHash)
	q.credential = &credential
	publisher := &recordingPublisher{}
	svc := newLocalIdentityTestService(q)
	svc.SetRevocationPublisher(publisher)

	_, err = svc.ChangeLocalOwnerPassword(context.Background(), user.ID, "old strong password", "new strong password")
	require.NoError(t, err)
	assert.Equal(t, 1, q.deletedAll)
	events := publisher.all()
	require.Len(t, events, 3, "every previous browser session ends its live deliveries exactly once")
	for index, want := range []string{sessionStorageKey("current-raw"), sessionStorageKey(legacyKey), sessionStorageKey("minted-during-rotation")} {
		assert.Equal(t, revocation.KindBrowserSessionRevoked, events[index].Kind)
		assert.Equal(t, want, events[index].TokenHash)
		assert.Equal(t, user.ID, events[index].UserID)
	}
	assert.True(t, verifyLocalPassword(q.credential.PasswordHash, "new strong password"))
	assert.False(t, verifyLocalPassword(q.credential.PasswordHash, "old strong password"))
}

func TestSelfHostedOAuthCannotClaimOwnerWithUnlinkedIdentity(t *testing.T) {
	owner := db.User{ID: 21, Username: "local-owner", LowerUsername: "local-owner", IsActive: true, IsAdmin: true}
	q := &localIdentityTestQueries{
		owner: &owner,
		mockAuthQuerier: &mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, pgx.ErrNoRows
			},
			createUserFn: func(context.Context, db.CreateUserParams) (db.User, error) {
				t.Fatal("self-host OAuth must not provision another user")
				return db.User{}, nil
			},
			upsertOAuthAccountPreserveRefreshFn: func(context.Context, db.UpsertOAuthAccountPreserveRefreshParams) (db.OauthAccount, error) {
				t.Fatal("an unlinked external identity must not claim the installation owner")
				return db.OauthAccount{}, nil
			},
			upsertEmailAddressFn: func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
				return db.UpsertEmailAddressRow{}, nil
			},
		},
	}
	svc := newLocalIdentityTestService(q)
	_, err := svc.resolveOAuthUser(context.Background(), exchangeMockGitHubClient(), "workos", "provider-token", "", 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not linked")
}

func TestSelfHostedOAuthRejectsPreviouslyLinkedForeignUser(t *testing.T) {
	owner := db.User{ID: 21, Username: "local-owner", LowerUsername: "local-owner", IsActive: true, IsAdmin: true}
	q := &localIdentityTestQueries{
		owner: &owner,
		mockAuthQuerier: &mockAuthQuerier{
			getOAuthAccountByProviderUserIDFn: func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{UserID: 22}, nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{ID: 22, Username: "foreign", IsActive: true}, nil
			},
		},
	}

	_, err := newLocalIdentityTestService(q).resolveOAuthUser(context.Background(), exchangeMockGitHubClient(), "workos", "provider-token", "", 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not linked to the installation owner")
}

func TestLocalIdentityPasswordRotationKeepsOldPasswordWhenRevocationCannotBeRecorded(t *testing.T) {
	oldHash, err := hashLocalPassword("old strong password")
	require.NoError(t, err)
	user := db.User{ID: 11, Username: "owner", LowerUsername: "owner", IsActive: true, IsAdmin: true}
	for _, tc := range []struct {
		name      string
		list      func(context.Context, int64) ([]db.AuthSession, error)
		publisher revocation.Publisher
	}{
		{"list fails", func(context.Context, int64) ([]db.AuthSession, error) { return nil, fmt.Errorf("list down") }, &recordingPublisher{}},
		{"record fails", func(context.Context, int64) ([]db.AuthSession, error) {
			return []db.AuthSession{{SessionKey: sessionStorageKey("current-raw")}}, nil
		}, &failingPublisher{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &localIdentityTestQueries{mockAuthQuerier: &mockAuthQuerier{listUserSessionsFn: tc.list}, owner: &user}
			credential := localCredentialRow(user, oldHash)
			q.credential = &credential
			svc := newLocalIdentityTestService(q)
			svc.SetRevocationPublisher(tc.publisher)
			_, err := svc.ChangeLocalOwnerPassword(context.Background(), user.ID, "old strong password", "new strong password")
			require.Error(t, err)
			assert.Zero(t, q.deletedAll)
			assert.True(t, verifyLocalPassword(q.credential.PasswordHash, "old strong password"), "a retry must still accept the old password")
		})
	}
}
