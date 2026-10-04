package services

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	createImportJobSQL = `
INSERT INTO import_jobs (id, user_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cloning')
ON CONFLICT (user_id, LOWER(github_owner), LOWER(github_repo))
WHERE status = 'cloning'
DO UPDATE SET github_owner = import_jobs.github_owner
RETURNING id, user_id, repository_id, workspace_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status, stage,
          refs_done, refs_total, objects_done, objects_total, issues_done, issues_total,
          error, created_at, updated_at,
          import_jobs.id = $1 AS created;
`
	getImportJobSQL = `
SELECT id, user_id, repository_id, workspace_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status, stage,
       refs_done, refs_total, objects_done, objects_total, issues_done, issues_total,
       error, created_at, updated_at
FROM import_jobs
WHERE id = $1 AND user_id = $2;
`
	markImportJobReadySQL = `
UPDATE import_jobs
SET repository_id = $2, workspace_id = NULLIF($3::text, '')::uuid, target_bookmark = $4, repo_name = $5, status = 'ready', error = '', updated_at = NOW()
WHERE id = $1
RETURNING id, user_id, repository_id, workspace_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status, stage,
          refs_done, refs_total, objects_done, objects_total, issues_done, issues_total,
          error, created_at, updated_at;
`
	markImportJobFailedSQL = `
UPDATE import_jobs
SET status = 'failed', error = $2, updated_at = NOW()
WHERE id = $1
RETURNING id, user_id, repository_id, workspace_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status, stage,
          refs_done, refs_total, objects_done, objects_total, issues_done, issues_total,
          error, created_at, updated_at;
`
	setImportJobStageSQL = `
UPDATE import_jobs
SET stage = $2, updated_at = NOW()
WHERE id = $1
RETURNING id;
`
	setImportJobProgressSQL = `
UPDATE import_jobs
SET refs_done = $2, refs_total = $3,
    objects_done = $4, objects_total = $5,
    issues_done = $6, issues_total = $7,
    updated_at = NOW()
WHERE id = $1
RETURNING id;
`
	retryImportJobSQL = `
UPDATE import_jobs
SET status = 'cloning', error = '', attempts = 0, available_at = NOW(),
    claim_token = NULL, claimed_at = NULL,
    provisioning_repository_id = CASE WHEN repository_id IS NULL THEN NULL ELSE provisioning_repository_id END,
    provisioning_token = CASE WHEN repository_id IS NULL THEN NULL ELSE provisioning_token END,
    updated_at = NOW()
WHERE id = $1 AND user_id = $2 AND status = 'failed'
RETURNING id, user_id, repository_id, workspace_id, github_owner, github_repo, repo_owner, repo_name, branch, target_bookmark, status, stage,
          refs_done, refs_total, objects_done, objects_total, issues_done, issues_total,
          error, created_at, updated_at;
`
	claimImportJobSQL = `
WITH candidate AS (
    SELECT id
    FROM import_jobs
    WHERE status = 'cloning'
      AND available_at <= NOW()
      AND (claim_token IS NULL OR claimed_at <= NOW() - make_interval(secs => $1::int))
    ORDER BY available_at, created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE import_jobs AS job
SET claim_token = $2, claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
FROM candidate
WHERE job.id = candidate.id
RETURNING job.id, job.user_id, job.repository_id, job.workspace_id,
          job.github_owner, job.github_repo, job.repo_owner, job.repo_name,
          job.branch, job.target_bookmark, job.stage, job.error,
	          job.provisioning_repository_id, job.provisioning_token, job.attempts;
`
	renewImportJobClaimSQL = `
UPDATE import_jobs
SET claimed_at = NOW(), updated_at = NOW()
WHERE id = $1 AND status = 'cloning' AND claim_token = $2
RETURNING id;
`
	releaseImportJobClaimSQL = `
UPDATE import_jobs
SET claim_token = NULL, claimed_at = NULL, error = $3,
    available_at = NOW() + make_interval(secs => $4::int), updated_at = NOW()
WHERE id = $1 AND status = 'cloning' AND claim_token = $2
RETURNING id;
`
	markClaimedImportJobReadySQL = `
UPDATE import_jobs
SET repository_id = $3, workspace_id = NULLIF($4::text, '')::uuid, target_bookmark = $5,
    repo_name = $6, status = 'ready', stage = '', error = '',
    claim_token = NULL, claimed_at = NULL, updated_at = NOW()
WHERE id = $1 AND status = 'cloning' AND claim_token = $2
	  AND (
	      provisioning_repository_id = $3
	      OR (provisioning_repository_id IS NULL AND provisioning_token IS NULL)
	  )
RETURNING id, user_id, repository_id, workspace_id, github_owner, github_repo,
          repo_owner, repo_name, branch, target_bookmark, status, stage,
          refs_done, refs_total, objects_done, objects_total, issues_done, issues_total, error,
	          created_at, updated_at;
`
	markClaimedImportJobFailedSQL = `
UPDATE import_jobs
SET status = 'failed', error = $3,
    claim_token = NULL, claimed_at = NULL, updated_at = NOW()
WHERE id = $1 AND status = 'cloning' AND claim_token = $2
RETURNING id, user_id, repository_id, workspace_id, github_owner, github_repo,
          repo_owner, repo_name, branch, target_bookmark, status, stage,
          refs_done, refs_total, objects_done, objects_total, issues_done, issues_total, error,
          created_at, updated_at;
`
	// importJobProvenanceSQL proves an existing local repo is the mirror of the
	// requested GitHub source. Ready jobs are definitive. A terminally failed job
	// is also definitive only when its durable provisioning ID/token still binds
	// the exact published repository; legacy and pre-publication failures remain
	// untrusted. This is the primary reuse signal (see
	// mirrorProvenanceMatches / ensureLocalRepo).
	importJobProvenanceSQL = `
SELECT EXISTS (
    SELECT 1 FROM import_jobs
    WHERE user_id = $1
      AND lower(github_owner) = lower($2)
      AND lower(github_repo) = lower($3)
      AND repository_id = $4
      AND (
          status = 'ready'
          OR (
              status = 'failed'
              AND provisioning_repository_id = repository_id
              AND provisioning_token IS NOT NULL
          )
      )
);
`
)

// Import progress stages, written at each runImport boundary and streamed to
// clients through the import-job SSE poll. Multi's toast maps these exact
// strings to human text — keep them in sync with importStageDetail there.
const (
	importStageResolving             = "resolving"
	importStageCreatingRepo          = "creating_repo"
	importStageCloningGitHub         = "cloning_github"
	importStagePushingMirror         = "pushing_mirror"
	importStageImportingRefs         = "importing_refs"
	importStageCreatingBookmark      = "creating_bookmark"
	importStageProvisioningWorkspace = "provisioning_workspace"

	githubImportClaimLease   = 15 * time.Minute
	githubImportRetryDelay   = 15 * time.Second
	githubImportPollInterval = 5 * time.Second
	githubImportMaxAttempts  = 20
)

var errGitHubImportCandidateOccupied = errors.New("github import mirror candidate occupied")

type terminalGitHubImportError struct{ error }

type claimedGitHubImportJob struct {
	ID                       string
	UserID                   int64
	RepositoryID             pgtype.Int8
	WorkspaceID              pgtype.UUID
	GitHubOwner              string
	GitHubRepo               string
	RepoOwner                string
	RepoName                 string
	Branch                   string
	TargetBookmark           string
	Stage                    string
	Error                    string
	ProvisioningRepositoryID pgtype.Int8
	ProvisioningToken        pgtype.Text
	ClaimToken               string
	Attempts                 int32
}

type GitHubImportDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type GitHubImportRepoDB interface {
	CreateRepo(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error)
	DeleteRepo(ctx context.Context, id int64) error
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
}

// GitHubImportOrgDB resolves organization namespaces for imports. Organizations
// are not a feature flag: when the GitHub source owner names an organization
// that exists on this deployment, the mirror belongs in that organization's
// namespace and the importing user must be a member of it.
type GitHubImportOrgDB interface {
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	CreateOrgRepo(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error)
}

type GitHubImportTokenDB interface {
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
	ListUserOAuthAccounts(ctx context.Context, userID int64) ([]db.OauthAccount, error)
}

type GitHubImportRepoHost interface {
	InitRepo(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error
	DeleteRepo(ctx context.Context, owner, repo string) error
	ImportRefs(ctx context.Context, owner, repo string) error
	GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error)
	CreateBookmark(ctx context.Context, owner, repo string, req repohost.CreateBookmarkRequest) (repohost.Bookmark, error)
}

type gitHubImportStagedRepoHost interface {
	GitHubImportRepoHost
	PrepareStagedImport(context.Context, string, string, string, string) (repohost.StagedProvision, error)
	ExecuteStagedProvision(context.Context, repohost.StagedProvision) error
	StagedProvisionGitEndpoint(context.Context, repohost.StagedProvision) (string, string, error)
	PublishStagedProvision(context.Context, repohost.StagedProvision) error
	FinalizeStagedProvision(context.Context, repohost.StagedProvision) error
	AbortStagedProvision(context.Context, repohost.StagedProvision) error
}

// gitHubImportStagedGitHeaders supplies the headers a staged import's mirror
// push must carry: the destination owner's storage allowance
// (smithersai/plue#768).
type gitHubImportStagedGitHeaders interface {
	StagedProvisionGitHeaders(context.Context, repohost.StagedProvision) (http.Header, error)
}

var _ gitHubImportStagedGitHeaders = (*repohost.Client)(nil)

type GitHubImportWorkspaceProvisioner interface {
	CreateWorkspaceAsync(ctx context.Context, input CreateWorkspaceInput) (WorkspaceResponse, error)
}

type GitHubImportMetrics interface {
	ObserveMirrorAttempt(result string)
	ObserveMirrorFailure(stage, reason string)
	ObserveMirrorDuration(phase string, seconds float64)
	ObserveMirrorCloneBytes(bytes float64)
	ObserveMirrorCloneDuration(seconds float64)
	ObserveBranchCreate(result string)
}

// GitHubImportInstallationTokenIssuer mints a GitHub App installation token
// scoped to a repository the importing user has connected.
type GitHubImportInstallationTokenIssuer interface {
	CreateGitHubInstallationToken(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error)
}

type GitHubImportService struct {
	db           GitHubImportDB
	repoDB       GitHubImportRepoDB
	orgs         GitHubImportOrgDB
	tokenDB      GitHubImportTokenDB
	repoHost     GitHubImportRepoHost
	workspaces   GitHubImportWorkspaceProvisioner
	decrypter    OAuthAccessTokenDecrypter
	refresher    GitHubUserTokenRefresher
	appTokens    GitHubImportInstallationTokenIssuer
	readAccess   RepositoryJobGitHubReadAccess
	httpClient   *http.Client
	gitBaseURL   string
	metrics      GitHubImportMetrics
	billing      BillingPolicy
	storageSetID string
	asyncTimeout time.Duration
	// refreshCooldown is the per-mirror window between GitHub clones (#2970).
	refreshCooldown time.Duration
	cloneMirror     func(ctx context.Context, owner, repo, sourceToken, pushURL, pushToken, jobID string) error
	runGit          func(ctx context.Context, env []string, args ...string) (string, error)
	mkdirTemp       func(dir, pattern string) (string, error)
	// provenanceMatches reports whether an existing local repo is provably the
	// mirror of the requested GitHub source: a ready import job or a failed job
	// with the exact durable published binding for this user + github source.
	// When true the import must REUSE the mirror (skip clone/import refs) instead
	// of returning the #47 conflict. Injectable for unit tests via
	// withGitHubImportProvenance (the service is often built with a nil db).
	provenanceMatches func(ctx context.Context, userID int64, githubOwner, githubRepo string, repositoryID int64) (bool, error)
	pool              *pgxpool.Pool
	provisioning      githubImportProvisioningStore
	stagedRepoHost    gitHubImportStagedRepoHost
	wakeDurable       chan struct{}
	durableEnabled    bool
	// syncedRepos enrolls imported GitHub sources into the sync registry so the
	// metadata proxy and github-sync keep them fresh. Optional.
	syncedRepos *GitHubSyncedRepoService
}

// githubImportProvisioningStore is the durable reservation boundary used by
// the same import worker in local and clustered deployments. The local store
// persists its reservation on import_jobs; Plue's store uses its cluster
// provisioning journal. Neither path changes the job's public receipts.
type githubImportProvisioningStore interface {
	Reserve(context.Context, repositoryProvisioningOperation) (repositoryProvisioningOperation, error)
	GetByToken(context.Context, string) (repositoryProvisioningOperation, error)
	AcquireProcessing(context.Context, int64, string, string) error
	GetPublished(context.Context, repositoryProvisioningOperation) (db.Repository, bool, error)
	MarkPublishReady(context.Context, int64, string, string) error
	RenewClaim(context.Context, int64, string, string) error
	Publish(context.Context, repositoryProvisioningOperation, string) (db.Repository, error)
	Complete(context.Context, int64, string, string) error
	Abort(context.Context, repositoryProvisioningOperation, string, func(context.Context) error) error
	ReleaseClaim(context.Context, repositoryProvisioningOperation, string, error)
}

// WithGitHubImportProvisioningStore supplies the deployment's journal to the
// canonical import worker. Local composition selects its product store instead.
func WithGitHubImportProvisioningStore(store RepositoryProvisioningStore) GitHubImportOption {
	return func(s *GitHubImportService) { s.provisioning = store }
}

// WithGitHubImportOrgs wires organization lookups into the import path so an
// org-owned GitHub repository mirrors into that organization's namespace.
// Without it the service only knows user namespaces.
func WithGitHubImportOrgs(orgs GitHubImportOrgDB) GitHubImportOption {
	return func(s *GitHubImportService) { s.orgs = orgs }
}

// WithGitHubImportSyncedRepos wires the sync registry, so every completed import
// enrolls its GitHub source for continuous metadata + ref sync.
func WithGitHubImportSyncedRepos(syncedRepos *GitHubSyncedRepoService) GitHubImportOption {
	return func(s *GitHubImportService) { s.syncedRepos = syncedRepos }
}

// EnableDurableWorker is called once during startup only after the database
// insert fence is contracted. Until then new binaries must not race legacy
// detached import goroutines from old pods.
func (s *GitHubImportService) EnableDurableWorker() {
	if s != nil && s.provisioning != nil && s.stagedRepoHost != nil {
		s.durableEnabled = true
	}
}

type GitHubImportOption func(*GitHubImportService)

func WithGitHubImportMetrics(metrics GitHubImportMetrics) GitHubImportOption {
	return func(s *GitHubImportService) { s.metrics = metrics }
}

// WithGitHubImportBillingPolicy applies the same committed private-repository
// admission used by normal create and fork paths to imported mirror repos.
func WithGitHubImportBillingPolicy(policy BillingPolicy) GitHubImportOption {
	return func(s *GitHubImportService) { s.billing = policy }
}

