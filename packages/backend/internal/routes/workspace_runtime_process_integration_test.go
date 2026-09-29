package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cgi"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const workspacePreviewHelperEnv = "SMITHERS_WORKSPACE_PREVIEW_HELPER"

type processWorkspaceUser struct {
	ID       int64
	Username string
}

type processWorkspaceRepo struct {
	ID    int64
	Owner string
	Name  string
}

func TestWorkspaceRuntimeProcessRequestPath(t *testing.T) {
	if address := os.Getenv(workspacePreviewHelperEnv); address != "" {
		server := &http.Server{Addr: address, Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
				http.Error(response, "product credentials reached preview", http.StatusInternalServerError)
				return
			}
			_, _ = response.Write([]byte("preview-ok\n"))
		})}
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			os.Exit(2)
		}
		return
	}

	pool := setupProcessWorkspacePool(t)
	queries := db.New(pool)
	user := processWorkspaceCreateUser(t, pool, "process_workspace_user")
	repo := processWorkspaceCreateRepo(t, pool, user, "process_workspace_repo", false)
	gitServer := processWorkspaceGitServer(t, repo)

	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 4})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	commandJobs, err := jobs.NewStore(pool)
	require.NoError(t, err)
	commandCodec, err := webhook.NewSecretCodec("routes-process-command-secret")
	require.NoError(t, err)
	service := services.NewWorkspaceService(queries,
		services.WithWorkspaceRuntime(runtime),
		services.WithWorkspaceGitBaseURL(gitServer.URL+"/api"),
		services.WithWorkspaceCommandJobs(commandJobs, commandCodec),
	)
	t.Cleanup(func() {
		drainDeadline := time.Now().Add(15 * time.Second)
		if testDeadline, ok := t.Deadline(); ok && testDeadline.Add(-10*time.Second).Before(drainDeadline) {
			drainDeadline = testDeadline.Add(-10 * time.Second)
		}
		drainCtx, cancelDrain := context.WithDeadline(context.Background(), drainDeadline)
		defer cancelDrain()
		if err := service.WaitForProvisioning(drainCtx); err != nil {
			t.Errorf("workspace provisioning did not finish before runtime cleanup: %v", err)
		}
	})
	workerCtx, stopWorker := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- service.RunWorkspaceCommandWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "routes-process-commands", Capacity: 2, Lease: 6 * time.Second,
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
	workspaceHandler := &WorkspaceHandler{Service: service}
	terminalHandler := &WorkspaceTerminalHandler{Service: service, AllowedOrigins: []string{"https://smithers.test"}}
	t.Cleanup(func() {
		if terminalHandler.TerminalSessions != nil {
			terminalHandler.TerminalSessions.Close()
		}
	})

	router := chi.NewRouter()
	router.Use(chiMiddleware.RequestID)
	router.Use(middleware.JSONTimeout(30 * time.Second))
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
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
		router.With(write...).Post("/workspaces", workspaceHandler.CreateWorkspace)
		router.With(write...).Post("/workspaces/{id}/suspend", workspaceHandler.SuspendWorkspace)
		router.With(write...).Post("/workspaces/{id}/resume", workspaceHandler.ResumeWorkspace)
		router.With(write...).Put("/workspaces/{id}/files/content", workspaceHandler.WriteWorkspaceFile)
		router.With(read...).Get("/workspaces/{id}/files/content", workspaceHandler.ReadWorkspaceFile)
		RegisterWorkspaceRuntimeRoutes(router, workspaceHandler, read, write)
		router.With(write...).Post("/workspace/sessions", workspaceHandler.CreateSession)
		router.With(read...).Get("/workspace/sessions/{id}/terminal", terminalHandler.TerminalWebSocket)
	})

	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	basePath := fmt.Sprintf("/api/repos/%s/%s", repo.Owner, repo.Name)

	// The same middleware stack rejects the execution path before the runtime
	// can observe an unauthenticated request.
	unauthorized := processWorkspaceDoRequest(t, server.Client(), server.URL, http.MethodPost, basePath+"/workspaces/missing/command-runs", []byte(`{"operation_id":"unauthorized","args":["/bin/true"]}`))
	require.Equal(t, http.StatusNotFound, unauthorized.StatusCode)
	_ = processWorkspaceReadBody(t, unauthorized)

	cookie := processWorkspaceCreateSessionCookie(t, queries, user)
	client := processWorkspaceAuthenticatedClient(t, server, cookie)
	createdResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces", []byte(`{"name":"local-process"}`))
	require.Equal(t, http.StatusAccepted, createdResponse.StatusCode)
	var created services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, createdResponse, &created)
	require.NotEmpty(t, created.ID)
	require.Empty(t, created.VMID, "trusted process execution must not be presented as a VM")
	require.Equal(t, "trusted_process", string(created.Isolation))
	provisionDeadline := time.Now().Add(2 * time.Minute)
	if testDeadline, ok := t.Deadline(); ok && testDeadline.Add(-30*time.Second).Before(provisionDeadline) {
		provisionDeadline = testDeadline.Add(-30 * time.Second)
	}
	provisionCtx, cancelProvision := context.WithDeadline(context.Background(), provisionDeadline)
	provisionErr := service.WaitForProvisioning(provisionCtx)
	cancelProvision()
	require.NoError(t, provisionErr)
	rowCtx, cancelRow := context.WithTimeout(context.Background(), 5*time.Second)
	provisioned, err := queries.GetWorkspace(rowCtx, created.ID)
	cancelRow()
	require.NoError(t, err)
	require.Equal(t, "running", provisioned.Status, "provisioning stage=%q failure code=%v", provisioned.ProvisioningStage, provisioned.FailureCode)
	seedResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/files/content?path=README.md", nil)
	require.Equal(t, http.StatusOK, seedResponse.StatusCode)
	var seedFile services.WorkspaceFileContent
	processWorkspaceDecodeJSON(t, seedResponse, &seedFile)
	require.Equal(t, "process workspace repository fixture\n", seedFile.Content)
	sourceRevision, err := runtime.ResolveWorkspaceSourceRevision(context.Background(), created.ID)
	require.NoError(t, err)
	require.Len(t, sourceRevision, 40)

	commandPath := basePath + "/workspaces/" + created.ID + "/command-runs"
	commandResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, commandPath, []byte(`{"operation_id":"command-1","args":["/bin/sh","-c","printf command-ok"]}`))
	require.Equal(t, http.StatusAccepted, commandResponse.StatusCode)
	var commandReceipt jobs.RequestReceipt
	processWorkspaceDecodeJSON(t, commandResponse, &commandReceipt)
	require.NotEmpty(t, commandReceipt.OperationID)
	command := processWorkspaceWaitCommandRun(t, client, server.URL, commandPath+"/"+commandReceipt.OperationID, 30*time.Second)
	require.Equal(t, jobs.StateCompleted, command.State, command.Error)
	require.NotNil(t, command.Result)
	require.Equal(t, 0, command.Result.ExitCode)
	require.Equal(t, "command-ok", command.Result.Stdout)

	cancelResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, commandPath, []byte(`{"operation_id":"command-cancel","args":["/bin/sh","-c","sleep 600"]}`))
	require.Equal(t, http.StatusAccepted, cancelResponse.StatusCode)
	var cancelReceipt jobs.RequestReceipt
	processWorkspaceDecodeJSON(t, cancelResponse, &cancelReceipt)
	cancelPath := commandPath + "/" + cancelReceipt.OperationID
	processWorkspaceWaitCommandState(t, client, server.URL, cancelPath, jobs.StateRunning, 30*time.Second)
	cancelRequest := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, cancelPath+"/cancel", nil)
	require.True(t, cancelRequest.StatusCode == http.StatusAccepted || cancelRequest.StatusCode == http.StatusOK, "cancel status %d", cancelRequest.StatusCode)
	_ = processWorkspaceReadBody(t, cancelRequest)
	cancelled := processWorkspaceWaitCommandRun(t, client, server.URL, cancelPath, 30*time.Second)
	require.Equal(t, jobs.StateCancelled, cancelled.State)

	writeResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPut, basePath+"/workspaces/"+created.ID+"/files/content?path=note.txt", []byte(`{"content":"persisted-local-file"}`))
	require.Equal(t, http.StatusOK, writeResponse.StatusCode)
	_ = processWorkspaceReadBody(t, writeResponse)
	readResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/files/content?path=note.txt", nil)
	require.Equal(t, http.StatusOK, readResponse.StatusCode)
	var file services.WorkspaceFileContent
	processWorkspaceDecodeJSON(t, readResponse, &file)
	require.Equal(t, "persisted-local-file", file.Content)

	suspendResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/suspend", nil)
	require.Equal(t, http.StatusOK, suspendResponse.StatusCode)
	var suspended services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, suspendResponse, &suspended)
	require.Equal(t, "suspended", suspended.Status)
	stoppedRuntime, err := runtime.InspectWorkspace(context.Background(), created.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", string(stoppedRuntime.State))

	resumeResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/resume", nil)
	require.Equal(t, http.StatusOK, resumeResponse.StatusCode)
	var resumed services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, resumeResponse, &resumed)
	require.Equal(t, "running", resumed.Status)
	readAfterResume := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/files/content?path=note.txt", nil)
	require.Equal(t, http.StatusOK, readAfterResume.StatusCode)
	processWorkspaceDecodeJSON(t, readAfterResume, &file)
	require.Equal(t, "persisted-local-file", file.Content)

	previewAddress := reserveLoopbackAddress(t)
	_, rawPort, err := net.SplitHostPort(previewAddress)
	require.NoError(t, err)
	port, err := strconv.ParseUint(rawPort, 10, 16)
	require.NoError(t, err)
	launchBody, err := json.Marshal(services.WorkspaceServiceLaunchInput{
		OperationID: "preview-service-1",
		Name:        "preview",
		Args:        []string{os.Args[0], "-test.run=^TestWorkspaceRuntimeProcessRequestPath$"},
		Environment: map[string]string{workspacePreviewHelperEnv: previewAddress},
		Port:        uint16(port),
	})
	require.NoError(t, err)
	launchResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/services", launchBody)
	require.Equal(t, http.StatusCreated, launchResponse.StatusCode, string(routesIntegrationReadBodyOnFailure(t, launchResponse)))
	if launchResponse.Body != nil {
		_ = launchResponse.Body.Close()
	}
	previewResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/preview/"+rawPort+"/", nil)
	require.Equal(t, http.StatusOK, previewResponse.StatusCode)
	require.Equal(t, "preview-ok\n", string(processWorkspaceReadBody(t, previewResponse)))

	sessionResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspace/sessions", []byte(`{"workspace_id":"`+created.ID+`","cols":90,"rows":30}`))
	require.Equal(t, http.StatusCreated, sessionResponse.StatusCode)
	var session services.WorkspaceSessionResponse
	processWorkspaceDecodeJSON(t, sessionResponse, &session)
	require.Equal(t, "running", session.Status)

	terminalURL := "ws" + strings.TrimPrefix(server.URL, "http") + basePath + "/workspace/sessions/" + session.ID + "/terminal"
	header := http.Header{}
	header.Set("Origin", "https://smithers.test")
	header.Set("Cookie", cookie.String())
	terminal, response, err := websocket.Dial(context.Background(), terminalURL, &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{"terminal"}})
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	defer terminal.CloseNow()
	require.NoError(t, terminal.Write(context.Background(), websocket.MessageBinary, []byte("printf 'terminal-ok\\n'\n")))
	readCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var terminalOutput strings.Builder
	for !strings.Contains(terminalOutput.String(), "terminal-ok") {
		_, frame, readErr := terminal.Read(readCtx)
		require.NoError(t, readErr)
		terminalOutput.Write(frame)
	}
	if os.Getenv("SMITHERS_WORKSPACE_COMMAND_TEN_MINUTES") == "1" {
		admittedAt := time.Now()
		longResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, commandPath, []byte(`{"operation_id":"command-ten-minutes","args":["/bin/sh","-c","sleep 600; printf long-command-ok; exit 7"]}`))
		require.Equal(t, http.StatusAccepted, longResponse.StatusCode)
		require.Less(t, time.Since(admittedAt), 2*time.Second, "admission must return immediately")
		var longReceipt jobs.RequestReceipt
		processWorkspaceDecodeJSON(t, longResponse, &longReceipt)
		longPath := commandPath + "/" + longReceipt.OperationID
		long := processWorkspaceWaitCommandRun(t, client, server.URL, longPath, 12*time.Minute)
		require.Equal(t, jobs.StateCompleted, long.State)
		require.NotNil(t, long.Result)
		require.Equal(t, 7, long.Result.ExitCode)
		require.Equal(t, "long-command-ok", long.Result.Stdout)
		require.False(t, long.Result.OutputTruncated)
	}
}

