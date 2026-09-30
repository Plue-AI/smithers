package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type githubImportHRow struct {
	err      error
	username string
	jobID    string
	created  bool
	status   string
}

type githubImportHInstallationTokens struct {
	token string
	err   error
}

func (i githubImportHInstallationTokens) CreateGitHubInstallationToken(context.Context, int64, string, string) (GitHubInstallationToken, error) {
	return GitHubInstallationToken{Token: i.token}, i.err
}

func (r githubImportHRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) == 1 {
		switch d := dest[0].(type) {
		case *string:
			if r.username != "" {
				*d = r.username
			} else {
				*d = r.jobID
			}
		}
		return nil
	}
	id := r.jobID
	if id == "" {
		id = uuid.NewString()
	}
	*(dest[0].(*string)) = id
	*(dest[1].(*int64)) = 7
	*(dest[2].(*pgtype.Int8)) = pgtype.Int8{Int64: 42, Valid: true}
	*(dest[3].(*pgtype.UUID)) = pgtype.UUID{}
	*(dest[4].(*string)) = "octo"
	*(dest[5].(*string)) = "demo"
	*(dest[6].(*string)) = "alice"
	*(dest[7].(*string)) = "demo"
	*(dest[8].(*string)) = "main"
	*(dest[9].(*string)) = "main"
	status := r.status
	if status == "" {
		status = "cloning"
	}
	*(dest[10].(*string)) = status
	*(dest[11].(*string)) = "stage"
	for i := 12; i <= 17; i++ {
		*(dest[i].(*int64)) = int64(i)
	}
	*(dest[18].(*string)) = ""
	*(dest[19].(*time.Time)) = time.Now().UTC()
	*(dest[20].(*time.Time)) = time.Now().UTC()
	if len(dest) > 21 {
		*(dest[21].(*bool)) = r.created
	}
	return nil
}

type githubImportHDB struct {
	mu        sync.Mutex
	username  string
	stages    []string
	createErr error
	getErr    error
	readyErr  error
	stageErr  error
	failedCh  chan struct{}
	status    string
	retryErr  error
	progress  ImportJobCounts
}

func (d *githubImportHDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch sql {
	case `SELECT username FROM users WHERE id = $1`:
		return githubImportHRow{username: d.username}
	case createImportJobSQL:
		return githubImportHRow{err: d.createErr, jobID: args[0].(string), created: true}
	case getImportJobSQL:
		return githubImportHRow{err: d.getErr, jobID: args[0].(string), status: d.status}
	case retryImportJobSQL:
		return githubImportHRow{err: d.retryErr, jobID: args[0].(string), status: "cloning"}
	case setImportJobStageSQL:
		if len(args) > 1 {
			d.stages = append(d.stages, args[1].(string))
		}
		return githubImportHRow{err: d.stageErr, jobID: "stage"}
	case setImportJobProgressSQL:
		d.progress = ImportJobCounts{
			Refs:    ImportJobCount{Done: args[1].(int64), Total: args[2].(int64)},
			Objects: ImportJobCount{Done: args[3].(int64), Total: args[4].(int64)},
			Issues:  ImportJobCount{Done: args[5].(int64), Total: args[6].(int64)},
		}
		return githubImportHRow{jobID: "progress"}
	case markImportJobReadySQL:
		return githubImportHRow{err: d.readyErr, jobID: args[0].(string)}
	case markImportJobFailedSQL:
		if d.failedCh != nil {
			close(d.failedCh)
			d.failedCh = nil
		}
		return githubImportHRow{jobID: args[0].(string)}
	default:
		return githubImportHRow{err: fmt.Errorf("unexpected sql")}
	}
}

type githubImportHRepoDB struct {
	existing  *db.Repository
	getErr    error
	createErr error
}

