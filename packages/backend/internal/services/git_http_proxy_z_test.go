package services

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestGitHTTPProxy_Z_InfoRefsUploadAndAuthErrorBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	token := "smithers_z_token"

	svc := NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
	}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{})
	_, err := svc.ProxyInfoRefs(ctx, "alice", "demo", "git-upload-pack", token, io.Discard)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{})
	_, err = svc.ProxyInfoRefs(ctx, "alice", "demo", "git-receive-pack", "", io.Discard)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{ID: 1, Username: "alice", TokenID: 9, TokenScopes: "read:repository"}, nil
		},
	}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{})
	_, err = svc.ProxyInfoRefs(ctx, "alice", "demo", "git-receive-pack", token, io.Discard)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{
		infoRefsFn: func(context.Context, string, string, string, io.Writer) (string, error) {
			return "", errors.New("repo host failed")
		},
	})
	_, err = svc.ProxyInfoRefs(ctx, "alice", "demo", "git-upload-pack", "", io.Discard)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{
		proxyUploadFn: func(context.Context, string, string, io.Reader, io.Writer) error {
			return errors.New("repo host failed")
		},
	})
	err = svc.ProxyUploadPack(ctx, "alice", "demo", "", bytes.NewBufferString("req"), io.Discard)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = NewGitHTTPProxyService(nil, nil, nil)
	_, err = svc.authenticateTokenWithPaths(ctx, token, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, errors.New("db failed")
		},
	}, nil, nil)
	_, err = svc.authenticateTokenWithPaths(ctx, token, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = svc.authenticateTokenWithPaths(ctx, " ", "alice", "demo")
	require.NoError(t, err)

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
	}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{})
	err = svc.ProxyUploadPack(ctx, "alice", "demo", token, bytes.NewBufferString("req"), io.Discard)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	svc = NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{ID: 7, Username: "alice", TokenID: 8, TokenScopes: "read:repository"}, nil
		},
	}, &mockGitHTTPAuthorizer{}, &mockGitHTTPRepoHostClient{
		proxyUploadFn: func(context.Context, string, string, io.Reader, io.Writer) error {
			return errors.New("upload failed")
		},
	})
	err = svc.ProxyUploadPack(ctx, "alice", "demo", token, bytes.NewBufferString("req"), io.Discard)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}
