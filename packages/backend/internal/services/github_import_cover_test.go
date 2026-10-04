package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// githubImportCovMetrics is written to from the detached import goroutine while
// the test asserts, so every field access goes through the mutex and reads use
// the snapshot accessors.
type githubImportCovMetrics struct {
	mu              sync.Mutex
	attemptObserved chan string
	attempts        []string
	failures        []string
	durations       []string
	cloneBytes      []float64
	cloneDurations  []float64
	branches        []string
}

func (m *githubImportCovMetrics) ObserveMirrorAttempt(result string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.attempts = append(m.attempts, result)
	if m.attemptObserved != nil {
		m.attemptObserved <- result
	}
}

func (m *githubImportCovMetrics) ObserveMirrorFailure(stage, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failures = append(m.failures, stage+":"+reason)
}

func (m *githubImportCovMetrics) ObserveMirrorDuration(phase string, seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.durations = append(m.durations, phase)
}

func (m *githubImportCovMetrics) ObserveMirrorCloneBytes(bytes float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cloneBytes = append(m.cloneBytes, bytes)
}

func (m *githubImportCovMetrics) ObserveMirrorCloneDuration(seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cloneDurations = append(m.cloneDurations, seconds)
}

func (m *githubImportCovMetrics) ObserveBranchCreate(result string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.branches = append(m.branches, result)
}

func (m *githubImportCovMetrics) attemptsSnapshot() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.attempts...)
}

func (m *githubImportCovMetrics) failuresSnapshot() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.failures...)
}

type githubImportCovRepoDB struct {
	getFn    func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	createFn func(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error)
	deleteFn func(ctx context.Context, id int64) error
}

func (d *githubImportCovRepoDB) CreateRepo(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	if d.createFn != nil {
		return d.createFn(ctx, arg)
	}
	return db.Repository{ID: 42, Name: arg.Name, LowerName: arg.LowerName, DefaultBookmark: arg.DefaultBookmark}, nil
}

func (d *githubImportCovRepoDB) DeleteRepo(ctx context.Context, id int64) error {
	if d.deleteFn != nil {
		return d.deleteFn(ctx, id)
	}
	return nil
}

