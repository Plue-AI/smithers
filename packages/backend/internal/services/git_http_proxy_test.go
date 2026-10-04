package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	stdErrors "errors"
	"io"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type mockGitHTTPProxyQuerier struct {
	getAuthInfoByTokenHashFn        func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	updateAccessTokenLastUsed       func(ctx context.Context, id int64) error
	getRepoByOwnerAndLowerNameFn    func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	listAllProtectedBookmarksFn     func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	getWorkflowRunByRunIDFn         func(ctx context.Context, runID int64) (db.WorkflowRun, error)
	getSelfHostOwnerFn              func(ctx context.Context) (db.User, error)
	getAuthInfoByTokenHashCall      int
	updateLastUsedCall              int
	getRepoByOwnerAndLowerNameCalls int
}

func (m *mockGitHTTPProxyQuerier) GetSelfHostOwner(ctx context.Context) (db.User, error) {
	if m.getSelfHostOwnerFn != nil {
		return m.getSelfHostOwnerFn(ctx)
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *mockGitHTTPProxyQuerier) GetWorkflowRunByRunID(ctx context.Context, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunByRunIDFn != nil {
		return m.getWorkflowRunByRunIDFn(ctx, runID)
	}
	return db.WorkflowRun{}, pgx.ErrNoRows
}

func (m *mockGitHTTPProxyQuerier) GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
	m.getAuthInfoByTokenHashCall++
	if m.getAuthInfoByTokenHashFn != nil {
		return m.getAuthInfoByTokenHashFn(ctx, tokenHash)
	}
	return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
}

func (m *mockGitHTTPProxyQuerier) UpdateAccessTokenLastUsed(ctx context.Context, id int64) error {
	m.updateLastUsedCall++
	if m.updateAccessTokenLastUsed != nil {
		return m.updateAccessTokenLastUsed(ctx, id)
	}
	return nil
}

func (m *mockGitHTTPProxyQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	m.getRepoByOwnerAndLowerNameCalls++
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{ID: 1}, nil
}

func (m *mockGitHTTPProxyQuerier) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	if m.listAllProtectedBookmarksFn != nil {
		return m.listAllProtectedBookmarksFn(ctx, repositoryID)
	}
	return nil, nil
}

type mockGitHTTPRepoHostClient struct {
	infoRefsFn      func(ctx context.Context, owner, repo, service string, stdout io.Writer) (string, error)
	proxyUploadFn   func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error
	proxyReceiveFn  func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error
	infoRefsCalls   int
	uploadPackCalls int
	receivePackCall int
	lastReceiveMeta repohost.ReceivePackMetadata
}

type mockGitHTTPAuthorizer struct {
	authorizeFn func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error
}

type mockGitHTTPRepoResolver struct {
	getRepoByOwnerAndNameFn    func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	getRepoByOwnerAndNameCalls int
}

func (m *mockGitHTTPRepoResolver) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	m.getRepoByOwnerAndNameCalls++
	if m.getRepoByOwnerAndNameFn != nil {
		return m.getRepoByOwnerAndNameFn(ctx, arg)
	}
	return db.GetRepoByOwnerAndNameRow{}, nil
}

type mockGitHTTPWebhookDispatcher struct {
	dispatchEventFn func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	dispatchCalls   int
	lastRepoID      int64
	lastEventType   webhooks.EventType
	lastPayload     any
}

func (m *mockGitHTTPWebhookDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.dispatchCalls++
	m.lastRepoID = repoID
	m.lastEventType = eventType
	m.lastPayload = payload
	if m.dispatchEventFn != nil {
		return m.dispatchEventFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockGitHTTPAuthorizer) Authorize(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
	if m.authorizeFn != nil {
		return m.authorizeFn(ctx, userID, owner, repo, mode)
	}
	return nil
}

func (m *mockGitHTTPRepoHostClient) InfoRefs(ctx context.Context, owner, repo, service string, stdout io.Writer) (string, error) {
	m.infoRefsCalls++
	if m.infoRefsFn != nil {
		return m.infoRefsFn(ctx, owner, repo, service, stdout)
	}
	return "", nil
}

func (m *mockGitHTTPRepoHostClient) ProxyUploadPack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
	m.uploadPackCalls++
	if m.proxyUploadFn != nil {
		return m.proxyUploadFn(ctx, owner, repo, stdin, stdout)
	}
	return nil
}

func (m *mockGitHTTPRepoHostClient) ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
	m.receivePackCall++
	if len(meta) > 0 {
		m.lastReceiveMeta = meta[0]
	}
	if m.proxyReceiveFn != nil {
		return m.proxyReceiveFn(ctx, owner, repo, stdin, stdout, meta...)
	}
	return nil
}

