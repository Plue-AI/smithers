package services

import (
	"context"
	"io"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// An agent run's token acts as the repository owner, but the default bookmark
// is reached only through landings, the stack service and the GitHub main
// pull, and the mythical stack only through the stack service. The platform's
// sync token (GitHub import and refresh) copies GitHub's refs, the default
// branch included.
func TestGitHTTPProxyService_ReceivePack_AgentRunCredentialNeverWritesDefaultOrMythical(t *testing.T) {
	t.Parallel()
	proxy := func(scopes string, systemIssued bool) (*GitHTTPProxyService, *mockGitHTTPRepoHostClient) {
		repo := db.Repository{ID: 314, Name: "demo", LowerName: "demo", DefaultBookmark: "trunk", UserID: pgtype.Int8{Int64: 10, Valid: true}}
		q := &mockGitHTTPProxyQuerier{
			getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
				return db.GetAuthInfoByTokenHashRow{ID: 10, Username: "alice", TokenID: 900, TokenScopes: scopes, TokenSystemIssued: systemIssued}, nil
			},
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
		}
		repoHost := &mockGitHTTPRepoHostClient{}
		authorizer := &mockGitHTTPAuthorizer{authorizeFn: func(context.Context, int64, string, string, AccessMode) error { return nil }}
		return NewGitHTTPProxyService(q, authorizer, repoHost), repoHost
	}
	push := func(svc *GitHTTPProxyService, refs ...string) error {
		return svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", receivePackBody(refs...), io.Discard)
	}
	agent := "write:repository,repo:314,agent-session:s1"
	sync := "write:repository," + middleware.SyncCredentialScope()

	for _, refs := range [][]string{{"refs/heads/trunk"}, {"refs/heads/feature", "refs/heads/trunk"}, {repohost.MythicalBookmarkRef}} {
		svc, repoHost := proxy(agent, true)
		err := push(svc, refs...)
		require.Error(t, err, "agent run token pushing %v", refs)
		assert.Equal(t, 403, apiStatus(t, err), "agent run token pushing %v", refs)
		assert.Zero(t, repoHost.receivePackCall, "agent run token pushing %v reached repo-host", refs)
	}

	svc, repoHost := proxy(agent, true)
	require.NoError(t, push(svc, "refs/heads/feature"))
	assert.Equal(t, middleware.CredentialAgentRun, repoHost.lastReceiveMeta.PusherCredential, "repo-host learns an agent run pushed")

	svc, repoHost = proxy(sync, true)
	require.NoError(t, push(svc, "refs/heads/trunk"), "the sync token copies GitHub's default branch")
	assert.Equal(t, middleware.CredentialSync, repoHost.lastReceiveMeta.PusherCredential)

	svc, repoHost = proxy(sync, true)
	err := push(svc, repohost.MythicalBookmarkRef)
	require.Error(t, err, "nothing but the stack service writes mythical")
	assert.Zero(t, repoHost.receivePackCall)

	svc, repoHost = proxy("write:repository", false)
	require.NoError(t, push(svc, "refs/heads/trunk"), "a person pushes the default bookmark")
	assert.Equal(t, middleware.CredentialPerson, repoHost.lastReceiveMeta.PusherCredential)

	// A person cannot mint a sync token: the marker counts only on a
	// system-issued token.
	svc, repoHost = proxy(sync, false)
	require.NoError(t, push(svc, "refs/heads/trunk"))
	assert.Equal(t, middleware.CredentialPerson, repoHost.lastReceiveMeta.PusherCredential)
}
