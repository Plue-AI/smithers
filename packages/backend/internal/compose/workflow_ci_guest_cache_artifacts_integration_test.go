package compose

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// smithers#1768: a sandbox-plane CI job restores and saves its `cache:`
// descriptors and uploads run artifacts through the assembled router, with
// the per-job token the scheduler mints. The fake sandbox runs each guest's
// real start and poll commands with bash in a private directory, so the
// shipped job script and the smithers-ci helper are what execute.
func TestNixCIGuestCacheAndArtifactsPostgres(t *testing.T) {
	for _, tool := range []string{"bash", "python3", "tail"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is required to run the fake CI guest", tool)
		}
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)

	// The public listing request runs as the repository owner.
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ci-owner", LowerUsername: "ci-owner", DisplayName: "CI owner"})
	require.NoError(t, err)
	repoA := ciTestRepo(t, pool, owner.ID, "cached")
	repoB := ciTestRepo(t, pool, owner.ID, "other")
	defA := ciTestDefinition(t, q, repoA)
	defB := ciTestDefinition(t, q, repoB)
	ownerPAT := ciTestPAT(t, q, owner.ID)

	// API + blob transfer server. The filesystem blob store serves its signed
	// URLs from the same origin, as in a self-hosted deployment.
	var handler http.Handler
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	t.Cleanup(srv.Close)
	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: srv.URL})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	router := buildWorkflowCIRouter(q, pool,
		&routes.WorkflowCacheHandler{Service: services.NewWorkflowCacheService(q, store, services.WorkflowCacheConfig{})},
		&routes.WorkflowArtifactHandler{Service: services.NewWorkflowArtifactService(q, store, time.Minute)},
	)
	mux := http.NewServeMux()
	mux.Handle("/api/blob-transfer/", store.TransferHandler())
	mux.Handle("/", router)
	handler = mux

	guests := newLocalCIGuests(t)
	schedulerStore := &ciTestSchedulerStore{Queries: q, pool: pool}
	worker := services.NewWorkflowSandboxSchedulerWorker(schedulerStore, guests,
		services.WithWorkflowSandboxSchedulerGitBaseURL(srv.URL),
		services.WithWorkflowSandboxSchedulerAPIBaseURL(srv.URL+"/api"),
		services.WithWorkflowSandboxSchedulerCIGuests(guests),
		services.WithWorkflowSandboxSchedulerCIPollInterval(20*time.Millisecond),
		services.WithWorkflowSandboxSchedulerCIJobCredentials(q, srv.URL+"/internal"),
	)
	runService := services.NewWorkflowRunService(q)
	dispatch := func(repoID, defID int64) int64 {
		t.Helper()
		results, err := runService.DispatchForEvent(ctx, services.DispatchForEventInput{
			RepositoryID:         repoID,
			WorkflowDefinitionID: &defID,
			Event:                services.TriggerEvent{Type: "workflow_dispatch", Ref: "refs/heads/main", CommitSHA: strings.Repeat("ab", 20)},
		})
		require.NoError(t, err)
		require.Len(t, results, 1)
		return results[0].WorkflowRunID
	}
	runOnce := func(repoID, defID int64) int64 {
		t.Helper()
		runID := dispatch(repoID, defID)
		require.NoError(t, worker.PollOnce(ctx))
		run, err := q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: runID, RepositoryID: repoID})
		require.NoError(t, err)
		require.Equal(t, "success", run.Status, "run logs:\n%s", strings.Join(ciTestLogs(t, pool, runID), "\n"))
		return runID
	}

	// Run 1: cache miss, the job builds deps/marker, saves it, and uploads an
	// artifact. While the job runs its token must not reach another run, the
	// agent-only routes, or survive the job.
	guests.probe = func(token string, runID int64) {
		other := dispatch(repoB, defB)
		status := ciTestInternal(t, srv.URL, token, http.MethodPost, fmt.Sprintf("/internal/runs/%d/artifacts/upload-url", other), `{"name":"x.txt","size":1}`)
		assert.Equal(t, http.StatusForbidden, status, "a job token cannot touch another run's artifacts")
		status = ciTestInternal(t, srv.URL, token, http.MethodPost, "/internal/agent/sessions/s/events", `{}`)
		assert.Equal(t, http.StatusUnauthorized, status, "a job token is not an agent token")
		status = ciTestInternal(t, srv.URL, "smithers_cijob_"+strings.Repeat("0", 40), http.MethodPost, "/internal/caches/restore", `{"key":"deps"}`)
		assert.Equal(t, http.StatusUnauthorized, status, "an unissued job token is rejected")
		// Cancel the probe run so the next poll does not pick it up.
		_, err := pool.Exec(ctx, `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1`, other)
		require.NoError(t, err)
	}
	first := runOnce(repoA, defA)
	guests.probe = nil
	firstLogs := ciTestLogs(t, pool, first)
	assert.Contains(t, firstLogs, "[cache] miss deps")
	assert.Contains(t, firstLogs, "built deps")
	assert.Contains(t, firstLogs, "[cache] saved deps")
	assert.Contains(t, firstLogs, "[artifact] uploaded report.txt (6 bytes)")
	token := guests.tokenFor(first)
	require.NotEmpty(t, token)
	assert.NotContains(t, strings.Join(firstLogs, "\n"), token, "the job token is redacted from logs")
	assert.Equal(t, http.StatusUnauthorized,
		ciTestInternal(t, srv.URL, token, http.MethodPost, "/internal/caches/restore", `{"key":"deps"}`),
		"the job token dies with its job")
	var live int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_task_guest_tokens`).Scan(&live))
	assert.Zero(t, live, "no job token outlives its job")

	// The public listing names the uploaded artifact.
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/repos/ci-owner/cached/runs/%d/artifacts", srv.URL, first), nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+ownerPAT)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var listed struct {
		Artifacts []struct {
			Name   string `json:"name"`
			Size   int64  `json:"size"`
			Status string `json:"status"`
		} `json:"artifacts"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&listed))
	require.Len(t, listed.Artifacts, 1)
	assert.Equal(t, "report.txt", listed.Artifacts[0].Name)
	assert.Equal(t, int64(6), listed.Artifacts[0].Size)
	assert.Equal(t, "ready", listed.Artifacts[0].Status)

	// Run 2 in a fresh guest restores the cache the first run saved.
	second := runOnce(repoA, defA)
	secondLogs := ciTestLogs(t, pool, second)
	assert.Contains(t, secondLogs, "[cache] hit deps (main)")
	assert.Contains(t, secondLogs, "restored deps: built")
	assert.Contains(t, secondLogs, "[cache] already exists deps")

	// Another repository with the same key sees none of it.
	third := runOnce(repoB, defB)
	thirdLogs := ciTestLogs(t, pool, third)
	assert.Contains(t, thirdLogs, "[cache] miss deps")
	assert.Contains(t, thirdLogs, "built deps")
}

