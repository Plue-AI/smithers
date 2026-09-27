package services

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkflowSandboxScheduler_Cov_OptionsEnvAndStart(t *testing.T) {
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_POLL_INTERVAL", "-1s")
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_CLAIM_LIMIT", "-3")
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_TIMEOUT", "not-a-duration")
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_VCPU_COUNT", "0")
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_MEMORY_MB", "0")
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_DISK_MB", "0")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	injector := NewSecretInjector(nil, nil)
	worker := NewWorkflowSandboxSchedulerWorker(
		&mockWorkflowSandboxSchedulerQuerier{},
		&mockWorkflowSandboxVMClient{},
		WithWorkflowSandboxSchedulerLogger(logger),
		WithWorkflowSandboxSchedulerLogger(nil),
		WithWorkflowSandboxSchedulerAPIBaseURL(" https://api.example.test "),
		WithWorkflowSandboxSchedulerGitBaseURL(" https://git.example.test "),
		WithWorkflowSandboxSchedulerSecretInjector(injector),
	)
	assert.Same(t, logger, worker.logger)
	assert.Same(t, injector, worker.secretInjector)
	assert.Equal(t, "https://api.example.test", worker.apiBaseURL)
	assert.Equal(t, "https://git.example.test", worker.gitBaseURL)
	assert.Equal(t, defaultWorkflowSandboxSchedulerInterval, worker.interval)
	assert.Equal(t, defaultWorkflowSandboxSchedulerClaim, worker.limit)
	assert.Equal(t, defaultWorkflowSandboxTimeout, worker.timeout)
	assert.Equal(t, defaultWorkflowSandboxVCPUCount, worker.vcpuCount)
	assert.Equal(t, defaultWorkflowSandboxMemoryMB, worker.memoryMB)
	assert.Equal(t, defaultWorkflowSandboxRootfsMB, worker.rootfsSizeMB)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Start(ctx)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Start did not return after context cancellation")
	}
}

func TestWorkflowSandboxScheduler_Cov_HelperBranches(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []string{"a.test", "b.test"}, parseWorkflowSandboxRegistries(" b.test, a.test, b.test,, "))
	assert.Equal(t, defaultWorkflowSandboxRegistries, parseWorkflowSandboxRegistries(""))
	assert.Equal(t, []string{"a", "b"}, splitCSV(" a, ,b "))
	assert.Equal(t, []string{"a", "b"}, uniqueSortedStrings([]string{" b ", "", "a", "b"}))
	assert.Equal(t, "api.example.test", hostForFirewallRule("https://api.example.test/base"))
	assert.Empty(t, hostForFirewallRule("://bad-url"))

	worker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{}, &mockWorkflowSandboxVMClient{})
	worker.apiBaseURL = "://bad"
	worker.apiGatewayURL = ""
	worker.allowedRegistry = nil
	emptyPolicy := worker.buildFirewallPolicy()
	require.NotNil(t, emptyPolicy)
	assert.Equal(t, "deny", emptyPolicy.DefaultEgressAction)
	assert.Empty(t, emptyPolicy.EgressAllow)

	worker.apiBaseURL = "https://api.example.test"
	worker.apiGatewayURL = "https://gateway.example.test/path"
	worker.allowedRegistry = []string{"registry.yarnpkg.com", "registry.yarnpkg.com", " npm.example.test "}
	policy := worker.buildFirewallPolicy()
	require.NotNil(t, policy)
	assert.Equal(t, "deny", policy.DefaultEgressAction)
	hosts := make([]string, 0, len(policy.EgressAllow))
	for _, rule := range policy.EgressAllow {
		hosts = append(hosts, rule.Host)
		assert.Equal(t, int32(443), rule.Port)
		assert.Equal(t, "tcp", rule.Protocol)
	}
	// The jjhub API host (apiBaseURL) is always allowed alongside the gateway
	// host so the runner's SMITHERS_JJHUB_API_URL tools work under
	// deny-by-default egress.
	assert.Equal(t, []string{"api.example.test", "gateway.example.test", "npm.example.test", "registry.yarnpkg.com"}, hosts)

	clonedEnv := cloneSandboxEnvironment(map[string]string{"TOKEN": "secret"})
	assert.Equal(t, "secret", clonedEnv["TOKEN"])
	clonedEnv["TOKEN"] = "changed"
	assert.Nil(t, cloneSandboxEnvironment(nil))

	url, err := buildPublicRepoCloneURL("https://git.example.test/root", "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "https://git.example.test/root/alice/demo.git", url)
	_, err = buildPublicRepoCloneURL("", "alice", "demo")
	require.Error(t, err)
	_, err = buildPublicRepoCloneURL("https://git.example.test", "", "demo")
	require.Error(t, err)
	_, err = buildPublicRepoCloneURL("://bad", "alice", "demo")
	require.Error(t, err)
}

