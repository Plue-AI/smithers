package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/repository"
)

// checkoutHarness is the browser request path through a real repository
// engine, product Git transport, product-only PostgreSQL schema, and common
// process runtime, with the durable command worker started on demand.
type checkoutHarness struct {
	pool      *pgxpool.Pool
	repo      processWorkspaceRepo
	engineURL string
	runtime   *processruntime.Runtime
	service   *services.WorkspaceService
	server    *httptest.Server
	client    *http.Client
	basePath  string
}

// autoInit false leaves the repository with no refs at all, as `repo create` does.
func newCheckoutHarness(t *testing.T, public, autoInit bool) *checkoutHarness {
	t.Helper()
	ffi := strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	for _, command := range []string{"git", "jj"} {
		_, err := exec.LookPath(command)
		require.NoError(t, err)
	}

	pool := setupProcessWorkspacePool(t)
	queries := db.New(pool)
	user := processWorkspaceCreateUser(t, pool, "checkout_owner")
	repo := processWorkspaceCreateRepo(t, pool, user, "checkout_repo", public)
	local, err := repository.OpenLocal(repository.Config{
		StoragePath: t.TempDir(), AuthToken: "checkout-engine-token", FFILibraryPath: ffi,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	require.NoError(t, local.Client().InitRepo(context.Background(), repo.Owner, repo.Name, "main", autoInit))
	engine := httptest.NewServer(local.Handler())
	t.Cleanup(engine.Close)

	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 4})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	workspaceHandler := &WorkspaceHandler{}
	gitHandler := &GitSmartHandler{
		Service: services.NewGitHTTPProxyService(queries, services.NewSSHAuthorizationService(queries), local.Client()),
		Metrics: NewSmithersMetrics(),
	}
	router := chi.NewRouter()
	router.Use(chiMiddleware.RequestID)
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Get("/{owner}/{repo}/info/refs", gitHandler.InfoRefs)
	router.Post("/{owner}/{repo}/git-upload-pack", gitHandler.UploadPack)
	router.Post("/{owner}/{repo}/git-receive-pack", gitHandler.ReceivePack)
	router.Route("/api/repos/{owner}/{repo}", func(router chi.Router) {
		router.Use(middleware.LoadRepoContext(queries))
		read := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeReadRepository),
			middleware.RequireRepoPermission(middleware.PermissionRead),
		}
		write := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeWriteRepository),
			middleware.RequireRepoPermission(middleware.PermissionWrite),
		}
		router.With(write...).Post("/workspaces", func(w http.ResponseWriter, r *http.Request) { workspaceHandler.CreateWorkspace(w, r) })
		router.With(read...).Get("/workspaces/{id}", func(w http.ResponseWriter, r *http.Request) { workspaceHandler.GetWorkspace(w, r) })
		router.With(read...).Get("/workspaces/{id}/files/content", func(w http.ResponseWriter, r *http.Request) { workspaceHandler.ReadWorkspaceFile(w, r) })
		RegisterWorkspaceRuntimeRoutes(router, workspaceHandler, read, write)
	})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	commandJobs, err := jobs.NewStore(pool)
	require.NoError(t, err)
	commandCodec, err := webhook.NewSecretCodec("checkout-command-secret")
	require.NoError(t, err)
	workspaceService := services.NewWorkspaceService(queries,
		services.WithWorkspaceRuntime(runtime), services.WithWorkspaceGitBaseURL(server.URL), services.WithWorkspaceCommandJobs(commandJobs, commandCodec))
	workspaceHandler.Service = workspaceService
	cookie := processWorkspaceCreateSessionCookie(t, queries, user)
	return &checkoutHarness{
		pool: pool, repo: repo, engineURL: engine.URL, runtime: runtime, service: workspaceService,
		server: server, client: processWorkspaceAuthenticatedClient(t, server, cookie),
		basePath: fmt.Sprintf("/api/repos/%s/%s", repo.Owner, repo.Name),
	}
}