func TestGitHTTPProxyService_InfoRefs_PublicReadWithoutToken_Allowed(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{}
	repoHost := &mockGitHTTPRepoHostClient{
		infoRefsFn: func(ctx context.Context, owner, repo, service string, stdout io.Writer) (string, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "git-upload-pack", service)
			_, _ = io.WriteString(stdout, "advertisement")
			return "application/x-git-upload-pack-advertisement", nil
		},
	}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(0), userID)
			assert.Equal(t, AccessModeRead, mode)
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	out := &bytes.Buffer{}
	contentType, err := svc.ProxyInfoRefs(context.Background(), "alice", "demo", "git-upload-pack", "", out)
	require.NoError(t, err)
	assert.Equal(t, "application/x-git-upload-pack-advertisement", contentType)
	assert.Equal(t, "advertisement", out.String())
	assert.Equal(t, 0, q.getAuthInfoByTokenHashCall)
	assert.Equal(t, 0, q.updateLastUsedCall)
}

func TestGitHTTPProxyService_SelfhostRejectsForeignUserToken(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID: 8, Username: "foreign", TokenID: 33, TokenScopes: "read:repository",
			}, nil
		},
		getSelfHostOwnerFn: func(context.Context) (db.User, error) {
			return db.User{ID: 7, Username: "owner"}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	svc := NewGitHTTPProxyService(
		q,
		&mockGitHTTPAuthorizer{},
		repoHost,
		WithGitHTTPMemberBoundary(q),
	)

	_, err := svc.ProxyInfoRefs(context.Background(), "owner", "repo", "git-upload-pack", "foreign-token", &bytes.Buffer{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "installation owner")
	assert.Zero(t, repoHost.infoRefsCalls)
	assert.Zero(t, q.updateLastUsedCall, "rejected foreign tokens must not record authenticated use")
}

func TestGitHTTPProxyService_InfoRefs_PrivateReadWithoutToken_Challenges(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(0), userID)
			assert.Equal(t, AccessModeRead, mode)
			return errors.Forbidden("permission denied")
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	_, err := svc.ProxyInfoRefs(context.Background(), "alice", "private", "git-upload-pack", "", io.Discard)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.infoRefsCalls)
}

func TestGitHTTPProxyService_UploadPack_PrivateReadWithoutToken_Challenges(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(0), userID)
			assert.Equal(t, AccessModeRead, mode)
			return errors.Forbidden("permission denied")
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyUploadPack(
		context.Background(),
		"alice",
		"private",
		"",
		bytes.NewBufferString("upload-request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.uploadPackCalls)
}

func TestGitHTTPProxyService_UploadPack_ReadScopeRequired(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:          10,
				Username:    "alice",
				TokenID:     900,
				TokenScopes: "read:user",
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			t.Fatal("authorizer should not be called for insufficient scope")
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyUploadPack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.uploadPackCalls)
}

func TestGitHTTPProxyService_ReceivePack_WriteScopeRequired(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:          10,
				Username:    "alice",
				TokenID:     900,
				TokenScopes: "read:repository",
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			t.Fatal("authorizer should not be called for insufficient scope")
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.receivePackCall)
}

// TestGitHTTPProxyService_RepoBoundToken_OtherRepoRejected verifies that a
// per-run repository-bound token (scopes "write:repository,repo:<id>") is
// treated as anonymous on every repository other than the one it is bound to:
// push is rejected outright and a private read is challenged, while the bound
// repository itself still works.
func TestGitHTTPProxyService_RepoBoundToken_OtherRepoRejected(t *testing.T) {
	t.Parallel()

	boundRepo := db.Repository{ID: 314, Name: "bound", LowerName: "bound", UserID: pgtype.Int8{Int64: 10, Valid: true}}
	otherRepo := db.Repository{ID: 999, Name: "other", LowerName: "other", UserID: pgtype.Int8{Int64: 10, Valid: true}}
	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:          10,
				Username:    "alice",
				TokenID:     900,
				TokenScopes: "write:repository,repo:314",
			}, nil
		},
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.LowerName == "bound" {
				return boundRepo, nil
			}
			return otherRepo, nil
		},
	}

	t.Run("push to the owner's OTHER repo is rejected", func(t *testing.T) {
		repoHost := &mockGitHTTPRepoHostClient{}
		authorizer := &mockGitHTTPAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
				t.Fatal("authorizer must not be consulted for a repo-bound token on another repo")
				return nil
			},
		}
		svc := NewGitHTTPProxyService(q, authorizer, repoHost)
		err := svc.ProxyReceivePack(
			context.Background(),
			"alice",
			"other",
			"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			bytes.NewBufferString("request"),
			io.Discard,
		)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})

	t.Run("push to the bound repo still authorizes as the user", func(t *testing.T) {
		repoHost := &mockGitHTTPRepoHostClient{}
		authorized := false
		authorizer := &mockGitHTTPAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
				assert.Equal(t, int64(10), userID)
				authorized = true
				return nil
			},
		}
		svc := NewGitHTTPProxyService(q, authorizer, repoHost)
		err := svc.ProxyReceivePack(
			context.Background(),
			"alice",
			"bound",
			"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			bytes.NewBufferString("0000"),
			io.Discard,
		)
		require.NoError(t, err)
		assert.True(t, authorized)
		assert.Equal(t, 1, repoHost.receivePackCall)
	})

	t.Run("read of the owner's OTHER private repo is challenged as anonymous", func(t *testing.T) {
		repoHost := &mockGitHTTPRepoHostClient{}
		authorizer := &mockGitHTTPAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
				assert.Equal(t, int64(0), userID, "restricted token must authorize as anonymous")
				return errors.Forbidden("permission denied")
			},
		}
		svc := NewGitHTTPProxyService(q, authorizer, repoHost)
		err := svc.ProxyUploadPack(
			context.Background(),
			"alice",
			"other",
			"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			bytes.NewBufferString("request"),
			io.Discard,
		)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.uploadPackCalls)
	})
}

