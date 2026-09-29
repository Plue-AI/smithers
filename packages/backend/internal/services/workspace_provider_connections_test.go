package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const poolTestBaseURL = "https://api.example.test"

// workspaceProviderPool is a pool fake: which providers have connected
// accounts for the workspace's repository.
type workspaceProviderPool struct {
	pools map[string]bool
	// closed: the repository preference keeps platform credentials.
	closed               bool
	calls                []string
	userID, repositoryID int64
	err                  error
}

func (p *workspaceProviderPool) ServesPool(_ context.Context, userID, repositoryID int64) (bool, error) {
	p.userID, p.repositoryID = userID, repositoryID
	return !p.closed, p.err
}

func (p *workspaceProviderPool) HasPool(_ context.Context, userID, repositoryID int64, provider string) (bool, error) {
	p.calls = append(p.calls, provider)
	p.userID, p.repositoryID = userID, repositoryID
	return p.pools[provider], p.err
}

func poolTokenQuerier(minted *[]db.CreateAccessTokenParams) *mockWorkspaceQuerier {
	return &mockWorkspaceQuerier{createAccessTokenFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
		*minted = append(*minted, arg)
		return db.AccessToken{ID: int64(len(*minted)), UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}, nil
	}}
}

func TestWorkspaceProviderPoolProvisioning(t *testing.T) {
	for _, kind := range []string{"container", "vm"} {
		for _, path := range []string{"create", "snapshot", "fork", "resume"} {
			for _, provider := range []string{ProviderConnectionProviderCodex, ProviderConnectionProviderClaude, "both", "none"} {
				t.Run(kind+"/"+path+"/"+provider, func(t *testing.T) {
					ctx := context.Background()
					workspace := sampleDBWorkspace("ws-byok")
					workspace.Kind = kind
					workspace.UserID = 42
					pool := &workspaceProviderPool{pools: map[string]bool{
						ProviderConnectionProviderCodex:  provider == ProviderConnectionProviderCodex || provider == "both",
						ProviderConnectionProviderClaude: provider == ProviderConnectionProviderClaude || provider == "both",
					}}
					var minted []db.CreateAccessTokenParams
					var policy *sandbox.EgressProxyPolicy
					files := map[string]string{}
					var commands []string
					captureFiles := func(staged map[string]sandbox.SandboxFile) {
						for path, file := range staged {
							files[path] = file.Content
						}
					}
					client := &mockWorkspaceSandboxVMClient{
						createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
							policy = req.EgressProxy
							captureFiles(req.Files)
							return sandbox.CreateResult{ID: "vm-byok"}, nil
						},
						forkVMFn: func(_ context.Context, _ string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
							policy = req.EgressProxy
							captureFiles(req.Files)
							return sandbox.CreateResult{ID: "vm-byok"}, nil
						},
						startVMFn: func(_ context.Context, _ string, req sandbox.StartRequest) (sandbox.StartResult, error) {
							policy = req.EgressProxy
							return sandbox.StartResult{ID: "vm-byok"}, nil
						},
						writeFileFn: func(_ context.Context, _, path string, req sandbox.WriteFileRequest) error {
							files[path] = req.Content
							return nil
						},
						execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
							commands = append(commands, req.Command)
							status := int32(0)
							return sandbox.ExecResult{StatusCode: &status}, nil
						},
					}
					service := newWorkspaceServiceForTests(poolTokenQuerier(&minted), WithWorkspaceSandboxClient(client),
						WithWorkspaceEnvironmentImages(&stubEnvironmentImageResolver{image: nixTestImage(kind)}),
						WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderConnections(pool))
					var err error
					switch path {
					case "create":
						_, err = service.createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 999})
					case "snapshot":
						_, err = service.createWorkspaceVMFromSnapshot(ctx, workspace, db.WorkspaceSnapshot{ID: "snapshot", SnapshotID: "disk"})
					case "fork":
						source := workspace
						source.ID = "source"
						source.VmID = "vm-source"
						_, err = service.forkWorkspaceVM(ctx, workspace, source)
					case "resume":
						workspace.VmID = "vm-byok"
						_, err = service.resumeWorkspaceVM(ctx, workspace)
					}
					require.NoError(t, err)
					assert.Empty(t, pool.calls, "boot offers routes without choosing from current accounts")
					assert.Equal(t, workspace.UserID, pool.userID, "accounts belong to the workspace owner, not the caller")
					assert.Equal(t, workspace.RepositoryID, pool.repositoryID)
					require.NotNil(t, policy)
					profile := files[workspaceAgentEnvironmentProfilePath]
					// Offered with or without accounts: the first account
					// connected later serves without a restart.
					require.Len(t, minted, 1, "one pool credential per boot")
					assert.Equal(t, "provider-pool-workspace-"+workspace.ID, minted[0].Name)
					assert.Equal(t, ProviderPoolTokenScopes(workspace.RepositoryID, workspace.ID), minted[0].Scopes)
					assert.Contains(t, profile, "export "+ProviderPoolURLEnvName+"='"+poolTestBaseURL+ProviderPoolPath+"'")
					assert.Contains(t, profile, "export "+ProviderPoolProvidersEnvName+"='chatgpt'")
					assert.Equal(t, []string{ProviderPoolKeyEnvName}, policy.SecretNames(), "the pool key is the only credential; no provider token is bound")
					for _, secret := range policy.Secrets {
						assert.Equal(t, []string{"api.example.test"}, secret.Hosts, "the pool key is bound to the API host only")
					}
					assert.NotContains(t, profile, "SMITHERS_OPENAI_AUTH", "ChatGPT mode is the guest's per-seat choice")
					assert.NotContains(t, files, "/root/.codex/auth.json", "no provider session file enters the guest")
					for _, secret := range policy.Secrets {
						for path, content := range files {
							assert.NotContains(t, content, secret.Value, path)
						}
						assert.NotContains(t, strings.Join(commands, "\n"), secret.Value)
					}
				})
			}
		}
	}
}