func TestWorkflowSandboxScheduler_Cov_RunPreparationAndFailureBranches(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, pgx.ErrNoRows
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})
	err := worker.executeRun(context.Background(), testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 50, RepositoryID: 60, WorkflowDefinitionID: 70}))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to load workflow definition")
	assert.Equal(t, []int64{50}, queries.markFailureIDs)
	assert.Empty(t, queries.terminalSteps)

	created := false
	stepWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		listWorkflowStepsByRunIDFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			assert.Equal(t, int64(80), runID)
			return nil, nil
		},
		createWorkflowStepFn: func(_ context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			created = true
			assert.Equal(t, int64(80), arg.WorkflowRunID)
			assert.Equal(t, "sandbox", arg.Name)
			assert.Equal(t, int64(1), arg.Position)
			assert.Equal(t, "running", arg.Status)
			return db.WorkflowStep{ID: 81, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, Status: arg.Status}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	step, err := stepWorker.ensureRunningStep(context.Background(), 80)
	require.NoError(t, err)
	assert.True(t, created)
	assert.Equal(t, int64(81), step.ID)

	orgWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", OrgID: pgtype.Int8{Int64: 44, Valid: true}}, nil
		},
		getOrgByIDFn: func(_ context.Context, id int64) (db.Organization, error) {
			assert.Equal(t, int64(44), id)
			return db.Organization{ID: id, Name: "acme"}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	repo, owner, cloneUserID, err := orgWorker.resolveRepositoryOwner(context.Background(), 90)
	require.NoError(t, err)
	assert.Equal(t, int64(90), repo.ID)
	assert.Equal(t, "acme", owner)
	assert.Zero(t, cloneUserID)

	noOwnerWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "orphan"}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	_, _, _, err = noOwnerWorker.resolveRepositoryOwner(context.Background(), 91)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository owner not set")
}

func TestWorkflowSandboxScheduler_Cov_CloneURLAndVMRequestBranches(t *testing.T) {
	t.Parallel()

	worker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		createAccessTokenFn: func(_ context.Context, _ db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{}, fmt.Errorf("token store down")
		},
	}, &mockWorkflowSandboxVMClient{}, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"))

	cloneURL, cloneToken, revoke, err := worker.buildCloneURL(context.Background(), 42, "alice", "demo", 7)
	require.NoError(t, err)
	assert.Equal(t, "https://git.example.test/alice/demo.git", cloneURL)
	assert.Empty(t, cloneToken, "public fallback clone URL must not carry a token")
	require.NotNil(t, revoke)
	revoke()

	worker.gitBaseURL = ""
	_, _, _, err = worker.buildCloneURL(context.Background(), 42, "alice", "demo", 0)
	require.Error(t, err)

	worker.gitBaseURL = "https://git.example.test"
	req := worker.buildCreateVMRequest(
		db.WorkflowRun{ID: 101, TriggerRef: "main"},
		db.WorkflowDefinition{ID: 102, Path: " / "},
		db.WorkflowStep{ID: 103},
		"https://git.example.test/alice/demo.git",
		map[string]string{"TOKEN": "secret"},
	)
	require.Len(t, req.GitRepos, 1)
	assert.Equal(t, "main", req.GitRepos[0].Rev)
	require.NotNil(t, req.Init)
	require.Len(t, req.Init.Services, 1)
	assert.Equal(t, "secret", req.Init.Services[0].Env["TOKEN"])
	runScript := req.Files[defaultWorkflowSandboxRunnerSH]
	assert.True(t, runScript.Executable)
	assert.Contains(t, runScript.Content, "flows/workflow/flow.ts")
	require.NotNil(t, req.WaitForReady)
	assert.False(t, *req.WaitForReady)
}
