package services

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type workspaceHeadTestQuerier struct {
	*mockWorkspaceQuerier
	headTokenID int64
}

func (q *workspaceHeadTestQuerier) SetWorkspaceHeadPushTokenID(_ context.Context, arg db.SetWorkspaceHeadPushTokenIDParams) error {
	if arg.HeadPushTokenID.Valid {
		q.headTokenID = arg.HeadPushTokenID.Int64
	} else {
		q.headTokenID = 0
	}
	return nil
}

func (q *workspaceHeadTestQuerier) GetRepoOwnerSlugAndNameByID(_ context.Context, repositoryID int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "acme", RepoName: "widgets"}, nil
}

func TestWorkspaceHeadTokenScopes_BindRepoAndWorkspace(t *testing.T) {
	t.Parallel()
	scopes := workspaceHeadTokenScopes(314, "0f8fad5b-d9cb-469f-a165-70867728950e")
	parsed := middleware.ParseTokenScopes(scopes)
	assert.True(t, parsed.Has(middleware.ScopeWriteRepository))
	assert.Equal(t, int64(314), middleware.ParseTokenRepositoryRestriction(scopes))
	assert.Equal(t, "0f8fad5b-d9cb-469f-a165-70867728950e", middleware.ParseTokenWorkspaceRestriction(scopes))
}

func TestBuildWorkspaceHeadReporterInstallCommand_ReplacesInheritedUnit(t *testing.T) {
	t.Parallel()
	cmd := buildWorkspaceHeadReporterInstallCommand()
	assert.Contains(t, cmd, "systemctl stop smithers-workspace-head.service")
	assert.Contains(t, cmd, "cat > '/usr/local/bin/smithers-workspace-head' <<'SMITHERS_HEAD_EOF'")
	assert.Contains(t, cmd, "refs/smithers/branches/${ws}/head")
	assert.Contains(t, cmd, "git -C \"$repo\" push --quiet --force --no-verify origin")
	assert.Contains(t, cmd, "/workspaces/${ws}/head")
	assert.Contains(t, cmd, "chmod 755 '/usr/local/bin/smithers-workspace-head'")
	assert.Contains(t, cmd, "cat > '/etc/smithers/workspace-git.env'")
	assert.Contains(t, cmd, "credential.helper")
	assert.Contains(t, cmd, "credential.useHttpPath")
	assert.Contains(t, cmd, workspaceGitCredentialSocket)
	// The script is a heredoc with a quoted delimiter: nothing in it expands
	// on the installing shell, so the token placeholders survive verbatim.
	assert.Contains(t, cmd, "${SMITHERS_WORKSPACE_TOKEN:?}")
}

func TestWorkspaceHeadReporterScriptHasValidShellSyntax(t *testing.T) {
	t.Parallel()
	cmd := exec.Command("bash", "-n")
	cmd.Stdin = strings.NewReader(workspaceHeadReporterScript)
	output, err := cmd.CombinedOutput()
	require.NoErrorf(t, err, "bash syntax check failed: %s", output)
}