const ciTestWorkflowConfig = `{
	"on": {"workflow_dispatch": {}},
	"jobs": {
		"build": {
			"runs-on": "nixos",
			"cache": [
				{"action": "restore", "key": "deps", "hash_files": ["lock.txt"]},
				{"action": "save", "key": "deps", "paths": ["deps"]}
			],
			"steps": [
				{"name": "deps", "run": "if [ -f deps/marker ]; then echo \"restored deps: $(cat deps/marker)\"; else mkdir -p deps && echo built > deps/marker && echo 'built deps'; fi"},
				{"name": "report", "run": "printf 'report' > report.txt && smithers-ci artifact upload report.txt report.txt --content-type text/plain"}
			]
		}
	}
}`

func ciTestRepo(t *testing.T, pool *pgxpool.Pool, userID int64, name string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number, next_landing_number)
		 VALUES ($1, $2, $2, '', FALSE, 'main', 1, 1) RETURNING id`, userID, name).Scan(&id))
	return id
}

func ciTestDefinition(t *testing.T, q *db.Queries, repoID int64) int64 {
	t.Helper()
	def, err := q.CreateWorkflowDefinition(context.Background(), db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "CI", Path: ".smithers/workflows/ci.tsx", Config: json.RawMessage(ciTestWorkflowConfig),
	})
	require.NoError(t, err)
	return def.ID
}

func ciTestPAT(t *testing.T, q *db.Queries, userID int64) string {
	t.Helper()
	token := "smithers_" + strings.Repeat("c1", 20)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	_, err := q.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
		UserID: userID, Name: "ci-reader", TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
		Scopes: "read:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	return token
}

func ciTestInternal(t *testing.T, base, token, method, path, body string) int {
	t.Helper()
	req, err := http.NewRequest(method, base+path, bytes.NewBufferString(body))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	return resp.StatusCode
}

func ciTestLogs(t *testing.T, pool *pgxpool.Pool, runID int64) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT entry FROM workflow_run_logs WHERE workflow_run_id = $1 ORDER BY sequence`, runID)
	require.NoError(t, err)
	defer rows.Close()
	var out []string
	for rows.Next() {
		var entry string
		require.NoError(t, rows.Scan(&entry))
		out = append(out, entry)
	}
	return out
}

