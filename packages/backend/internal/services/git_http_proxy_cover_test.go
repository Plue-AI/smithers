package services

import (
	"bytes"
	"context"
	stdErrors "errors"
	"io"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitHTTPProxy_Cov_AuthenticateAuthorizeAndAuthErrorBranches(t *testing.T) {
	svc := NewGitHTTPProxyService(nil, nil, &mockGitHTTPRepoHostClient{})
	credential, err := svc.authenticateTokenWithPaths(context.Background(), " ", "alice", "demo")
	require.NoError(t, err)
	assert.Nil(t, credential.user)
	assert.Nil(t, credential.scopes)

	_, err = svc.authenticateTokenWithPaths(context.Background(), "token", "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, gitHTTPProxyCovStatus(t, err))

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
	}
	svc = NewGitHTTPProxyService(q, nil, &mockGitHTTPRepoHostClient{})
	_, err = svc.authenticateTokenWithPaths(context.Background(), "token", "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, gitHTTPProxyCovStatus(t, err))

	q = &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{ID: 9, Username: "alice", TokenID: 44, TokenScopes: "read:repository"}, nil
		},
		updateAccessTokenLastUsed: func(context.Context, int64) error {
			return assert.AnError
		},
	}
	svc = NewGitHTTPProxyService(q, nil, &mockGitHTTPRepoHostClient{})
	_, err = svc.authenticateTokenWithPaths(context.Background(), "token", "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, gitHTTPProxyCovStatus(t, err))

	assert.NoError(t, gitHTTPAuthErrorForUser(&db.User{ID: 1}, AccessModeRead, nil))
	assert.Equal(t, assert.AnError, gitHTTPAuthErrorForUser(&db.User{ID: 1}, AccessModeRead, assert.AnError))
	assert.Equal(t, assert.AnError, gitHTTPAuthErrorForUser(nil, AccessModeRead, assert.AnError))
	assert.Equal(t, http.StatusUnauthorized, gitHTTPProxyCovStatus(t, gitHTTPAuthErrorForUser(nil, AccessModeRead, pkgerrors.Forbidden("private"))))
	assert.Equal(t, http.StatusForbidden, gitHTTPProxyCovStatus(t, gitHTTPAuthErrorForUser(nil, AccessModeWrite, pkgerrors.Forbidden("private"))))

	err = svc.authorize(context.Background(), 1, "alice", "repo", AccessModeRead)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, gitHTTPProxyCovStatus(t, err))

	svc = NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{authorizeFn: func(context.Context, int64, string, string, AccessMode) error {
		return stdErrors.New("resolver down")
	}}, &mockGitHTTPRepoHostClient{})
	err = svc.authorize(context.Background(), 1, "alice", "repo", AccessModeRead)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, gitHTTPProxyCovStatus(t, err))
}

func TestGitHTTPProxy_Cov_ProxyBranches(t *testing.T) {
	t.Run("receive pack requires token", func(t *testing.T) {
		svc := NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{})
		err := svc.ProxyReceivePack(context.Background(), "alice", "repo", "", bytes.NewBufferString("in"), io.Discard)
		require.Error(t, err)
		assert.Equal(t, http.StatusUnauthorized, gitHTTPProxyCovStatus(t, err))
	})

	t.Run("repo host failures map to internal", func(t *testing.T) {
		repoHost := &mockGitHTTPRepoHostClient{
			infoRefsFn: func(context.Context, string, string, string, io.Writer) (string, error) {
				return "", assert.AnError
			},
			proxyUploadFn: func(context.Context, string, string, io.Reader, io.Writer) error {
				return assert.AnError
			},
		}
		svc := NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{}, &mockGitHTTPAuthorizer{}, repoHost)

		_, err := svc.ProxyInfoRefs(context.Background(), "alice", "repo", "git-upload-pack", "", io.Discard)
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, gitHTTPProxyCovStatus(t, err))

		err = svc.ProxyUploadPack(context.Background(), "alice", "repo", "", bytes.NewBufferString("in"), io.Discard)
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, gitHTTPProxyCovStatus(t, err))
	})
}

func gitHTTPProxyCovStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}