func TestInstallWorkspaceHeadReporter_SeedsScopedCredentialCacheWithoutPersistingToken(t *testing.T) {
	t.Parallel()
	q := &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	var install sandbox.ExecRequest
	var service sandbox.ServiceSpec
	vm := &mockWorkspaceSandboxVMClient{
		execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-498", vmID)
			install = req
			status := int32(0)
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
		createSystemdServiceFn: func(_ context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			assert.Equal(t, "vm-498", vmID)
			service = req
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceGitBaseURL("https://api.jjhub.tech"),
		WithWorkspaceSandboxClient(vm),
	)

	workspace := db.Workspace{ID: "workspace-498", RepositoryID: 77, UserID: 9, TargetBookmark: "main"}
	updated, err := svc.installWorkspaceHeadReporter(context.Background(), workspace, "vm-498")
	require.NoError(t, err)
	require.True(t, updated.HeadPushTokenID.Valid)
	assert.Equal(t, updated.HeadPushTokenID.Int64, q.headTokenID)

	token := service.Env["SMITHERS_WORKSPACE_TOKEN"]
	require.NotEmpty(t, token)
	assert.Equal(t, "https://api.jjhub.tech/acme/widgets.git", service.Env["SMITHERS_WORKSPACE_GIT_URL"])
	assert.Equal(t, workspaceGitCredentialSocket, service.Env["SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET"])
	assert.Contains(t, workspaceHeadReporterScript, "git credential-cache")
	assert.Contains(t, workspaceHeadReporterScript, "username=smithers")
	assert.NotContains(t, install.Command, token, "the credential profile and reporter files must not persist the token")
	assert.NotContains(t, workspaceGitCredentialEnvironment(), token)
	assert.NotContains(t, workspaceGitCredentialEnvironment(), "Authorization:")
}

func TestSandboxKindForWorkspace_AgentIsContainerGuest(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "container", sandboxKindForWorkspace("agent"))
	assert.Equal(t, "container", sandboxKindForWorkspace(""))
	assert.Equal(t, "vm", sandboxKindForWorkspace("vm"))
	assert.Equal(t, "desktop", sandboxKindForWorkspace("desktop"))
	assert.Equal(t, "agent", normalizeWorkspaceKind("agent"))
}

func TestReportWorkspaceHead_Authorization(t *testing.T) {
	t.Parallel()
	const workspaceID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	newSvc := func(t *testing.T) (*WorkspaceService, *[]string) {
		t.Helper()
		var notified []string
		row := db.Workspace{ID: workspaceID, RepositoryID: 200, UserID: 7, Status: "running", TargetBookmark: "main"}
		q := &mockWorkspaceQuerier{
			getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
				if id != workspaceID {
					return db.Workspace{}, pgx.ErrNoRows
				}
				return row, nil
			},
			updateWorkspaceHeadFn: func(_ context.Context, arg db.UpdateWorkspaceHeadParams) (db.Workspace, error) {
				row.HeadChangeID = arg.HeadChangeID
				row.HeadCommitID = arg.HeadCommitID
				row.Ahead = arg.Ahead
				row.Behind = arg.Behind
				return row, nil
			},
			notifyWorkspaceStatusFn: func(_ context.Context, arg db.NotifyWorkspaceStatusParams) error {
				notified = append(notified, arg.Payload)
				return nil
			},
		}
		return newWorkspaceServiceForTests(q), &notified
	}
	base := ReportWorkspaceHeadInput{WorkspaceID: workspaceID, RepositoryID: 200, ChangeID: "kxyz", CommitID: "abc123", Ahead: 2, Behind: 1}

	t.Run("workspace token for its own workspace", func(t *testing.T) {
		svc, notified := newSvc(t)
		input := base
		input.TokenWorkspaceID = strings.ToUpper(workspaceID)
		resp, err := svc.ReportWorkspaceHead(context.Background(), input)
		require.NoError(t, err)
		assert.Equal(t, "kxyz", resp.Head.ChangeID)
		assert.Equal(t, "abc123", resp.Head.CommitID)
		assert.Equal(t, int32(2), resp.Ahead)
		require.Len(t, *notified, 1)
		var payload map[string]any
		require.NoError(t, json.Unmarshal([]byte((*notified)[0]), &payload))
		assert.Equal(t, "running", payload["status"])
		assert.Equal(t, "abc123", payload["head"].(map[string]any)["commit_id"])
		assert.EqualValues(t, 1, payload["behind"])
	})
	t.Run("workspace token for another workspace is refused", func(t *testing.T) {
		svc, notified := newSvc(t)
		input := base
		input.TokenWorkspaceID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
		_, err := svc.ReportWorkspaceHead(context.Background(), input)
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Empty(t, *notified)
	})
	t.Run("owner user token", func(t *testing.T) {
		svc, _ := newSvc(t)
		input := base
		input.UserID = 7
		_, err := svc.ReportWorkspaceHead(context.Background(), input)
		require.NoError(t, err)
	})
	t.Run("other user is refused", func(t *testing.T) {
		svc, _ := newSvc(t)
		input := base
		input.UserID = 8
		_, err := svc.ReportWorkspaceHead(context.Background(), input)
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
	})
	t.Run("other repository is not found", func(t *testing.T) {
		svc, _ := newSvc(t)
		input := base
		input.UserID = 7
		input.RepositoryID = 201
		_, err := svc.ReportWorkspaceHead(context.Background(), input)
		require.Error(t, err)
		assert.Equal(t, 404, apiStatus(t, err))
	})
	t.Run("head values are required", func(t *testing.T) {
		svc, _ := newSvc(t)
		input := base
		input.UserID = 7
		input.CommitID = ""
		_, err := svc.ReportWorkspaceHead(context.Background(), input)
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
	})
}

