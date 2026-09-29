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

// This is the browser request path through a real repository engine, product
// Git transport, product-only PostgreSQL schema, and common process runtime.
// A running receipt must mean the checkout and its source are actually ready.
func TestWorkspaceHTTPMaterializesPublicRepository(t *testing.T) {
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
	repo := processWorkspaceCreateRepo(t, pool, user, "checkout_repo", true)
	local, err := repository.OpenLocal(repository.Config{
		StoragePath: t.TempDir(), AuthToken: "checkout-engine-token", FFILibraryPath: ffi,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	require.NoError(t, local.Client().InitRepo(context.Background(), repo.Owner, repo.Name, "main", true))

	// Seed through the real native Git transport. The product URL below is the
	// one workspace bootstrap must use, and is checked independently here.
	engine := httptest.NewServer(local.Handler())
	t.Cleanup(engine.Close)
	seed := filepath.Join(t.TempDir(), "seed")
	checkoutGit(t, "", "checkout-engine-token", "clone", engine.URL+"/git/"+repo.Owner+"/"+repo.Name+".git", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "README.md"), []byte("checked out through Smithers\n"), 0o644))
	checkoutGit(t, seed, "", "add", "README.md")
	checkoutGit(t, seed, "", "-c", "user.name=Checkout Test", "-c", "user.email=checkout@example.test", "commit", "-m", "Seed public source")
	seedCommit := strings.TrimSpace(checkoutGit(t, seed, "", "rev-parse", "HEAD"))
	checkoutGit(t, seed, "checkout-engine-token", "push", "origin", "HEAD:main")

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
	workerCtx, stopWorker := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- workspaceService.RunWorkspaceCommandWorker(workerCtx, jobs.WorkerConfig{
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
	publicRemote := server.URL + "/" + repo.Owner + "/" + repo.Name + ".git"
	require.Contains(t, checkoutGit(t, "", "", "ls-remote", publicRemote, "refs/heads/main"), seedCommit)

	cookie := processWorkspaceCreateSessionCookie(t, queries, user)
	client := processWorkspaceAuthenticatedClient(t, server, cookie)
	basePath := fmt.Sprintf("/api/repos/%s/%s", repo.Owner, repo.Name)
	createdResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces", []byte(`{"name":"from-seeded-repository"}`))
	require.Equal(t, http.StatusAccepted, createdResponse.StatusCode, string(routesIntegrationReadBodyOnFailure(t, createdResponse)))
	var created services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, createdResponse, &created)
	require.NotEmpty(t, created.ID)

	deadline := time.Now().Add(60 * time.Second)
	for {
		response := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID, nil)
		require.Equal(t, http.StatusOK, response.StatusCode)
		var receipt services.WorkspaceResponse
		processWorkspaceDecodeJSON(t, response, &receipt)
		if receipt.Status == "running" {
			break
		}
		if receipt.Status == "failed" || time.Now().After(deadline) {
			t.Fatalf("workspace checkout receipt: status=%q code=%q message=%q id=%q", receipt.Status, receipt.FailureCode, receipt.FailureMessage, created.ID)
		}
		time.Sleep(25 * time.Millisecond)
	}

	fileResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/files/content?path=README.md", nil)
	require.Equal(t, http.StatusOK, fileResponse.StatusCode, string(routesIntegrationReadBodyOnFailure(t, fileResponse)))
	var file services.WorkspaceFileContent
	processWorkspaceDecodeJSON(t, fileResponse, &file)
	require.Equal(t, "checked out through Smithers\n", file.Content)

	commandPath := basePath + "/workspaces/" + created.ID + "/command-runs"
	commandResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, commandPath, []byte(`{"operation_id":"verify-checkout","args":["/bin/sh","-c","test -d .git && test -d .jj && git rev-parse HEAD"]}`))
	require.Equal(t, http.StatusAccepted, commandResponse.StatusCode, string(routesIntegrationReadBodyOnFailure(t, commandResponse)))
	var commandReceipt jobs.RequestReceipt
	processWorkspaceDecodeJSON(t, commandResponse, &commandReceipt)
	command := processWorkspaceWaitCommandRun(t, client, server.URL, commandPath+"/"+commandReceipt.OperationID, 30*time.Second)
	require.Equal(t, jobs.StateCompleted, command.State, command.Error)
	require.NotNil(t, command.Result)
	require.Equal(t, 0, command.Result.ExitCode, command.Result.Stderr)
	require.Equal(t, seedCommit, strings.TrimSpace(command.Result.Stdout))
	resolved, err := runtime.ResolveWorkspaceSourceRevision(context.Background(), created.ID)
	require.NoError(t, err)
	require.Len(t, resolved, 40)
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