func (r githubImportHRepoDB) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if r.existing != nil {
		return *r.existing, nil
	}
	if r.getErr != nil {
		return db.Repository{}, r.getErr
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (r githubImportHRepoDB) CreateRepo(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	if r.createErr != nil {
		return db.Repository{}, r.createErr
	}
	return db.Repository{ID: 42, Name: arg.Name, LowerName: arg.LowerName, DefaultBookmark: arg.DefaultBookmark}, nil
}

func (r githubImportHRepoDB) DeleteRepo(context.Context, int64) error {
	return nil
}

type githubImportHTokenDB struct {
	accounts  []db.OauthAccount
	listErr   error
	createErr error
}

func (t githubImportHTokenDB) CreateAccessToken(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
	if t.createErr != nil {
		return db.AccessToken{}, t.createErr
	}
	return db.AccessToken{ID: 88}, nil
}

func (t githubImportHTokenDB) DeleteAccessToken(context.Context, db.DeleteAccessTokenParams) error {
	return nil
}

func (t githubImportHTokenDB) ListUserOAuthAccounts(context.Context, int64) ([]db.OauthAccount, error) {
	if t.listErr != nil {
		return nil, t.listErr
	}
	return t.accounts, nil
}

type githubImportHRepoHost struct {
	initErr   error
	importErr error
	listErr   error
	createErr error
	bookmarks []repohost.Bookmark
}

func (h *githubImportHRepoHost) InitRepo(context.Context, string, string, string, bool) error {
	return h.initErr
}

func (h *githubImportHRepoHost) DeleteRepo(context.Context, string, string) error {
	return nil
}

func (h *githubImportHRepoHost) ImportRefs(context.Context, string, string) error {
	return h.importErr
}

func (h *githubImportHRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	if h.listErr != nil {
		return nil, "", h.listErr
	}
	return h.bookmarks, "", nil
}

func (h *githubImportHRepoHost) CreateBookmark(context.Context, string, string, repohost.CreateBookmarkRequest) (repohost.Bookmark, error) {
	if h.createErr != nil {
		return repohost.Bookmark{}, h.createErr
	}
	return repohost.Bookmark{}, nil
}

type githubImportHWorkspace struct {
	err  error
	resp WorkspaceResponse
}

func (w githubImportHWorkspace) CreateWorkspaceAsync(context.Context, CreateWorkspaceInput) (WorkspaceResponse, error) {
	if w.err != nil {
		return WorkspaceResponse{}, w.err
	}
	if w.resp.ID != "" {
		return w.resp, nil
	}
	return WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", TargetBookmark: "main"}, nil
}

type githubImportHDecrypter struct {
	token string
	err   error
}

func (d githubImportHDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	if d.err != nil {
		return "", d.err
	}
	return d.token, nil
}

type githubImportHMetrics struct {
	attempts []string
	failures []string
	branches []string
	bytes    []float64
}

func (m *githubImportHMetrics) ObserveMirrorAttempt(result string) {
	m.attempts = append(m.attempts, result)
}
func (m *githubImportHMetrics) ObserveMirrorFailure(stage, reason string) {
	m.failures = append(m.failures, stage+":"+reason)
}
func (m *githubImportHMetrics) ObserveMirrorDuration(string, float64) {}
func (m *githubImportHMetrics) ObserveMirrorCloneBytes(bytes float64) {
	m.bytes = append(m.bytes, bytes)
}
func (m *githubImportHMetrics) ObserveMirrorCloneDuration(float64) {}
func (m *githubImportHMetrics) ObserveBranchCreate(result string) {
	m.branches = append(m.branches, result)
}

func githubImportHAPI(t *testing.T, status int, body any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	return server
}

func githubImportHService(api *httptest.Server, opts ...GitHubImportOption) *GitHubImportService {
	allOpts := append([]GitHubImportOption{WithGitHubImportHTTPClient(api.Client())}, opts...)
	return NewGitHubImportService(
		&githubImportHDB{username: "alice"},
		githubImportHRepoDB{},
		githubImportHTokenDB{},
		&githubImportHRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}},
		githubImportHDecrypter{},
		"https://plue.test",
		allOpts...,
	)
}