func TestWorkspaceHeadReporterRefreshesEvictedCredentialWithoutHeadChange(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	// Run the real reporter loop with a cache transport that evicts its first
	// value. No repository exists, so the unchanged/missing-head path must heal.
	fakeGit := `#!/usr/bin/env bash
if [ "${!#}" = store ]; then
  cat > "$TEST_CACHE"
  count=$(cat "$TEST_COUNT" 2>/dev/null || echo 0)
  echo $((count + 1)) > "$TEST_COUNT"
fi
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "git"), []byte(fakeGit), 0755))
	fakeSleep := `#!/usr/bin/env bash
if [ ! -f "$TEST_EVICTED" ]; then
  rm -f "$TEST_CACHE"
  touch "$TEST_EVICTED"
else
  kill -TERM "$PPID"
fi
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "sleep"), []byte(fakeSleep), 0755))
	cmd := exec.Command("bash", "-c", workspaceHeadReporterScript)
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"),
		"SMITHERS_WORKSPACE_PATH="+filepath.Join(dir, "absent"),
		"SMITHERS_WORKSPACE_ID=test", "SMITHERS_API_BASE_URL=https://example.invalid/api",
		"SMITHERS_WORKSPACE_REPO=test/repo", "SMITHERS_WORKSPACE_GIT_URL=https://example.invalid/test/repo.git",
		"SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET="+filepath.Join(dir, "cache/socket"),
		"SMITHERS_WORKSPACE_TOKEN=test-token", "TEST_CACHE="+filepath.Join(dir, "credential"),
		"TEST_COUNT="+filepath.Join(dir, "count"), "TEST_EVICTED="+filepath.Join(dir, "evicted"))
	output, err := cmd.CombinedOutput()
	require.NoErrorf(t, err, "reporter: %s", output)
	cached, err := os.ReadFile(filepath.Join(dir, "credential"))
	require.NoError(t, err, "the reporter must restore an evicted cache without a new head")
	assert.Contains(t, string(cached), "password=test-token")
}

func TestEnsureWorkspaceHeadReporter_RecoversOnlyMissingPublisher(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int32
		wantStarts int
		wantError  bool
	}{
		{"healthy", 0, 0, false}, {"cold restart", 1, 1, false}, {"probe failure", 2, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workspace := db.Workspace{ID: "workspace-498", RepositoryID: 77, UserID: 9, VmID: "vm-498", Status: "running", TargetBookmark: "main"}
			q := &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
			}}
			calls, starts := 0, 0
			vm := &mockWorkspaceSandboxVMClient{
				execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
					calls++
					status := int32(0)
					if calls == 1 {
						status = tc.status
						assert.Contains(t, req.Command, "test -S")
					}
					return sandbox.ExecResult{StatusCode: &status}, nil
				},
				createSystemdServiceFn: func(_ context.Context, _ string, spec sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
					starts++
					assert.Equal(t, workspaceHeadReporterService, spec.Name)
					require.NotEmpty(t, spec.Env["SMITHERS_WORKSPACE_TOKEN"])
					return sandbox.CreateServiceResult{Success: true}, nil
				},
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceGitBaseURL("https://api.jjhub.tech"), WithWorkspaceSandboxClient(vm))
			updated, err := svc.ensureWorkspaceHeadReporter(context.Background(), workspace)
			if tc.wantError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, tc.wantStarts, starts)
			assert.Equal(t, tc.wantStarts > 0, updated.HeadPushTokenID.Valid)
			if tc.wantStarts == 0 {
				assert.Equal(t, 1, calls, "a running publisher is only probed")
			}
		})
	}
}
