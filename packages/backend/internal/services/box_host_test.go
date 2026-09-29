package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type boxHostTestQuerier struct {
	*workspaceHeadTestQuerier
	shared    bool
	tokens    []db.AccessToken
	deleted   []int64
	repoErr   error
	createErr error
}

func (q *boxHostTestQuerier) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	if q.repoErr != nil {
		return db.Repository{}, q.repoErr
	}
	return db.Repository{ID: id, Name: "Widgets", OrgID: pgtype.Int8{Int64: 5, Valid: true}}, nil
}
func (q *boxHostTestQuerier) GetOrgByID(_ context.Context, id int64) (db.Organization, error) {
	return db.Organization{ID: id, Name: "acme co"}, nil
}
func (q *boxHostTestQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	return db.User{ID: id, Username: "someone"}, nil
}
func (q *boxHostTestQuerier) HasWritableWorkspaceShares(context.Context, string) (bool, error) {
	return q.shared, nil
}
func (q *boxHostTestQuerier) ListAccessTokensByUserID(context.Context, int64) ([]db.AccessToken, error) {
	return q.tokens, nil
}
func (q *boxHostTestQuerier) CreateAccessToken(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	if q.createErr != nil && strings.HasPrefix(arg.Name, "flow-host-cache-") {
		return db.AccessToken{}, q.createErr
	}
	token := db.AccessToken{ID: int64(len(q.tokens) + 100), UserID: arg.UserID, Name: arg.Name, Scopes: arg.Scopes}
	q.tokens = append(q.tokens, token)
	return token, nil
}
func (q *boxHostTestQuerier) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	q.deleted = append(q.deleted, arg.ID)
	return nil
}

// The box's coding host gets the box's landing binding and a repository-scoped
// landing credential for each start; the previous one is revoked (#2198).
func TestPrepareBoxHostMintsTheLandingCredentialPerStart(t *testing.T) {
	prepareRuntimeTestHelper(t)
	workspace := db.Workspace{ID: "workspace-2198", RepositoryID: 77, UserID: 9, VmID: "vm-2198", Status: "running", TargetBookmark: "main"}
	q := &boxHostTestQuerier{workspaceHeadTestQuerier: &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
	}}}
	q.tokens = []db.AccessToken{{ID: 7, UserID: 9, Name: "flow-host-landing-host-1"}, {ID: 8, UserID: 9, Name: "other"},
		{ID: 9, UserID: 9, Name: "flow-host-cache-host-1"}}
	probes := 0
	vm := &mockWorkspaceSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			probes++
			status := int32(0)
			if probes == 2 {
				return sandbox.ExecResult{StatusCode: &status, Stdout: runtimeTestReceipt(t, workspace, "unchanged")}, nil
			}
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceGitBaseURL("https://api.jjhub.tech/"), WithWorkspaceSandboxClient(vm),
		WithWorkspaceAgentEnvironment(boxHostTestEnvironment{}))

	environment, err := svc.PrepareBoxHost(context.Background(), "host-1", workspace.ID, 77, 9)
	require.NoError(t, err)
	require.Equal(t, "https://api.jjhub.tech/api", environment["SMITHERS_JJHUB_API_URL"])
	require.Equal(t, "production", environment["NODE_ENV"])
	require.Equal(t, sandbox.EgressProxyPlaceholder("NPM_TOKEN"), environment["NPM_TOKEN"], "a secret is its egress placeholder")
	require.NotContains(t, environment, "PATH")
	require.NotContains(t, environment, "NEVER", "a plaintext setup secret never reaches the host")
	require.NotContains(t, environment, "SMITHERS_GATEWAY_ID")
	require.NotEmpty(t, environment["SMITHERS_JJHUB_TOKEN"])
	require.Equal(t, []int64{7, 9}, q.deleted, "the previous start's credentials are revoked")
	minted, cache := q.tokens[len(q.tokens)-2], q.tokens[len(q.tokens)-1]
	require.Equal(t, "flow-host-landing-host-1", minted.Name)
	require.Equal(t, boxHostLandingTokenScopes(77, workspace.ID), minted.Scopes)
	require.Equal(t, 2, probes, "the source publisher and landing binding are checked first")

	svc.RetireBoxHostCredential(context.Background(), "host-1", 9)
	require.Equal(t, []int64{7, 9, 7, 9, minted.ID, cache.ID}, q.deleted)

	// Stopping or suspending the box revokes every host credential minted for it.
	q.deleted = nil
	q.tokens = append(q.tokens, db.AccessToken{ID: 50, UserID: 9, Name: "flow-host-landing-other-box", Scopes: boxHostLandingTokenScopes(77, "another")})
	svc.retireBoxHostCredentials(context.Background(), workspace)
	require.Contains(t, q.deleted, minted.ID)
	require.Contains(t, q.deleted, cache.ID, "the cache credential stops with its box")
	require.NotContains(t, q.deleted, int64(50))
	require.NotContains(t, q.deleted, int64(8))

	q.shared = true
	environment, err = svc.PrepareBoxHost(context.Background(), "host-1", workspace.ID, 77, 9)
	require.NoError(t, err)
	require.NotContains(t, environment, "SMITHERS_JJHUB_TOKEN", "a box with write shares gets no credential")
	require.NotContains(t, environment, "SMITHERS_CACHE_TOKEN")
	require.NotContains(t, environment, "SMITHERS_CACHE_URL")
	require.Equal(t, "production", environment["NODE_ENV"])

	unprovisioned := newWorkspaceServiceForTests(q, WithWorkspaceGitBaseURL("https://api.jjhub.tech"), WithWorkspaceAgentEnvironment(boxHostTestEnvironment{}))
	environment, err = unprovisioned.PrepareBoxHost(context.Background(), "host-1", workspace.ID, 77, 9)
	require.NoError(t, err)
	require.NotContains(t, environment, "SMITHERS_JJHUB_TOKEN", "a runtime without the landing binding gets no credential")
	require.NotContains(t, environment, "SMITHERS_CACHE_TOKEN")
	require.Equal(t, "production", environment["NODE_ENV"], "but still the repository's agent environment")
}