// WithGitHubImportStorageSet places newly imported repositories on the same
// active storage set used by ordinary repository creation. Without this
// option imports would remain pinned to s1 after a deployment moves new
// repository placement to another storage set.
func WithGitHubImportStorageSet(storageSetID string) GitHubImportOption {
	return func(s *GitHubImportService) {
		if normalized := strings.TrimSpace(storageSetID); normalized != "" {
			s.storageSetID = normalized
		}
	}
}

// WithGitHubImportGitRunner exposes the existing native Git seam to composed
// integration fixtures; nil retains the production command and its policy.
func WithGitHubImportGitRunner(run func(context.Context, []string, ...string) (string, error)) GitHubImportOption {
	return func(s *GitHubImportService) {
		if run != nil {
			s.runGit = run
		}
	}
}

// RunGitImportCommand retains the one policy-enforcing native implementation.
func RunGitImportCommand(ctx context.Context, env []string, args ...string) (string, error) {
	return runGitCombinedOutput(ctx, env, args...)
}

func WithGitHubImportHTTPClient(client *http.Client) GitHubImportOption {
	return func(s *GitHubImportService) {
		if client != nil {
			s.httpClient = client
		}
	}
}

func WithGitHubImportWorkspaceProvisioner(workspaces GitHubImportWorkspaceProvisioner) GitHubImportOption {
	return func(s *GitHubImportService) { s.workspaces = workspaces }
}

// WithGitHubImportTokenRefresher wires the reactive refresh-on-401 capability so
// an expired GitHub user token is renewed and retried during a private-repo
// import. Without it a rejected token surfaces as an honest 401 as before.
func WithGitHubImportTokenRefresher(refresher GitHubUserTokenRefresher) GitHubImportOption {
	return func(s *GitHubImportService) { s.refresher = refresher }
}

// WithGitHubImportInstallationTokens lets imports prefer short-lived GitHub App
// credentials over a user's OAuth token when the repository is connected.
func WithGitHubImportInstallationTokens(issuer GitHubImportInstallationTokenIssuer) GitHubImportOption {
	return func(s *GitHubImportService) { s.appTokens = issuer }
}

// WithGitHubImportReadAccess wires the proof that the importer's own GitHub
// credential still reads a private source. An installation token reads every
// repo the App is installed on, so it cannot answer that. Without it, a private
// source reached through an installation token fails closed.
func WithGitHubImportReadAccess(access RepositoryJobGitHubReadAccess) GitHubImportOption {
	return func(s *GitHubImportService) { s.readAccess = access }
}

func withGitHubImportCloneMirror(fn func(ctx context.Context, owner, repo, sourceToken, pushURL, pushToken, jobID string) error) GitHubImportOption {
	return func(s *GitHubImportService) { s.cloneMirror = fn }
}

// withGitHubImportProvenance injects the mirror-provenance check so the reuse
// path is unit-testable without a live import_jobs table.
func withGitHubImportProvenance(fn func(ctx context.Context, userID int64, githubOwner, githubRepo string, repositoryID int64) (bool, error)) GitHubImportOption {
	return func(s *GitHubImportService) { s.provenanceMatches = fn }
}

func NewGitHubImportService(db GitHubImportDB, repoDB GitHubImportRepoDB, tokenDB GitHubImportTokenDB, repoHost GitHubImportRepoHost, decrypter OAuthAccessTokenDecrypter, gitBaseURL string, opts ...GitHubImportOption) *GitHubImportService {
	s := &GitHubImportService{
		db:              db,
		repoDB:          repoDB,
		tokenDB:         tokenDB,
		repoHost:        repoHost,
		decrypter:       decrypter,
		httpClient:      observability.NewHTTPClient(15 * time.Second),
		gitBaseURL:      gitBaseURL,
		storageSetID:    DefaultStorageSetID,
		asyncTimeout:    10 * time.Minute,
		refreshCooldown: githubMirrorRefreshCooldown(),
		runGit:          runGitCombinedOutput,
		mkdirTemp:       os.MkdirTemp,
	}
	s.cloneMirror = s.cloneAndPushMirror
	s.provenanceMatches = s.importJobProvenanceMatches
	if pool, ok := db.(*pgxpool.Pool); ok && pool != nil {
		if staged, stagedOK := repoHost.(gitHubImportStagedRepoHost); stagedOK {
			s.pool = pool
			s.stagedRepoHost = staged
			s.wakeDurable = make(chan struct{}, 1)
		}
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

type ImportJob struct {
	ImportJobID    string               `json:"importJobId"`
	RepoOwner      string               `json:"repoOwner"`
	RepoName       string               `json:"repoName"`
	TargetBookmark string               `json:"target_bookmark"`
	WorkspaceID    string               `json:"workspace_id,omitempty"`
	Workspace      *WorkspaceResponse   `json:"workspace,omitempty"`
	Status         string               `json:"status"`
	Stage          string               `json:"stage"`
	Counts         ImportJobCounts      `json:"counts"`
	Error          string               `json:"error,omitempty"`
	Repository     *ImportJobRepository `json:"repository,omitempty"`
	CreatedAt      time.Time            `json:"created_at"`
	UpdatedAt      time.Time            `json:"updated_at"`
	userID         int64
	githubOwner    string
	githubRepo     string
	branch         string
}

type ImportJobCount struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

type ImportJobCounts struct {
	Refs    ImportJobCount `json:"refs"`
	Objects ImportJobCount `json:"objects"`
	Issues  ImportJobCount `json:"issues"`
}

type ImportJobRepository struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

type ImportGitHubRepoInput struct {
	UserID int64
	Owner  string
	Repo   string
	Branch string
}

type ImportTemplateRepoInput struct {
	UserID     int64
	TemplateID string
	Name       string
}

type templateSeed struct {
	Owner string
	Repo  string
}

var templateSeedRegistry = map[string]templateSeed{
	"vite-react":       {Owner: "smithersai", Repo: "template-vite-react"},
	"ts-lib":           {Owner: "smithersai", Repo: "template-ts-lib"},
	"incur-cli":        {Owner: "smithersai", Repo: "template-incur-cli"},
	"smithers-product": {Owner: "smithersai", Repo: "template-smithers-product"},
}

func (s *GitHubImportService) StartImport(ctx context.Context, input ImportGitHubRepoInput) (ImportJob, error) {
	return s.startImport(ctx, input, "")
}

// StartTemplateImport resolves a fixed seed and queues it through the existing
// GitHub import worker. repo_name is the requested destination while the
// github_owner/github_repo columns retain the seed source coordinates.
func (s *GitHubImportService) StartTemplateImport(ctx context.Context, input ImportTemplateRepoInput) (ImportJob, error) {
	if input.UserID <= 0 {
		return ImportJob{}, pkgerrors.Unauthorized("authentication required")
	}
	templateID := strings.TrimSpace(input.TemplateID)
	seed, ok := templateSeedRegistry[templateID]
	if !ok {
		return ImportJob{}, pkgerrors.NotFound("template not found")
	}
	name := strings.TrimSpace(input.Name)
	if err := validateRepoName(name); err != nil {
		return ImportJob{}, err
	}
	if s == nil || s.db == nil || s.repoDB == nil {
		return ImportJob{}, pkgerrors.Internal("github import service unavailable")
	}
	localOwner, err := s.resolveLocalOwner(ctx, input.UserID)
	if err != nil {
		return ImportJob{}, pkgerrors.Internal("resolve import owner: " + err.Error())
	}
	_, err = s.repoDB.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner: localOwner, LowerName: strings.ToLower(name),
	})
	if err == nil {
		return ImportJob{}, pkgerrors.Conflict(fmt.Sprintf("repository '%s' already exists", name))
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ImportJob{}, pkgerrors.Internal("check template repository name: " + err.Error())
	}
	return s.startImport(ctx, ImportGitHubRepoInput{
		UserID: input.UserID, Owner: seed.Owner, Repo: seed.Repo, Branch: "main",
	}, name)
}

func (s *GitHubImportService) startImport(ctx context.Context, input ImportGitHubRepoInput, targetName string) (ImportJob, error) {
	if s == nil || s.db == nil || s.repoDB == nil || s.tokenDB == nil || s.repoHost == nil || s.decrypter == nil {
		return ImportJob{}, pkgerrors.Internal("github import service unavailable")
	}
	if input.UserID <= 0 {
		return ImportJob{}, pkgerrors.Unauthorized("authentication required")
	}
	if s.stagedRepoHost != nil && (s.provisioning == nil || !s.durableEnabled) {
		return ImportJob{}, &pkgerrors.APIError{
			Status: http.StatusServiceUnavailable, Code: pkgerrors.CodeRepositoryProvisioningRollout,
			Message: "repository imports are temporarily unavailable during a provisioning rollout",
		}
	}
	owner, repo, err := normalizeRepoRef(input.Owner, input.Repo)
	if err != nil {
		return ImportJob{}, err
	}
	// repo_owner is the local namespace slug, NOT the github source owner:
	// every repo-host op and the storage-set resolver key on it. It is the
	// organization when the source owner names an organization on this
	// deployment, and the importing user otherwise.
	importedOwner, err := s.resolveImportOwner(ctx, input.UserID, owner, repo)
	if err != nil {
		return ImportJob{}, err
	}
	localOwner := importedOwner.Name
	if targetName == "" {
		targetName = repo
	}
	branch := strings.TrimSpace(input.Branch)
	if branch == "" {
		branch = "main"
	}
	if err := repohost.ValidateBookmarkName(branch); err != nil {
		return ImportJob{}, pkgerrors.BadRequest("invalid target bookmark: " + err.Error())
	}
	id := uuid.New().String()
	job, created, err := s.scanStartedImportJob(s.db.QueryRow(ctx, createImportJobSQL, id, input.UserID, owner, repo, localOwner, targetName, branch, branch))
	if err != nil {
		return ImportJob{}, pkgerrors.Internal("create import job: " + err.Error())
	}
	if !created {
		if !strings.EqualFold(job.RepoName, targetName) {
			return ImportJob{}, pkgerrors.Conflict("this template seed is already being imported to a different repository")
		}
		if job.TargetBookmark != branch {
			return ImportJob{}, &pkgerrors.APIError{
				Status:  http.StatusConflict,
				Code:    pkgerrors.CodeGitHubImportAlreadyActive,
				Message: "this GitHub repository is already being imported with a different target bookmark",
			}
		}
		return job, nil
	}

	if s.provisioning != nil && s.stagedRepoHost != nil {
		s.wakeDurableWorker()
	} else {
		// Compatibility seam for unit/alternate constructors without a pool.
		// Production always takes the durable claimed worker path above.
		go s.runImportDetached(id, input.UserID, owner, repo, localOwner, targetName, branch)
	}
	return job, nil
}

func (s *GitHubImportService) wakeDurableWorker() {
	if s == nil || s.wakeDurable == nil {
		return
	}
	select {
	case s.wakeDurable <- struct{}{}:
	default:
	}
}

// Start resumes durable import jobs after process restarts. It claims one job
// at a time so leases cannot expire in a batch before later items begin.
func (s *GitHubImportService) Start(ctx context.Context) {
	if s == nil || !s.durableEnabled || s.provisioning == nil || s.stagedRepoHost == nil || s.pool == nil {
		return
	}
	ticker := time.NewTicker(githubImportPollInterval)
	defer ticker.Stop()
	for {
		processed, err := s.processOneDurableImport(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("mirror.import.reconcile_failed", "error", err)
		}
		if processed {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.wakeDurable:
		}
	}
}

func (s *GitHubImportService) processOneDurableImport(ctx context.Context) (processed bool, retErr error) {
	claimToken := newRepositoryProvisionClaimToken()
	job, found, err := s.claimDurableImport(ctx, claimToken)
	if err != nil || !found {
		return false, err
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			panicErr := fmt.Errorf("durable github import panicked: %v", recovered)
			slog.Error("mirror.import.durable_panic", "import_job_id", job.ID,
				"panic", recovered, "stack", string(debug.Stack()))
			processed = true
			retErr = s.handleDurableImportFailure(job, panicErr)
		}
	}()
	processCtx, cancel := context.WithTimeout(ctx, s.asyncTimeout)
	defer cancel()
	if err := s.runDurableImport(processCtx, &job); err != nil {
		return true, s.handleDurableImportFailure(job, err)
	}
	return true, nil
}

func (s *GitHubImportService) handleDurableImportFailure(job claimedGitHubImportJob, processErr error) error {
	if isTerminalGitHubImportFailure(processErr) || job.Attempts >= githubImportMaxAttempts {
		terminalCtx, terminalCancel := context.WithTimeout(context.Background(), repoHostMutationConsistencyTimeout)
		terminalErr := s.terminalizeDurableImport(terminalCtx, job, processErr)
		terminalCancel()
		if terminalErr == nil {
			return nil
		}
		processErr = fmt.Errorf("%w (terminal cleanup remains retryable: %v)", processErr, terminalErr)
	}
	releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer releaseCancel()
	if err := s.releaseDurableImportClaim(releaseCtx, job, processErr); err != nil {
		return fmt.Errorf("process import job %s: %w (release claim: %v)", job.ID, processErr, err)
	}
	return fmt.Errorf("process import job %s: %w", job.ID, processErr)
}

func isTerminalGitHubImportFailure(err error) bool {
	var terminal terminalGitHubImportError
	if errors.As(err, &terminal) {
		return true
	}
	var apiErr *pkgerrors.APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	switch apiErr.Status {
	case http.StatusPaymentRequired:
		// A plan limit needs user action; background retries cannot raise it.
		return apiErr.Code == pkgerrors.CodePlanLimitExceeded
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden,
		http.StatusNotFound, http.StatusConflict, http.StatusUnprocessableEntity:
		return true
	case http.StatusRequestEntityTooLarge:
		// The pre-clone size budget: a repository over the limit is over it on
		// every attempt, so retrying only delays the answer. facebook/react was
		// retried 53 times across 13 hours before the user was told it is 1041
		// MB against a 1024 MB limit — the card sat RUNNING throughout (repro
		// apps/ui/canary-repros/github/12.2).
		return true
	case http.StatusTooManyRequests:
		return apiErr.Code == pkgerrors.CodeQuotaExceeded
	default:
		return false
	}
}

func (s *GitHubImportService) claimDurableImport(
	ctx context.Context,
	claimToken string,
) (claimedGitHubImportJob, bool, error) {
	var job claimedGitHubImportJob
	err := s.pool.QueryRow(ctx, claimImportJobSQL,
		durationSeconds(githubImportClaimLease), claimToken,
	).Scan(
		&job.ID, &job.UserID, &job.RepositoryID, &job.WorkspaceID,
		&job.GitHubOwner, &job.GitHubRepo, &job.RepoOwner, &job.RepoName,
		&job.Branch, &job.TargetBookmark, &job.Stage, &job.Error,
		&job.ProvisioningRepositoryID, &job.ProvisioningToken, &job.Attempts,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimedGitHubImportJob{}, false, nil
	}
	if err != nil {
		return claimedGitHubImportJob{}, false, fmt.Errorf("claim durable github import: %w", err)
	}
	job.ClaimToken = claimToken
	return job, true, nil
}

