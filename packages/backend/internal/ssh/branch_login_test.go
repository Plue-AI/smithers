package ssh

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type branchResolverFunc func(context.Context, int64, string) (WorkspaceAccess, error)

func (f branchResolverFunc) ResolveBranch(ctx context.Context, member int64, branch string) (WorkspaceAccess, error) {
	return f(ctx, member, branch)
}

// Supplemental auth-boundary tests: these fixtures are not C-J3-06 evidence.
func TestBranchLoginProvidersFailClosed(t *testing.T) {
	key, fingerprint := outageTestKey(t)
	for _, tc := range []struct {
		name                    string
		resolver                bool
		bridge                  bool
		resolveErr, validateErr error
	}{
		{name: "no providers"},
		{name: "no roster identity authorization", bridge: true},
		{name: "no authenticated daemon transport", resolver: true},
		{name: "removed member", resolver: true, bridge: true, resolveErr: ErrWorkspaceAccessDenied},
		{name: "suspended member", resolver: true, bridge: true, resolveErr: ErrWorkspaceAccessDenied},
		{name: "unavailable identity", resolver: true, bridge: true, resolveErr: ErrWorkspaceUnavailable},
		{name: "bridge refused", resolver: true, bridge: true, validateErr: ErrWorkspaceAccessDenied},
		{name: "bridge unavailable", resolver: true, bridge: true, validateErr: ErrWorkspaceUnavailable},
		{name: "authorized", resolver: true, bridge: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolves := 0
			s := &Server{BranchLogins: true, Queries: knownUserQuerier(fingerprint)}
			if tc.resolver {
				s.BranchResolver = branchResolverFunc(func(_ context.Context, member int64, branch string) (WorkspaceAccess, error) {
					resolves++
					assert.Equal(t, int64(7), member)
					assert.Equal(t, "retry-webhooks", branch)
					return WorkspaceAccess{SandboxID: "machine-1", User: "alice"}, tc.resolveErr
				})
			}
			bridge := &stubWorkspaceBridge{err: tc.validateErr}
			if tc.bridge {
				s.WorkspaceBridge = bridge
			}
			ctx := newAuthTestContext("127.0.0.1:3000", "retry-webhooks")
			want := tc.resolver && tc.bridge && tc.resolveErr == nil && tc.validateErr == nil
			assert.Equal(t, want, s.publicKeyHandler(ctx, key))
			if !tc.resolver || !tc.bridge {
				assert.Zero(t, resolves)
				assert.Zero(t, bridge.calls)
			}
			if tc.resolveErr != nil {
				assert.Zero(t, bridge.calls)
			}
			if !want {
				assert.Nil(t, ctx.Value(workspaceAccessKey))
			}
		})
	}
}

func TestBranchCompositionRejectsGrantsAndPasswords(t *testing.T) {
	key, fingerprint := outageTestKey(t)
	bridge := &stubWorkspaceBridge{}
	s := &Server{BranchLogins: true, WorkspaceBridge: bridge, Queries: knownUserQuerier(fingerprint)}
	for _, login := range []string{"sandbox+alice", "sandbox+alice:" + outageTestToken, "../workspace"} {
		ctx := newAuthTestContext("127.0.0.1:3000", login)
		assert.False(t, s.publicKeyHandler(ctx, key))
		assert.False(t, s.passwordHandler(ctx, outageTestToken))
	}
	assert.False(t, s.passwordHandler(newAuthTestContext("127.0.0.1:3000", "retry-webhooks"), outageTestToken))
	assert.Zero(t, bridge.calls)
	// Git transport remains available using its conventional username.
	assert.True(t, s.publicKeyHandler(newAuthTestContext("127.0.0.1:3000", "git"), key))
}