// seed pushes one commit to main through the engine's native Git transport.
func (h *checkoutHarness) seed(t *testing.T) string {
	t.Helper()
	seed := filepath.Join(t.TempDir(), "seed")
	checkoutGit(t, "", "checkout-engine-token", "clone", h.engineURL+"/git/"+h.repo.Owner+"/"+h.repo.Name+".git", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "README.md"), []byte("checked out through Smithers\n"), 0o644))
	checkoutGit(t, seed, "", "add", "README.md")
	checkoutGit(t, seed, "", "-c", "user.name=Checkout Test", "-c", "user.email=checkout@example.test", "commit", "-m", "Seed public source")
	seedCommit := strings.TrimSpace(checkoutGit(t, seed, "", "rev-parse", "HEAD"))
	checkoutGit(t, seed, "checkout-engine-token", "push", "origin", "HEAD:main")
	return seedCommit
}

func (h *checkoutHarness) startWorker(t *testing.T) {
	t.Helper()
	workerCtx, stopWorker := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- h.service.RunWorkspaceCommandWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "checkout-command", Capacity: 1, Lease: 6 * time.Second,
			PollInterval: 50 * time.Millisecond, RetryDelay: 100 * time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		stopWorker()
		select {
		case err := <-workerDone:
			require.NoError(t, err)
		case <-time.After(10 * time.Second):
			t.Error("workspace command worker did not stop")
		}
	})
}

func (h *checkoutHarness) createWorkspace(t *testing.T, body string) string {
	t.Helper()
	response := processWorkspaceDoRequest(t, h.client, h.server.URL, http.MethodPost, h.basePath+"/workspaces", []byte(body))
	require.Equal(t, http.StatusAccepted, response.StatusCode, string(routesIntegrationReadBodyOnFailure(t, response)))
	var created services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, response, &created)
	require.NotEmpty(t, created.ID)
	return created.ID
}