func processWorkspaceWaitCommandState(t *testing.T, client *http.Client, baseURL, path string, want jobs.State, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		response := processWorkspaceDoRequest(t, client, baseURL, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, response.StatusCode, string(routesIntegrationReadBodyOnFailure(t, response)))
		var run services.WorkspaceCommandRun
		processWorkspaceDecodeJSON(t, response, &run)
		if run.State == want {
			return
		}
		if run.State.Terminal() {
			t.Fatalf("command reached %s before %s: %+v", run.State, want, run)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("command did not reach %s within %s", want, timeout)
}

func processWorkspaceWaitCommandRun(t *testing.T, client *http.Client, baseURL, path string, timeout time.Duration) services.WorkspaceCommandRun {
	t.Helper()
	deadline := time.Now().Add(timeout)
	interval := 50 * time.Millisecond
	if timeout > time.Minute {
		interval = time.Second
	}
	for time.Now().Before(deadline) {
		response := processWorkspaceDoRequest(t, client, baseURL, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, response.StatusCode, string(routesIntegrationReadBodyOnFailure(t, response)))
		var run services.WorkspaceCommandRun
		processWorkspaceDecodeJSON(t, response, &run)
		if run.State.Terminal() {
			return run
		}
		time.Sleep(interval)
	}
	t.Fatalf("command did not finish within %s", timeout)
	return services.WorkspaceCommandRun{}
}

func processWorkspaceGitServer(t *testing.T, repo processWorkspaceRepo) *httptest.Server {
	t.Helper()
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	root := t.TempDir()
	repositoryPath := filepath.Join(root, "api", repo.Owner, repo.Name+".git")
	require.NoError(t, os.MkdirAll(filepath.Dir(repositoryPath), 0o700))
	processWorkspaceRunGit(t, "", nil, "init", "--bare", "--initial-branch=main", repositoryPath)
	blob := strings.TrimSpace(processWorkspaceRunGit(t, repositoryPath, strings.NewReader("process workspace repository fixture\n"), "hash-object", "-w", "--stdin"))
	tree := strings.TrimSpace(processWorkspaceRunGit(t, repositoryPath, strings.NewReader("100644 blob "+blob+"\tREADME.md\n"), "mktree"))
	commit := strings.TrimSpace(processWorkspaceRunGit(t, repositoryPath, strings.NewReader("fixture\n"), "commit-tree", tree))
	processWorkspaceRunGit(t, repositoryPath, nil, "update-ref", "refs/heads/main", commit)
	processWorkspaceRunGit(t, repositoryPath, nil, "symbolic-ref", "HEAD", "refs/heads/main")

	backend := &cgi.Handler{
		Path: gitExecutable, Args: []string{"http-backend"}, Dir: root,
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
			http.Error(response, "missing repository bearer", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)
	return server
}

func processWorkspaceRunGit(t *testing.T, gitDirectory string, stdin io.Reader, args ...string) string {
	t.Helper()
	if gitDirectory != "" {
		args = append([]string{"--git-dir=" + gitDirectory}, args...)
	}
	command := exec.Command("git", args...)
	command.Stdin = stdin
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Smithers Test", "GIT_AUTHOR_EMAIL=test@smithers.invalid", "GIT_AUTHOR_DATE=2020-01-01T00:00:00Z",
		"GIT_COMMITTER_NAME=Smithers Test", "GIT_COMMITTER_EMAIL=test@smithers.invalid", "GIT_COMMITTER_DATE=2020-01-01T00:00:00Z",
	)
	output, err := command.CombinedOutput()
	require.NoError(t, err, "%s", output)
	return string(output)
}

func reserveLoopbackAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	return address
}