func TestGitHubImport_H_StartImportAndLookupBranches(t *testing.T) {
	ctx := context.Background()

	_, err := (*GitHubImportService)(nil).StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "o", Repo: "r"})
	require.EqualError(t, err, "github import service unavailable")

	_, err = NewGitHubImportService(&githubImportHDB{}, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test").StartImport(ctx, ImportGitHubRepoInput{Owner: "o", Repo: "r"})
	require.Contains(t, err.Error(), "authentication required")

	_, err = NewGitHubImportService(&githubImportHDB{}, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test").StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Repo: "r"})
	require.Contains(t, err.Error(), "owner is required")

	_, err = NewGitHubImportService(&githubImportHDB{}, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test").StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "o", Repo: "r"})
	require.Contains(t, err.Error(), "resolve import owner")

	_, err = NewGitHubImportService(&githubImportHDB{username: "alice", createErr: assert.AnError}, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test").StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "o", Repo: "r"})
	require.Contains(t, err.Error(), "create import job")

	failedCh := make(chan struct{})
	dbase := &githubImportHDB{username: "alice", failedCh: failedCh}
	api := githubImportHAPI(t, http.StatusInternalServerError, nil)
	svc := NewGitHubImportService(dbase, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test", WithGitHubImportHTTPClient(api.Client()))
	svc.asyncTimeout = time.Second
	job, err := svc.StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "Octo", Repo: "Demo", Branch: " "})
	require.NoError(t, err)
	assert.Equal(t, "alice", job.RepoOwner)
	select {
	case <-failedCh:
	case <-time.After(2 * time.Second):
		t.Fatal("background import did not mark failed")
	}

	_, err = (*GitHubImportService)(nil).GetImportJob(ctx, 1, uuid.NewString())
	require.Contains(t, err.Error(), "service unavailable")

	_, err = svc.GetImportJob(ctx, 1, "bad")
	require.Contains(t, err.Error(), "invalid import job id")

	svc.db = &githubImportHDB{getErr: pgx.ErrNoRows}
	_, err = svc.GetImportJob(ctx, 1, uuid.NewString())
	require.Contains(t, err.Error(), "import job not found")

	svc.db = &githubImportHDB{getErr: assert.AnError}
	_, err = svc.GetImportJob(ctx, 1, uuid.NewString())
	require.Contains(t, err.Error(), "get import job")
}

func TestGitHubImport_H_RunImportDetachedReadyAndMetrics(t *testing.T) {
	api := githubImportHAPI(t, http.StatusOK, map[string]any{"private": false, "default_branch": "main"})
	metrics := &githubImportHMetrics{}
	dbase := &githubImportHDB{username: "alice", readyErr: assert.AnError}
	svc := githubImportHService(api, WithGitHubImportMetrics(metrics), WithGitHubImportWorkspaceProvisioner(githubImportHWorkspace{}), withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }))
	svc.db = dbase
	svc.runImportDetached("job", 7, "octo", "demo", "alice", "main")
	assert.Empty(t, metrics.attempts)

	dbase.readyErr = nil
	svc.runImportDetached("job", 7, "octo", "demo", "alice", "main")
	assert.Contains(t, metrics.attempts, "ok")

	(*GitHubImportService)(nil).setStage(context.Background(), "job", "stage")
	(&GitHubImportService{db: &githubImportHDB{stageErr: assert.AnError}}).setStage(context.Background(), "job", "stage")
}

func TestGitHubImport_H_GetImportJobIncludesProgressAndRepository(t *testing.T) {
	svc := &GitHubImportService{db: &githubImportHDB{status: "ready"}}
	job, err := svc.GetImportJob(context.Background(), 7, uuid.NewString())
	require.NoError(t, err)
	require.NotNil(t, job.Repository)
	assert.Equal(t, ImportJobRepository{Owner: "alice", Name: "demo"}, *job.Repository)
	assert.Equal(t, ImportJobCount{Done: 12, Total: 13}, job.Counts.Refs)
	assert.Equal(t, ImportJobCount{Done: 14, Total: 15}, job.Counts.Objects)
	assert.Equal(t, ImportJobCount{Done: 16, Total: 17}, job.Counts.Issues)
}

func TestGitHubImport_H_RetryImportJob(t *testing.T) {
	ctx := context.Background()
	jobID := uuid.NewString()

	_, err := (*GitHubImportService)(nil).RetryImportJob(ctx, 7, jobID)
	require.ErrorContains(t, err, "service unavailable")
	_, err = (&GitHubImportService{db: &githubImportHDB{}}).RetryImportJob(ctx, 7, "bad")
	require.ErrorContains(t, err, "invalid import job id")
	_, err = (&GitHubImportService{db: &githubImportHDB{getErr: pgx.ErrNoRows}}).RetryImportJob(ctx, 7, jobID)
	require.ErrorContains(t, err, "import job not found")
	_, err = (&GitHubImportService{db: &githubImportHDB{status: "ready"}}).RetryImportJob(ctx, 7, jobID)
	require.ErrorContains(t, err, "only failed import jobs")
	_, err = (&GitHubImportService{db: &githubImportHDB{status: "failed", retryErr: pgx.ErrNoRows}}).RetryImportJob(ctx, 7, jobID)
	require.ErrorContains(t, err, "no longer failed")

	dbase := &githubImportHDB{status: "failed"}
	job, err := (&GitHubImportService{db: dbase}).RetryImportJob(ctx, 7, jobID)
	require.NoError(t, err)
	assert.Equal(t, "cloning", job.Status)
	assert.Equal(t, "stage", job.Stage, "retry must preserve the last failed stage")
	assert.Equal(t, ImportJobCount{Done: 12, Total: 13}, job.Counts.Refs)
}