// waitSettled polls the public receipt until provisioning reaches running or failed.
func (h *checkoutHarness) waitSettled(t *testing.T, workspaceID string) services.WorkspaceResponse {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		response := processWorkspaceDoRequest(t, h.client, h.server.URL, http.MethodGet, h.basePath+"/workspaces/"+workspaceID, nil)
		require.Equal(t, http.StatusOK, response.StatusCode)
		var receipt services.WorkspaceResponse
		processWorkspaceDecodeJSON(t, response, &receipt)
		if receipt.Status == "running" || receipt.Status == "failed" {
			return receipt
		}
		if time.Now().After(deadline) {
			t.Fatalf("workspace did not settle: status=%q id=%q", receipt.Status, workspaceID)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (h *checkoutHarness) waitRunning(t *testing.T, workspaceID string) {
	t.Helper()
	receipt := h.waitSettled(t, workspaceID)
	require.Equal(t, "running", receipt.Status, "code=%q message=%q", receipt.FailureCode, receipt.FailureMessage)
}

func (h *checkoutHarness) postCommand(t *testing.T, workspaceID, body string) *http.Response {
	t.Helper()
	return processWorkspaceDoRequest(t, h.client, h.server.URL, http.MethodPost, h.basePath+"/workspaces/"+workspaceID+"/command-runs", []byte(body))
}

func (h *checkoutHarness) runCommand(t *testing.T, workspaceID, body string) services.WorkspaceCommandRun {
	t.Helper()
	response := h.postCommand(t, workspaceID, body)
	require.Equal(t, http.StatusAccepted, response.StatusCode, string(routesIntegrationReadBodyOnFailure(t, response)))
	var receipt jobs.RequestReceipt
	processWorkspaceDecodeJSON(t, response, &receipt)
	return processWorkspaceWaitCommandRun(t, h.client, h.server.URL, h.basePath+"/workspaces/"+workspaceID+"/command-runs/"+receipt.OperationID, 30*time.Second)
}

func (h *checkoutHarness) commandJobCount(t *testing.T, workspaceID string) int {
	t.Helper()
	var count int
	require.NoError(t, h.pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE request_id LIKE $1`, workspaceID+":%").Scan(&count))
	return count
}

// A running receipt must mean the checkout and its source are actually ready.
func TestWorkspaceHTTPMaterializesPublicRepository(t *testing.T) {
	h := newCheckoutHarness(t, true, true)
	seedCommit := h.seed(t)
	h.startWorker(t)
	publicRemote := h.server.URL + "/" + h.repo.Owner + "/" + h.repo.Name + ".git"
	require.Contains(t, checkoutGit(t, "", "", "ls-remote", publicRemote, "refs/heads/main"), seedCommit)

	workspaceID := h.createWorkspace(t, `{"name":"from-seeded-repository"}`)
	h.waitRunning(t, workspaceID)

	fileResponse := processWorkspaceDoRequest(t, h.client, h.server.URL, http.MethodGet, h.basePath+"/workspaces/"+workspaceID+"/files/content?path=README.md", nil)
	require.Equal(t, http.StatusOK, fileResponse.StatusCode, string(routesIntegrationReadBodyOnFailure(t, fileResponse)))
	var file services.WorkspaceFileContent
	processWorkspaceDecodeJSON(t, fileResponse, &file)
	require.Equal(t, "checked out through Smithers\n", file.Content)

	command := h.runCommand(t, workspaceID, `{"operation_id":"verify-checkout","args":["/bin/sh","-c","test -d .git && test -d .jj && git rev-parse HEAD"]}`)
	require.Equal(t, jobs.StateCompleted, command.State, command.Error)
	require.NotNil(t, command.Result)
	require.Equal(t, 0, command.Result.ExitCode, command.Result.Stderr)
	require.Equal(t, seedCommit, strings.TrimSpace(command.Result.Stdout))
	resolved, err := h.runtime.ResolveWorkspaceSourceRevision(context.Background(), workspaceID)
	require.NoError(t, err)
	require.Len(t, resolved, 40)
}

// #3008: a private repository created and never pushed has no bookmark to
// clone. Its workspace still runs, with an unborn main and colocated Jujutsu,
// and later commands reuse the receipt without a source commit to verify.
func TestWorkspaceHTTPProvisionsEmptyRepository(t *testing.T) {
	h := newCheckoutHarness(t, false, false)
	h.startWorker(t)

	workspaceID := h.createWorkspace(t, `{"name":"from-empty-repository"}`)
	h.waitRunning(t, workspaceID)

	first := h.runCommand(t, workspaceID, `{"operation_id":"inspect-empty","args":["/bin/sh","-c","test -d .jj && git symbolic-ref HEAD && git remote get-url origin && if git rev-parse -q --verify HEAD; then exit 9; fi && git for-each-ref refs/remotes | wc -l | tr -d ' '"]}`)
	require.Equal(t, jobs.StateCompleted, first.State, first.Error)
	require.NotNil(t, first.Result)
	require.Equal(t, 0, first.Result.ExitCode, first.Result.Stderr)
	lines := strings.Split(strings.TrimSpace(first.Result.Stdout), "\n")
	require.Len(t, lines, 3, first.Result.Stdout)
	require.Equal(t, "refs/heads/main", lines[0])
	require.Equal(t, h.server.URL+"/"+h.repo.Owner+"/"+h.repo.Name+".git", lines[1])
	require.Equal(t, "0", lines[2])

	second := h.runCommand(t, workspaceID, `{"operation_id":"first-change","args":["/bin/sh","-c","printf 'hello\\n' > hello.txt && jj --config user.name=T --config user.email=t@example.test commit -m first >/dev/null 2>&1 && jj log --no-graph -r @- -T description"]}`)
	require.Equal(t, jobs.StateCompleted, second.State, second.Error)
	require.NotNil(t, second.Result)
	require.Equal(t, 0, second.Result.ExitCode, second.Result.Stderr)
	require.Equal(t, "first", strings.TrimSpace(second.Result.Stdout))

	reused := h.runCommand(t, workspaceID, `{"operation_id":"inspect-receipt","args":["/bin/sh","-c","test \"$(cat hello.txt)\" = hello && cat .git/smithers-workspace-initialization.json"]}`)
	require.Equal(t, jobs.StateCompleted, reused.State, reused.Error)
	require.NotNil(t, reused.Result)
	require.Equal(t, 0, reused.Result.ExitCode, reused.Result.Stderr)
	require.Contains(t, reused.Result.Stdout, `"source_revision":"0000000000000000000000000000000000000000"`)
}

// A pending, starting or failed workspace refuses a new command before any
// durable work exists, while an operation admitted earlier still replays.
func TestWorkspaceHTTPRefusesCommandsUntilWorkspaceReady(t *testing.T) {
	h := newCheckoutHarness(t, true, true)
	h.seed(t)
	h.startWorker(t)

	workspaceID := h.createWorkspace(t, `{"name":"readiness"}`)
	h.waitRunning(t, workspaceID)
	admittedBody := `{"operation_id":"admitted-while-running","args":["/usr/bin/true"]}`
	admitted := h.runCommand(t, workspaceID, admittedBody)
	require.Equal(t, jobs.StateCompleted, admitted.State, admitted.Error)

	for status, code := range map[string]string{"pending": `"conflict"`, "starting": `"conflict"`, "failed": `"workspace_failed"`} {
		_, err := h.pool.Exec(context.Background(), `UPDATE workspaces SET status=$2 WHERE id=$1`, workspaceID, status)
		require.NoError(t, err)
		response := h.postCommand(t, workspaceID, fmt.Sprintf(`{"operation_id":"reject-%s","args":["/usr/bin/true"]}`, status))
		body := string(routesIntegrationReadBodyOnFailure(t, response))
		require.Equal(t, http.StatusConflict, response.StatusCode, body)
		require.Contains(t, body, code)
		require.Equal(t, 1, h.commandJobCount(t, workspaceID), status)

		replay := h.postCommand(t, workspaceID, admittedBody)
		require.Equal(t, http.StatusAccepted, replay.StatusCode, string(routesIntegrationReadBodyOnFailure(t, replay)))
		var replayed jobs.RequestReceipt
		processWorkspaceDecodeJSON(t, replay, &replayed)
		require.Equal(t, admitted.OperationID, replayed.OperationID)
	}
}

// #3008: a workspace whose provisioning failed refuses new commands with a
// typed conflict before any durable work exists, while an operation admitted
// earlier still replays.
func TestWorkspaceHTTPRefusesCommandsForFailedWorkspace(t *testing.T) {
	h := newCheckoutHarness(t, true, true)
	h.seed(t)
	h.startWorker(t)

	workspaceID := h.createWorkspace(t, `{"name":"missing-bookmark","source_bookmark":"absent"}`)
	receipt := h.waitSettled(t, workspaceID)
	require.Equal(t, "failed", receipt.Status)

	response := h.postCommand(t, workspaceID, `{"operation_id":"after-failure","args":["/bin/true"]}`)
	body := string(routesIntegrationReadBodyOnFailure(t, response))
	require.Equal(t, http.StatusConflict, response.StatusCode, body)
	require.Contains(t, body, `"workspace_failed"`)
	require.Zero(t, h.commandJobCount(t, workspaceID))
}

// #3008: a command admitted while its workspace was usable settles failed,
// never uncertain, when the workspace fails before the worker runs it; the
// same operation replays its receipt instead of being refused.
func TestWorkspaceHTTPSettlesAdmittedCommandWhenWorkspaceFails(t *testing.T) {
	h := newCheckoutHarness(t, true, true)
	h.seed(t)

	workspaceID := h.createWorkspace(t, `{"name":"fails-after-admission"}`)
	h.waitRunning(t, workspaceID)
	body := `{"operation_id":"admitted-before-failure","args":["/bin/sh","-c","touch ran"]}`
	response := h.postCommand(t, workspaceID, body)
	require.Equal(t, http.StatusAccepted, response.StatusCode, string(routesIntegrationReadBodyOnFailure(t, response)))
	var admitted jobs.RequestReceipt
	processWorkspaceDecodeJSON(t, response, &admitted)
	_, err := h.pool.Exec(context.Background(), `UPDATE workspaces SET status='failed' WHERE id=$1`, workspaceID)
	require.NoError(t, err)

	h.startWorker(t)
	run := processWorkspaceWaitCommandRun(t, h.client, h.server.URL, h.basePath+"/workspaces/"+workspaceID+"/command-runs/"+admitted.OperationID, 30*time.Second)
	require.Equal(t, jobs.StateFailed, run.State)
	require.Equal(t, "workspace failed to provision; create a new workspace", run.Error)
	var externalStarted bool
	require.NoError(t, h.pool.QueryRow(context.Background(), `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&externalStarted))
	require.False(t, externalStarted)

	replay := h.postCommand(t, workspaceID, body)
	require.Equal(t, http.StatusAccepted, replay.StatusCode, string(routesIntegrationReadBodyOnFailure(t, replay)))
	var replayed jobs.RequestReceipt
	processWorkspaceDecodeJSON(t, replay, &replayed)
	require.Equal(t, admitted.OperationID, replayed.OperationID)
	require.Equal(t, 1, h.commandJobCount(t, workspaceID))
}

func checkoutGit(t *testing.T, directory, token string, args ...string) string {
	t.Helper()
	if token != "" {
		args = append([]string{"-c", "http.extraHeader=Authorization: Bearer " + token}, args...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = directory
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	output, err := command.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, output)
	return string(output)
}