func TestBranchAmbiguityOnlyPrintsCandidates(t *testing.T) {
	key, fingerprint := outageTestKey(t)
	bridge := &stubWorkspaceBridge{}
	s := &Server{BranchLogins: true, WorkspaceBridge: bridge, Queries: knownUserQuerier(fingerprint), BranchResolver: branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) {
		return WorkspaceAccess{}, &AmbiguousBranchError{Candidates: []string{"scratch/ben/draft", "scratch/maya/draft"}}
	})}
	ctx := newAuthTestContext("127.0.0.1:3000", "draft")
	require.True(t, s.publicKeyHandler(ctx, key))
	sess := newTestSession("", "")
	sess.ctx.SetValue(workspaceAccessKey, ctx.Value(workspaceAccessKey))
	sess.ctx.SetValue(workspaceErrorKey, ctx.Value(workspaceErrorKey))
	s.sessionHandler(sess)
	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "ambiguous branch: scratch/ben/draft, scratch/maya/draft")
	assert.Zero(t, bridge.calls)
}

func TestBranchLoginRejectsUnknownAndDeployKeys(t *testing.T) {
	key, _ := outageTestKey(t)
	queries := knownUserQuerier() // no member key
	s := &Server{BranchLogins: true, Queries: queries, WorkspaceBridge: &stubWorkspaceBridge{}, BranchResolver: branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) {
		t.Fatal("a non-member key must never reach branch resolution")
		return WorkspaceAccess{}, nil
	})}
	assert.False(t, s.publicKeyHandler(newAuthTestContext("127.0.0.1:3000", "retry-webhooks"), key))
	queries.getAnyDeployKeyByFingerprint = func(context.Context, string) (db.DeployKey, error) {
		return db.DeployKey{ID: 1}, nil
	}
	assert.False(t, s.publicKeyHandler(newAuthTestContext("127.0.0.1:3000", "retry-webhooks"), key))
}

func TestBranchLoginRejectsGrantMaterialAndMissingIdentity(t *testing.T) {
	key, fingerprint := outageTestKey(t)
	for _, access := range []WorkspaceAccess{
		{}, {SandboxID: "machine-1"}, {User: "alice"},
		{SandboxID: "machine-1", User: "alice", Token: outageTestToken},
		{SandboxID: "machine-1", User: "root"},
		{SandboxID: "machine-1", User: "developer"},
		{SandboxID: "machine-1", User: "agent"},
		{SandboxID: "machine-1", User: "machined"},
		{SandboxID: "machine-1", User: "../alice"},
		{SandboxID: "machine-1", User: "Alice"},
		{SandboxID: "machine-1", User: "álîce"},
	} {
		bridge := &stubWorkspaceBridge{}
		s := &Server{BranchLogins: true, Queries: knownUserQuerier(fingerprint), WorkspaceBridge: bridge, BranchResolver: branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) { return access, nil })}
		assert.False(t, s.publicKeyHandler(newAuthTestContext("127.0.0.1:3000", "retry-webhooks"), key))
		assert.Zero(t, bridge.calls)
	}
}

type branchTestSession struct{ *testSession }

func (*branchTestSession) User() string { return "retry-webhooks" }

func TestBranchChannelRechecksAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name      string
		principal bool
		resolver  bool
		access    WorkspaceAccess
		err       error
	}{
		{name: "missing principal", resolver: true},
		{name: "missing resolver", principal: true},
		{name: "revoked after authentication", principal: true, resolver: true, err: ErrWorkspaceAccessDenied},
		{name: "identity changed", principal: true, resolver: true, access: WorkspaceAccess{SandboxID: "machine-1", User: "bob"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bridge := &stubWorkspaceBridge{}
			s := &Server{BranchLogins: true, WorkspaceBridge: bridge}
			if tc.resolver {
				s.BranchResolver = branchResolverFunc(func(_ context.Context, member int64, branch string) (WorkspaceAccess, error) {
					assert.Equal(t, int64(7), member)
					assert.Equal(t, "retry-webhooks", branch)
					return tc.access, tc.err
				})
			}
			sess := &branchTestSession{newTestSession("", "")}
			sess.ctx.SetValue(workspaceAccessKey, WorkspaceAccess{SandboxID: "machine-1", User: "alice"})
			if tc.principal {
				sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 7, Username: "alice"})
			}
			s.sessionHandler(sess)
			assert.Equal(t, 1, sess.exitCode)
			assert.Zero(t, bridge.calls, "refuse before validating or serving a different/revoked identity")
		})
	}
}