func TestGitHubImport_H_SetProgressNormalizesInvalidCounts(t *testing.T) {
	dbase := &githubImportHDB{}
	svc := &GitHubImportService{db: dbase}
	svc.setProgress(context.Background(), "job", ImportJobCounts{
		Refs: ImportJobCount{Done: 5, Total: 2}, Objects: ImportJobCount{Done: -1, Total: 3},
	})
	assert.Equal(t, ImportJobCount{Done: 5, Total: 5}, dbase.progress.Refs)
	assert.Equal(t, ImportJobCount{Done: 0, Total: 3}, dbase.progress.Objects)
}

func TestGitHubImport_H_RunImportFailureStages(t *testing.T) {
	ctx := context.Background()
	api := githubImportHAPI(t, http.StatusOK, map[string]any{"private": false, "default_branch": ""})

	cases := []struct {
		name    string
		mutate  func(*GitHubImportService)
		wantErr string
	}{
		{"github info", func(s *GitHubImportService) { s.tokenDB = githubImportHTokenDB{listErr: assert.AnError} }, "load github oauth account"},
		{"ensure repo", func(s *GitHubImportService) { s.repoDB = githubImportHRepoDB{getErr: assert.AnError} }, "lookup local repo"},
		{"token", func(s *GitHubImportService) { s.tokenDB = githubImportHTokenDB{createErr: assert.AnError} }, "create import push token"},
		{"clone", func(s *GitHubImportService) {
			s.cloneMirror = func(context.Context, string, string, string, string, string, string) error {
				return errors.New("clone failed")
			}
		}, "clone failed"},
		{"import refs", func(s *GitHubImportService) {
			s.repoHost = &githubImportHRepoHost{importErr: assert.AnError, bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
		}, "import refs"},
		{"bookmark target", func(s *GitHubImportService) { s.repoHost = &githubImportHRepoHost{} }, "imported bookmark not found"},
		{"create bookmark", func(s *GitHubImportService) {
			s.repoHost = &githubImportHRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}, createErr: assert.AnError}
		}, "create bookmark"},
		{"workspace", func(s *GitHubImportService) { s.workspaces = githubImportHWorkspace{err: assert.AnError} }, "create bound workspace"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			metrics := &githubImportHMetrics{}
			svc := githubImportHService(api, WithGitHubImportMetrics(metrics), WithGitHubImportWorkspaceProvisioner(githubImportHWorkspace{}), withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }))
			tc.mutate(svc)
			_, _, err := svc.runImport(ctx, 7, "octo", "demo", "alice", "main", "job")
			require.ErrorContains(t, err, tc.wantErr)
			assert.NotEmpty(t, metrics.failures)
		})
	}
}