// ciTestSchedulerStore is the product queries plus the claim fence a
// deployment store supplies (see ports.RuntimeStores.WorkflowScheduler).
type ciTestSchedulerStore struct {
	*db.Queries
	pool *pgxpool.Pool
}

func (s *ciTestSchedulerStore) ClaimQueuedWorkflowRuns(ctx context.Context, limit int32) ([]runtimeports.ClaimQueuedWorkflowRunsRow, error) {
	rows, err := s.pool.Query(ctx, `UPDATE workflow_runs SET status = 'running', started_at = NOW(), updated_at = NOW()
		WHERE id IN (SELECT id FROM workflow_runs WHERE status = 'queued' AND execution_plane = 'sandbox' ORDER BY id LIMIT $1)
		RETURNING id, repository_id, workflow_definition_id, trigger_ref, trigger_commit_sha, trigger_event`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []runtimeports.ClaimQueuedWorkflowRunsRow
	for rows.Next() {
		var row runtimeports.ClaimQueuedWorkflowRunsRow
		if err := rows.Scan(&row.ID, &row.RepositoryID, &row.WorkflowDefinitionID, &row.TriggerRef, &row.TriggerCommitSha, &row.TriggerEvent); err != nil {
			return nil, err
		}
		_, _ = rand.Read(row.ClaimToken.Bytes[:])
		row.ClaimToken.Valid = true
		row.ClaimGeneration = 1
		row.ClaimLeaseExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *ciTestSchedulerStore) RenewWorkflowSandboxClaim(context.Context, runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
	return pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, nil
}

func (s *ciTestSchedulerStore) finish(ctx context.Context, id int64, status string) (db.WorkflowRun, error) {
	var repoID int64
	if err := s.pool.QueryRow(ctx, `UPDATE workflow_runs SET status = $2, completed_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND status = 'running' RETURNING repository_id`, id, status).Scan(&repoID); err != nil {
		return db.WorkflowRun{}, err
	}
	return s.Queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: id, RepositoryID: repoID})
}

func (s *ciTestSchedulerStore) MarkWorkflowRunSuccess(ctx context.Context, arg runtimeports.MarkWorkflowRunSuccessParams) (db.WorkflowRun, error) {
	return s.finish(ctx, arg.ID, "success")
}

func (s *ciTestSchedulerStore) MarkWorkflowRunFailure(ctx context.Context, arg runtimeports.MarkWorkflowRunFailureParams) (db.WorkflowRun, error) {
	return s.finish(ctx, arg.ID, "failure")
}