func (s *GitHubImportService) renewDurableImportClaim(ctx context.Context, job claimedGitHubImportJob) error {
	var id string
	if err := s.pool.QueryRow(ctx, renewImportJobClaimSQL, job.ID, job.ClaimToken).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errRepositoryProvisionInProgress
		}
		return fmt.Errorf("renew github import claim: %w", err)
	}
	return nil
}

func (s *GitHubImportService) releaseDurableImportClaim(
	ctx context.Context,
	job claimedGitHubImportJob,
	processErr error,
) error {
	message := strings.TrimSpace(processErr.Error())
	if len(message) > 4096 {
		message = message[:4096]
	}
	var id string
	if err := s.pool.QueryRow(ctx, releaseImportJobClaimSQL, job.ID, job.ClaimToken,
		message, githubImportRetryDelaySeconds(processErr)).Scan(&id); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("release github import claim: %w", err)
	}
	return nil
}

// githubImportRetryDelaySeconds preserves provider backoff across the durable
// worker boundary. Returning a claimed job to the queue earlier than the
// upstream Retry-After deadline creates a hot retry loop that burns attempts
// without giving GitHub time to recover.
func githubImportRetryDelaySeconds(processErr error) int32 {
	delay := durationSeconds(githubImportRetryDelay)
	var apiErr *pkgerrors.APIError
	if !errors.As(processErr, &apiErr) || apiErr.RetryAfter <= int(delay) {
		return delay
	}
	const maxInt32 = int64(^uint32(0) >> 1)
	if int64(apiErr.RetryAfter) > maxInt32 {
		return int32(maxInt32)
	}
	return int32(apiErr.RetryAfter)
}

// terminalizeDurableImport fails a permanently-invalid or exhausted job only
// after any unpublished token-owned storage has been durably removed. A
// published repository is retained: once visible, compensation would destroy a
// repository the user can already address.
func (s *GitHubImportService) terminalizeDurableImport(
	ctx context.Context,
	job claimedGitHubImportJob,
	processErr error,
) error {
	// Terminal cleanup may follow a full import timeout. Re-establish exclusive
	// job ownership before touching storage, then verify it again before the
	// final state transition so an expired worker can never race a takeover.
	if err := s.renewDurableImportClaim(ctx, job); err != nil {
		return fmt.Errorf("renew terminal import claim: %w", err)
	}
	if job.ProvisioningToken.Valid {
		operation, err := s.provisioning.GetByToken(ctx, job.ProvisioningToken.String)
		if err == nil {
			operation.ImportJobID = job.ID
			operation.ImportJobClaimToken = job.ClaimToken
			if err := s.provisioning.AcquireProcessing(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); err != nil {
				return fmt.Errorf("claim terminal import reservation: %w", err)
			}
			operation.ClaimToken = pgtype.Text{String: job.ClaimToken, Valid: true}
			_, published, inspectErr := s.provisioning.GetPublished(ctx, operation)
			if inspectErr != nil {
				s.provisioning.ReleaseClaim(ctx, operation, job.ClaimToken, inspectErr)
				return inspectErr
			}
			if !published {
				if abortErr := s.provisioning.Abort(ctx, operation, job.ClaimToken, func(abortCtx context.Context) error {
					return s.stagedRepoHost.AbortStagedProvision(abortCtx, operation.staged())
				}); abortErr != nil && !errors.Is(abortErr, errRepositoryProvisionMissing) {
					s.provisioning.ReleaseClaim(ctx, operation, job.ClaimToken, abortErr)
					return fmt.Errorf("abort terminal import reservation: %w", abortErr)
				}
			} else {
				// Publication is irreversible. Settle the repo-host journal and remove
				// the operation fence before failing only the higher-level import job.
				if finalizeErr := s.stagedRepoHost.FinalizeStagedProvision(ctx, operation.staged()); finalizeErr != nil {
					s.provisioning.ReleaseClaim(ctx, operation, job.ClaimToken, finalizeErr)
					return fmt.Errorf("finalize terminal published import: %w", finalizeErr)
				}
				if renewErr := s.provisioning.RenewClaim(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); renewErr != nil {
					return renewErr
				}
				if completeErr := s.provisioning.Complete(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); completeErr != nil &&
					!errors.Is(completeErr, errRepositoryProvisionMissing) {
					return completeErr
				}
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load terminal import reservation: %w", err)
		}
	}
	message := strings.TrimSpace(processErr.Error())
	if len(message) > 4096 {
		message = message[:4096]
	}
	if err := s.renewDurableImportClaim(ctx, job); err != nil {
		return fmt.Errorf("renew terminal import claim before failure: %w", err)
	}
	if _, err := s.scanImportJob(s.pool.QueryRow(
		ctx, markClaimedImportJobFailedSQL, job.ID, job.ClaimToken, message,
	)); err != nil {
		return fmt.Errorf("mark durable github import failed: %w", err)
	}
	return nil
}

func (s *GitHubImportService) runDurableImport(ctx context.Context, job *claimedGitHubImportJob) error {
	if err := s.renewDurableImportClaim(ctx, *job); err != nil {
		return err
	}
	s.setStage(ctx, job.ID, importStageResolving)
	// Publication is the point of no return. Resume all post-publication work
	// from the durable local row before contacting GitHub, so revoked OAuth or an
	// upstream outage cannot strand an already-visible repository.
	if repository, published, err := s.loadDurableImportRepository(ctx, *job); err != nil {
		return err
	} else if published {
		return s.resumeDurablePublishedImport(ctx, job, repository)
	}
	if job.ProvisioningToken.Valid {
		operation, err := s.provisioning.GetByToken(ctx, job.ProvisioningToken.String)
		if err != nil {
			return fmt.Errorf("load bound import reservation: %w", err)
		}
		if err := validateDurableImportOperation(*job, operation); err != nil {
			return err
		}
		if operation.PublishReady {
			return s.resumeDurableReadyImport(ctx, job, operation)
		}
	}

	githubCloneToken, private, defaultBranch, err := s.githubCloneInfoForRepo(
		ctx, job.UserID, job.GitHubOwner, job.GitHubRepo,
	)
	if err != nil {
		return err
	}
	if !private {
		githubCloneToken = ""
	}
	defaultBranch = strings.TrimSpace(defaultBranch)
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	if err := repohost.ValidateBookmarkName(defaultBranch); err != nil {
		return terminalGitHubImportError{pkgerrors.UnprocessableEntity("GitHub default branch cannot be represented as a bookmark")}
	}

	operation, reusedRepository, err := s.reserveDurableImportRepository(ctx, job, defaultBranch)
	if err != nil {
		return err
	}
	if reusedRepository != nil {
		return s.finishDurableReusedImport(ctx, job, *reusedRepository, defaultBranch, githubCloneToken)
	}
	operation.ImportJobID = job.ID
	operation.ImportJobClaimToken = job.ClaimToken
	job.ProvisioningRepositoryID = pgtype.Int8{Int64: operation.RepositoryID, Valid: true}
	job.ProvisioningToken = pgtype.Text{String: operation.Token, Valid: true}
	job.RepoName = operation.Name

	if err := s.provisioning.AcquireProcessing(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); err != nil {
		return err
	}
	operation.ClaimToken = pgtype.Text{String: job.ClaimToken, Valid: true}
	operationSettled := false
	defer func() {
		if operationSettled {
			return
		}
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.provisioning.ReleaseClaim(releaseCtx, operation, job.ClaimToken,
			errors.New("github import provisioning attempt did not settle"))
	}()

	if repository, published, err := s.provisioning.GetPublished(ctx, operation); err != nil {
		return err
	} else if published {
		if err := s.finishDurablePublishedImport(ctx, job, repository, defaultBranch, &operation); err != nil {
			return err
		}
		operationSettled = true
		return nil
	}

	staged := operation.staged()
	if !operation.PublishReady {
		if err := s.stagedRepoHost.ExecuteStagedProvision(ctx, staged); err != nil {
			if isDefinitiveProvisionConflict(err) {
				return terminalGitHubImportError{fmt.Errorf("create hidden import stage: %w", err)}
			}
			return fmt.Errorf("create hidden import stage: %w", err)
		}
		if err := s.renewDurableImportClaims(ctx, *job, operation); err != nil {
			return err
		}
		pushURL, pushCapability, err := s.stagedRepoHost.StagedProvisionGitEndpoint(ctx, staged)
		if err != nil {
			return err
		}
		pushHeaders, err := s.stagedMirrorPushHeaders(ctx, staged)
		if err != nil {
			return err
		}
		if err := s.cloneAndSyncMirror(ctx, "mirror.clone.staged", job.GitHubOwner, job.GitHubRepo,
			githubCloneToken, pushURL, pushCapability, job.ID, mirrorPushArgs, pushHeaders); err != nil {
			return err
		}
		if err := s.renewDurableImportClaims(ctx, *job, operation); err != nil {
			return err
		}
		// For imports this bit means the hidden mirror contents are complete. The
		// generic reconciler excludes imports, so recording it before the physical
		// rename is safe and lets retries skip a second push after a lost response.
		if err := s.provisioning.MarkPublishReady(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); err != nil {
			return err
		}
		operation.PublishReady = true
	}
	if err := s.stagedRepoHost.PublishStagedProvision(ctx, staged); err != nil {
		if isDefinitiveProvisionConflict(err) {
			return terminalGitHubImportError{fmt.Errorf("publish hidden import stage: %w", err)}
		}
		return fmt.Errorf("publish hidden import stage: %w", err)
	}
	if err := s.renewDurableImportClaims(ctx, *job, operation); err != nil {
		return err
	}
	repository, err := s.provisioning.Publish(ctx, operation, job.ClaimToken)
	if err != nil {
		return err
	}
	job.RepositoryID = pgtype.Int8{Int64: repository.ID, Valid: true}
	if err := s.finishDurablePublishedImport(ctx, job, repository, defaultBranch, &operation); err != nil {
		return err
	}
	operationSettled = true
	return nil
}

func validateDurableImportOperation(job claimedGitHubImportJob, operation repositoryProvisioningOperation) error {
	if !job.ProvisioningRepositoryID.Valid || operation.OperationType != repositoryProvisionImport ||
		operation.ActorID != job.UserID || operation.RepositoryID != job.ProvisioningRepositoryID.Int64 ||
		operation.Token != job.ProvisioningToken.String || operation.OwnerName != job.RepoOwner ||
		!strings.EqualFold(operation.Name, job.RepoName) {
		return errRepositoryProvisionMismatch
	}
	return nil
}

// resumeDurableReadyImport handles the crash window after the hidden mirror
// push was durably sealed but before physical/DB publication. No GitHub access
// is needed: publish is idempotent and the operation contains its default ref.
func (s *GitHubImportService) resumeDurableReadyImport(
	ctx context.Context,
	job *claimedGitHubImportJob,
	operation repositoryProvisioningOperation,
) error {
	operation.ImportJobID = job.ID
	operation.ImportJobClaimToken = job.ClaimToken
	if err := s.provisioning.AcquireProcessing(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); err != nil {
		return err
	}
	operation.ClaimToken = pgtype.Text{String: job.ClaimToken, Valid: true}
	settled := false
	defer func() {
		if !settled {
			s.provisioning.ReleaseClaim(context.WithoutCancel(ctx), operation, job.ClaimToken,
				errors.New("ready github import publication did not settle"))
		}
	}()
	if err := s.stagedRepoHost.PublishStagedProvision(ctx, operation.staged()); err != nil {
		if isDefinitiveProvisionConflict(err) {
			return terminalGitHubImportError{fmt.Errorf("publish ready hidden import: %w", err)}
		}
		return fmt.Errorf("publish ready hidden import: %w", err)
	}
	if err := s.renewDurableImportClaims(ctx, *job, operation); err != nil {
		return err
	}
	repository, err := s.provisioning.Publish(ctx, operation, job.ClaimToken)
	if err != nil {
		return err
	}
	job.RepositoryID = pgtype.Int8{Int64: repository.ID, Valid: true}
	if err := s.finishDurablePublishedImport(ctx, job, repository, operation.DefaultBookmark, &operation); err != nil {
		return err
	}
	settled = true
	return nil
}

// resumeDurablePublishedImport finishes a repository whose database row is
// already visible. The operation journal may still exist when the process died
// after DB publication; if so, reclaim it and finalize the repo-host journal.
func (s *GitHubImportService) resumeDurablePublishedImport(
	ctx context.Context,
	job *claimedGitHubImportJob,
	repository db.Repository,
) error {
	defaultBranch := strings.TrimSpace(repository.DefaultBookmark)
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	if job.ProvisioningToken.Valid {
		operation, err := s.provisioning.GetByToken(ctx, job.ProvisioningToken.String)
		if err == nil {
			if operation.RepositoryID != repository.ID || validateDurableImportOperation(*job, operation) != nil ||
				operation.Name != repository.Name {
				return errRepositoryProvisionMismatch
			}
			operation.ImportJobID = job.ID
			operation.ImportJobClaimToken = job.ClaimToken
			if err := s.provisioning.AcquireProcessing(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); err != nil {
				return err
			}
			operation.ClaimToken = pgtype.Text{String: job.ClaimToken, Valid: true}
			settled := false
			defer func() {
				if !settled {
					s.provisioning.ReleaseClaim(context.WithoutCancel(ctx), operation, job.ClaimToken,
						errors.New("published github import completion did not settle"))
				}
			}()
			if err := s.finishDurablePublishedImport(ctx, job, repository, defaultBranch, &operation); err != nil {
				return err
			}
			settled = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load published import reservation: %w", err)
		}
	}
	return s.finishDurablePublishedImport(ctx, job, repository, defaultBranch, nil)
}

func (s *GitHubImportService) finishDurablePublishedImport(
	ctx context.Context,
	job *claimedGitHubImportJob,
	repository db.Repository,
	defaultBranch string,
	operation *repositoryProvisioningOperation,
) error {
	if operation != nil {
		if err := s.renewDurableImportClaims(ctx, *job, *operation); err != nil {
			return err
		}
	} else if err := s.renewDurableImportClaim(ctx, *job); err != nil {
		return err
	}
	// A published import mirror was cloned from GitHub by this job.
	s.recordMirrorCloned(ctx, repository.ID)

	s.setStage(ctx, job.ID, importStageCreatingBookmark)
	exists, err := s.bookmarkExists(ctx, job.RepoOwner, repository.Name, job.Branch)
	if err != nil {
		return err
	}
	if !exists {
		targetChangeID, err := s.importedBookmarkTarget(ctx, job.RepoOwner, repository.Name, defaultBranch)
		if err != nil {
			return err
		}
		if err := runRepoHostMutation(ctx, func(mutationCtx context.Context) error {
			_, mutationErr := s.repoHost.CreateBookmark(mutationCtx, job.RepoOwner, repository.Name,
				repohost.CreateBookmarkRequest{Name: job.Branch, TargetChangeID: targetChangeID, IfAbsent: true})
			return mutationErr
		}); err != nil {
			return fmt.Errorf("create imported bookmark: %w", err)
		}
	}

	s.setStage(ctx, job.ID, importStageProvisioningWorkspace)
	workspace, err := s.createBoundWorkspace(ctx, job.UserID, repository, job.RepoOwner, repository.Name, job.Branch)
	if err != nil {
		return err
	}
	if operation != nil {
		if err := s.renewDurableImportClaims(ctx, *job, *operation); err != nil {
			return err
		}
		if err := s.stagedRepoHost.FinalizeStagedProvision(ctx, operation.staged()); err != nil {
			return fmt.Errorf("finalize imported repository provision: %w", err)
		}
		if err := s.renewDurableImportClaims(ctx, *job, *operation); err != nil {
			return err
		}
		if err := s.provisioning.Complete(ctx, operation.RepositoryID, operation.Token, job.ClaimToken); err != nil &&
			!errors.Is(err, errRepositoryProvisionMissing) {
			return err
		}
	}
	return s.markDurableImportReady(ctx, *job, repository, workspace)
}

func (s *GitHubImportService) finishDurableReusedImport(
	ctx context.Context,
	job *claimedGitHubImportJob,
	repository db.Repository,
	defaultBranch string,
	githubCloneToken string,
) error {
	if err := s.renewDurableImportClaim(ctx, *job); err != nil {
		return err
	}
	repository, workspace, err := s.finishReusedImport(
		ctx, job.UserID, job.GitHubOwner, job.RepoOwner, job.GitHubRepo,
		job.Branch, defaultBranch, job.ID, githubCloneToken, repository,
	)
	if err != nil {
		return err
	}
	if err := s.renewDurableImportClaim(ctx, *job); err != nil {
		return err
	}
	return s.markDurableImportReady(ctx, *job, repository, workspace)
}

func (s *GitHubImportService) markDurableImportReady(
	ctx context.Context,
	job claimedGitHubImportJob,
	repository db.Repository,
	workspace WorkspaceResponse,
) error {
	_, err := s.scanImportJob(s.pool.QueryRow(ctx, markClaimedImportJobReadySQL,
		job.ID, job.ClaimToken, repository.ID, workspace.ID,
		workspace.TargetBookmark, repository.Name,
	))
	if err != nil {
		return fmt.Errorf("mark durable github import ready: %w", err)
	}
	// Import is one of the three registry enrollment triggers (spec §1a): the
	// mirror it just built is exactly what continuous ref sync should keep
	// current. Best-effort — never fails a completed import.
	s.EnrollImportedGitHubRepo(ctx, job.UserID, job.GitHubOwner, job.GitHubRepo, job.RepoOwner, repository.Name)
	return nil
}

func (s *GitHubImportService) renewDurableImportClaims(
	ctx context.Context,
	job claimedGitHubImportJob,
	operation repositoryProvisioningOperation,
) error {
	if err := s.renewDurableImportClaim(ctx, job); err != nil {
		return err
	}
	return s.provisioning.RenewClaim(ctx, operation.RepositoryID, operation.Token, job.ClaimToken)
}

func (s *GitHubImportService) loadDurableImportRepository(
	ctx context.Context,
	job claimedGitHubImportJob,
) (db.Repository, bool, error) {
	repositoryID := int64(0)
	if job.RepositoryID.Valid {
		repositoryID = job.RepositoryID.Int64
	} else if job.ProvisioningRepositoryID.Valid {
		repositoryID = job.ProvisioningRepositoryID.Int64
	}
	if repositoryID == 0 {
		return db.Repository{}, false, nil
	}
	repository, err := db.New(s.pool).GetRepoByID(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, false, nil
	}
	if err != nil {
		return db.Repository{}, false, fmt.Errorf("load durable imported repository: %w", err)
	}
	owner, err := s.importOwnerForSlug(ctx, job.RepoOwner)
	if err != nil {
		return db.Repository{}, false, err
	}
	owned := !repository.UserID.Valid && owner.OrgID.Valid && repository.OrgID == owner.OrgID
	if owned {
		if s.orgs == nil {
			owned = false
		} else if _, err := s.orgs.GetOrgMember(ctx, db.GetOrgMemberParams{
			OrganizationID: owner.OrgID.Int64, UserID: job.UserID,
		}); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return db.Repository{}, false, fmt.Errorf("authorize durable imported repository: %w", err)
			}
			owned = false
		}
	} else {
		owned = !owner.OrgID.Valid && !repository.OrgID.Valid &&
			repository.UserID.Valid && repository.UserID.Int64 == job.UserID
	}
	if !owned || (job.RepoName != "" && !strings.EqualFold(repository.Name, job.RepoName)) {
		return db.Repository{}, false, fmt.Errorf("durable import repository binding does not match job")
	}
	return repository, true, nil
}

