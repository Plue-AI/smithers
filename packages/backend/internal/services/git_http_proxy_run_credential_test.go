package services

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// On an install main is a GitHub mirror (§5.2.1, §12.2.3), including for
// person tokens. Hosted receive policy and mythical ownership stay intact.
func TestGitHTTPProxyService_ReceivePack_AgentRunCredentialNeverWritesDefaultOrMythical(t *testing.T) {
	t.Parallel()
	proxy := func(scopes string, systemIssued bool) (*GitHTTPProxyService, *mockGitHTTPRepoHostClient) {
		repo := db.Repository{ID: 314, Name: "demo", LowerName: "demo", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 10, Valid: true}}
		q := &mockGitHTTPProxyQuerier{
			getSelfHostOwnerFn: func(context.Context) (db.User, error) { return db.User{ID: 10}, nil },
			getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
				return db.GetAuthInfoByTokenHashRow{ID: 10, Username: "alice", TokenID: 900, TokenScopes: scopes, TokenSystemIssued: systemIssued}, nil
			},
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
		}
		repoHost := &mockGitHTTPRepoHostClient{}
		authorizer := &mockGitHTTPAuthorizer{authorizeFn: func(context.Context, int64, string, string, AccessMode) error { return nil }}
		return NewGitHTTPProxyService(q, authorizer, repoHost, WithGitHTTPMemberBoundary(q)), repoHost
	}
	push := func(svc *GitHTTPProxyService, refs ...string) error {
		return svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", receivePackBody(refs...), io.Discard)
	}
	for _, credential := range []struct {
		name, scopes string
		system       bool
	}{
		{"session", "write:repository", false}, {"personal-token", "write:repository", false},
		{"delegated", "write:repository", false}, {"agent-run", "write:repository,repo:314,agent-session:s1", true},
		{"machine", "write:repository,repo:314", true}, {"workspace", "write:repository,repo:314", true},
	} {
		for _, op := range []string{"fast-forward", "non-fast-forward", "create", "delete"} {
			t.Run(credential.name+"/"+op, func(t *testing.T) {
				svc, host := proxy(credential.scopes, credential.system)
				body := receivePackBody("refs/heads/main")
				old, next := strings.Repeat("1", 40), strings.Repeat("2", 40)
				if op == "non-fast-forward" {
					old, next = next, old
				}
				if op == "create" {
					old = strings.Repeat("0", 40)
				}
				if op == "delete" {
					next = strings.Repeat("0", 40)
				}
				copy(body.Bytes()[4:44], old)
				copy(body.Bytes()[45:85], next)
				err := svc.ProxyReceivePack(context.Background(), "alice", "demo", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", body, io.Discard)
				require.Error(t, err)
				assert.Equal(t, 403, apiStatus(t, err))
				refusal := err.(*pkgerrors.APIError)
				assert.Equal(t, pkgerrors.CodePermission, refusal.Code)
				assert.Equal(t, "permission", refusal.Class)
				assert.Zero(t, host.receivePackCall)
			})
		}
	}

	agent := "write:repository,repo:314,agent-session:s1"
	sync := "write:repository," + middleware.SyncCredentialScope()

	for _, refs := range [][]string{{"refs/heads/main"}, {"refs/heads/feature", "refs/heads/main"}, {repohost.MythicalBookmarkRef}} {
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
	require.NoError(t, push(svc, "refs/heads/main"), "the sync token copies GitHub's default branch")
	assert.Equal(t, middleware.CredentialSync, repoHost.lastReceiveMeta.PusherCredential)

	svc, repoHost = proxy(sync, true)
	err := push(svc, repohost.MythicalBookmarkRef)
	require.Error(t, err, "nothing but the stack service writes mythical")
	assert.Zero(t, repoHost.receivePackCall)

	svc, repoHost = proxy("write:repository", false)
	require.Error(t, push(svc, "refs/heads/main"), "install main is a GitHub mirror")
	assert.Zero(t, repoHost.receivePackCall)

	svc, repoHost = proxy("write:repository", false)
	require.NoError(t, push(svc, "refs/heads/feature"))
	assert.Equal(t, middleware.CredentialPerson, repoHost.lastReceiveMeta.PusherCredential)
	svc.ownerBoundary = nil // Hosted composition retains direct person writes.
	require.NoError(t, push(svc, "refs/heads/main"))

	// A person cannot mint a sync token: the marker counts only on a
	// system-issued token.
	svc, repoHost = proxy(sync, false)
	require.Error(t, push(svc, "refs/heads/main"))
	assert.Zero(t, repoHost.receivePackCall)
}