// localCIGuests is a fake sandbox provider whose guests are private
// directories on this machine. It runs the scheduler's commands with bash,
// mapping the guest's fixed paths into the guest's directory.
type localCIGuests struct {
	t     *testing.T
	mu    sync.Mutex
	next  int
	roots map[string]string
	// tokens records the job token each run's guest received.
	tokens map[int64]string
	// probe runs inside the job's lifetime, with the job's own token.
	probe func(token string, runID int64)
}

func newLocalCIGuests(t *testing.T) *localCIGuests {
	return &localCIGuests{t: t, roots: map[string]string{}, tokens: map[int64]string{}}
}

func (g *localCIGuests) tokenFor(runID int64) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.tokens[runID]
}

func (g *localCIGuests) CIGuestVMRequest(_ context.Context, _ int64, gitRepos []sandbox.GitRepositorySpec) (sandbox.CreateRequest, error) {
	return sandbox.CreateRequest{Kind: "vm", GitRepos: gitRepos}, nil
}

func (g *localCIGuests) CreateSandbox(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
	g.mu.Lock()
	g.next++
	id := fmt.Sprintf("vm-%d", g.next)
	g.mu.Unlock()
	root := g.t.TempDir()
	// The "clone": a checkout with the file the cache version hashes.
	if err := os.MkdirAll(filepath.Join(root, "repo"), 0o755); err != nil {
		return sandbox.CreateResult{}, err
	}
	if err := os.WriteFile(filepath.Join(root, "repo", "lock.txt"), []byte("v1\n"), 0o644); err != nil {
		return sandbox.CreateResult{}, err
	}
	g.mu.Lock()
	g.roots[id] = root
	g.mu.Unlock()
	return sandbox.CreateResult{ID: id}, nil
}

func (g *localCIGuests) Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	g.mu.Lock()
	root := g.roots[vmID]
	g.mu.Unlock()
	if token := req.Secrets["SMITHERS_CI_JOB_TOKEN"]; token != "" && g.probe != nil {
		var runID int64
		_, _ = fmt.Sscan(req.Secrets["SMITHERS_WORKFLOW_RUN_ID"], &runID)
		g.probe(token, runID)
	}
	if token := req.Secrets["SMITHERS_CI_JOB_TOKEN"]; token != "" {
		var runID int64
		_, _ = fmt.Sscan(req.Secrets["SMITHERS_WORKFLOW_RUN_ID"], &runID)
		g.mu.Lock()
		g.tokens[runID] = token
		g.mu.Unlock()
	}
	command := strings.NewReplacer(
		"/workspace/repo", filepath.Join(root, "repo"),
		"/var/log/smithers-ci", filepath.Join(root, "log"),
		"/var/lib/smithers-ci", filepath.Join(root, "lib"),
	).Replace(req.Command)
	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	cmd.Env = os.Environ()
	for name, value := range req.Secrets {
		cmd.Env = append(cmd.Env, name+"="+value)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := int32(0)
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = int32(exitErr.ExitCode())
	} else if err != nil {
		return sandbox.ExecResult{}, err
	}
	return sandbox.ExecResult{Stdout: stdout.String(), Stderr: stderr.String(), StatusCode: &code}, nil
}

func (g *localCIGuests) DeleteSandbox(context.Context, string) error { return nil }

// buildWorkflowCIRouter is the assembled router with only the workflow cache
// and artifact handlers wired.
func buildWorkflowCIRouter(q *db.Queries, pool *pgxpool.Pool, cache *routes.WorkflowCacheHandler, artifacts *routes.WorkflowArtifactHandler) http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{},
		nil, // changesetHandler
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,                     // notificationHandler
		nil,                     // pairSessionHandler
		nil, nil, nil, nil, nil, // admin user/org/repo/github-app/audit
		nil, nil, nil, nil, nil, nil, nil, nil, // webhook, secret, provider, variable, billing, protected, status, lfs
		nil, // jjVCSHandler
		&routes.AgentInternalHandler{},
		nil, nil, nil, nil, nil, nil, // agent sessions/stream, approvals, branch lock, push hook, workflow
		cache, artifacts,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}
