package services

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// This launch-configuration unit test captures the publisher instead of
// running its Linux shell loop. Repository preparation uses the real process
// runtime and Git HTTP transport. The Linux publisher loop is outside this test.
type publicationLaunchRuntime struct {
	workspaceapi.WorkspaceRuntime
	publisher workspaceapi.ServiceSpec
}

func (r *publicationLaunchRuntime) StartService(_ context.Context, _ string, spec workspaceapi.ServiceSpec) (workspaceapi.Service, error) {
	r.publisher = spec
	return workspaceapi.Service{}, nil
}

func (r *publicationLaunchRuntime) StopService(context.Context, string, string) error { return nil }

func (r *publicationLaunchRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(command.Args) == 3 && command.Args[2] == runtimeWorkspaceHeadReporterProbe {
		return workspaceapi.CommandResult{}, nil
	}
	return r.WorkspaceRuntime.ExecuteCommand(ctx, id, command)
}

func TestRuntimeWorkspacePublisherLaunchReachesHeadEndpointWithAPIBase(t *testing.T) {
	for _, suffix := range []string{"", "/api", "/api/"} {
		t.Run("base="+suffix, func(t *testing.T) { testRuntimeWorkspacePublisherLaunchBase(t, suffix) })
	}
}

func testRuntimeWorkspacePublisherLaunchBase(t *testing.T, suffix string) {
	requireExecutable(t, "git")
	requireExecutable(t, "jj")
	const owner, repo = "alice", "publication"
	gitRoot := t.TempDir()
	seedBareRepository(t, filepath.Join(gitRoot, strings.Trim(suffix, "/"), owner, repo+".git"), "main")
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	backend := &cgi.Handler{Path: gitExecutable, Args: []string{"http-backend"}, Dir: gitRoot,
		Env: []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"}}
	const headPath = "/api/repos/alice/publication/workspaces/runtime-publication/head"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/head") {
			if request.URL.Path != headPath || !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
				http.NotFound(response, request)
				return
			}
			response.WriteHeader(http.StatusNoContent)
			return
		}
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)

	row := sampleDBWorkspace("runtime-publication")
	row.Status, row.VmID = "starting", ""
	current := row
	mock := &mockWorkspaceQuerier{}
	queries := &runtimeHeadQuerier{runtimeRepositoryQuerier: &runtimeRepositoryQuerier{
		mockWorkspaceQuerier: mock, owner: owner, repo: repo}, revoke: func(int64) {}}
	mock.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		current.HeadPushTokenID = pgtype.Int8{Int64: queries.recordedHeadTokenID(), Valid: queries.recordedHeadTokenID() != 0}
		return current, nil
	}
	mock.updateWorkspaceStatusFn = func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		current.Status = arg.Status
		return current, nil
	}
	issued := int64(0)
	mock.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		issued++
		return db.AccessToken{ID: issued}, nil
	}
	process, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, process.Close()) })
	runtime := &publicationLaunchRuntime{WorkspaceRuntime: process}
	service := newWorkspaceServiceForTests(queries, WithWorkspaceRuntime(runtime), WithWorkspaceGitBaseURL(server.URL+suffix))
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	_, err = service.ensureRuntimeWorkspaceRunningLocked(ctx, row, row.UserID)
	require.NoError(t, err)
	require.Equal(t, workspaceHeadReporterService, runtime.publisher.Name)
	environment := runtime.publisher.Command.Environment
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		environment["SMITHERS_API_BASE_URL"]+"/api/repos/"+environment["SMITHERS_WORKSPACE_REPO"]+"/workspaces/"+environment["SMITHERS_WORKSPACE_ID"]+"/head", strings.NewReader(`{"change_id":"change","commit_id":"commit","ahead":0,"behind":0}`))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+environment["SMITHERS_WORKSPACE_TOKEN"])
	response, err := server.Client().Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusNoContent, response.StatusCode, "the launched publisher must address the actual head endpoint")
}