func TestWorkspaceProviderPoolRepositorySecretPrecedence(t *testing.T) {
	for _, bound := range []bool{true, false} {
		t.Run(map[bool]string{true: "proxy", false: "setup"}[bound], func(t *testing.T) {
			env := &boundSecretsAgentEnvironmentProvider{}
			config := &env.config
			for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
				if bound {
					config.ProxyBound = append(config.ProxyBound, key)
					env.bound = append(env.bound, sandbox.EgressProxySecret{Name: key, Value: "repo-key", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}})
				} else {
					if config.Secrets == nil {
						config.Secrets = map[string]string{}
					}
					config.Secrets[key] = "repo-key"
				}
			}
			pool := &workspaceProviderPool{err: errors.New("must not consult a shadowed pool")}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderConnections(pool))
			binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-explicit"))
			require.NoError(t, err)
			assert.Empty(t, pool.calls)
			assert.Equal(t, env.bound, binding.egress.Secrets)
			assert.Equal(t, *config, binding.environment)
		})
	}
}

func TestWorkspaceProviderPoolKeepsPlatformSeats(t *testing.T) {
	var minted []db.CreateAccessTokenParams
	pool := &workspaceProviderPool{pools: map[string]bool{ProviderConnectionProviderCodex: true}}
	service := newWorkspaceServiceForTests(poolTokenQuerier(&minted), WithWorkspaceGitBaseURL(poolTestBaseURL),
		WithWorkspaceProviderBootstrap([]modelproxy.Seat{modelproxy.Seats[0]}, ""), WithWorkspaceProviderConnections(pool))
	binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-platform"))
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{ProviderPoolKeyEnvName, "ANTHROPIC_API_KEY"}, binding.egress.SecretNames(),
		"the metered seat stays for a seat the pool has no accounts for")
	for _, secret := range binding.egress.Secrets {
		assert.Equal(t, []string{"api.example.test"}, secret.Hosts)
	}
	var names []string
	for _, token := range minted {
		names = append(names, strings.SplitN(token.Name, "-workspace-", 2)[0])
	}
	assert.ElementsMatch(t, []string{"provider-pool", "model-proxy"}, names)
	assert.Empty(t, bootstrapModel(binding.environment), "the platform seat must not pin the offered pool")
	assert.Equal(t, "anthropic:claude-sonnet-4-6", bootstrapFallbackModel(binding.environment), "the platform seat remains available when the pool is empty")
	profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
	require.NoError(t, err)
	assert.NotContains(t, profile, "private")
}

func TestWorkspaceProviderPoolNoConnectionPreservesRequest(t *testing.T) {
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderConnections(&workspaceProviderPool{closed: true}))
	req, err := service.buildWorkspaceVMRequest(context.Background(), "", nil, 101, "", "container")
	require.NoError(t, err)
	before, err := json.Marshal(req)
	require.NoError(t, err)
	binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-none"))
	require.NoError(t, err)
	binding.apply(&req)
	after, err := json.Marshal(req)
	require.NoError(t, err)
	assert.JSONEq(t, string(before), string(after))
}

func TestWorkspaceProviderPoolFailurePreventsBoot(t *testing.T) {
	pool := &workspaceProviderPool{err: errors.New("secret-token-in-upstream-error")}
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderConnections(pool), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Fatal("must not boot")
			return sandbox.CreateResult{}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			t.Fatal("must not resume")
			return sandbox.StartResult{}, nil
		},
	}))
	workspace := sampleDBWorkspace("ws-failure")
	_, err := service.createWorkspaceVM(context.Background(), workspace, CreateWorkspaceSessionInput{})
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret-token")
	_, err = service.resumeWorkspaceVM(context.Background(), workspace)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret-token")
}