func TestGitHubImport_H_BoundWorkspaceRepoAndBookmarkHelpers(t *testing.T) {
	ctx := context.Background()
	svc := &GitHubImportService{}
	_, err := svc.createBoundWorkspace(ctx, 7, db.Repository{ID: 42}, "alice", "demo", "main")
	require.Contains(t, err.Error(), "workspace provisioner unavailable")

	svc.workspaces = githubImportHWorkspace{resp: WorkspaceResponse{ID: "ws", TargetBookmark: "other"}}
	_, err = svc.createBoundWorkspace(ctx, 7, db.Repository{ID: 42}, "alice", "demo", "main")
	require.Contains(t, err.Error(), "workspace bookmark binding")

	metrics := &githubImportHMetrics{}
	existing := db.Repository{ID: 99, Name: "demo"}
	svc = &GitHubImportService{repoDB: githubImportHRepoDB{existing: &existing}, repoHost: &githubImportHRepoHost{}, metrics: metrics}
	_, _, err = svc.ensureLocalRepo(ctx, 7, "alice", "octo", "demo", "main")
	require.ErrorContains(t, err, "repository 'demo' already exists")
	assert.Contains(t, metrics.attempts, "already_exists")

	_, _, err = (&GitHubImportService{repoDB: githubImportHRepoDB{createErr: assert.AnError}, repoHost: &githubImportHRepoHost{}}).ensureLocalRepo(ctx, 7, "alice", "octo", "demo", "main")
	require.ErrorContains(t, err, "create local repo")

	_, _, err = (&GitHubImportService{repoDB: githubImportHRepoDB{}, repoHost: &githubImportHRepoHost{initErr: assert.AnError}}).ensureLocalRepo(ctx, 7, "alice", "octo", "demo", "main")
	require.ErrorContains(t, err, "init local repo")

	_, err = (&GitHubImportService{repoHost: &githubImportHRepoHost{listErr: assert.AnError}}).importedBookmarkTarget(ctx, "alice", "demo", "main")
	require.ErrorContains(t, err, "read bookmark")

	_, err = (&GitHubImportService{repoHost: &githubImportHRepoHost{bookmarks: []repohost.Bookmark{{Name: "main"}}}}).importedBookmarkTarget(ctx, "alice", "demo", "main")
	require.ErrorContains(t, err, "imported bookmark not found")
}