func (d *githubImportCovRepoDB) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if d.getFn != nil {
		return d.getFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

type githubImportCovWorkspaceProvisioner struct {
	resp WorkspaceResponse
	err  error
}

func (p githubImportCovWorkspaceProvisioner) CreateWorkspaceAsync(context.Context, CreateWorkspaceInput) (WorkspaceResponse, error) {
	return p.resp, p.err
}

func TestGitHubImport_Cov_StartGetAndDetachedFailure(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	queries := db.New(pool)
	username := githubImportCovRepoName(t, "importer") + "-" + uuid.NewString()[:8]
	var user db.User
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1)
		RETURNING id, username, lower_username, email, lower_email, display_name, bio, avatar_url, user_type, is_active, is_admin, prohibit_login, email_notifications_enabled, created_at, updated_at`,
		username, username+"@example.com").Scan(&user.ID, &user.Username, &user.LowerUsername, &user.Email, &user.LowerEmail,
		&user.DisplayName, &user.Bio, &user.AvatarUrl, &user.UserType, &user.IsActive, &user.IsAdmin,
		&user.ProhibitLogin, &user.EmailNotificationsEnabled, &user.CreatedAt, &user.UpdatedAt))

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/repos/octo/"+githubImportCovRepoName(t, "source"), r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{"private": false, "default_branch": "trunk"})
	}))
	t.Cleanup(api.Close)
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	metrics := &githubImportCovMetrics{attemptObserved: make(chan string, 1)}
	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "trunk", TargetChangeID: "change-trunk"}}}
	svc := NewGitHubImportService(
		pool,
		queries,
		queries,
		repoHost,
		testGitHubImportDecrypter{},
		"https://git.example",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportMetrics(metrics),
		WithGitHubImportWorkspaceProvisioner(githubImportCovWorkspaceProvisioner{err: assert.AnError}),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }),
	)

	sourceRepo := githubImportCovRepoName(t, "source")
	job, err := svc.StartImport(ctx, ImportGitHubRepoInput{
		UserID: user.ID,
		Owner:  "octo",
		Repo:   sourceRepo,
		Branch: "landing/demo",
	})
	require.NoError(t, err)
	assert.Equal(t, user.LowerUsername, job.RepoOwner)
	assert.Equal(t, sourceRepo, job.RepoName)
	assert.Equal(t, "landing/demo", job.TargetBookmark)
	assert.Equal(t, "cloning", job.Status)

	got, err := svc.GetImportJob(ctx, user.ID, job.ImportJobID)
	require.NoError(t, err)
	assert.Equal(t, job.ImportJobID, got.ImportJobID)

	_, err = svc.GetImportJob(ctx, user.ID, "not-a-uuid")
	require.Error(t, err)
	githubImportCovAssertAPIStatus(t, err, http.StatusBadRequest)

	_, err = svc.GetImportJob(ctx, user.ID+9999, job.ImportJobID)
	require.Error(t, err)
	githubImportCovAssertAPIStatus(t, err, http.StatusNotFound)

	// The terminal attempt is recorded after the detached job's DB update.
	// Wait for that event: neither DB latency nor scheduling is bounded by the
	// old three-second poll, and this test is not exercising import timeouts.
	require.Equal(t, "failed", <-metrics.attemptObserved)
	failed, err := svc.GetImportJob(ctx, user.ID, job.ImportJobID)
	require.NoError(t, err)
	assert.Equal(t, "failed", failed.Status)
	assert.Equal(t, importStageProvisioningWorkspace, failed.Stage)
	assert.Contains(t, failed.Error, "create bound workspace")
	assert.Contains(t, metrics.attemptsSnapshot(), "failed")
	assert.Contains(t, metrics.failuresSnapshot(), "workspace:create")
}

func TestGitHubImport_Cov_MetadataTokensReposAndHelpers(t *testing.T) {
	ctx := context.Background()

	t.Run("options and clone info branches", func(t *testing.T) {
		metrics := &githubImportCovMetrics{}
		svc := NewGitHubImportService(nil, nil, testGitHubImportTokenDB{}, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{}, "https://git.example", WithGitHubImportMetrics(metrics), WithGitHubImportHTTPClient(nil))
		require.Same(t, metrics, svc.metrics)
		assert.NotNil(t, svc.httpClient)

		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/repos/octo/private":
				_ = json.NewEncoder(w).Encode(map[string]any{"private": true, "default_branch": "main"})
			case "/repos/octo/forbidden":
				http.Error(w, `{"message":"rate limited"}`, http.StatusForbidden)
			case "/repos/octo/bad-json":
				_, _ = w.Write([]byte("{bad json"))
			default:
				http.Error(w, "nope", http.StatusInternalServerError)
			}
		}))
		t.Cleanup(api.Close)
		t.Setenv(envGitHubAppAPIBaseURL, api.URL)

		workosSvc := NewGitHubImportService(nil, nil, testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "workos", AccessTokenEncrypted: []byte("cipher")}}}, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{token: "gho_workos"}, "https://git.example", WithGitHubImportHTTPClient(api.Client()))
		token, private, branch, err := workosSvc.githubCloneInfoForRepo(ctx, 1, "octo", "private")
		require.NoError(t, err)
		assert.Equal(t, "gho_workos", token)
		assert.True(t, private)
		assert.Equal(t, "main", branch)

		_, _, _, err = workosSvc.githubCloneInfoForRepo(ctx, 1, "octo", "forbidden")
		require.Error(t, err)
		githubImportCovAssertAPIStatus(t, err, http.StatusForbidden)

		_, _, _, err = workosSvc.githubCloneInfoForRepo(ctx, 1, "octo", "missing")
		require.Error(t, err)
		githubImportCovAssertAPIStatus(t, err, http.StatusInternalServerError)

		_, status, _, err := workosSvc.fetchGitHubRepoMetadata(ctx, "", "octo", "bad-json")
		require.Error(t, err)
		assert.Equal(t, http.StatusOK, status)

		blankRefresher := &fakeGitHubTokenRefresher{newToken: " "}
		refreshSvc := NewGitHubImportService(nil, nil, testGitHubImportTokenDB{}, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{}, "https://git.example", WithGitHubImportTokenRefresher(blankRefresher))
		_, err = refreshSvc.refreshUserGitHubToken(ctx, db.OauthAccount{Provider: "github"})
		require.Error(t, err)
		githubImportCovAssertAPIStatus(t, err, http.StatusUnauthorized)
	})

	t.Run("repo and workspace helpers", func(t *testing.T) {
		metrics := &githubImportCovMetrics{}
		repoHost := &testGitHubImportRepoHost{}
		existing := db.Repository{ID: 77, Name: "demo", LowerName: "demo", DefaultBookmark: "main"}
		svc := NewGitHubImportService(nil, &githubImportCovRepoDB{
			getFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return existing, nil
			},
		}, nil, repoHost, nil, "https://git.example", WithGitHubImportMetrics(metrics))

		_, _, err := svc.ensureLocalRepo(ctx, 7, "alice", "octo", "demo", "main")
		require.ErrorContains(t, err, "repository 'demo' already exists")
		assert.Empty(t, repoHost.initRepoOwner)
		assert.Contains(t, metrics.attemptsSnapshot(), "already_exists")

		lookupErrSvc := NewGitHubImportService(nil, &githubImportCovRepoDB{
			getFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{}, errors.New("db unavailable")
			},
		}, nil, repoHost, nil, "https://git.example")
		_, _, err = lookupErrSvc.ensureLocalRepo(ctx, 7, "alice", "octo", "demo", "main")
		require.ErrorContains(t, err, "lookup local repo")

		// Repo-host init failure must compensate the just-created DB row so a
		// phantom repository never survives a failed import.
		var deleted []int64
		initFailSvc := NewGitHubImportService(nil, &githubImportCovRepoDB{
			deleteFn: func(_ context.Context, id int64) error {
				deleted = append(deleted, id)
				return nil
			},
		}, nil, &testGitHubImportRepoHost{initRepoErr: errors.New("repo-host down")}, nil, "https://git.example")
		_, _, err = initFailSvc.ensureLocalRepo(ctx, 7, "alice", "octo", "demo", "main")
		require.ErrorContains(t, err, "init local repo")
		assert.Equal(t, []int64{42}, deleted)

		mismatchSvc := &GitHubImportService{workspaces: githubImportCovWorkspaceProvisioner{resp: WorkspaceResponse{TargetBookmark: "other"}}}
		_, err = mismatchSvc.createBoundWorkspace(ctx, 7, db.Repository{ID: 42}, "alice", "demo", "main")
		require.ErrorContains(t, err, "workspace bookmark binding")
	})

	t.Run("mark failed and utility helpers", func(t *testing.T) {
		pool := getAgentTestPool(t)
		user := githubImportCovSeedUser(t, ctx, "mark")
		// Rows survive -count iterations in the shared integration database.
		jobID := uuid.NewString()
		_, err := pool.Exec(ctx, `
			INSERT INTO import_jobs (id, user_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status)
			VALUES ($1, $2, 'octo', 'demo', $3, 'demo', 'main', 'main', 'cloning')
		`, jobID, user.ID, user.LowerUsername)
		require.NoError(t, err)

		svc := NewGitHubImportService(pool, nil, nil, nil, nil, "https://git.example")
		require.NoError(t, svc.markFailed(ctx, jobID, fmt.Errorf("%s", strings.Repeat("x", 2100))))
		job, err := svc.GetImportJob(ctx, user.ID, jobID)
		require.NoError(t, err)
		assert.Equal(t, "failed", job.Status)
		assert.Len(t, job.Error, 2000)

		_, err = pool.Exec(ctx, `
			UPDATE import_jobs
			SET stage = 'importing_refs', refs_done = 4, refs_total = 9,
			    provisioning_repository_id = 1234,
			    provisioning_token = $2,
			    attempts = 20
			WHERE id = $1
		`, jobID, strings.Repeat("a", 64))
		require.NoError(t, err)
		retried, err := svc.RetryImportJob(ctx, user.ID, jobID)
		require.NoError(t, err)
		assert.Equal(t, "cloning", retried.Status)
		assert.Equal(t, "importing_refs", retried.Stage)
		assert.Equal(t, ImportJobCount{Done: 4, Total: 9}, retried.Counts.Refs)
		assert.Empty(t, retried.Error)
		var attempts int32
		var provisioningID pgtype.Int8
		var provisioningToken pgtype.Text
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT attempts, provisioning_repository_id, provisioning_token
			FROM import_jobs WHERE id = $1
		`, jobID).Scan(&attempts, &provisioningID, &provisioningToken))
		assert.Zero(t, attempts)
		assert.False(t, provisioningID.Valid, "retry must discard an unpublished reservation")
		assert.False(t, provisioningToken.Valid, "retry must discard an unpublished reservation token")

		metrics := &githubImportCovMetrics{}
		svc.metrics = metrics
		svc.observeFailure("clone", fmt.Errorf("clone: denied"))
		assert.Equal(t, []string{"clone:clone"}, metrics.failuresSnapshot())

		_, err = gitMirrorObjectBytes(ctx, "/definitely/not/a/git/dir")
		require.Error(t, err)
		if _, lookErr := exec.LookPath("git"); lookErr == nil {
			assert.Contains(t, err.Error(), "exit status")
		}
	})
}