func (s *GitHubImportService) reserveDurableImportRepository(
	ctx context.Context,
	job *claimedGitHubImportJob,
	defaultBookmark string,
) (repositoryProvisioningOperation, *db.Repository, error) {
	if job.ProvisioningToken.Valid {
		operation, err := s.provisioning.GetByToken(ctx, job.ProvisioningToken.String)
		if err != nil {
			return repositoryProvisioningOperation{}, nil, fmt.Errorf("load bound import reservation: %w", err)
		}
		if err := validateDurableImportOperation(*job, operation); err != nil {
			return repositoryProvisioningOperation{}, nil, err
		}
		operation.ImportJobID = job.ID
		operation.ImportJobClaimToken = job.ClaimToken
		return operation, nil, nil
	}

	owner, err := s.importOwnerForSlug(ctx, job.RepoOwner)
	if err != nil {
		return repositoryProvisioningOperation{}, nil, err
	}
	candidates := mirrorNameCandidates(job.GitHubRepo, job.GitHubOwner)
	exactTarget := isTemplateSeed(job.GitHubOwner, job.GitHubRepo)
	if exactTarget {
		candidates = []string{job.RepoName}
	}
	for _, name := range candidates {
		existing, err := s.repoDB.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
			Owner: job.RepoOwner, LowerName: strings.ToLower(name),
		})
		if err == nil {
			if exactTarget {
				continue
			}
			provenance, provenanceErr := s.mirrorProvenanceMatches(
				ctx, job.UserID, job.GitHubOwner, job.GitHubRepo, existing,
			)
			if provenanceErr != nil {
				return repositoryProvisioningOperation{}, nil, provenanceErr
			}
			if provenance {
				return repositoryProvisioningOperation{}, &existing, nil
			}
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return repositoryProvisioningOperation{}, nil, fmt.Errorf("lookup import repository candidate: %w", err)
		}

		staged, err := s.stagedRepoHost.PrepareStagedImport(
			ctx, s.storageSetID, job.RepoOwner, name, defaultBookmark,
		)
		if err != nil {
			return repositoryProvisioningOperation{}, nil, err
		}
		userOwner := pgtype.Int8{Int64: job.UserID, Valid: true}
		billingOwnerType, billingOwnerID := BillingOwnerTypeUser, job.UserID
		if owner.OrgID.Valid {
			userOwner = pgtype.Int8{}
			billingOwnerType, billingOwnerID = BillingOwnerTypeOrg, owner.OrgID.Int64
		}
		wanted := newInitProvisioningOperation(
			job.UserID,
			userOwner, owner.OrgID, job.RepoOwner,
			repositoryProvisionParams{
				Name: name, LowerName: strings.ToLower(name),
				Description: "Imported from github.com/" + job.GitHubOwner + "/" + job.GitHubRepo,
				IsPublic:    false, DefaultBookmark: defaultBookmark,
			}, staged, repositoryProvisionImport,
		)
		wanted.ImportJobID = job.ID
		wanted.ImportJobClaimToken = job.ClaimToken
		var reserved repositoryProvisioningOperation
		err = authorizeRepoCreateThenCommit(ctx, s.billing, billingOwnerType, billingOwnerID, true, func(commitCtx context.Context) error {
			var reserveErr error
			reserved, reserveErr = s.provisioning.Reserve(commitCtx, wanted)
			return reserveErr
		})
		if err != nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(
				context.WithoutCancel(ctx), repoProvisionStorageCleanupTimeout,
			)
			abortErr := s.stagedRepoHost.AbortStagedProvision(cleanupCtx, staged)
			cleanupCancel()
			if abortErr != nil {
				return repositoryProvisioningOperation{}, nil,
					fmt.Errorf("reserve import repository: %w (abort unbound stage: %v)", err, abortErr)
			}
			if errors.Is(err, errRepositoryProvisionConflict) ||
				errors.Is(err, errRepositoryProvisionMismatch) {
				continue
			}
			return repositoryProvisioningOperation{}, nil, err
		}
		reserved.ImportJobID = job.ID
		reserved.ImportJobClaimToken = job.ClaimToken
		return reserved, nil, nil
	}
	return repositoryProvisioningOperation{}, nil,
		pkgerrors.Conflict(fmt.Sprintf("repository '%s' already exists; choose a different target name before importing", job.RepoName))
}

// importOwner names the local namespace a mirror is created in. OrgID is set
// only when that namespace is an organization; a user namespace leaves it
// invalid and the repository row is created with the importing user's id.
type importOwner struct {
	Name  string
	OrgID pgtype.Int8
}

// resolveImportOwner decides which namespace an import lands in. An org-owned
// source (an organization that exists on this deployment under the same slug)
// lands in that organization when the importing user is a member of it, and is
// refused with org_membership_required when they are not. It never silently
// falls back to the importing user's namespace: taking somebody else's
// organization repository into your own account is a fork, and forks are an
// explicit action, not the quiet outcome of an import.
func (s *GitHubImportService) resolveImportOwner(
	ctx context.Context, userID int64, githubOwner, githubRepo string,
) (importOwner, error) {
	// Template seeds are published from a first-party org but are meant to be
	// copied into the caller's own namespace, so they skip org resolution.
	if !isTemplateSeed(githubOwner, githubRepo) {
		org, err := s.lookupImportOrg(ctx, githubOwner)
		if err != nil {
			return importOwner{}, err
		}
		if org != nil {
			if _, err := s.orgs.GetOrgMember(ctx, db.GetOrgMemberParams{
				OrganizationID: org.ID, UserID: userID,
			}); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return importOwner{}, pkgerrors.New(
						pkgerrors.CodeOrgMembershipRequired,
						fmt.Sprintf(
							"'%s' is an organization on this deployment; join it to import its repositories, or fork '%s/%s' into your own namespace",
							org.Name, githubOwner, githubRepo),
					)
				}
				return importOwner{}, pkgerrors.Internal("load organization membership: " + err.Error())
			}
			return importOwner{Name: org.Name, OrgID: pgtype.Int8{Int64: org.ID, Valid: true}}, nil
		}
	}
	username, err := s.resolveLocalOwner(ctx, userID)
	if err != nil {
		return importOwner{}, pkgerrors.Internal("resolve import owner: " + err.Error())
	}
	return importOwner{Name: username}, nil
}

// lookupImportOrg returns the organization owning the given namespace slug, or
// nil when the slug is not an organization on this deployment. owner_namespaces
// keeps user and organization slugs in one unique space, so a slug that matches
// an organization can never also be a username.
func (s *GitHubImportService) lookupImportOrg(ctx context.Context, slug string) (*db.Organization, error) {
	if s.orgs == nil {
		return nil, nil
	}
	org, err := s.orgs.GetOrgByLowerName(ctx, strings.ToLower(strings.TrimSpace(slug)))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, pkgerrors.Internal("load organization: " + err.Error())
	}
	return &org, nil
}

// importOwnerForSlug re-resolves a persisted repo_owner slug to its namespace.
// import_jobs stores only the slug, so the worker resolves it again rather than
// carrying an owner kind through the job row.
func (s *GitHubImportService) importOwnerForSlug(ctx context.Context, slug string) (importOwner, error) {
	org, err := s.lookupImportOrg(ctx, slug)
	if err != nil {
		return importOwner{}, err
	}
	if org != nil {
		return importOwner{Name: org.Name, OrgID: pgtype.Int8{Int64: org.ID, Valid: true}}, nil
	}
	return importOwner{Name: slug}, nil
}

// resolveLocalOwner returns the importing user's canonical username — the jjhub
// namespace a user-owned mirror is created under. All repo-host operations and
// the DB storage-set resolver (GetRepoByOwnerAndLowerName) key on this, never
// the github source owner.
func (s *GitHubImportService) resolveLocalOwner(ctx context.Context, userID int64) (string, error) {
	var username string
	if err := s.db.QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, userID).Scan(&username); err != nil {
		return "", err
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return "", fmt.Errorf("empty username for user %d", userID)
	}
	return username, nil
}

func (s *GitHubImportService) GetImportJob(ctx context.Context, userID int64, id string) (ImportJob, error) {
	if s == nil || s.db == nil {
		return ImportJob{}, pkgerrors.Internal("github import service unavailable")
	}
	if userID <= 0 {
		return ImportJob{}, pkgerrors.Unauthorized("authentication required")
	}
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil {
		return ImportJob{}, pkgerrors.BadRequest("invalid import job id")
	}
	job, err := s.scanImportJob(s.db.QueryRow(ctx, getImportJobSQL, parsed.String(), userID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ImportJob{}, pkgerrors.NotFound("import job not found")
		}
		return ImportJob{}, pkgerrors.Internal("get import job: " + err.Error())
	}
	return job, nil
}

// RetryImportJob atomically returns a failed job to the durable queue. The
// stage and counters are deliberately retained so clients do not lose the last
// observed progress. Terminal cleanup removes unpublished staged repositories,
// so their stale reservation binding is cleared; a published repository stays
// bound and the durable worker resumes its remaining bookmark/workspace work.
func (s *GitHubImportService) RetryImportJob(ctx context.Context, userID int64, id string) (ImportJob, error) {
	if s == nil || s.db == nil {
		return ImportJob{}, pkgerrors.Internal("github import service unavailable")
	}
	if userID <= 0 {
		return ImportJob{}, pkgerrors.Unauthorized("authentication required")
	}
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil {
		return ImportJob{}, pkgerrors.BadRequest("invalid import job id")
	}
	current, err := s.scanImportJob(s.db.QueryRow(ctx, getImportJobSQL, parsed.String(), userID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ImportJob{}, pkgerrors.NotFound("import job not found")
		}
		return ImportJob{}, pkgerrors.Internal("get import job: " + err.Error())
	}
	if current.Status != "failed" {
		return ImportJob{}, pkgerrors.Conflict("only failed import jobs can be retried")
	}

	job, err := s.scanImportJob(s.db.QueryRow(ctx, retryImportJobSQL, parsed.String(), userID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ImportJob{}, pkgerrors.Conflict("import job is no longer failed")
		}
		return ImportJob{}, pkgerrors.Internal("retry import job: " + err.Error())
	}
	if s.provisioning != nil && s.stagedRepoHost != nil {
		s.wakeDurableWorker()
	} else if s.repoDB != nil && s.tokenDB != nil && s.repoHost != nil && s.decrypter != nil {
		go s.runImportDetached(job.ImportJobID, job.userID, job.githubOwner, job.githubRepo, job.RepoOwner, job.RepoName, job.branch)
	}
	return job, nil
}

