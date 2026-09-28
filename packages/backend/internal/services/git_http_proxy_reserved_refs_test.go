package services

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func receivePackBody(refs ...string) *bytes.Buffer {
	var buf bytes.Buffer
	for i, ref := range refs {
		line := fmt.Sprintf("%040d %040d %s", i, i+1, ref)
		if i == 0 {
			line += "\x00report-status"
		}
		line += "\n"
		fmt.Fprintf(&buf, "%04x%s", len(line)+4, line)
	}
	buf.WriteString("0000")
	buf.WriteString("PACK")
	return &buf
}

func newReservedRefProxy(t *testing.T, scopes string) (*GitHTTPProxyService, *mockGitHTTPRepoHostClient) {
	t.Helper()
	repo := db.Repository{ID: 314, Name: "demo", LowerName: "demo", UserID: pgtype.Int8{Int64: 10, Valid: true}}
	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{ID: 10, Username: "alice", TokenID: 900, TokenScopes: scopes}, nil
		},
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{authorizeFn: func(context.Context, int64, string, string, AccessMode) error { return nil }}
	return NewGitHTTPProxyService(q, authorizer, repoHost), repoHost
}

const reservedRefsWorkspace = "0f8fad5b-d9cb-469f-a165-70867728950e"

func TestGitHTTPProxyService_ReceivePack_ReservedRefs(t *testing.T) {
	t.Parallel()
	push := func(svc *GitHTTPProxyService, refs ...string) error {
		return svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", receivePackBody(refs...), io.Discard)
	}
	t.Run("user token cannot write a workspace head ref", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository")
		err := push(svc, repohost.WorkspaceHeadRef(reservedRefsWorkspace))
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})
	t.Run("user token cannot write anything under refs/smithers/", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository")
		err := push(svc, "refs/smithers/anything")
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})
	t.Run("user token still pushes bookmarks", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository")
		require.NoError(t, push(svc, "refs/heads/feature"))
		assert.Equal(t, 1, repoHost.receivePackCall)
		assert.Empty(t, repoHost.lastReceiveMeta.WorkspaceID)
	})
	t.Run("workspace token pushes its own head ref and repo-host learns the workspace", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository,repo:314,workspace:"+reservedRefsWorkspace)
		require.NoError(t, push(svc, repohost.WorkspaceHeadRef(reservedRefsWorkspace)))
		assert.Equal(t, 1, repoHost.receivePackCall)
		assert.Equal(t, reservedRefsWorkspace, repoHost.lastReceiveMeta.WorkspaceID)
	})
	t.Run("workspace token cannot push another workspace's head", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository,repo:314,workspace:"+reservedRefsWorkspace)
		err := push(svc, repohost.WorkspaceHeadRef("7c9e6679-7425-40de-944b-e07fc1f90ae7"))
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})
	t.Run("user token writes its own refs/smithers/users/<id>/ and repo-host learns the pusher", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository")
		require.NoError(t, push(svc, repohost.UserRef(10, "head")))
		assert.Equal(t, 1, repoHost.receivePackCall)
		assert.Equal(t, int64(10), repoHost.lastReceiveMeta.PusherID)
	})
	t.Run("user token cannot write another user's refs/smithers/users/<id>/", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository")
		err := push(svc, repohost.UserRef(11, "head"))
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})
	t.Run("workspace token cannot write its user's refs/smithers/users/<id>/", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository,repo:314,workspace:"+reservedRefsWorkspace)
		err := push(svc, repohost.UserRef(10, "head"))
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})
	t.Run("workspace token cannot push a bookmark", func(t *testing.T) {
		svc, repoHost := newReservedRefProxy(t, "write:repository,repo:314,workspace:"+reservedRefsWorkspace)
		err := push(svc, "refs/heads/main")
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})
}

// A push repo-host stopped at its duration limit is a 408 with its message.
func TestGitProxyFailureKeepsAPushTooSlow(t *testing.T) {
	err := gitProxyFailure(context.Background(), "receive-pack", "alice", "demo", &repohost.StatusError{
		StatusCode: http.StatusRequestTimeout, Code: repohost.PushTooSlowCode, Message: "push took longer than 10m0s; nothing was changed"})
	var apiErr *errors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, http.StatusRequestTimeout, apiErr.Status)
	require.Equal(t, "push took longer than 10m0s; nothing was changed", apiErr.Message)
}

func TestGitProxyFailureKeepsPushTooLarge(t *testing.T) {
	for _, code := range []string{"push_too_large", "user_ref_push_too_large"} {
		t.Run(code, func(t *testing.T) {
			message := "push exceeds its size cap; nothing was changed"
			err := gitProxyFailure(context.Background(), "receive-pack", "alice", "demo", &repohost.StatusError{
				StatusCode: http.StatusRequestEntityTooLarge, Code: code, Message: message})
			var apiErr *errors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, http.StatusRequestEntityTooLarge, apiErr.Status)
			assert.Equal(t, errors.Code(code), apiErr.Code)
			assert.Equal(t, message, apiErr.Message)
		})
	}
}