func githubImportCovSeedUser(t *testing.T, ctx context.Context, suffix string) db.User {
	t.Helper()
	// Each -count iteration needs a unique owner. Keep repository names stable
	// so the GitHub API fake can match the requested source path.
	username := githubImportCovRepoName(t, suffix) + "-" + uuid.NewString()[:8]
	var user db.User
	err := getAgentTestPool(t).QueryRow(ctx, `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1)
		RETURNING id, username, lower_username, email, lower_email, display_name, bio, avatar_url, user_type, is_active, is_admin, prohibit_login, email_notifications_enabled, created_at, updated_at
	`, username, username+"@example.com").Scan(
		&user.ID,
		&user.Username,
		&user.LowerUsername,
		&user.Email,
		&user.LowerEmail,
		&user.DisplayName,
		&user.Bio,
		&user.AvatarUrl,
		&user.UserType,
		&user.IsActive,
		&user.IsAdmin,
		&user.ProhibitLogin,
		&user.EmailNotificationsEnabled,
		&user.CreatedAt,
		&user.UpdatedAt,
	)
	require.NoError(t, err)
	return user
}

func githubImportCovRepoName(t *testing.T, suffix string) string {
	t.Helper()
	replacer := strings.NewReplacer("/", "-", "_", "-", " ", "-", ".", "-")
	value := strings.ToLower(replacer.Replace(t.Name() + "-" + suffix))
	if len(value) > 55 {
		value = value[len(value)-55:]
	}
	return strings.Trim(value, "-")
}

func githubImportCovAssertAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, status, apiErr.Status)
}