func (s *GitHubImportService) runImportDetached(jobID string, userID int64, owner, repo, localOwner string, targetAndBranch ...string) {
	targetName := repo
	branch := "main"
	if len(targetAndBranch) == 1 {
		branch = targetAndBranch[0]
	} else if len(targetAndBranch) >= 2 {
		targetName = targetAndBranch[0]
		branch = targetAndBranch[1]
	}
	// Outermost recover: this runs on a detached goroutine (see the `go
	// s.runImportDetached(...)` call site) with no request goroutine to catch
	// a panic, so an unrecovered one would crash the whole multi-tenant
	// server. Mark the job failed instead of leaving it stuck pending forever.
	defer func() {
		if r := recover(); r != nil {
			slog.Error("mirror.import.panic", "import_job_id", jobID, "panic", r, "stack", string(debug.Stack()))
			_ = s.markFailed(context.Background(), jobID, fmt.Errorf("import panicked: %v", r))
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), s.asyncTimeout)
	defer cancel()
	ctx, span := otel.Tracer("smithers-server").Start(ctx, "mirror.import")
	span.SetAttributes(attribute.String("repo_owner", localOwner), attribute.String("repo_name", targetName), attribute.String("mirror_id", jobID))
	defer span.End()

	started := time.Now()
	repository, workspace, err := s.runImportToName(ctx, userID, owner, repo, localOwner, targetName, branch, jobID)
	if err != nil {
		span.RecordError(err)
		_ = s.markFailed(context.Background(), jobID, err)
		if s.metrics != nil {
			s.metrics.ObserveMirrorAttempt("failed")
		}
		slog.Error("mirror.import.fail", "import_job_id", jobID, "repo_owner", localOwner, "repo_name", repo, "error", err)
		return
	}
	// repo_name is (re)stamped from the created row: a name-collision import gets
	// a deduped mirror name (ensureLocalRepo), and clients read the REAL mirror
	// coordinates off the ready job row.
	if _, err := s.scanImportJob(s.db.QueryRow(context.Background(), markImportJobReadySQL, jobID, repository.ID, workspace.ID, workspace.TargetBookmark, repository.Name)); err != nil {
		slog.Error("mirror.import.ready_state_failed", "import_job_id", jobID, "error", err)
		return
	}
	if s.metrics != nil {
		s.metrics.ObserveMirrorAttempt("ok")
		s.metrics.ObserveMirrorDuration("total", time.Since(started).Seconds())
	}
	slog.Info("mirror.import.ok", "import_job_id", jobID, "repo_owner", localOwner, "repo_name", repository.Name, "source_repo", repo)
}

// setStage records import progress on the job row (streamed to clients over
// the SSE poll). Best-effort by design: progress reporting must never fail or
// abort the import itself.
func (s *GitHubImportService) setStage(ctx context.Context, jobID, stage string) {
	if s == nil || s.db == nil {
		return
	}
	var id string
	if err := s.db.QueryRow(ctx, setImportJobStageSQL, jobID, stage).Scan(&id); err != nil {
		slog.Warn("mirror.import.stage_write_failed", "import_job_id", jobID, "stage", stage, "error", err)
	}
}

// setProgress persists one coherent snapshot. Like stage writes, progress is
// observational and must never make the import itself fail.
func (s *GitHubImportService) setProgress(ctx context.Context, jobID string, progress ImportJobCounts) {
	if s == nil || s.db == nil || strings.TrimSpace(jobID) == "" {
		return
	}
	progress = normalizeImportJobProgress(progress)
	var id string
	if err := s.db.QueryRow(ctx, setImportJobProgressSQL, jobID,
		progress.Refs.Done, progress.Refs.Total,
		progress.Objects.Done, progress.Objects.Total,
		progress.Issues.Done, progress.Issues.Total,
	).Scan(&id); err != nil {
		slog.Warn("mirror.import.progress_write_failed", "import_job_id", jobID, "error", err)
	}
}

func normalizeImportJobProgress(progress ImportJobCounts) ImportJobCounts {
	counts := []*ImportJobCount{&progress.Refs, &progress.Objects, &progress.Issues}
	for _, count := range counts {
		if count.Done < 0 {
			count.Done = 0
		}
		if count.Total < count.Done {
			count.Total = count.Done
		}
	}
	return progress
}

func (s *GitHubImportService) runImport(ctx context.Context, userID int64, owner, repo, localOwner, branch, jobID string) (db.Repository, WorkspaceResponse, error) {
	return s.runImportToName(ctx, userID, owner, repo, localOwner, repo, branch, jobID)
}

func (s *GitHubImportService) runImportToName(ctx context.Context, userID int64, owner, repo, localOwner, targetName, branch, jobID string) (db.Repository, WorkspaceResponse, error) {
	// owner = github source (octocat); localOwner = the importing user's jjhub
	// namespace (alice). Github lookups + the clone source use `owner`; every
	// jjhub/repo-host operation uses `localOwner` so the repo created under the
	// user is the same one the storage-set resolver finds.
	s.setStage(ctx, jobID, importStageResolving)
	githubCloneToken, private, defaultBranch, err := s.githubCloneInfoForRepo(ctx, userID, owner, repo)
	if err != nil {
		s.observeFailure("github_repo", err)
		return db.Repository{}, WorkspaceResponse{}, err
	}
	if !private {
		githubCloneToken = ""
	}
	if defaultBranch == "" {
		defaultBranch = "main"
	}

	s.setStage(ctx, jobID, importStageCreatingRepo)
	var repository db.Repository
	var reused bool
	if isTemplateSeed(owner, repo) {
		repository, reused, err = s.ensureExactLocalRepo(ctx, userID, localOwner, owner, repo, targetName, defaultBranch)
	} else {
		repository, reused, err = s.ensureLocalRepo(ctx, userID, localOwner, owner, repo, defaultBranch)
	}
	if err != nil {
		s.observeFailure("import_refs", err)
		return db.Repository{}, WorkspaceResponse{}, err
	}
	// REUSE PATH: the existing local repo is provably the mirror of this GitHub
	// source (#47 provenance), so the mirror already lives in repo-host storage.
	// Skip cloneMirror + ImportRefs entirely — nothing is pushed to storage — and
	// finish by (conditionally) creating the branch bookmark and provisioning the
	// bound workspace. This is the reopen flow behind the 2026-07-13 prod toast.
	// The repo predates this run, so a later failure here must NOT delete it.
	if reused {
		reusedRepository, workspace, reuseErr := s.finishReusedImport(ctx, userID, owner, localOwner, repo, branch, defaultBranch, jobID, githubCloneToken, repository)
		if reuseErr == nil {
			s.EnrollImportedGitHubRepo(ctx, userID, owner, repo, localOwner, reusedRepository.Name)
		}
		return reusedRepository, workspace, reuseErr
	}

	// FRESH PATH: ensureLocalRepo just created the repo row + repo-host storage
	// this run. If ANY later stage fails, compensate exactly like the InitRepo
	// failure path (ensureLocalRepo) — delete the created repo with a cancel-free
	// context — so a half-imported orphan can't wedge every subsequent retry via
	// the existing-repo conflict (2026-07-13 prod bug).
	workspace, err := s.runFreshImport(ctx, userID, owner, repo, localOwner, branch, defaultBranch, jobID, githubCloneToken, repository)
	if err != nil {
		s.rollbackFreshImportRepo(ctx, repository.ID, localOwner, repository.Name)
		return db.Repository{}, WorkspaceResponse{}, err
	}
	s.EnrollImportedGitHubRepo(ctx, userID, owner, repo, localOwner, repository.Name)
	return repository, workspace, nil
}

func (s *GitHubImportService) rollbackFreshImportRepo(ctx context.Context, repositoryID int64, owner, repo string) {
	storageCtx, cancelStorage := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionStorageCleanupTimeout)
	storageErr := s.repoHost.DeleteRepo(storageCtx, owner, repo)
	if storageErr != nil && !isRepoHostStatus(storageErr, http.StatusNotFound) {
		slog.Error("mirror.import.orphan_storage_cleanup_failed",
			"repo_id", repositoryID, "repo_owner", owner, "repo_name", repo,
			"database_row_preserved", true, "error", storageErr)
		cancelStorage()
		// The row is the only durable placement/namespace pointer for storage
		// whose deletion did not complete conclusively. Keep it reserved instead
		// of creating an unreachable physical orphan.
		return
	}
	cancelStorage()

	dbCtx, cancelDB := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
	defer cancelDB()
	if err := s.repoDB.DeleteRepo(dbCtx, repositoryID); err != nil {
		slog.Error("mirror.import.orphan_repo_cleanup_failed",
			"repo_id", repositoryID, "repo_owner", owner, "repo_name", repo, "error", err)
	}
}

// runFreshImport runs the stages that only apply to a newly-created mirror repo:
// clone GitHub → push mirror → ImportRefs → create the branch bookmark →
// provision the bound workspace. Every returned error is compensated by the
// caller (runImport) deleting the repo ensureLocalRepo created this run, so this
// helper never performs cleanup itself.
func (s *GitHubImportService) runFreshImport(ctx context.Context, userID int64, owner, repo, localOwner, branch, defaultBranch, jobID, githubCloneToken string, repository db.Repository) (WorkspaceResponse, error) {
	// owner/repo name the GITHUB source; every local repo-host op below keys on
	// the created row's name, which diverges from the source name when the
	// import was deduped around a same-name collision (ensureLocalRepo).
	mirrorName := repository.Name
	token, err := issueTemporarySyncPushToken(ctx, s.tokenDB, userID, repository.ID, "github-import-push")
	if err != nil {
		s.observeFailure("auth", err)
		return WorkspaceResponse{}, fmt.Errorf("create import push token: %w", err)
	}
	defer revokeTemporaryRepoCloneToken(context.Background(), s.tokenDB, userID, token.ID)

	// Build a CREDENTIAL-FREE push URL; the push token rides GIT_CONFIG_* env in
	// cloneAndPushMirror instead of the remote URL, so it never appears on argv.
	pushURLParsed, err := buildRepoCloneURL(s.gitBaseURL, localOwner, mirrorName)
	if err != nil {
		s.observeFailure("auth", err)
		return WorkspaceResponse{}, err
	}
	pushURL := pushURLParsed.String()

	s.setStage(ctx, jobID, importStageCloningGitHub)
	if err := s.cloneMirror(ctx, owner, repo, githubCloneToken, pushURL, token.Plaintext, jobID); err != nil {
		s.observeFailure("clone", err)
		return WorkspaceResponse{}, err
	}

	importStarted := time.Now()
	s.setStage(ctx, jobID, importStageImportingRefs)
	if err := runRepoHostMutation(ctx, func(mutationCtx context.Context) error {
		return s.repoHost.ImportRefs(mutationCtx, localOwner, mirrorName)
	}); err != nil {
		s.observeFailure("import_refs", err)
		return WorkspaceResponse{}, fmt.Errorf("import refs: %w", err)
	}
	s.recordMirrorCloned(ctx, repository.ID)
	if s.metrics != nil {
		s.metrics.ObserveMirrorDuration("import_refs", time.Since(importStarted).Seconds())
	}

	branchStarted := time.Now()
	s.setStage(ctx, jobID, importStageCreatingBookmark)
	targetChangeID, err := s.importedBookmarkTarget(ctx, localOwner, mirrorName, defaultBranch)
	if err != nil {
		s.observeFailure("branch", err)
		if s.metrics != nil {
			s.metrics.ObserveBranchCreate("failed")
		}
		return WorkspaceResponse{}, err
	}
	err = runRepoHostMutation(ctx, func(mutationCtx context.Context) error {
		_, mutationErr := s.repoHost.CreateBookmark(mutationCtx, localOwner, mirrorName, repohost.CreateBookmarkRequest{Name: branch, TargetChangeID: targetChangeID, IfAbsent: true})
		return mutationErr
	})
	if err != nil {
		s.observeFailure("branch", err)
		if s.metrics != nil {
			s.metrics.ObserveBranchCreate("failed")
		}
		return WorkspaceResponse{}, fmt.Errorf("create bookmark: %w", err)
	}
	if s.metrics != nil {
		s.metrics.ObserveBranchCreate("ok")
		s.metrics.ObserveMirrorDuration("branch", time.Since(branchStarted).Seconds())
	}

	s.setStage(ctx, jobID, importStageProvisioningWorkspace)
	workspace, err := s.createBoundWorkspace(ctx, userID, repository, localOwner, mirrorName, branch)
	if err != nil {
		s.observeFailure("workspace", err)
		return WorkspaceResponse{}, err
	}

	return workspace, nil
}

// finishReusedImport completes a re-import that reuses an already-mirrored repo.
// The mirror is FIRST refreshed from GitHub (refreshReusedMirror) so a reopened
// repo picks up new upstream commits instead of serving the tree frozen at
// first-import time (2026-07-14 "files I expect" complaint) — with NON-PRUNING
// semantics that never clobber jjhub-side refs (#47), and best-effort so a
// GitHub outage degrades to serving the existing (stale) mirror. The requested
// branch bookmark is then created ONLY when absent: repo-host CreateBookmark
// MOVES an existing bookmark, which on reopen would clobber committed user work,
// so the existence check is mandatory.
func (s *GitHubImportService) finishReusedImport(ctx context.Context, userID int64, sourceOwner, localOwner, repo, branch, defaultBranch, jobID, githubCloneToken string, repository db.Repository) (db.Repository, WorkspaceResponse, error) {
	// repo names the GITHUB source; the reused mirror's local name may differ
	// when it was deduped around a same-name collision (ensureLocalRepo), so
	// every local repo-host op keys on the existing row's name.
	mirrorName := repository.Name
	if s.metrics != nil {
		s.metrics.ObserveMirrorAttempt("reused")
	}

	// Refresh BEFORE resolving the default-branch bookmark so the resolved change
	// reflects the just-refreshed GitHub head. Best-effort: never fails the reopen.
	s.refreshReusedMirror(ctx, userID, repository.ID, sourceOwner, repo, localOwner, mirrorName, jobID, githubCloneToken)

	s.setStage(ctx, jobID, importStageCreatingBookmark)
	targetChangeID, err := s.importedBookmarkTarget(ctx, localOwner, mirrorName, defaultBranch)
	if err != nil {
		s.observeFailure("branch", err)
		if s.metrics != nil {
			s.metrics.ObserveBranchCreate("failed")
		}
		return db.Repository{}, WorkspaceResponse{}, err
	}
	exists, err := s.bookmarkExists(ctx, localOwner, mirrorName, branch)
	if err != nil {
		s.observeFailure("branch", err)
		if s.metrics != nil {
			s.metrics.ObserveBranchCreate("failed")
		}
		return db.Repository{}, WorkspaceResponse{}, err
	}
	if !exists {
		if err := runRepoHostMutation(ctx, func(mutationCtx context.Context) error {
			_, mutationErr := s.repoHost.CreateBookmark(mutationCtx, localOwner, mirrorName, repohost.CreateBookmarkRequest{Name: branch, TargetChangeID: targetChangeID, IfAbsent: true})
			return mutationErr
		}); err != nil {
			s.observeFailure("branch", err)
			if s.metrics != nil {
				s.metrics.ObserveBranchCreate("failed")
			}
			return db.Repository{}, WorkspaceResponse{}, fmt.Errorf("create bookmark: %w", err)
		}
		if s.metrics != nil {
			s.metrics.ObserveBranchCreate("ok")
		}
	} else if s.metrics != nil {
		s.metrics.ObserveBranchCreate("reused")
	}

	s.setStage(ctx, jobID, importStageProvisioningWorkspace)
	workspace, err := s.createBoundWorkspace(ctx, userID, repository, localOwner, mirrorName, branch)
	if err != nil {
		s.observeFailure("workspace", err)
		return db.Repository{}, WorkspaceResponse{}, err
	}
	return repository, workspace, nil
}