func TestGitHTTPProxyService_TokenHashedLookupAndLastUsedUpdated(t *testing.T) {
	t.Parallel()

	token := "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	sum := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(sum[:])
	updateCalled := false

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			assert.Equal(t, expectedHash, tokenHash)
			return db.GetAuthInfoByTokenHashRow{
				ID:            7,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       88,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
		updateAccessTokenLastUsed: func(ctx context.Context, id int64) error {
			updateCalled = true
			assert.Equal(t, int64(88), id)
			return nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{
		proxyUploadFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
			body, err := io.ReadAll(stdin)
			require.NoError(t, err)
			assert.Equal(t, "upload-request", string(body))
			_, _ = io.WriteString(stdout, "upload-response")
			return nil
		},
	}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(7), userID)
			assert.Equal(t, AccessModeRead, mode)
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	stdout := &bytes.Buffer{}
	err := svc.ProxyUploadPack(
		context.Background(),
		"alice",
		"demo",
		token,
		bytes.NewBufferString("upload-request"),
		stdout,
	)
	require.NoError(t, err)
	assert.Equal(t, "upload-response", stdout.String())
	assert.True(t, updateCalled)
}

func TestGitHTTPProxyService_AuthorizerForbidden_ReturnsAPIError(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            33,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       90,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			return errors.Forbidden("permission denied")
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"private",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.receivePackCall)
}

func TestGitHTTPProxyService_InvalidServiceRejected(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	_, err := svc.ProxyInfoRefs(context.Background(), "alice", "demo", "git-upload-archive", "", io.Discard)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestGitHTTPProxyService_InvalidTokenRejected(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestGitHTTPProxyService_TokenLastUsedWriteFailure_ReturnsInternal(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            7,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       88,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
		updateAccessTokenLastUsed: func(ctx context.Context, id int64) error {
			return stdErrors.New("write failed")
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGitHTTPProxyService_ReceivePack_Success_DispatchesPushWebhook(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return db.Repository{ID: 109}, nil
		},
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            7,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       88,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{
		proxyReceiveFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
			return nil
		},
	}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)
	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("0000"),
		io.Discard,
	)

	require.NoError(t, err)
	assert.Equal(t, 1, repoHost.receivePackCall)
	assert.Equal(t, int64(109), repoHost.lastReceiveMeta.RepositoryID)
}

func TestGitHTTPProxyService_ReceivePack_RepositoryLookupFailureStopsPush(t *testing.T) {
	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{ID: 7, Username: "alice", TokenID: 88, TokenScopes: "write:repository", IsActive: true}, nil
		},
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return db.Repository{}, pgx.ErrNoRows
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	svc := NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{}, repoHost)
	err := svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", bytes.NewBufferString("0000"), io.Discard)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 1, q.getRepoByOwnerAndLowerNameCalls)
	assert.Zero(t, repoHost.receivePackCall)
}

func TestGitHTTPProxyService_ReceivePack_ProxyFailure_DoesNotDispatchPushWebhook(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            7,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       88,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{
		proxyReceiveFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
			return stdErrors.New("repo host failed")
		},
	}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)
	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("0000"),
		io.Discard,
	)

	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 1, repoHost.receivePackCall)
}

func TestGitHTTPProxyService_ReceivePack_DispatchFailure_DoesNotFailPush(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            7,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       88,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)
	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("0000"),
		io.Discard,
	)

	require.NoError(t, err)
	assert.Equal(t, 1, repoHost.receivePackCall)
}
func TestGitHTTPProxyService_ReceivePack_ForwardsPusherMetadata(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:            42,
				Username:      "alice",
				LowerUsername: "alice",
				TokenID:       99,
				TokenScopes:   "write:repository",
				IsActive:      true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{
		proxyReceiveFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
			return nil
		},
	}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			return nil
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)
	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		"smithers_sometoken",
		bytes.NewBufferString("0000"),
		io.Discard,
	)

	require.NoError(t, err)
	assert.Equal(t, int64(42), repoHost.lastReceiveMeta.PusherID)
	assert.Equal(t, "alice", repoHost.lastReceiveMeta.PusherLogin)
}