func routesIntegrationReadBodyOnFailure(t *testing.T, response *http.Response) []byte {
	t.Helper()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	return processWorkspaceReadBody(t, response)
}

func setupProcessWorkspacePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}

func processWorkspaceCreateUser(t *testing.T, pool *pgxpool.Pool, prefix string) processWorkspaceUser {
	t.Helper()
	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	username := prefix + "_" + unique
	var id int64
	err := pool.QueryRow(context.Background(), `INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$1,$2,$2,$1) RETURNING id`, username, username+"@example.com").Scan(&id)
	require.NoError(t, err)
	return processWorkspaceUser{ID: id, Username: username}
}

func processWorkspaceCreateRepo(t *testing.T, pool *pgxpool.Pool, owner processWorkspaceUser, prefix string, public bool) processWorkspaceRepo {
	t.Helper()
	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	name := prefix + "_" + unique
	var id int64
	err := pool.QueryRow(context.Background(), `INSERT INTO repositories (user_id,name,lower_name,description,is_public,default_bookmark,next_issue_number,next_landing_number) VALUES ($1,$2,$2,'',$3,'main',1,1) RETURNING id`, owner.ID, name, public).Scan(&id)
	require.NoError(t, err)
	return processWorkspaceRepo{ID: id, Owner: owner.Username, Name: name}
}

func processWorkspaceCreateSessionCookie(t *testing.T, queries *db.Queries, user processWorkspaceUser) *http.Cookie {
	t.Helper()
	session, err := queries.CreateAuthSession(context.Background(), db.CreateAuthSessionParams{
		SessionKey: uuid.NewString(), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(24 * time.Hour),
	})
	require.NoError(t, err)
	return &http.Cookie{Name: "smithers_session", Value: session.SessionKey, Path: "/"}
}

func processWorkspaceAuthenticatedClient(t *testing.T, server *httptest.Server, cookie *http.Cookie) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	base, err := url.Parse(server.URL)
	require.NoError(t, err)
	jar.SetCookies(base, []*http.Cookie{cookie})
	client := *server.Client()
	client.Jar = jar
	return &client
}

func processWorkspaceDoRequest(t *testing.T, client *http.Client, baseURL, method, path string, body []byte) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, baseURL+path, reader)
	require.NoError(t, err)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	require.NoError(t, err)
	return response
}

func processWorkspaceReadBody(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	return body
}

func processWorkspaceDecodeJSON(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	require.NoError(t, json.NewDecoder(response.Body).Decode(target))
}