// refreshReusedMirror re-fetches the mirror from GitHub and re-imports its refs
// on the reuse path, so a reopened mirror reflects new upstream commits instead
// of the tree frozen at first-import time. It is BEST-EFFORT by contract: a
// GitHub outage or an expired user token must NOT fail the reopen — it logs
// mirror.reuse.refresh_failed and degrades to serving the existing (stale)
// mirror. It NEVER deletes the pre-existing repo (this is not the fresh path;
// the e60d6f8beb compensation only applies to freshly-created repos). Inside
// the mirror's refresh cooldown, or while another import refreshes it, it
// clones nothing (claimMirrorRefresh).
func (s *GitHubImportService) refreshReusedMirror(ctx context.Context, userID, repositoryID int64, sourceOwner, sourceRepo, localOwner, mirrorName, jobID, githubCloneToken string) {
	claim, claimed := s.claimMirrorRefresh(ctx, repositoryID, jobID)
	if !claimed {
		if s.metrics != nil {
			s.metrics.ObserveMirrorAttempt("refresh_skipped")
		}
		return
	}
	started := time.Now()
	if err := s.refreshMirrorFromGitHub(ctx, userID, repositoryID, sourceOwner, sourceRepo, localOwner, mirrorName, jobID, githubCloneToken); err != nil {
		s.settleMirrorRefresh(ctx, repositoryID, claim, false)
		// Degrade to the stale mirror: the user still gets their repo, staleness
		// is the fallback, not the norm. Not surfaced, not fatal, no cleanup.
		slog.Warn("mirror.reuse.refresh_failed", "import_job_id", jobID, "repo_owner", localOwner, "repo_name", mirrorName, "error", err)
		if s.metrics != nil {
			s.metrics.ObserveMirrorAttempt("refresh_failed")
		}
		return
	}
	s.settleMirrorRefresh(ctx, repositoryID, claim, true)
	if s.metrics != nil {
		s.metrics.ObserveMirrorDuration("refresh", time.Since(started).Seconds())
	}
}

// refreshMirrorFromGitHub performs the non-destructive refresh: clone the GitHub
// source and force-push its branch/tag namespaces into repo-host storage with
// NON-PRUNING refspecs (jjhub-side refs survive, #47), then ImportRefs so jj
// bookmarks tracking updated git refs move forward while jjhub-only bookmarks are
// left untouched. Returns an error on any failure; the best-effort wrapper
// (refreshReusedMirror) decides that a failure degrades rather than fails.
func (s *GitHubImportService) refreshMirrorFromGitHub(ctx context.Context, userID, repositoryID int64, sourceOwner, sourceRepo, localOwner, mirrorName, jobID, githubCloneToken string) error {
	token, err := issueTemporarySyncPushToken(ctx, s.tokenDB, userID, repositoryID, "github-import-refresh-push")
	if err != nil {
		return fmt.Errorf("create refresh push token: %w", err)
	}
	defer revokeTemporaryRepoCloneToken(context.Background(), s.tokenDB, userID, token.ID)

	// Credential-free push URL; the push token rides GIT_CONFIG_* env, never argv.
	pushURLParsed, err := buildRepoCloneURL(s.gitBaseURL, localOwner, mirrorName)
	if err != nil {
		return err
	}

	s.setStage(ctx, jobID, importStageCloningGitHub)
	if err := s.cloneAndSyncMirror(ctx, "mirror.refresh", sourceOwner, sourceRepo, githubCloneToken, pushURLParsed.String(), token.Plaintext, jobID, nonPruningPushArgs, nil); err != nil {
		return err
	}

	s.setStage(ctx, jobID, importStageImportingRefs)
	if err := runRepoHostMutation(ctx, func(mutationCtx context.Context) error {
		return s.repoHost.ImportRefs(mutationCtx, localOwner, mirrorName)
	}); err != nil {
		return fmt.Errorf("import refs: %w", err)
	}
	return nil
}

// bookmarkExists reports whether one named bookmark is present in the mirror.
func (s *GitHubImportService) bookmarkExists(ctx context.Context, owner, repo, name string) (bool, error) {
	_, found, err := repohost.LookupBookmark(ctx, s.repoHost, owner, repo, name)
	if err != nil {
		return false, fmt.Errorf("read bookmark: %w", err)
	}
	return found, nil
}

// createBoundWorkspace starts the imported bookmark's workspace. When the
// user's sandbox allowance is full, the repository is still imported: the
// result carries only the bookmark (no ID) and the workspace starts when the
// user opens it, where the same allowance refusal is reported. Without a
// provisioner (the self-hosted install, whose machines start per branch) the
// import ends when the mirror holds the bookmark: Source ready (spec §8.6.3).
func (s *GitHubImportService) createBoundWorkspace(ctx context.Context, userID int64, repository db.Repository, owner, repo, bookmark string) (WorkspaceResponse, error) {
	if s.workspaces == nil {
		return WorkspaceResponse{TargetBookmark: bookmark}, nil
	}
	workspace, err := s.workspaces.CreateWorkspaceAsync(ctx, CreateWorkspaceInput{
		RepositoryID:   repository.ID,
		UserID:         userID,
		RepoOwner:      owner,
		RepoName:       repo,
		Name:           bookmark,
		SourceBookmark: bookmark,
	})
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) && (apiErr.Code == pkgerrors.CodePlanLimitExceeded || apiErr.Code == pkgerrors.CodeQuotaExceeded) {
		slog.Info("mirror.import.workspace_deferred", "repository_id", repository.ID, "user_id", userID, "code", apiErr.Code)
		return WorkspaceResponse{TargetBookmark: bookmark}, nil
	}
	if err != nil {
		return WorkspaceResponse{}, fmt.Errorf("create bound workspace: %w", err)
	}
	if targetWorkspaceBookmark(workspace.TargetBookmark) != targetWorkspaceBookmark(bookmark) {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace bookmark binding was not persisted")
	}
	return workspace, nil
}

// importedBookmarkTarget resolves the imported default bookmark in one lookup.
func (s *GitHubImportService) importedBookmarkTarget(ctx context.Context, owner, repo, bookmarkName string) (string, error) {
	bookmark, found, err := repohost.LookupBookmark(ctx, s.repoHost, owner, repo, bookmarkName)
	if err != nil {
		return "", fmt.Errorf("read bookmark: %w", err)
	}
	if found && strings.TrimSpace(bookmark.TargetChangeID) != "" {
		return bookmark.TargetChangeID, nil
	}
	return "", pkgerrors.NotFound("imported bookmark not found")
}

// createImportRepoRow inserts the mirror's repositories row in the namespace the
// import resolved to: an organization row when the source owner is an
// organization on this deployment, the importing user's row otherwise.
func (s *GitHubImportService) createImportRepoRow(
	ctx context.Context, owner importOwner, params db.CreateRepoParams,
) (db.Repository, error) {
	if !owner.OrgID.Valid {
		return s.repoDB.CreateRepo(ctx, params)
	}
	if s.orgs == nil {
		return db.Repository{}, pkgerrors.Internal("organization imports are not wired on this deployment")
	}
	return s.orgs.CreateOrgRepo(ctx, db.CreateOrgRepoParams{
		OrgID:           owner.OrgID,
		Name:            params.Name,
		LowerName:       params.LowerName,
		Description:     params.Description,
		IsPublic:        params.IsPublic,
		DefaultBookmark: params.DefaultBookmark,
	})
}

// ensureLocalRepo creates the jjhub repository under the namespace localOwner
// names — the importing user, or the organization the source owner resolved to.
// sourceOwner is only used for the human-readable
// "Imported from github.com/<sourceOwner>/<repo>" description; the DB row +
// repo-host init key on localOwner so the storage-set resolver can find it.
//
// The returned bool reports whether the existing repo is being REUSED: when a
// same-name local repo already exists AND provenance proves it is the mirror of
// the requested GitHub source, the repo row is returned with reused=true and the
// caller must skip cloneMirror + ImportRefs. Without provenance the existing repo
// still yields the #47 409 conflict (never mirror-push over foreign storage).
func (s *GitHubImportService) ensureLocalRepo(ctx context.Context, userID int64, localOwner, sourceOwner, repo, defaultBookmark string) (db.Repository, bool, error) {
	return s.ensureLocalRepoFromCandidates(ctx, userID, localOwner, sourceOwner, repo, defaultBookmark, mirrorNameCandidates(repo, sourceOwner), true)
}

func (s *GitHubImportService) ensureExactLocalRepo(ctx context.Context, userID int64, localOwner, sourceOwner, sourceRepo, targetName, defaultBookmark string) (db.Repository, bool, error) {
	return s.ensureLocalRepoFromCandidates(ctx, userID, localOwner, sourceOwner, sourceRepo, defaultBookmark, []string{targetName}, false)
}

func (s *GitHubImportService) ensureLocalRepoFromCandidates(ctx context.Context, userID int64, localOwner, sourceOwner, repo, defaultBookmark string, candidates []string, allowReuse bool) (db.Repository, bool, error) {
	requestStartedAt := time.Now().UTC()
	// Mirror names collide within a user's namespace: importing octocat/tools
	// and fork-owner/tools both want "<user>/tools". Instead of dead-ending on
	// the #47 conflict (the UI offers no target-name choice), walk a small
	// candidate list — the source name first, then source-owner-qualified
	// names — REUSING any candidate that provenance proves is this source's
	// mirror (a prior deduped import), and creating under the first free name.
	owner, err := s.importOwnerForSlug(ctx, localOwner)
	if err != nil {
		return db.Repository{}, false, err
	}
	for _, name := range candidates {
		existing, err := s.repoDB.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
			Owner:     strings.ToLower(localOwner),
			LowerName: strings.ToLower(name),
		})
		if err == nil {
			if !allowReuse {
				continue
			}
			provenance, provErr := s.mirrorProvenanceMatches(ctx, userID, sourceOwner, repo, existing)
			if provErr != nil {
				return db.Repository{}, false, provErr
			}
			if provenance {
				return existing, true, nil
			}
			// A same-name repo that is NOT this source's mirror — try the next
			// candidate name rather than 409ing or pushing over foreign storage.
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, false, fmt.Errorf("lookup local repo: %w", err)
		}

		createParams := db.CreateRepoParams{
			UserID:          pgtype.Int8{Int64: userID, Valid: true},
			Name:            name,
			LowerName:       strings.ToLower(name),
			Description:     "Imported from github.com/" + sourceOwner + "/" + repo,
			IsPublic:        false,
			DefaultBookmark: strings.TrimSpace(defaultBookmark),
		}
		expected := repositoryCreateExpectation{
			UserID:          createParams.UserID,
			Name:            createParams.Name,
			LowerName:       createParams.LowerName,
			Description:     createParams.Description,
			IsPublic:        createParams.IsPublic,
			DefaultBookmark: createParams.DefaultBookmark,
			NotBefore:       requestStartedAt,
		}
		billingOwnerType, billingOwnerID := BillingOwnerTypeUser, userID
		if owner.OrgID.Valid {
			// An organization namespace owns the row and the bill; the
			// importing user is the actor, not the owner.
			createParams.UserID = pgtype.Int8{}
			expected.UserID = pgtype.Int8{}
			expected.OrgID = owner.OrgID
			billingOwnerType, billingOwnerID = BillingOwnerTypeOrg, owner.OrgID.Int64
		}
		var created db.Repository
		err = authorizeRepoCreateThenCommit(ctx, s.billing, billingOwnerType, billingOwnerID, true, func(commitCtx context.Context) error {
			var createErr error
			created, createErr = s.createImportRepoRow(commitCtx, owner, createParams)
			adopted := false
			if createErr != nil {
				switch classifyRepositoryCreateError(createErr) {
				case repositoryCreateErrorConflict, repositoryCreateErrorDefinitive:
					return fmt.Errorf("create local repo: %w", createErr)
				case repositoryCreateErrorAmbiguous:
					recovered, state, lookupErr := reconcileAmbiguousRepositoryCreate(commitCtx, s.repoDB.GetRepoByOwnerAndLowerName, localOwner, expected)
					if state == repositoryCreateConflicting {
						return errGitHubImportCandidateOccupied
					}
					if state != repositoryCreateAdopted {
						slog.Error("mirror.import.ambiguous_repo_create_unresolved",
							"repo_owner", localOwner, "repo_name", name, "create_error", createErr, "lookup_error", lookupErr)
						return fmt.Errorf("create local repo: %w", createErr)
					}
					created = recovered
					adopted = true
				}
			}
			if initErr := runRepoHostMutation(commitCtx, func(mutationCtx context.Context) error {
				return s.repoHost.InitRepo(mutationCtx, localOwner, name, defaultBookmark, false)
			}); initErr != nil {
				if adopted && isRepoHostAlreadyExists(initErr) {
					return nil
				}
				if adopted {
					// The recovered row can be shared with an identical concurrent
					// import. Its ownership is unknowable after a lost INSERT result,
					// so destructive compensation is unsafe on this path.
					return fmt.Errorf("init local repo: %w", initErr)
				}
				// Compensate the DB row like RepoService.CreateRepo does: a repositories
				// row without repo-host storage is a phantom — it shows up in listings,
				// blocks retried imports via the existing-repo conflict above, and can
				// never serve git operations. Delete with a cancel-free context so a
				// timed-out import still cleans up after itself.
				s.rollbackFreshImportRepo(commitCtx, created.ID, localOwner, name)
				return fmt.Errorf("init local repo: %w", initErr)
			}
			return nil
		})
		if err != nil {
			if errors.Is(err, errGitHubImportCandidateOccupied) {
				continue
			}
			return db.Repository{}, false, err
		}
		if name != repo {
			slog.Info("mirror.import.name_deduped",
				"repo_owner", localOwner, "mirror_name", name, "source", sourceOwner+"/"+repo)
		}
		return created, false, nil
	}
	if s.metrics != nil {
		s.metrics.ObserveMirrorAttempt("already_exists")
	}
	targetName := repo
	if len(candidates) == 1 {
		targetName = candidates[0]
	}
	return db.Repository{}, false, pkgerrors.Conflict(fmt.Sprintf("repository '%s' already exists; choose a different target name before importing", targetName))
}