func TestWorkspaceProviderPoolPrecedenceIsPerProvider(t *testing.T) {
	for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
		t.Run(key, func(t *testing.T) {
			env := &boundSecretsAgentEnvironmentProvider{bound: []sandbox.EgressProxySecret{{Name: key, Value: "repo-key", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}}
			env.config.ProxyBound = []string{key}
			pool := &workspaceProviderPool{pools: map[string]bool{ProviderConnectionProviderCodex: true, ProviderConnectionProviderClaude: true}}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceGitBaseURL(poolTestBaseURL), WithWorkspaceProviderConnections(pool))
			binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-precedence"))
			require.NoError(t, err)
			assert.Contains(t, binding.egress.Secrets, env.bound[0])
			vars := map[string]string{}
			for _, variable := range binding.environment.Env {
				vars[variable.Name] = variable.Value
			}
			assert.Empty(t, pool.calls)
			if key == "OPENAI_API_KEY" {
				// The repository keys the one pool seat itself: no pool is
				// offered, and an Anthropic key never has a pool route (#2777).
				assert.NotContains(t, vars, ProviderPoolProvidersEnvName)
				assert.NotContains(t, binding.egress.SecretNames(), ProviderPoolKeyEnvName)
			} else {
				assert.Equal(t, "chatgpt", vars[ProviderPoolProvidersEnvName])
			}
		})
	}
}

func TestProviderPoolScopesBindOnlyTheWorkspaceCredential(t *testing.T) {
	workspace := sampleDBWorkspace("ws-scope")
	q := &poolScopeQuerier{workspace: workspace, tokens: map[int64]db.AccessToken{
		1: {ID: 1, UserID: workspace.UserID, Name: "provider-pool-workspace-" + workspace.ID, SystemIssued: true},
		2: {ID: 2, UserID: workspace.UserID, Name: "sandbox-workspace-" + workspace.ID, SystemIssued: true},
		3: {ID: 3, UserID: workspace.UserID, Name: "provider-pool-workspace-" + workspace.ID},
	}}
	scopes := NewProviderPoolScopes(q, nil, nil)
	tokenID := int64(1)
	info := func(userID int64, raw string) *middleware.AuthInfo {
		return &middleware.AuthInfo{User: &db.User{ID: userID}, IsTokenAuth: true, TokenID: tokenID, RawScopes: raw}
	}
	scope := func(info *middleware.AuthInfo) (int64, int64, bool) {
		ctx := context.Background()
		if info != nil {
			ctx = middleware.ContextWithAuthInfo(ctx, info)
		}
		return scopes.Scope(ctx, "smithers_pooltoken")
	}
	user, repo, ok := scope(info(workspace.UserID, ProviderPoolTokenScopes(workspace.RepositoryID, workspace.ID)))
	require.True(t, ok)
	assert.Equal(t, [2]int64{workspace.UserID, workspace.RepositoryID}, [2]int64{user, repo})
	for name, candidate := range map[string]*middleware.AuthInfo{
		"no workspace binding":   info(workspace.UserID, "read:workspace,repo:1"),
		"another repository":     info(workspace.UserID, ProviderPoolTokenScopes(workspace.RepositoryID+1, workspace.ID)),
		"another user":           info(workspace.UserID+1, ProviderPoolTokenScopes(workspace.RepositoryID, workspace.ID)),
		"another workspace":      info(workspace.UserID, ProviderPoolTokenScopes(workspace.RepositoryID, "ws-other")),
		"a session, not a token": nil,
	} {
		_, _, ok := scope(candidate)
		assert.False(t, ok, name)
	}
	for _, id := range []int64{2, 3, 99} {
		tokenID = id
		_, _, ok := scope(info(workspace.UserID, workspaceHeadTokenScopes(workspace.RepositoryID, workspace.ID)))
		assert.False(t, ok, "token %d: only the workspace's pool credential spends an account", id)
	}
}

// A managed host's credential never passes on syntax alone: without its
// live binding it has no pool.
func TestProviderPoolScopesVerifyAHostCredential(t *testing.T) {
	scopes := NewProviderPoolScopes(&poolScopeQuerier{}, nil, nil)
	_, _, ok := scopes.Scope(context.Background(), "smithers_flowhost_11111111-1111-4111-8111-111111111111.forged")
	assert.False(t, ok)
}

type poolScopeQuerier struct {
	workspace db.Workspace
	tokens    map[int64]db.AccessToken
}

func (q *poolScopeQuerier) GetAccessTokenByID(_ context.Context, id int64) (db.AccessToken, error) {
	if token, ok := q.tokens[id]; ok {
		return token, nil
	}
	return db.AccessToken{}, errors.New("not found")
}

func (q *poolScopeQuerier) GetWorkspace(_ context.Context, id string) (db.Workspace, error) {
	if id == q.workspace.ID {
		return q.workspace, nil
	}
	return db.Workspace{}, errors.New("not found")
}