func TestGitHubImport_H_GitHubCloneInfoAndTokenBranches(t *testing.T) {
	ctx := context.Background()

	api := githubImportHAPI(t, http.StatusNotFound, nil)
	_, _, _, err := NewGitHubImportService(nil, nil, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test", WithGitHubImportHTTPClient(api.Client())).githubCloneInfoForRepo(ctx, 7, "octo", "demo")
	require.Contains(t, err.Error(), "GitHub credential is required")

	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTeapot} {
		api = githubImportHAPI(t, status, nil)
		tokenDB := githubImportHTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("x")}}}
		_, _, _, err = NewGitHubImportService(nil, nil, tokenDB, &githubImportHRepoHost{}, githubImportHDecrypter{token: "old"}, "https://plue.test", WithGitHubImportHTTPClient(api.Client())).githubCloneInfoForRepo(ctx, 7, "octo", "demo")
		require.Error(t, err)
	}

	api = githubImportHAPI(t, http.StatusOK, map[string]any{"private": true, "default_branch": "main"})
	_, _, _, err = NewGitHubImportService(nil, nil, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test", WithGitHubImportHTTPClient(api.Client())).githubCloneInfoForRepo(ctx, 7, "octo", "demo")
	require.Contains(t, err.Error(), "GitHub credential is required")
	require.True(t, isTerminalGitHubImportFailure(err), "missing private-repo credentials must fail the durable job immediately")

	appSvc := NewGitHubImportService(nil, nil, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportInstallationTokens(githubImportHInstallationTokens{token: " ghs_installation "}),
		WithGitHubImportReadAccess(&repositoryJobGitHubReadStub{allowed: map[string]bool{"7/octo/demo": true}}),
	)
	cloneToken, private, _, err := appSvc.githubCloneInfoForRepo(ctx, 7, "octo", "demo")
	require.NoError(t, err)
	assert.True(t, private)
	assert.Equal(t, "ghs_installation", cloneToken)

	api = githubImportHAPI(t, http.StatusOK, "not-json")
	_, _, _, err = NewGitHubImportService(nil, nil, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test", WithGitHubImportHTTPClient(api.Client())).fetchGitHubRepoMetadata(ctx, "", "octo", "demo")
	require.Contains(t, err.Error(), "decode")

	t.Setenv(envGitHubAppAPIBaseURL, "http://[::1")
	_, _, _, err = (&GitHubImportService{httpClient: http.DefaultClient}).fetchGitHubRepoMetadata(ctx, "", "octo", "demo")
	require.Contains(t, err.Error(), "build github repository request")

	_, err = (&GitHubImportService{}).refreshUserGitHubToken(ctx, db.OauthAccount{})
	require.Contains(t, err.Error(), "github oauth token was rejected")

	_, err = (&GitHubImportService{refresher: &fakeGitHubTokenRefresher{newToken: " "}}).refreshUserGitHubToken(ctx, db.OauthAccount{})
	require.Contains(t, err.Error(), "github oauth token was rejected")

	_, _, err = (&GitHubImportService{tokenDB: githubImportHTokenDB{listErr: assert.AnError}, decrypter: githubImportHDecrypter{}}).loadGitHubOAuthToken(ctx, 7)
	require.ErrorContains(t, err, "load github oauth account")

	_, _, err = (&GitHubImportService{tokenDB: githubImportHTokenDB{accounts: []db.OauthAccount{{Provider: "github"}}}, decrypter: githubImportHDecrypter{err: assert.AnError}}).loadGitHubOAuthToken(ctx, 7)
	require.Error(t, err)

	token, account, err := (&GitHubImportService{tokenDB: githubImportHTokenDB{accounts: []db.OauthAccount{{Provider: "workos"}}}, decrypter: githubImportHDecrypter{token: " workos-token "}}).loadGitHubOAuthToken(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, "workos-token", token)
	assert.Equal(t, "workos", account.Provider)

	_, _, err = (&GitHubImportService{tokenDB: githubImportHTokenDB{accounts: []db.OauthAccount{{Provider: "workos"}}}, decrypter: githubImportHDecrypter{err: assert.AnError}}).loadGitHubOAuthToken(ctx, 7)
	require.Error(t, err)
}

func TestGitHubImport_H_CloneAndPushMirrorWithFakeGit(t *testing.T) {
	ctx := context.Background()
	metrics := &githubImportHMetrics{}
	dbase := &githubImportHDB{}
	var cloneEnv, pushEnv, cloneArgs []string
	svc := &GitHubImportService{db: dbase, metrics: metrics}
	svc.runGit = func(_ context.Context, env []string, args ...string) (string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "clone --mirror"):
			cloneEnv = env
			cloneArgs = append([]string(nil), args...)
			localMirror := args[len(args)-1]
			return "", exec.Command("git", "init", "--bare", localMirror).Run()
		case strings.Contains(joined, "push --mirror"):
			pushEnv = env
			return "", nil
		default:
			return "", nil
		}
	}

	err := svc.cloneAndPushMirror(ctx, "octo", "demo", "source-token", "https://plue.test/alice/demo.git", "push-token", "job")
	require.NoError(t, err)
	assert.NotEmpty(t, cloneEnv)
	assert.Contains(t, cloneEnv, "GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader")
	assert.Contains(t, cloneEnv, "GIT_CONFIG_VALUE_0=Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:source-token")))
	assert.Contains(t, cloneArgs, "https://github.com/octo/demo.git")
	assert.NotContains(t, strings.Join(cloneArgs, " "), "source-token", "source token must never appear in argv or the clone URL")
	assert.NotEmpty(t, pushEnv)
	assert.Contains(t, pushEnv, "GIT_CONFIG_VALUE_0=Authorization: Bearer push-token")
	assert.NotEmpty(t, metrics.bytes)
	assert.Contains(t, dbase.stages, importStagePushingMirror)

	err = (&GitHubImportService{runGit: func(context.Context, []string, ...string) (string, error) {
		return "clone output", assert.AnError
	}}).cloneAndPushMirror(ctx, "octo", "demo", "", "https://plue.test/alice/demo.git", "push-token", "job")
	require.ErrorContains(t, err, "clone github repo")

	err = (&GitHubImportService{runGit: func(context.Context, []string, ...string) (string, error) {
		return "", nil
	}}).cloneAndPushMirror(ctx, "octo", "demo", "", "https://plue.test/alice/demo.git", " ", "job")
	require.ErrorContains(t, err, "push token is required")

	err = (&GitHubImportService{runGit: func(_ context.Context, _ []string, args ...string) (string, error) {
		if len(args) > 0 && args[0] == "--git-dir" {
			return "push output", assert.AnError
		}
		return "", nil
	}}).cloneAndPushMirror(ctx, "octo", "demo", "", "https://plue.test/alice/demo.git", "push-token", "job")
	require.ErrorContains(t, err, "push mirrored refs")

	_, err = gitMirrorObjectBytes(ctx, "/path/that/does/not/exist")
	require.Error(t, err)
}

func TestGitHubImport_H_ObserveFailureNilError(t *testing.T) {
	metrics := &githubImportHMetrics{}
	(&GitHubImportService{metrics: metrics}).observeFailure("stage", nil)
	assert.Equal(t, []string{"stage:error"}, metrics.failures)
}

func (h *githubImportHRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