// The coding host's checks read the repository's remote target cache with
// their own credential: read-only, bound to the one repository, never the
// landing credential (whose write scope unreviewed check code must not hold),
// and revoked with the host (#1756).
func TestPrepareBoxHostGrantsAReadOnlyBuildCacheCredential(t *testing.T) {
	prepareRuntimeTestHelper(t)
	workspace := db.Workspace{ID: "workspace-1756", RepositoryID: 77, UserID: 9, VmID: "vm-1756", Status: "running", TargetBookmark: "main"}
	q := &boxHostTestQuerier{workspaceHeadTestQuerier: &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
	}}}
	probes := 0
	vm := &mockWorkspaceSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			probes++
			status := int32(0)
			if probes%2 == 0 {
				return sandbox.ExecResult{StatusCode: &status, Stdout: runtimeTestReceipt(t, workspace, "unchanged")}, nil
			}
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceGitBaseURL("https://api.jjhub.tech/"), WithWorkspaceSandboxClient(vm))

	environment, err := svc.PrepareBoxHost(context.Background(), "host-1", workspace.ID, 77, 9)
	require.NoError(t, err)
	require.Equal(t, "https://api.jjhub.tech/api/repos/acme%20co/Widgets/build-cache", environment["SMITHERS_CACHE_URL"])
	require.NotEmpty(t, environment["SMITHERS_CACHE_TOKEN"])
	require.NotEqual(t, environment["SMITHERS_JJHUB_TOKEN"], environment["SMITHERS_CACHE_TOKEN"], "never the landing credential")
	cache := q.tokens[len(q.tokens)-1]
	require.Equal(t, "flow-host-cache-host-1", cache.Name)
	scopes := strings.Split(cache.Scopes, ",")
	require.Contains(t, scopes, "read:repository")
	require.Contains(t, scopes, "repo:77")
	require.NotContains(t, scopes, "write:repository")
	require.Equal(t, boxHostCacheTokenScopes(77, workspace.ID), cache.Scopes)

	// A cache credential that cannot be minted fails the start and revokes
	// the landing credential minted just before it.
	q.tokens, q.deleted = nil, nil
	q.createErr = errors.New("database unavailable")
	_, err = svc.PrepareBoxHost(context.Background(), "host-2", workspace.ID, 77, 9)
	require.ErrorIs(t, err, q.createErr)
	require.Len(t, q.tokens, 1)
	require.Equal(t, []int64{q.tokens[0].ID}, q.deleted)

	// A repository that cannot be loaded mints nothing.
	q.tokens, q.deleted, q.createErr = nil, nil, nil
	q.repoErr = errors.New("repository gone")
	_, err = svc.PrepareBoxHost(context.Background(), "host-3", workspace.ID, 77, 9)
	require.ErrorIs(t, err, q.repoErr)
	require.Empty(t, q.tokens)
}

type boxHostTestEnvironment struct{}

func (boxHostTestEnvironment) LoadForProvisioning(context.Context, int64) (AgentEnvironmentProvisioningConfig, error) {
	return AgentEnvironmentProvisioningConfig{
		Env: []AgentEnvironmentVariable{{Name: "NODE_ENV", Value: "production"}, {Name: "PATH", Value: "/evil"},
			{Name: "SMITHERS_GATEWAY_ID", Value: "spoofed"}},
		Secrets:    map[string]string{"NEVER": "plaintext"},
		ProxyBound: []string{"NPM_TOKEN"},
	}, nil
}

type boxActivityCounter struct {
	*mockWorkspaceQuerier
	touches int
}

func (q *boxActivityCounter) TouchWorkspaceActivity(context.Context, string) error {
	q.touches++
	return nil
}

// Using a box's coding host keeps the box awake without a write per call.
func TestKeepBoxAwakeWritesAtMostOncePerInterval(t *testing.T) {
	q := &boxActivityCounter{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	svc := newWorkspaceServiceForTests(q)
	for range 5 {
		svc.KeepBoxAwake(context.Background(), "box")
	}
	svc.KeepBoxAwake(context.Background(), "other")
	require.Equal(t, 2, q.touches)
}

// A backend restart stops every workspace in the runtime. A box the product
// still holds running is started again for its host; one stopped or
// suspended on purpose is refused and never touched (#2131).
func TestRestartLostBoxStartsOnlyABoxHeldRunning(t *testing.T) {
	startReached := errors.New("runtime start reached")
	for _, status := range []string{"running", "suspended", "stopped"} {
		t.Run(status, func(t *testing.T) {
			row := sampleDBWorkspace("ws-lost-box")
			row.Status = status
			q := &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return row, nil },
				getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return row, nil },
			}
			runtime := &admissionWorkspaceRuntime{startErr: startReached}
			service := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(&countedResumePolicy{}), WithWorkspaceRuntime(runtime))
			err := service.RestartLostBox(context.Background(), row.ID, row.RepositoryID, row.UserID)
			if status == "running" {
				require.ErrorContains(t, err, startReached.Error())
				require.Equal(t, 1, runtime.starts)
				return
			}
			require.Error(t, err)
			require.Zero(t, runtime.starts)
		})
	}
}