func isTemplateSeed(owner, repo string) bool {
	for _, seed := range templateSeedRegistry {
		if strings.EqualFold(seed.Owner, owner) && strings.EqualFold(seed.Repo, repo) {
			return true
		}
	}
	return false
}

// mirrorNameCandidates lists the local names an imported mirror may take, in
// preference order: the source repo name itself, then source-owner-qualified
// fallbacks so two same-named sources ("octocat/tools", "fork/tools") can both
// mirror into one user namespace. Bounded — a user hoarding every candidate
// still gets the honest conflict from the caller.
func mirrorNameCandidates(repo, sourceOwner string) []string {
	qualified := repo + "-" + strings.ToLower(strings.TrimSpace(sourceOwner))
	digest := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(sourceOwner)) + "/" + strings.ToLower(strings.TrimSpace(repo))))
	hashSuffix := fmt.Sprintf("-%x", digest[:6])
	base := strings.TrimRight(repo, ".-_")
	if base == "" {
		base = "repository"
	}
	if len(base)+len(hashSuffix) > 100 {
		base = strings.TrimRight(base[:100-len(hashSuffix)], ".-_")
	}
	hashed := base + hashSuffix
	raw := []string{repo, qualified, qualified + "-2", qualified + "-3", hashed}
	candidates := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, candidate := range raw {
		if validateRepoName(candidate) != nil {
			continue
		}
		lower := strings.ToLower(candidate)
		if _, duplicate := seen[lower]; duplicate {
			continue
		}
		seen[lower] = struct{}{}
		candidates = append(candidates, candidate)
	}
	return candidates
}

// mirrorProvenanceMatches decides whether an existing same-name local repo may be
// REUSED as the mirror of the requested GitHub source. STRONG provenance ONLY:
// a prior ready import_jobs row or a failed row with an exact durable published
// repository binding (via the injectable provenanceMatches seam, defaulting to
// importJobProvenanceMatches). The
// "Imported from github.com/<sourceOwner>/<repo>" Description marker is
// deliberately NOT sufficient on its own — ensureLocalRepo stamps it before the
// import can possibly succeed, so it also matches a FRESH import that failed
// mid-flow (empty repo-host storage, no ready import_jobs row). Reusing on that
// marker skips clone/ImportRefs against empty storage and wedges every retry
// (2026-07-13 prod bug). Absent a strong job match the caller returns the #47
// 409 conflict instead.
func (s *GitHubImportService) mirrorProvenanceMatches(ctx context.Context, userID int64, sourceOwner, repo string, existing db.Repository) (bool, error) {
	if s.provenanceMatches == nil {
		return false, nil
	}
	return s.provenanceMatches(ctx, userID, sourceOwner, repo, existing.ID)
}

// importJobProvenanceMatches is the default provenanceMatches seam: it queries
// import_jobs for a prior definitive import of this user + github source whose
// repository_id equals the existing repo's ID. Returns false when no db is wired
// (unit tests inject the seam directly).
func (s *GitHubImportService) importJobProvenanceMatches(ctx context.Context, userID int64, githubOwner, githubRepo string, repositoryID int64) (bool, error) {
	if s.db == nil {
		return false, nil
	}
	var exists bool
	if err := s.db.QueryRow(ctx, importJobProvenanceSQL, userID, githubOwner, githubRepo, repositoryID).Scan(&exists); err != nil {
		return false, fmt.Errorf("check import provenance: %w", err)
	}
	return exists, nil
}

// defaultGitHubImportMaxSizeMB bounds the GitHub repository size an import will
// clone. `cloneAndSyncMirror` runs `git clone --mirror` into a temp dir that
// lives on the API pod's /tmp emptyDir, so an unbounded clone is an unbounded
// write to a sized volume: production evicted an API replica every ~15 minutes
// with `Usage of EmptyDir volume "tmp" exceeds the limit "1Gi"`, observed
// directly as /tmp/smithers-github-import-* growing 183 MB -> 1.69 GB in 90
// seconds. Every request in flight on that replica died with it. Refuse the
// oversized import honestly instead.
//
// Keep this comfortably below the api-deployment `tmp` emptyDir sizeLimit so
// concurrent imports still fit.
const defaultGitHubImportMaxSizeMB = 1024

// githubImportMaxSizeMB returns the configured import size budget in megabytes.
// A non-positive value disables the check (local dev / self-hosted operators
// with unbounded scratch space).
func githubImportMaxSizeMB() int64 {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB"))
	if raw == "" {
		return defaultGitHubImportMaxSizeMB
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		slog.Warn("invalid SMITHERS_GITHUB_IMPORT_MAX_SIZE_MB; using the default",
			"value", raw, "default_mb", defaultGitHubImportMaxSizeMB)
		return defaultGitHubImportMaxSizeMB
	}
	return parsed
}

// gitHubImportSizeExceeded reports whether GitHub's advertised repository size
// is over the configured budget, and by how much. sizeKB is GitHub's `size`
// field (kilobytes). A zero/absent size is never treated as over budget: some
// repositories (and every GitHub Enterprise proxy that drops the field) report
// 0, and refusing those would break imports that fit fine.
func gitHubImportSizeExceeded(sizeKB, maxMB int64) (bool, int64) {
	if maxMB <= 0 || sizeKB <= 0 {
		return false, sizeKB / 1024
	}
	sizeMB := sizeKB / 1024
	return sizeMB > maxMB, sizeMB
}

func (s *GitHubImportService) githubCloneInfoForRepo(ctx context.Context, userID int64, owner, repo string) (string, bool, string, error) {
	token, account, installation, err := s.githubImportSourceToken(ctx, userID, owner, repo)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", false, "", err
	}

	metadata, status, responseHeader, err := s.fetchGitHubRepoMetadata(ctx, token, owner, repo)
	if err != nil {
		return "", false, "", err
	}
	// The stored user-to-server token expires ~8h after connect; on a genuine 401
	// (expired token) refresh once and retry with the rotated token before
	// surfacing the honest 401. A 403 is a rate limit / SAML / access denial — NOT
	// an expired token — and must NOT trigger a refresh: GitHub App refresh tokens
	// are single-use, so rotating them on 403 during a rate-limit storm is what
	// caused the 2026-07-04 reconnect cascade. Anonymous requests (no token) can't
	// be refreshed, so skip.
	if status == http.StatusUnauthorized && token != "" && strings.TrimSpace(account.Provider) != "" {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			token = newToken
			metadata, status, responseHeader, err = s.fetchGitHubRepoMetadata(ctx, token, owner, repo)
			if err != nil {
				return "", false, "", err
			}
		}
	}

	if status == http.StatusNotFound && token == "" {
		return "", false, "", pkgerrors.Unauthorized("GitHub credential is required for private repository import; install the GitHub App or link a GitHub account")
	}
	if status == http.StatusNotFound {
		return "", false, "", pkgerrors.NotFound("github repository not found")
	}
	if status == http.StatusTooManyRequests || (status == http.StatusForbidden && githubRepoMetadataRateLimited(responseHeader)) {
		return "", false, "", &pkgerrors.APIError{
			Status:     http.StatusTooManyRequests,
			Code:       pkgerrors.CodeRateLimitExceeded,
			Message:    "github repository request was rate limited",
			RetryAfter: gitHubRepoMetadataRetryAfter(responseHeader, time.Now().UTC()),
		}
	}
	if status == http.StatusUnauthorized {
		return "", false, "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	if status == http.StatusForbidden {
		return "", false, "", pkgerrors.Forbidden("github oauth token was rejected")
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return "", false, "", pkgerrors.Internal("github repository request was rejected")
	}
	if metadata.Private && token == "" {
		return "", false, "", pkgerrors.Unauthorized("GitHub credential is required for private repository import; install the GitHub App or link a GitHub account")
	}
	// The installation token comes from a repo connection that proved access
	// once, and it keeps reading the repo after the importer loses access. Every
	// import, reopen refresh and source retention passes through here, so the
	// importer's own credential must still read a private source before any
	// upstream commit reaches their repository.
	if metadata.Private && installation && (s.readAccess == nil || !s.readAccess.GitHubRepoReadAuthorized(ctx, userID, owner, repo)) {
		slog.Warn("github.source.read_access_lost", "user_id", userID, "github_owner", owner, "github_repo", repo)
		if s.metrics != nil {
			s.metrics.ObserveMirrorFailure("github_access", "reconnect_required")
		}
		return "", false, "", pkgerrors.GitHubReconnectRequired(fmt.Sprintf(
			"your GitHub account can no longer read %s/%s; reconnect GitHub with an account that can read it. Your existing Smithers copy is unchanged", owner, repo))
	}
	maxMB := githubImportMaxSizeMB()
	if exceeded, sizeMB := gitHubImportSizeExceeded(metadata.SizeKB, maxMB); exceeded {
		// Refuse BEFORE the clone: the mirror clone is what fills the pod's
		// scratch volume, and an eviction takes every other in-flight request
		// with it.
		slog.Warn("refusing oversized github import",
			"owner", owner, "repo", repo, "size_mb", sizeMB, "max_mb", maxMB)
		return "", false, "", pkgerrors.New(pkgerrors.CodeGitHubImportTooLarge, fmt.Sprintf(
			"github repository %s/%s is %d MB, over the %d MB import limit",
			owner, repo, sizeMB, maxMB))
	}
	return token, metadata.Private, strings.TrimSpace(metadata.DefaultBranch), nil
}

// githubImportSourceToken prefers a short-lived GitHub App installation token.
// A linked OAuth token remains the fallback for imports made before a
// repo_connection exists. Absence of either credential is not itself an error:
// the anonymous metadata probe below keeps public imports working and produces
// a terminal, user-visible error if GitHub hides a private repository with 404.
// The bool reports an installation token, which proves nothing about the
// user's own access.
func (s *GitHubImportService) githubImportSourceToken(ctx context.Context, userID int64, owner, repo string) (string, db.OauthAccount, bool, error) {
	if s.appTokens != nil {
		installation, err := s.appTokens.CreateGitHubInstallationToken(ctx, userID, owner, repo)
		if err == nil && strings.TrimSpace(installation.Token) != "" {
			return strings.TrimSpace(installation.Token), db.OauthAccount{}, true, nil
		}
	}
	token, account, err := s.loadGitHubOAuthToken(ctx, userID)
	return token, account, false, err
}

type githubRepoMetadata struct {
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	// SizeKB is GitHub's reported repository size in kilobytes. It is the only
	// pre-clone signal for how much scratch disk `git clone --mirror` will
	// consume, and the import refuses over budget rather than filling the API
	// pod's /tmp (see githubImportMaxSizeMB).
	SizeKB int64 `json:"size"`
}

// fetchGitHubRepoMetadata performs one GET /repos/{owner}/{repo} and returns the
// decoded metadata plus the raw HTTP status and response headers so the caller
// can apply the token/visibility/rate-limit decision tree (and refresh-retry on
// a credential-gone status). token may be empty for an anonymous (public-repo)
// probe. err is only non-nil for transport/decode failures — a non-2xx status
// is reported via the returned status code, not an error.
func (s *GitHubImportService) fetchGitHubRepoMetadata(ctx context.Context, token, owner, repo string) (githubRepoMetadata, int, http.Header, error) {
	reqURL := strings.TrimRight(githubAPIBaseURL(), "/") + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return githubRepoMetadata{}, 0, nil, pkgerrors.Internal("failed to build github repository request").WithCause(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return githubRepoMetadata{}, 0, nil, pkgerrors.Internal("github repository request failed").WithCause(err)
	}
	defer func() { _ = resp.Body.Close() }()
	responseHeader := resp.Header.Clone()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return githubRepoMetadata{}, resp.StatusCode, responseHeader, nil
	}

	var metadata githubRepoMetadata
	if err := json.Unmarshal(body, &metadata); err != nil {
		return githubRepoMetadata{}, resp.StatusCode, responseHeader, pkgerrors.Internal("failed to decode github repository response").WithCause(err)
	}
	return metadata, resp.StatusCode, responseHeader, nil
}

func githubRepoMetadataRateLimited(header http.Header) bool {
	for name := range header {
		if strings.EqualFold(name, "Retry-After") {
			return true
		}
	}
	return strings.TrimSpace(header.Get("X-RateLimit-Remaining")) == "0"
}

// refreshUserGitHubToken performs a single reactive refresh of the user's GitHub
// token after a credential-gone response and returns the rotated access token.
// It returns an error (leaving the caller on today's honest-401 behavior) when
// no refresher is wired or no refresh token is stored for the account.
func (s *GitHubImportService) refreshUserGitHubToken(ctx context.Context, account db.OauthAccount) (string, error) {
	if s.refresher == nil {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	token, err := s.refresher.RefreshUserGitHubToken(ctx, account)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(token) == "" {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	return token, nil
}

func (s *GitHubImportService) loadGitHubOAuthToken(ctx context.Context, userID int64) (string, db.OauthAccount, error) {
	accounts, err := s.tokenDB.ListUserOAuthAccounts(ctx, userID)
	if err != nil {
		return "", db.OauthAccount{}, fmt.Errorf("load github oauth account: %w", err)
	}
	// Prefer a real provider="github" account. Fall back to "workos" ONLY because
	// plue's WorkOS path is GitHub-backed (it stores a gho_* token under "workos");
	// a genuine WorkOS token must never shadow a real GitHub credential.
	fallbackIdx := -1
	for i := range accounts {
		switch strings.ToLower(strings.TrimSpace(accounts[i].Provider)) {
		case "github":
			token, err := s.decrypter.DecryptOAuthAccessToken(accounts[i].AccessTokenEncrypted)
			if err != nil {
				return "", db.OauthAccount{}, err
			}
			return s.proactivelyRefreshGitHubToken(ctx, accounts[i], strings.TrimSpace(token))
		case "workos":
			if fallbackIdx < 0 {
				fallbackIdx = i
			}
		}
	}
	if fallbackIdx >= 0 {
		token, err := s.decrypter.DecryptOAuthAccessToken(accounts[fallbackIdx].AccessTokenEncrypted)
		if err != nil {
			return "", db.OauthAccount{}, err
		}
		return s.proactivelyRefreshGitHubToken(ctx, accounts[fallbackIdx], strings.TrimSpace(token))
	}
	return "", db.OauthAccount{}, pgx.ErrNoRows
}

// proactivelyRefreshGitHubToken renews a token the persisted expiry says is dead
// (or nearly) BEFORE the import spends it. This matters more here than anywhere
// else: the token is handed to `git clone` via the credential env, and a git
// failure is an opaque exit status — never a *pkgerrors.APIError with status 401
// — so the reactive refresh-on-401 path cannot rescue it. A mirror clone that
// straddles the ~8h boundary would otherwise just fail the import.
func (s *GitHubImportService) proactivelyRefreshGitHubToken(ctx context.Context, account db.OauthAccount, token string) (string, db.OauthAccount, error) {
	proactive, ok := s.refresher.(githubUserTokenProactiveRefresher)
	if !ok {
		return token, account, nil
	}
	refreshed, err := proactive.RefreshUserGitHubTokenIfExpiring(ctx, account, token)
	if err != nil {
		return "", db.OauthAccount{}, err
	}
	return refreshed, account, nil
}

// cloneAndPushMirror is the FRESH-import mirror sync: clone the GitHub source and
// push it into the freshly-created (empty) repo-host storage with --mirror, which
// mirrors AND prunes the destination to match the source exactly. --mirror is
// only safe here because the storage was just created this run (nothing to prune).
func (s *GitHubImportService) cloneAndPushMirror(ctx context.Context, owner, repo, sourceToken, pushURL, pushToken, jobID string) error {
	return s.cloneAndSyncMirror(ctx, "mirror.clone", owner, repo, sourceToken, pushURL, pushToken, jobID, mirrorPushArgs, nil)
}

// stagedMirrorPushHeaders reads the headers a staged import's mirror push
// carries from the staged host, for each push.
func (s *GitHubImportService) stagedMirrorPushHeaders(ctx context.Context, staged repohost.StagedProvision) (http.Header, error) {
	host, ok := s.stagedRepoHost.(gitHubImportStagedGitHeaders)
	if !ok {
		return nil, nil
	}
	headers, err := host.StagedProvisionGitHeaders(ctx, staged)
	if err != nil {
		return nil, fmt.Errorf("read staged import push headers: %w", err)
	}
	return headers, nil
}

// cloneAndSyncMirror clones the GitHub source into a temp mirror and pushes it
// into repo-host storage. buildPushArgs decides the push refspecs so the same
// clone/push plumbing (temp dir, credential-free URL, GIT_CONFIG_* token
// discipline, cleanup) serves both the fresh --mirror push and the reuse-refresh
// non-pruning push. spanName names the trace span for the caller's phase.
// pushHeaders are sent with every push request.
func (s *GitHubImportService) cloneAndSyncMirror(ctx context.Context, spanName, owner, repo, sourceToken, pushURL, pushToken, jobID string, buildPushArgs func(gitDir, pushURL string) []string, pushHeaders http.Header) error {
	ctx, span := otel.Tracer("smithers-server").Start(ctx, spanName)
	span.SetAttributes(attribute.String("repo_owner", owner), attribute.String("repo_name", repo), attribute.String("mirror_id", jobID))
	defer span.End()

	mkdirTemp := s.mkdirTemp
	if mkdirTemp == nil {
		mkdirTemp = os.MkdirTemp
	}
	tmp, err := mkdirTemp("", "smithers-github-import-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	source := githubGitBaseURL() + url.PathEscape(owner) + "/" + url.PathEscape(repo) + ".git"
	localMirror := filepath.Join(tmp, repo+".git")
	started := time.Now()
	cloneEnv := nonInteractiveGitEnv()
	if t := strings.TrimSpace(sourceToken); t != "" {
		cloneEnv = append(cloneEnv, gitGitHubAuthEnv(t)...)
	}
	runGit := s.runGit
	if runGit == nil {
		runGit = runGitCombinedOutput
	}
	if out, err := runGit(ctx, cloneEnv, "clone", "--mirror", source, localMirror); err != nil {
		// Authentication/access refusals need a person; use the existing
		// terminal predicate instead of spending all twenty transient attempts.
		message := strings.ToLower(out)
		for _, refusal := range []string{"authentication failed", "could not read username", "repository not found", "requested url returned error: 401", "requested url returned error: 403", "requested url returned error: 404"} {
			if strings.Contains(message, refusal) {
				return terminalGitHubImportError{pkgerrors.Forbidden("Repository source access was refused")}
			}
		}
		return fmt.Errorf("clone github repo: %w: %s", err, strings.TrimSpace(out))
	}
	if progress, err := gitMirrorProgress(ctx, localMirror); err == nil {
		s.setProgress(ctx, jobID, progress)
	} else {
		slog.Warn("mirror.import.progress_measure_failed", "import_job_id", jobID, "error", err)
	}
	if s.metrics != nil {
		s.metrics.ObserveMirrorCloneDuration(time.Since(started).Seconds())
	}
	mirrorBytes, mirrorBytesErr := gitMirrorObjectBytes(ctx, localMirror)
	if mirrorBytesErr == nil && s.metrics != nil {
		s.metrics.ObserveMirrorCloneBytes(float64(mirrorBytes))
		span.SetAttributes(attribute.Int64("bytes_cloned", mirrorBytes))
	}
	if mirrorBytesErr == nil {
		if err := mirrorFitsStorageAllowance(pushHeaders, mirrorBytes); err != nil {
			return err
		}
	}
	s.setStage(ctx, jobID, importStagePushingMirror)
	pushEnv := nonInteractiveGitEnv()
	// The destination push credential also rides GIT_CONFIG_* env, never argv —
	// pushURL is deliberately credential-free (buildRepoCloneURL).
	if t := strings.TrimSpace(pushToken); t != "" {
		pushEnv = append(pushEnv, gitBearerAuthEnv(t, gitHeaderLines(pushHeaders)...)...)
	} else {
		return fmt.Errorf("push token is required")
	}
	if out, err := runGit(ctx, pushEnv, buildPushArgs(localMirror, pushURL)...); err != nil {
		return fmt.Errorf("push mirrored refs: %w: %s", err, strings.TrimSpace(withoutURLPath(out, pushURL)))
	}
	return nil
}

// withoutURLPath replaces rawURL in git's output with its scheme and host:
// a staged import's push URL carries the storage route's capability and its
// stage token (smithersai/plue#786), and a failed push names it.
func withoutURLPath(out, rawURL string) string {
	redacted := "repo-host"
	if parsed, err := url.Parse(rawURL); err == nil && parsed.Host != "" {
		redacted = parsed.Scheme + "://" + parsed.Host
	}
	return strings.ReplaceAll(out, rawURL, redacted)
}

func gitMirrorProgress(ctx context.Context, gitDir string) (ImportJobCounts, error) {
	refsOutput, err := sourceRetentionGitCommand(ctx, nonInteractiveGitEnv(), "--git-dir", gitDir, "for-each-ref", "--format=%(refname)").Output()
	if err != nil {
		return ImportJobCounts{}, fmt.Errorf("count mirror refs: %w", err)
	}
	refs := int64(0)
	for _, line := range strings.Split(strings.TrimSpace(string(refsOutput)), "\n") {
		if strings.TrimSpace(line) != "" {
			refs++
		}
	}

	objectsOutput, err := sourceRetentionGitCommand(ctx, nonInteractiveGitEnv(), "--git-dir", gitDir, "count-objects", "-v").Output()
	if err != nil {
		return ImportJobCounts{}, fmt.Errorf("count mirror objects: %w", err)
	}
	objects := int64(0)
	for _, line := range strings.Split(string(objectsOutput), "\n") {
		key, valueText, ok := strings.Cut(line, ":")
		if !ok || (strings.TrimSpace(key) != "count" && strings.TrimSpace(key) != "in-pack") {
			continue
		}
		value, parseErr := strconv.ParseInt(strings.TrimSpace(valueText), 10, 64)
		if parseErr != nil {
			return ImportJobCounts{}, fmt.Errorf("parse mirror object count: %w", parseErr)
		}
		objects += value
	}
	return ImportJobCounts{
		Refs:    ImportJobCount{Done: refs, Total: refs},
		Objects: ImportJobCount{Done: objects, Total: objects},
	}, nil
}

// mirrorPushArgs is the FRESH-import push: --mirror mirrors AND PRUNES the
// destination refs to match the source. Only safe against freshly-created,
// empty storage.
func mirrorPushArgs(gitDir, pushURL string) []string {
	return []string{"--git-dir", gitDir, "push", "--mirror", pushURL}
}

// nonPruningPushArgs is the reuse-refresh push: force-update GitHub's branch and
// tag namespaces WITHOUT --mirror. Force is correct — GitHub is the source of
// truth for its own branch namespace and provenance already proved this mirror
// belongs to that source — but because it is NOT --mirror, refs absent from
// GitHub (jjhub-created bookmarks, landing branches, committed user work) are
// NEVER pruned. This preserves #47 while still refreshing GitHub's own refs.
func nonPruningPushArgs(gitDir, pushURL string) []string {
	return []string{"--git-dir", gitDir, "push", "--force", pushURL, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"}
}

func runGitCombinedOutput(ctx context.Context, env []string, args ...string) (string, error) {
	cmd := sourceRetentionGitCommand(ctx, env, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func nonInteractiveGitEnv() []string {
	return sourceRetentionGitEnv("", "")
}

// gitBearerAuthEnv injects a bearer credential via env-based git config
// (GIT_CONFIG_*), NEVER on argv: an `-c http.extraHeader=…` flag — or a
// token embedded in the remote URL — leaks the credential to `ps`/proc for
// every local process for the whole clone/push. Env config keeps it off argv.
// Each of headers ("Name: value") rides beside the credential the same way.
func gitBearerAuthEnv(token string, headers ...string) []string {
	headers = append([]string{"Authorization: Bearer " + strings.TrimSpace(token)}, headers...)
	env := []string{"GIT_CONFIG_COUNT=" + strconv.Itoa(len(headers))}
	for i, header := range headers {
		env = append(env,
			fmt.Sprintf("GIT_CONFIG_KEY_%d=http.extraHeader", i),
			fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, header))
	}
	return env
}

// gitHeaderLines renders headers as http.extraHeader values, in name order.
func gitHeaderLines(headers http.Header) []string {
	names := slices.Sorted(maps.Keys(headers))
	var lines []string
	for _, name := range names {
		for _, value := range headers[name] {
			lines = append(lines, name+": "+value)
		}
	}
	return lines
}

// mirrorFitsStorageAllowance refuses, as the plan limit, a mirror larger
// than the storage allowance its push carries. mirrorBytes is measured as
// repo-host measures the repository it stores, so an owner at the storage
// limit is told so before the push rather than by a failed one; repo-host
// still caps the pack itself (smithersai/plue#768).
func mirrorFitsStorageAllowance(pushHeaders http.Header, mirrorBytes int64) error {
	raw := pushHeaders.Get(repohost.GitBytesAllowanceHeader)
	if raw == "" {
		return nil
	}
	allowance, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fmt.Errorf("parse storage allowance %q: %w", raw, err)
	}
	if mirrorBytes <= allowance {
		return nil
	}
	refusal := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "this import would exceed the storage limit for the current plan")
	refusal.LimitKind = BillingMetricStorageBytes
	return refusal
}

// GitHub's Git HTTPS endpoint uses the token as a Basic-auth password.
// Keep it in environment-based config, off process arguments and remote URLs.
func gitGitHubAuthEnv(token string) []string {
	credential := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + strings.TrimSpace(token)))
	return []string{
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http." + githubGitBaseURL() + ".extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Basic " + credential,
	}
}

func gitMirrorObjectBytes(ctx context.Context, gitDir string) (int64, error) {
	out, err := sourceRetentionGitCommand(ctx, nonInteractiveGitEnv(), "--git-dir", gitDir, "count-objects", "-v").Output()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, line := range strings.Split(string(out), "\n") {
		key, valueText, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		var value int64
		if _, err := fmt.Sscanf(strings.TrimSpace(valueText), "%d", &value); err == nil && (key == "size" || key == "size-pack") {
			total += value * 1024
		}
	}
	return total, nil
}

func (s *GitHubImportService) markFailed(ctx context.Context, jobID string, err error) error {
	msg := strings.TrimSpace(err.Error())
	if len(msg) > 2000 {
		msg = msg[:2000]
	}
	_, scanErr := s.scanImportJob(s.db.QueryRow(ctx, markImportJobFailedSQL, jobID, msg))
	return scanErr
}

func (s *GitHubImportService) observeFailure(stage string, err error) {
	if s.metrics == nil {
		return
	}
	reason := "error"
	if err != nil {
		reason = strings.ToLower(strings.ReplaceAll(strings.Fields(err.Error())[0], ":", ""))
	}
	s.metrics.ObserveMirrorFailure(stage, reason)
}

func (s *GitHubImportService) scanImportJob(row pgx.Row) (ImportJob, error) {
	return scanImportJobRow(row)
}

func (s *GitHubImportService) scanStartedImportJob(row pgx.Row) (ImportJob, bool, error) {
	var created bool
	job, err := scanImportJobRow(row, &created)
	return job, created, err
}

func scanImportJobRow(row pgx.Row, extraDestinations ...any) (ImportJob, error) {
	var (
		id           string
		userID       int64
		repositoryID pgtype.Int8
		workspaceID  pgtype.UUID
		githubOwner  string
		githubRepo   string
		repoOwner    string
		repoName     string
		branch       string
		target       string
		status       string
		stage        string
		refsDone     int64
		refsTotal    int64
		objectsDone  int64
		objectsTotal int64
		issuesDone   int64
		issuesTotal  int64
		errorMessage string
		createdAt    time.Time
		updatedAt    time.Time
	)
	destinations := []any{
		&id, &userID, &repositoryID, &workspaceID, &githubOwner, &githubRepo,
		&repoOwner, &repoName, &branch, &target, &status, &stage,
		&refsDone, &refsTotal, &objectsDone, &objectsTotal, &issuesDone, &issuesTotal, &errorMessage,
		&createdAt, &updatedAt,
	}
	destinations = append(destinations, extraDestinations...)
	err := row.Scan(destinations...)
	if err != nil {
		return ImportJob{}, err
	}
	job := ImportJob{
		ImportJobID:    id,
		RepoOwner:      repoOwner,
		RepoName:       repoName,
		TargetBookmark: targetWorkspaceBookmark(target),
		WorkspaceID:    UUIDString(workspaceID),
		Status:         status,
		Stage:          stage,
		Counts: ImportJobCounts{
			Refs:    ImportJobCount{Done: refsDone, Total: refsTotal},
			Objects: ImportJobCount{Done: objectsDone, Total: objectsTotal},
			Issues:  ImportJobCount{Done: issuesDone, Total: issuesTotal},
		},
		Error:       errorMessage,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
		userID:      userID,
		githubOwner: githubOwner,
		githubRepo:  githubRepo,
		branch:      branch,
	}
	if repositoryID.Valid {
		job.Repository = &ImportJobRepository{Owner: repoOwner, Name: repoName}
	}
	return job, nil
}
