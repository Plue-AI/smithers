package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

var repoNameRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
var ownerSegmentRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
var repoTopicRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,34}$`)

// reservedRepoNames blocks HTTP path-segment collisions for repository pages (REPO-003).
var reservedRepoNames = map[string]struct{}{
	"agent":        {},
	"bookmarks":    {},
	"changes":      {},
	"commits":      {},
	"contributors": {},
	"issues":       {},
	"labels":       {},
	"landings":     {},
	"milestones":   {},
	"operations":   {},
	"pulls":        {},
	"settings":     {},
	"stargazers":   {},
	"watchers":     {},
	"workflows":    {},
}

func isReservedRepoName(name string) bool {
	_, isReserved := reservedRepoNames[strings.ToLower(name)]
	return isReserved
}

// RepoQuerier defines the database operations needed by RepoService.
type RepoQuerier interface {
	CreateRepo(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error)
	CreateOrgRepo(ctx context.Context, arg db.CreateOrgRepoParams) (db.Repository, error)
	CreateForkRepo(ctx context.Context, arg db.CreateForkRepoParams) (db.Repository, error)
	DeleteRepo(ctx context.Context, id int64) error
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	UpdateRepo(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error)
	UpdateRepoTopics(ctx context.Context, arg db.UpdateRepoTopicsParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)

	CountRepoStars(ctx context.Context, repositoryID int64) (int64, error)
	CountRepoForks(ctx context.Context, forkID pgtype.Int8) (int64, error)
	IsRepoStarred(ctx context.Context, arg db.IsRepoStarredParams) (bool, error)

	ArchiveRepo(ctx context.Context, id int64) (db.Repository, error)
	UnarchiveRepo(ctx context.Context, id int64) (db.Repository, error)
	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	TransferRepoToUser(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error)
	TransferRepoToOrg(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error)
	DeleteCollaboratorsByRepo(ctx context.Context, repositoryID int64) error
	DeleteTeamReposByRepo(ctx context.Context, repositoryID int64) error
	ListCollaboratorsByRepo(ctx context.Context, repositoryID int64) ([]db.Collaborator, error)
	ListTeamReposByRepo(ctx context.Context, repositoryID int64) ([]db.TeamRepo, error)
	AddCollaborator(ctx context.Context, arg db.AddCollaboratorParams) (db.Collaborator, error)
	AddTeamRepo(ctx context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error)
}

// RepoHostClient defines the repo-host operations needed by RepoService.
type RepoHostClient interface {
	InitRepo(ctx context.Context, owner, repo, defaultBookmark string, autoInit bool) error
	DeleteRepo(ctx context.Context, owner, repo string) error
	ForkRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error
	MoveRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
	ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error)
	GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error)
}

// repoHostNotesReader exposes real Git notes refs independently of bookmarks.
type repoHostNotesReader interface {
	ListNotesRefs(ctx context.Context, owner, repo string) ([]repohost.NotesRef, error)
}

var _ repoHostNotesReader = (*repohost.Client)(nil)

// repoHostDefaultBookmarkSetter is the repo-host capability that keeps Git's
// HEAD symref aligned with repositories.default_bookmark. It is separate from
// the broad read/write interface so lightweight service consumers remain
// source-compatible, while UpdateRepo fails closed if a deployed repo-host
// client is too old to coordinate a default-bookmark change.
type repoHostDefaultBookmarkSetter interface {
	SetDefaultBookmark(ctx context.Context, owner, repo, name string) error
}

var _ repoHostDefaultBookmarkSetter = (*repohost.Client)(nil)

// repoHostStagedDeleteClient is the additional capability required for a
// coordinated repository deletion. Production repo-host clients implement
// it; failing closed here prevents an alternate client from silently falling
// back to deleting storage irreversibly before a fallible DB commit.
type repoHostStagedDeleteClient interface {
	StageDeleteRepo(ctx context.Context, owner, repo string) (repohost.StagedDelete, error)
	RestoreStagedDelete(ctx context.Context, staged repohost.StagedDelete) error
	FinalizeStagedDelete(ctx context.Context, staged repohost.StagedDelete) error
}

// repoHostPreparedDeleteClient separates handle preparation from the first
// storage mutation so the handle can be committed to PostgreSQL beforehand.
type repoHostPreparedDeleteClient interface {
	repoHostStagedDeleteClient
	PrepareStagedDelete(ctx context.Context, owner, repo string) (repohost.StagedDelete, error)
	ExecuteStagedDelete(ctx context.Context, staged repohost.StagedDelete) error
}

var _ repoHostStagedDeleteClient = (*repohost.Client)(nil)
var _ repoHostPreparedDeleteClient = (*repohost.Client)(nil)

// repoHostStagedMoveClient journals cross-namespace storage moves so an
// ambiguous HTTP response can be rolled back idempotently before the DB
// transaction is allowed to roll back.
type repoHostStagedMoveClient interface {
	StageMoveRepo(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (repohost.StagedMove, error)
	RollbackStagedMove(ctx context.Context, staged repohost.StagedMove) error
	FinalizeStagedMove(ctx context.Context, staged repohost.StagedMove) error
}

type repoHostPreparedMoveClient interface {
	repoHostStagedMoveClient
	PrepareStagedMove(ctx context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) (repohost.StagedMove, error)
	ExecuteStagedMove(ctx context.Context, staged repohost.StagedMove) error
}

var _ repoHostStagedMoveClient = (*repohost.Client)(nil)
var _ repoHostPreparedMoveClient = (*repohost.Client)(nil)
var _ repoHostProvisioningClient = (*repohost.Client)(nil)

// RepoService handles repository business logic.
type RepoService struct {
	pool                *pgxpool.Pool
	revocations         revocation.Publisher
	queries             RepoQuerier
	repoHost            RepoHostClient
	dispatcher          webhooks.Dispatcher
	activeStorageSetID  string
	placementResolver   repoPlacementResolver
	billing             BillingPolicy
	ownershipTx         repoOwnershipTxManager
	storageOperations   repositoryStorageOperationStore
	provisioning        RepositoryProvisioningStore
	provisioner         repoHostProvisioningClient
	provisioningEnabled bool
	productOnly         bool
	productProvisioning *productRepositoryProvisioner
}

// EnableDurableProvisioning contracts request-side creates after every legacy
// API pod has drained. Keeping reservations disabled during rolling overlap is
// required because old binaries do not include pending operations in quota
// counts.
func (s *RepoService) EnableDurableProvisioning() {
	if s != nil && s.provisioning != nil && s.provisioner != nil {
		s.provisioningEnabled = true
	}
}

func repositoryProvisioningRolloutError() error {
	return &errors.APIError{
		Status: http.StatusServiceUnavailable, Code: errors.CodeRepositoryProvisioningRollout,
		Message: "repository creation is temporarily unavailable during a provisioning rollout",
	}
}

// repoOwnershipTxManager begins a transaction holding a per-repository
// advisory lock for ownership-sensitive writes (transfer, delete, settings
// update). Abstracting this behind an interface keeps the service
// unit-testable without a real pgxpool.Pool.
type repoOwnershipTxManager interface {
	BeginOwnershipTx(ctx context.Context, repositoryID int64) (repoOwnershipTx, error)
}

// repoOwnershipTx is the query surface available inside the advisory-locked
// transaction, plus commit/rollback.
type repoOwnershipTx interface {
	// GetRepoByIDForUpdate re-reads the repository and locks its row until the
	// transaction ends, so ownership-dependent writers that lock the same row
	// (e.g. AddTeamRepoIfOrgRepo) serialize with the whole transaction.
	GetRepoByIDForUpdate(ctx context.Context, id int64) (db.Repository, error)
	DeleteCollaboratorsByRepo(ctx context.Context, repositoryID int64) error
	DeleteTeamReposByRepo(ctx context.Context, repositoryID int64) error
	TransferRepoToUser(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error)
	TransferRepoToOrg(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error)
	UpdateRepo(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error)
	DeleteRepo(ctx context.Context, id int64) error
	AuthorizeStorageOperation(ctx context.Context, token string) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// repoOwnershipDBTransaction exposes the already-open production transaction
// to policy extensions that must share its connection and lock lifetime. It is
// intentionally optional so lightweight ownership transaction fakes and
// alternate implementations keep the smaller repoOwnershipTx contract.
type repoOwnershipDBTransaction interface {
	OwnershipDBTX() db.DBTX
}

// pgxRepoOwnershipTxManager is the production implementation backed by pgxpool.
type pgxRepoOwnershipTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxRepoOwnershipTxManager) BeginOwnershipTx(ctx context.Context, repositoryID int64) (repoOwnershipTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	// Transaction-scoped advisory lock keyed by repository id. It serializes
	// ownership-sensitive writes for one repository across all API replicas
	// and is released automatically at commit/rollback.
	if _, err := tx.Exec(ctx, repoOwnershipLockSQL, repositoryID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return &pgxRepoOwnershipTx{tx: tx, q: db.New(tx)}, nil
}

type pgxRepoOwnershipTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxRepoOwnershipTx) OwnershipDBTX() db.DBTX {
	return t.tx
}

func (t *pgxRepoOwnershipTx) GetRepoByIDForUpdate(ctx context.Context, id int64) (db.Repository, error) {
	return t.q.GetRepoByIDForUpdate(ctx, id)
}

func (t *pgxRepoOwnershipTx) DeleteCollaboratorsByRepo(ctx context.Context, repositoryID int64) error {
	return t.q.DeleteCollaboratorsByRepo(ctx, repositoryID)
}

func (t *pgxRepoOwnershipTx) DeleteTeamReposByRepo(ctx context.Context, repositoryID int64) error {
	return t.q.DeleteTeamReposByRepo(ctx, repositoryID)
}

func (t *pgxRepoOwnershipTx) TransferRepoToUser(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
	return t.q.TransferRepoToUser(ctx, arg)
}

func (t *pgxRepoOwnershipTx) TransferRepoToOrg(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error) {
	return t.q.TransferRepoToOrg(ctx, arg)
}

func (t *pgxRepoOwnershipTx) UpdateRepo(ctx context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
	return t.q.UpdateRepo(ctx, arg)
}

func (t *pgxRepoOwnershipTx) DeleteRepo(ctx context.Context, id int64) error {
	return t.q.DeleteRepo(ctx, id)
}

func (t *pgxRepoOwnershipTx) AuthorizeStorageOperation(ctx context.Context, token string) error {
	_, err := t.tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	return err
}

func (t *pgxRepoOwnershipTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxRepoOwnershipTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

// repoOwnershipUnchanged reports whether the fresh row still has the same
// identity, owner, and name as the snapshot the caller authorized against.
// It fences authorization decisions against concurrent transfers/renames.
func repoOwnershipUnchanged(fresh, snapshot db.Repository) bool {
	return fresh.ID == snapshot.ID &&
		fresh.UserID == snapshot.UserID &&
		fresh.OrgID == snapshot.OrgID &&
		fresh.LowerName == snapshot.LowerName
}

type repositoryOwnerNameQuerier interface {
	GetUserByID(context.Context, int64) (db.User, error)
	GetOrgByID(context.Context, int64) (db.Organization, error)
}

// canonicalRepositoryOwner returns the exact path segment used when storage
// was provisioned. Repository lookup is intentionally case-insensitive, but
// repo-host paths are not; forwarding request casing can make valid storage
// unreachable or stage the wrong physical namespace on case-sensitive hosts.
func (s *RepoService) canonicalRepositoryOwner(ctx context.Context, repository db.Repository, requestOwner string) (string, error) {
	loader, ok := s.queries.(repositoryOwnerNameQuerier)
	if !ok {
		// Lightweight unit-test queriers predate the canonical loader. Production
		// db.Queries always implements it; keep alternate clients compatible when
		// durable operation storage is disabled.
		if s.storageOperations == nil {
			return strings.TrimSpace(requestOwner), nil
		}
		return "", errors.Internal("failed to resolve repository owner")
	}
	if repository.UserID.Valid && !repository.OrgID.Valid {
		user, err := loader.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return "", errors.Internal("failed to resolve repository owner").WithCause(err)
		}
		return user.Username, nil
	}
	if repository.OrgID.Valid && !repository.UserID.Valid {
		org, err := loader.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return "", errors.Internal("failed to resolve repository owner").WithCause(err)
		}
		return org.Name, nil
	}
	return "", errors.Internal("failed to resolve repository owner")
}

func isRepositoryStorageOperationConflict(err error) bool {
	if stdErrors.Is(err, errRepositoryStorageOperationExists) {
		return true
	}
	var pgErr *pgconn.PgError
	return stdErrors.As(err, &pgErr) && pgErr.Code == "55006" &&
		strings.Contains(strings.ToLower(pgErr.Message), "repository storage operation")
}

type UpdateRepoRequest struct {
	Name                       *string   `json:"name,omitempty"`
	Description                *string   `json:"description,omitempty"`
	Private                    *bool     `json:"private,omitempty"`
	DefaultBookmark            *string   `json:"default_bookmark,omitempty"`
	Topics                     *[]string `json:"topics,omitempty"`
	LandingQueueMode           *string   `json:"landing_queue_mode,omitempty"`
	LandingQueueRequiredChecks *[]string `json:"landing_queue_required_checks,omitempty"`
}

type RepoContent struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	SHA      string `json:"sha"`
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
	Size     int64  `json:"size"`
}

type GitRefObject struct {
	SHA  string `json:"sha"`
	Type string `json:"type"`
}

type GitRef struct {
	Ref    string       `json:"ref"`
	Object GitRefObject `json:"object"`
}

// repoPlacementResolver belongs to the private Plue repository adapter. Product
// repository rows contain no deployment placement; lookups use the stable ID.
type repoPlacementResolver interface {
	StorageSetForRepository(ctx context.Context, repositoryID int64) (string, error)
}

type RepoServiceOption func(*RepoService)

func WithRepoPlacementResolver(resolver repoPlacementResolver) RepoServiceOption {
	return func(s *RepoService) { s.placementResolver = resolver }
}

func WithRepoWebhookDispatcher(dispatcher webhooks.Dispatcher) RepoServiceOption {
	return func(s *RepoService) {
		s.dispatcher = dispatcher
	}
}

func WithRepoBillingPolicy(policy BillingPolicy) RepoServiceOption {
	return func(s *RepoService) {
		s.billing = policy
	}
}

// NewRepoService creates a new RepoService.
func NewRepoService(q RepoQuerier, rh RepoHostClient, activeStorageSet string, opts ...RepoServiceOption) *RepoService {
	if activeStorageSet == "" {
		activeStorageSet = DefaultStorageSetID
	}
	s := &RepoService{queries: q, repoHost: rh, activeStorageSetID: activeStorageSet}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// NewProductRepoServiceWithPool builds repository behavior against the shared
// product schema. Placement and cluster operation journals are supplied only
// by private deployment adapters, never inferred from a product row.
func NewProductRepoServiceWithPool(q RepoQuerier, rh RepoHostClient, pool *pgxpool.Pool, opts ...RepoServiceOption) *RepoService {
	s := &RepoService{queries: q, repoHost: rh, pool: pool, productOnly: true}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	if pool != nil {
		s.ownershipTx = &pgxRepoOwnershipTxManager{pool: pool}
		s.storageOperations = newPostgresRepositoryStorageOperationStore(pool)
		if provisioner, ok := rh.(repoHostProvisioningClient); ok {
			s.productProvisioning = &productRepositoryProvisioner{pool: pool, host: provisioner}
		}
	}
	return s
}

// WithRepoProvisioningStore injects the deployment journal. A staged host with
// no journal refuses creates rather than running an unjournaled fallback.
func WithRepoProvisioningStore(store RepositoryProvisioningStore) RepoServiceOption {
	return func(s *RepoService) { s.provisioning = store }
}

// NewRepoServiceWithPool returns a RepoService whose ownership-sensitive
// writes (transfer, delete, settings update) run inside a per-repository
// advisory-locked transaction, so concurrent transfers serialize and stale
// authorization snapshots are re-validated before mutating.
func NewRepoServiceWithPool(q RepoQuerier, rh RepoHostClient, activeStorageSet string, pool *pgxpool.Pool, opts ...RepoServiceOption) *RepoService {
	s := NewRepoService(q, rh, activeStorageSet, opts...)
	s.pool = pool
	if pool != nil {
		s.ownershipTx = &pgxRepoOwnershipTxManager{pool: pool}
		s.storageOperations = newPostgresRepositoryStorageOperationStore(pool)
		if provisioner, ok := rh.(repoHostProvisioningClient); ok {
			s.provisioner = provisioner
		}
	}
	return s
}

func normalizeDefaultBookmark(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "main"
	}
	return trimmed
}

func validateDefaultBookmark(name string) error {
	if utf8.RuneCountInString(name) > 255 {
		return errors.ValidationFailed(errors.FieldError{
			Resource: "Repository",
			Field:    "default_bookmark",
			Code:     "invalid",
		})
	}
	if err := repohost.ValidateBookmarkName(name); err != nil {
		return errors.ValidationFailed(errors.FieldError{
			Resource: "Repository",
			Field:    "default_bookmark",
			Code:     "invalid",
		})
	}
	return nil
}

const (
	repoProvisionStorageCleanupTimeout = repoHostMutationConsistencyTimeout
	repoProvisionDBCleanupTimeout      = 10 * time.Second
)

type repositoryCreateErrorKind uint8

const (
	repositoryCreateErrorDefinitive repositoryCreateErrorKind = iota
	repositoryCreateErrorConflict
	repositoryCreateErrorAmbiguous
)

// classifyRepositoryCreateError distinguishes a database rejection from a
// transport/result ambiguity. pgx exposes server-side errors as *pgconn.PgError:
// those are definitive, with 23505 retaining the existing conflict mapping.
// The legacy textual uniqueness fallback is also retained for alternate
// queriers and tests. Only other errors can represent a committed statement
// whose RETURNING row was lost and therefore qualify for reconciliation.
func classifyRepositoryCreateError(err error) repositoryCreateErrorKind {
	if err == nil {
		return repositoryCreateErrorDefinitive
	}
	var pgErr *pgconn.PgError
	if stdErrors.As(err, &pgErr) {
		if pgErr.Code == "23505" {
			return repositoryCreateErrorConflict
		}
		return repositoryCreateErrorDefinitive
	}
	if isRepoUniqueViolation(err) {
		return repositoryCreateErrorConflict
	}
	return repositoryCreateErrorAmbiguous
}

type repositoryCreateExpectation struct {
	UserID          pgtype.Int8
	OrgID           pgtype.Int8
	Name            string
	LowerName       string
	Description     string
	IsPublic        bool
	DefaultBookmark string
	IsFork          bool
	ForkID          pgtype.Int8
	NotBefore       time.Time
}

type repositoryCreateReconciliation uint8

const (
	repositoryCreateUnresolved repositoryCreateReconciliation = iota
	repositoryCreateConflicting
	repositoryCreateAdopted
)

type repositoryByOwnerLookup func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)

// reconcileAmbiguousRepositoryCreate looks up the unique owner/name key on a
// detached, bounded context. A row is safe to adopt only when it is no older
// than this request and exactly matches every field the failed INSERT supplied.
// Anything else may belong to a prior or concurrent non-identical request.
func reconcileAmbiguousRepositoryCreate(
	parent context.Context,
	lookup repositoryByOwnerLookup,
	owner string,
	expected repositoryCreateExpectation,
) (db.Repository, repositoryCreateReconciliation, error) {
	reconcileCtx, cancel := context.WithTimeout(context.WithoutCancel(parent), repoProvisionDBCleanupTimeout)
	defer cancel()

	recovered, err := lookup(reconcileCtx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     owner,
		LowerName: expected.LowerName,
	})
	if err != nil {
		return db.Repository{}, repositoryCreateUnresolved, err
	}
	if !repositoryMatchesCreateExpectation(recovered, expected) {
		return db.Repository{}, repositoryCreateConflicting, nil
	}
	return recovered, repositoryCreateAdopted, nil
}

func repositoryMatchesCreateExpectation(repository db.Repository, expected repositoryCreateExpectation) bool {
	return repository.ID > 0 &&
		repository.UserID == expected.UserID &&
		repository.OrgID == expected.OrgID &&
		repository.Name == expected.Name &&
		repository.LowerName == expected.LowerName &&
		repository.Description == expected.Description &&
		repository.IsPublic == expected.IsPublic &&
		repository.DefaultBookmark == expected.DefaultBookmark &&
		repository.IsFork == expected.IsFork &&
		repository.ForkID == expected.ForkID &&
		!repository.CreatedAt.Before(expected.NotBefore)
}

func isRepoHostAlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	var statusErr *repohost.StatusError
	if !stdErrors.As(err, &statusErr) || (statusErr.StatusCode != 400 && statusErr.StatusCode != 409) {
		return false
	}
	return strings.Contains(strings.ToLower(statusErr.Message), "already exists")
}

// rollbackProvisionedRepo compensates a failed create/fork in dependency
// order. The repo-host client resolves the repository's storage set through
// the database row, so storage must be removed before that row is deleted.
// Cleanup is detached from the request cancellation so a client timeout does
// not leave a permanently conflicting on-disk repository behind.
func (s *RepoService) rollbackProvisionedRepo(ctx context.Context, repositoryID int64, owner, repo string) {
	storageCtx, cancelStorage := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionStorageCleanupTimeout)
	storageErr := s.repoHost.DeleteRepo(storageCtx, owner, repo)
	if storageErr != nil && !isRepoHostStatus(storageErr, 404) {
		slog.Error("failed to clean up repository storage after provisioning failure",
			"repo_id", repositoryID, "owner", owner, "repo_name", repo,
			"database_row_preserved", true, "error", storageErr)
		cancelStorage()
		// Preserve the row that resolves this physical namespace. Deleting it
		// after an ambiguous/failed storage cleanup would orphan any surviving
		// repository and let a later same-name create collide with or delete it.
		return
	}
	cancelStorage()

	dbCtx, cancelDB := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
	defer cancelDB()
	if err := s.queries.DeleteRepo(dbCtx, repositoryID); err != nil {
		slog.Error("failed to clean up repository row after provisioning failure",
			"repo_id", repositoryID, "owner", owner, "repo_name", repo, "error", err)
	}
}

func (s *RepoService) finishDurableRepositoryProvision(
	ctx context.Context,
	wanted repositoryProvisioningOperation,
	ownerType string,
	ownerID int64,
) (db.Repository, error) {
	var operation repositoryProvisioningOperation
	existing, found, findErr := s.provisioning.FindExact(ctx, wanted)
	switch {
	case findErr == nil && found:
		// The reservation already consumed quota under the owner's lock. Running
		// admission again would count this same pending private repo and can deny
		// the exact retry at the plan limit.
		operation = existing
	case stdErrors.Is(findErr, errRepositoryProvisionMismatch):
		return db.Repository{}, errors.Conflict(fmt.Sprintf("repository '%s' already exists", wanted.Name))
	case findErr != nil:
		return db.Repository{}, errors.Internal("failed to inspect repository provisioning retry")
	default:
		if err := authorizeRepoCreateThenCommit(ctx, s.billing, ownerType, ownerID, !wanted.IsPublic, func(commitCtx context.Context) error {
			reserved, reserveErr := s.provisioning.Reserve(commitCtx, wanted)
			if reserveErr != nil {
				return reserveErr
			}
			operation = reserved
			return nil
		}); err != nil {
			// A concurrent identical request can reserve between the optimistic
			// FindExact above and this request's quota decision. Recheck after any
			// admission failure so the same pending allocation is adopted instead
			// of being denied against quota it already consumes.
			recheck, recheckFound, recheckErr := s.provisioning.FindExact(ctx, wanted)
			if recheckErr == nil && recheckFound {
				operation = recheck
			} else {
				switch {
				case stdErrors.Is(err, errRepositoryProvisionConflict), stdErrors.Is(err, errRepositoryProvisionMismatch):
					return db.Repository{}, errors.Conflict(fmt.Sprintf("repository '%s' already exists", wanted.Name))
				default:
					return db.Repository{}, err
				}
			}
		}
	}

	consistencyCtx, cancel, err := beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
	if err != nil {
		return db.Repository{}, err
	}
	defer cancel()
	claimToken := newRepositoryProvisionClaimToken()
	if claimErr := s.provisioning.AcquireProcessing(
		consistencyCtx, operation.RepositoryID, operation.Token, claimToken,
	); claimErr != nil {
		if stdErrors.Is(claimErr, errRepositoryProvisionInProgress) {
			return db.Repository{}, errors.Conflict("repository provisioning is already in progress")
		}
		return db.Repository{}, errors.Internal("failed to claim repository provisioning operation").WithCause(claimErr)
	}
	operation.ClaimToken = pgtype.Text{String: claimToken, Valid: true}
	settled := false
	defer func() {
		if !settled {
			releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer releaseCancel()
			s.provisioning.ReleaseClaim(releaseCtx, operation, claimToken,
				stdErrors.New("request-side repository provisioning did not settle"))
		}
	}()
	staged := operation.staged()
	if repository, published, lookupErr := s.provisioning.GetPublished(consistencyCtx, operation); lookupErr != nil {
		return db.Repository{}, errors.Internal("failed to reconcile reserved repository").WithCause(lookupErr)
	} else if published {
		if renewErr := s.provisioning.RenewClaim(consistencyCtx, operation.RepositoryID, operation.Token, claimToken); renewErr != nil {
			return db.Repository{}, errors.Conflict("repository provisioning claim changed")
		}
		if finalizeErr := s.provisioner.FinalizeStagedProvision(consistencyCtx, staged); finalizeErr != nil {
			slog.Error("published repository provisioning journal requires reconciliation",
				"repo_id", operation.RepositoryID, "error", finalizeErr)
			return repository, nil
		}
		if renewErr := s.provisioning.RenewClaim(consistencyCtx, operation.RepositoryID, operation.Token, claimToken); renewErr != nil {
			return repository, nil
		}
		completeErr := s.provisioning.Complete(consistencyCtx, operation.RepositoryID, operation.Token, claimToken)
		if completeErr != nil && !stdErrors.Is(completeErr, errRepositoryProvisionMissing) {
			slog.Error("published repository provisioning intent requires reconciliation",
				"repo_id", operation.RepositoryID, "error", completeErr)
		} else {
			settled = true
		}
		return repository, nil
	}
	if err := s.provisioner.ExecuteStagedProvision(consistencyCtx, staged); err != nil {
		if isDefinitiveProvisionConflict(err) {
			abortErr := s.provisioning.Abort(consistencyCtx, operation, claimToken, func(abortCtx context.Context) error {
				return s.provisioner.AbortStagedProvision(abortCtx, staged)
			})
			if abortErr == nil || stdErrors.Is(abortErr, errRepositoryProvisionMissing) {
				settled = true
				return db.Repository{}, errors.Conflict(fmt.Sprintf("repository '%s' already exists", operation.Name))
			}
			slog.Error("failed to abort definitive repository provisioning conflict",
				"repo_id", operation.RepositoryID, "error", abortErr)
		}
		return db.Repository{}, errors.Internal("failed to stage repository storage").WithCause(err)
	}
	if renewErr := s.provisioning.RenewClaim(consistencyCtx, operation.RepositoryID, operation.Token, claimToken); renewErr != nil {
		return db.Repository{}, errors.Conflict("repository provisioning claim changed")
	}
	if err := s.provisioner.PublishStagedProvision(consistencyCtx, staged); err != nil {
		if isDefinitiveProvisionConflict(err) {
			abortErr := s.provisioning.Abort(consistencyCtx, operation, claimToken, func(abortCtx context.Context) error {
				return s.provisioner.AbortStagedProvision(abortCtx, staged)
			})
			if abortErr == nil || stdErrors.Is(abortErr, errRepositoryProvisionMissing) {
				settled = true
				return db.Repository{}, errors.Conflict(fmt.Sprintf("repository '%s' already exists", operation.Name))
			}
			slog.Error("failed to abort repository publish conflict", "repo_id", operation.RepositoryID, "error", abortErr)
		}
		return db.Repository{}, errors.Internal("failed to publish repository storage").WithCause(err)
	}
	if err := s.provisioning.RenewClaim(consistencyCtx, operation.RepositoryID, operation.Token, claimToken); err != nil {
		return db.Repository{}, errors.Conflict("repository provisioning claim changed")
	}
	if err := s.provisioning.MarkPublishReady(consistencyCtx, operation.RepositoryID, operation.Token, claimToken); err != nil {
		return db.Repository{}, errors.Internal("failed to record published repository storage").WithCause(err)
	}
	operation.PublishReady = true
	repository, err := s.provisioning.Publish(consistencyCtx, operation, claimToken)
	if err != nil {
		slog.Error("failed to publish reserved repository row", "repo_id", operation.RepositoryID, "error", err)
		return db.Repository{}, errors.Internal("failed to publish repository").WithCause(err)
	}
	if err := s.provisioner.FinalizeStagedProvision(consistencyCtx, staged); err != nil {
		// The stable row and live storage are already exact. Leave the operation
		// fence for the reconciler, but report the successful create to avoid a
		// client retry being mistaken for an unrelated namespace collision.
		slog.Error("repository provisioning journal requires reconciliation",
			"repo_id", operation.RepositoryID, "error", err)
		return repository, nil
	}
	if renewErr := s.provisioning.RenewClaim(consistencyCtx, operation.RepositoryID, operation.Token, claimToken); renewErr != nil {
		return repository, nil
	}
	completeErr := s.provisioning.Complete(consistencyCtx, operation.RepositoryID, operation.Token, claimToken)
	if completeErr != nil && !stdErrors.Is(completeErr, errRepositoryProvisionMissing) {
		slog.Error("repository provisioning intent requires reconciliation",
			"repo_id", operation.RepositoryID, "error", completeErr)
	} else {
		settled = true
	}
	return repository, nil
}

func isDefinitiveProvisionConflict(err error) bool {
	var statusErr *repohost.StatusError
	if !stdErrors.As(err, &statusErr) {
		return false
	}
	return statusErr.StatusCode == 409 && (statusErr.Code == "destination_occupied" || statusErr.Code == "provision_completed")
}

// CreateRepo validates inputs, creates the repo in the DB, and initializes it on disk.
func (s *RepoService) CreateRepo(
	ctx context.Context,
	user *db.User,
	name, description string,
	isPublic bool,
	defaultBookmark string,
	autoInit bool,
) (db.Repository, error) {
	requestStartedAt := time.Now().UTC()
	if user == nil {
		return db.Repository{}, errors.Unauthorized("authentication required")
	}
	name = strings.TrimSpace(name)
	defaultBookmark = normalizeDefaultBookmark(defaultBookmark)

	if err := validateRepoName(name); err != nil {
		return db.Repository{}, err
	}
	if err := validateDefaultBookmark(defaultBookmark); err != nil {
		return db.Repository{}, err
	}

	createParams := db.CreateRepoParams{
		UserID:          pgtype.Int8{Int64: user.ID, Valid: true},
		Name:            name,
		LowerName:       strings.ToLower(name),
		Description:     description,
		IsPublic:        isPublic,
		DefaultBookmark: defaultBookmark,
	}
	if s.productOnly {
		repository, err := s.createProductRepository(ctx, productCreationSpec{
			OperationType: repositoryProvisionInit, ActorID: user.ID,
			UserID: pgtype.Int8{Int64: user.ID, Valid: true}, OwnerName: user.Username,
			Name: name, LowerName: createParams.LowerName, Description: description,
			IsPublic: isPublic, DefaultBookmark: defaultBookmark, AutoInit: autoInit,
		}, BillingOwnerTypeUser, user.ID)
		if err != nil {
			return db.Repository{}, err
		}
		_ = s.dispatchRepositoryEvent(ctx, repository, user, webhooks.EventTypeCreate, "created")
		return repository, nil
	}
	if s.provisioner != nil {
		if s.provisioning == nil || !s.provisioningEnabled {
			return db.Repository{}, repositoryProvisioningRolloutError()
		}
		staged, prepareErr := s.provisioner.PrepareStagedInit(
			ctx, s.activeStorageSetID, user.Username, name, defaultBookmark, autoInit)
		if prepareErr != nil {
			return db.Repository{}, errors.Internal("failed to prepare repository storage").WithCause(prepareErr)
		}
		wanted := newInitProvisioningOperation(
			user.ID,
			createParams.UserID, pgtype.Int8{}, user.Username,
			repositoryProvisionParams{
				Name: name, LowerName: createParams.LowerName, Description: description,
				IsPublic: isPublic, DefaultBookmark: defaultBookmark, AutoInit: autoInit,
			}, staged, repositoryProvisionInit,
		)
		repository, provisionErr := s.finishDurableRepositoryProvision(
			ctx, wanted, BillingOwnerTypeUser, user.ID)
		if provisionErr != nil {
			return db.Repository{}, provisionErr
		}
		_ = s.dispatchRepositoryEvent(ctx, repository, user, webhooks.EventTypeCreate, "created")
		return repository, nil
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
	var repo db.Repository
	err := authorizeRepoCreateThenCommit(ctx, s.billing, BillingOwnerTypeUser, user.ID, !isPublic, func(commitCtx context.Context) error {
		var createErr error
		repo, createErr = s.queries.CreateRepo(commitCtx, createParams)
		adopted := false
		if createErr != nil {
			switch classifyRepositoryCreateError(createErr) {
			case repositoryCreateErrorConflict:
				return errors.Conflict(fmt.Sprintf("repository '%s' already exists", name))
			case repositoryCreateErrorDefinitive:
				slog.Error("failed to create repository record", "repo_name", name, "error", createErr)
				return errors.Internal("failed to create repository").WithCause(createErr)
			case repositoryCreateErrorAmbiguous:
				recovered, state, lookupErr := reconcileAmbiguousRepositoryCreate(commitCtx, s.queries.GetRepoByOwnerAndLowerName, user.Username, expected)
				if state == repositoryCreateConflicting {
					return errors.Conflict(fmt.Sprintf("repository '%s' already exists", name))
				}
				if state != repositoryCreateAdopted {
					slog.Error("failed to reconcile ambiguous repository creation",
						"repo_name", name, "create_error", createErr, "lookup_error", lookupErr)
					return errors.Internal("failed to create repository")
				}
				repo = recovered
				adopted = true
			}
		}

		if initErr := runRepoHostMutation(commitCtx, func(mutationCtx context.Context) error {
			return s.repoHost.InitRepo(mutationCtx, user.Username, name, defaultBookmark, autoInit)
		}); initErr != nil {
			if adopted && isRepoHostAlreadyExists(initErr) {
				return nil
			}
			slog.Error("failed to initialize repository on disk", "owner", user.Username, "repo_name", name, "error", initErr)
			if adopted {
				// The INSERT result was ambiguous, so an exact recovered row may
				// belong to a concurrent identical request. Never compensate by
				// deleting shared metadata or storage when ownership cannot be
				// proven; a later retry/operator can converge repo-host safely.
				return errors.Internal("failed to initialize repository")
			}
			s.rollbackProvisionedRepo(commitCtx, repo.ID, user.Username, name)
			return errors.Internal("failed to initialize repository").WithCause(initErr)
		}
		return nil
	})
	if err != nil {
		return db.Repository{}, err
	}

	_ = s.dispatchRepositoryEvent(ctx, repo, user, webhooks.EventTypeCreate, "created")

	return repo, nil
}

// CreateOrgRepo validates input, verifies org ownership, creates the repo in DB, and initializes it on disk.
func (s *RepoService) CreateOrgRepo(
	ctx context.Context,
	actor *db.User,
	orgName, name, description string,
	isPublic bool,
	defaultBookmark string,
	autoInit bool,
) (db.Repository, error) {
	requestStartedAt := time.Now().UTC()
	if actor == nil {
		return db.Repository{}, errors.Unauthorized("authentication required")
	}

	name = strings.TrimSpace(name)
	defaultBookmark = normalizeDefaultBookmark(defaultBookmark)
	if err := validateRepoName(name); err != nil {
		return db.Repository{}, err
	}
	if err := validateDefaultBookmark(defaultBookmark); err != nil {
		return db.Repository{}, err
	}

	lowerOrg := strings.ToLower(strings.TrimSpace(orgName))
	if lowerOrg == "" {
		return db.Repository{}, errors.BadRequest("organization name is required")
	}

	org, err := s.queries.GetOrgByLowerName(ctx, lowerOrg)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, errors.NotFound("organization not found")
		}
		return db.Repository{}, errors.Internal("failed to load organization").WithCause(err)
	}

	member, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         actor.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, errors.Forbidden("insufficient organization permissions")
		}
		return db.Repository{}, errors.Internal("failed to load organization membership").WithCause(err)
	}
	if strings.ToLower(strings.TrimSpace(member.Role)) != "owner" {
		return db.Repository{}, errors.Forbidden("insufficient organization permissions")
	}

	createParams := db.CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            name,
		LowerName:       strings.ToLower(name),
		Description:     description,
		IsPublic:        isPublic,
		DefaultBookmark: defaultBookmark,
	}
	if s.productOnly {
		repository, err := s.createProductRepository(ctx, productCreationSpec{
			OperationType: repositoryProvisionInit, ActorID: actor.ID,
			OrgID: pgtype.Int8{Int64: org.ID, Valid: true}, OwnerName: org.Name,
			Name: name, LowerName: createParams.LowerName, Description: description,
			IsPublic: isPublic, DefaultBookmark: defaultBookmark, AutoInit: autoInit,
		}, BillingOwnerTypeOrg, org.ID)
		if err != nil {
			return db.Repository{}, err
		}
		_ = s.dispatchRepositoryEvent(ctx, repository, actor, webhooks.EventTypeCreate, "created")
		return repository, nil
	}
	if s.provisioner != nil {
		if s.provisioning == nil || !s.provisioningEnabled {
			return db.Repository{}, repositoryProvisioningRolloutError()
		}
		staged, prepareErr := s.provisioner.PrepareStagedInit(
			ctx, s.activeStorageSetID, org.Name, name, defaultBookmark, autoInit)
		if prepareErr != nil {
			return db.Repository{}, errors.Internal("failed to prepare repository storage").WithCause(prepareErr)
		}
		wanted := newInitProvisioningOperation(
			actor.ID,
			pgtype.Int8{}, createParams.OrgID, org.Name,
			repositoryProvisionParams{
				Name: name, LowerName: createParams.LowerName, Description: description,
				IsPublic: isPublic, DefaultBookmark: defaultBookmark, AutoInit: autoInit,
			}, staged, repositoryProvisionInit,
		)
		repository, provisionErr := s.finishDurableRepositoryProvision(
			ctx, wanted, BillingOwnerTypeOrg, org.ID)
		if provisionErr != nil {
			return db.Repository{}, provisionErr
		}
		_ = s.dispatchRepositoryEvent(ctx, repository, actor, webhooks.EventTypeCreate, "created")
		return repository, nil
	}
	expected := repositoryCreateExpectation{
		OrgID:           createParams.OrgID,
		Name:            createParams.Name,
		LowerName:       createParams.LowerName,
		Description:     createParams.Description,
		IsPublic:        createParams.IsPublic,
		DefaultBookmark: createParams.DefaultBookmark,
		NotBefore:       requestStartedAt,
	}
	var repo db.Repository
	err = authorizeRepoCreateThenCommit(ctx, s.billing, BillingOwnerTypeOrg, org.ID, !isPublic, func(commitCtx context.Context) error {
		var createErr error
		repo, createErr = s.queries.CreateOrgRepo(commitCtx, createParams)
		adopted := false
		if createErr != nil {
			switch classifyRepositoryCreateError(createErr) {
			case repositoryCreateErrorConflict:
				return errors.Conflict(fmt.Sprintf("repository '%s' already exists", name))
			case repositoryCreateErrorDefinitive:
				slog.Error("failed to create org repository record", "org", orgName, "repo_name", name, "error", createErr)
				return errors.Internal("failed to create repository").WithCause(createErr)
			case repositoryCreateErrorAmbiguous:
				recovered, state, lookupErr := reconcileAmbiguousRepositoryCreate(commitCtx, s.queries.GetRepoByOwnerAndLowerName, org.Name, expected)
				if state == repositoryCreateConflicting {
					return errors.Conflict(fmt.Sprintf("repository '%s' already exists", name))
				}
				if state != repositoryCreateAdopted {
					slog.Error("failed to reconcile ambiguous organization repository creation",
						"org", orgName, "repo_name", name, "create_error", createErr, "lookup_error", lookupErr)
					return errors.Internal("failed to create repository")
				}
				repo = recovered
				adopted = true
			}
		}

		if initErr := runRepoHostMutation(commitCtx, func(mutationCtx context.Context) error {
			return s.repoHost.InitRepo(mutationCtx, org.Name, name, defaultBookmark, autoInit)
		}); initErr != nil {
			if adopted && isRepoHostAlreadyExists(initErr) {
				return nil
			}
			slog.Error("failed to initialize org repository on disk", "org", org.Name, "repo_name", name, "error", initErr)
			if adopted {
				return errors.Internal("failed to initialize repository")
			}
			s.rollbackProvisionedRepo(commitCtx, repo.ID, org.Name, name)
			return errors.Internal("failed to initialize repository").WithCause(initErr)
		}
		return nil
	})
	if err != nil {
		return db.Repository{}, err
	}

	_ = s.dispatchRepositoryEvent(ctx, repo, actor, webhooks.EventTypeCreate, "created")

	return repo, nil
}

// ForkOutcome is the answer to an explicit fork request: the fork itself plus
// whether this call is the one that created it.
//
// Created is false when the caller already owned this fork of this upstream.
// Forking is a deliberate, user-initiated act, so asking twice must not
// scatter `repo`, `repo-1`, `repo-2` across the caller's namespace — the
// second request is answered with the repository the first one made.
type ForkOutcome struct {
	Repository db.Repository
	Created    bool
}

// ForkRepo creates a fork of an existing repository under the authenticated user's namespace.
// The fork inherits the parent's description (unless overridden), visibility, and default bookmark.
// An optional name override can be provided; if empty, the parent repo's name is used.
// An optional description override can be provided; if empty, the parent repo's description is used.
//
// Forking is never implicit. Nothing in plue forks on the caller's behalf: a
// fork exists only because a user asked for this repository, by name, in their
// own namespace. Two rules follow from that and are enforced here:
//
//   - A caller who can already write to the source is refused with
//     CodeForkNotNeeded. Forks exist to give a reader a namespace they can
//     write in; a writer already has one, and a silent second copy of a
//     repository they can edit is exactly the accident this endpoint exists to
//     prevent.
//   - A caller who already holds this fork gets that repository back
//     (Created=false), not a second one.
func (s *RepoService) ForkRepo(ctx context.Context, actor *db.User, owner, repo string, nameOverride, descriptionOverride string) (ForkOutcome, error) {
	requestStartedAt := time.Now().UTC()
	if actor == nil {
		return ForkOutcome{}, errors.Unauthorized("authentication required")
	}

	// Resolve the source repository (must be readable by the actor).
	sourceRepo, err := s.resolveReadableRepo(ctx, actor, owner, repo)
	if err != nil {
		return ForkOutcome{}, err
	}
	sourceOwner, err := s.canonicalRepositoryOwner(ctx, sourceRepo, owner)
	if err != nil {
		return ForkOutcome{}, err
	}

	// A writer has nothing to fork: refuse before anything is created, and say
	// why, so the caller edits the repository instead of shadowing it.
	writable, err := s.canWriteRepo(ctx, sourceRepo, actor.ID)
	if err != nil {
		return ForkOutcome{}, err
	}
	if writable {
		return ForkOutcome{}, errors.New(errors.CodeForkNotNeeded, fmt.Sprintf(
			"you already have write access to %s/%s; edit it directly instead of forking it", sourceOwner, sourceRepo.Name))
	}

	// Determine fork name.
	forkName := strings.TrimSpace(nameOverride)
	if forkName == "" {
		forkName = sourceRepo.Name
	}
	if err := validateRepoName(forkName); err != nil {
		return ForkOutcome{}, err
	}

	// Idempotence: the caller already forked this upstream under this name.
	if existing, found := s.existingForkOf(ctx, actor.Username, forkName, sourceRepo.ID); found {
		return ForkOutcome{Repository: existing, Created: false}, nil
	}

	// Determine fork description.
	forkDescription := sourceRepo.Description
	if strings.TrimSpace(descriptionOverride) != "" {
		forkDescription = descriptionOverride
	}

	createParams := db.CreateForkRepoParams{
		UserID:          pgtype.Int8{Int64: actor.ID, Valid: true},
		Name:            forkName,
		LowerName:       strings.ToLower(forkName),
		Description:     forkDescription,
		IsPublic:        sourceRepo.IsPublic,
		DefaultBookmark: sourceRepo.DefaultBookmark,
		ForkID:          pgtype.Int8{Int64: sourceRepo.ID, Valid: true},
	}
	if s.productOnly {
		repository, err := s.createProductRepository(ctx, productCreationSpec{
			OperationType: repositoryProvisionFork, ActorID: actor.ID,
			UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, OwnerName: actor.Username,
			Name: forkName, LowerName: createParams.LowerName, Description: forkDescription,
			IsPublic: sourceRepo.IsPublic, DefaultBookmark: sourceRepo.DefaultBookmark,
			SourceRepositoryID: pgtype.Int8{Int64: sourceRepo.ID, Valid: true},
			SourceOwner:        sourceOwner, SourceRepo: sourceRepo.Name,
		}, BillingOwnerTypeUser, actor.ID)
		if err != nil {
			return ForkOutcome{}, err
		}
		_ = s.dispatchRepositoryEvent(ctx, repository, actor, webhooks.EventTypeCreate, "created")
		return ForkOutcome{Repository: repository, Created: true}, nil
	}
	if s.provisioner != nil {
		if s.provisioning == nil || !s.provisioningEnabled {
			return ForkOutcome{}, repositoryProvisioningRolloutError()
		}
		if s.placementResolver == nil {
			return ForkOutcome{}, errors.Internal("repository placement resolver is not configured")
		}
		sourceStorageSet, placementErr := s.placementResolver.StorageSetForRepository(ctx, sourceRepo.ID)
		if placementErr != nil || sourceStorageSet == "" {
			return ForkOutcome{}, errors.Internal("failed to resolve repository placement")
		}
		staged, prepareErr := s.provisioner.PrepareStagedFork(
			ctx, sourceStorageSet, sourceOwner, sourceRepo.Name, actor.Username, forkName)
		if prepareErr != nil {
			return ForkOutcome{}, errors.Internal("failed to prepare fork storage").WithCause(prepareErr)
		}
		wanted := newForkProvisioningOperation(
			actor, actor.Username,
			repositoryProvisionParams{
				Name: forkName, LowerName: createParams.LowerName, Description: forkDescription,
				IsPublic: sourceRepo.IsPublic, DefaultBookmark: sourceRepo.DefaultBookmark,
			}, sourceRepo, sourceOwner, staged,
		)
		repository, provisionErr := s.finishDurableRepositoryProvision(
			ctx, wanted, BillingOwnerTypeUser, actor.ID)
		if provisionErr != nil {
			return ForkOutcome{}, provisionErr
		}
		_ = s.dispatchRepositoryEvent(ctx, repository, actor, webhooks.EventTypeCreate, "created")
		return ForkOutcome{Repository: repository, Created: true}, nil
	}
	expected := repositoryCreateExpectation{
		UserID:          createParams.UserID,
		Name:            createParams.Name,
		LowerName:       createParams.LowerName,
		Description:     createParams.Description,
		IsPublic:        createParams.IsPublic,
		DefaultBookmark: createParams.DefaultBookmark,
		IsFork:          true,
		ForkID:          createParams.ForkID,
		NotBefore:       requestStartedAt,
	}

	// A private fork consumes one private-repository slot. Keep the owner lock
	// across both the DB insert and storage compensation so concurrent creates
	// observe only a successfully provisioned repository.
	var forkedRepo db.Repository
	err = authorizeRepoCreateThenCommit(ctx, s.billing, BillingOwnerTypeUser, actor.ID, !sourceRepo.IsPublic, func(commitCtx context.Context) error {
		var createErr error
		forkedRepo, createErr = s.queries.CreateForkRepo(commitCtx, createParams)
		adopted := false
		if createErr != nil {
			switch classifyRepositoryCreateError(createErr) {
			case repositoryCreateErrorConflict:
				return errors.Conflict(fmt.Sprintf("repository '%s' already exists", forkName))
			case repositoryCreateErrorDefinitive:
				slog.Error("failed to create fork repository record", "owner", actor.Username, "repo_name", forkName, "error", createErr)
				return errors.Internal("failed to create fork").WithCause(createErr)
			case repositoryCreateErrorAmbiguous:
				recovered, state, lookupErr := reconcileAmbiguousRepositoryCreate(commitCtx, s.queries.GetRepoByOwnerAndLowerName, actor.Username, expected)
				if state == repositoryCreateConflicting {
					return errors.Conflict(fmt.Sprintf("repository '%s' already exists", forkName))
				}
				if state != repositoryCreateAdopted {
					slog.Error("failed to reconcile ambiguous fork creation",
						"owner", actor.Username, "repo_name", forkName, "create_error", createErr, "lookup_error", lookupErr)
					return errors.Internal("failed to create fork")
				}
				forkedRepo = recovered
				adopted = true
			}
		}

		if forkErr := runRepoHostMutation(commitCtx, func(mutationCtx context.Context) error {
			return s.repoHost.ForkRepo(mutationCtx, sourceOwner, sourceRepo.Name, actor.Username, forkName)
		}); forkErr != nil {
			if adopted && isRepoHostAlreadyExists(forkErr) {
				return nil
			}
			slog.Error("failed to copy fork repository data", "src_owner", sourceOwner, "src_repo", sourceRepo.Name, "dst_owner", actor.Username, "dst_repo", forkName, "error", forkErr)
			if adopted {
				return errors.Internal("failed to copy repository data for fork")
			}
			s.rollbackProvisionedRepo(commitCtx, forkedRepo.ID, actor.Username, forkName)
			return errors.Internal("failed to copy repository data for fork").WithCause(forkErr)
		}
		return nil
	})
	if err != nil {
		return ForkOutcome{}, err
	}

	// The source repository's num_forks is maintained by the
	// trg_repositories_fork_count_* triggers on the fork row itself, so both
	// this creation and any later fork deletion are counted exactly once.

	_ = s.dispatchRepositoryEvent(ctx, forkedRepo, actor, webhooks.EventTypeCreate, "created")

	return ForkOutcome{Repository: forkedRepo, Created: true}, nil
}

func (s *RepoService) GetRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
	return s.resolveReadableRepo(ctx, viewer, owner, repo)
}

// RepoView is a repository as one viewer sees it: the row, plus the two facts
// an interface needs before it can offer an action. Without them a client is
// reduced to guessing — and the guess that fork is harmless is how a reader
// ends up with an unasked-for copy of someone else's repository.
type RepoView struct {
	Repository db.Repository
	// GitHubSource is present only when one ready import durably binds this
	// repository to one GitHub source. The repository description is not proof.
	GitHubSource *GitHubSource
	// Multiple ready sources are unsafe to resolve to one review target.
	GitHubSourceAmbiguous bool
	// A service without the import store cannot decide whether Cloud or GitHub
	// owns a pull request number, so callers must fail closed.
	GitHubSourceUnavailable bool
	// CanWrite is the viewer's effective write access. False means every write
	// affordance must be shown as unavailable with the fork offer beside it,
	// never hidden and never auto-resolved by forking.
	CanWrite bool
	// ForkOf is "owner/name" of the upstream when this repository is a fork,
	// and empty otherwise (including when the upstream has been deleted).
	ForkOf string
}

type GitHubSource struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

func (s *RepoService) githubSource(ctx context.Context, repositoryID int64) (*GitHubSource, bool, error) {
	if s.pool == nil {
		return nil, false, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT min(github_owner), min(github_repo) FROM import_jobs WHERE repository_id=$1 AND status='ready' GROUP BY lower(github_owner), lower(github_repo) LIMIT 2`, repositoryID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var source *GitHubSource
	for rows.Next() {
		var next GitHubSource
		if err := rows.Scan(&next.Owner, &next.Repo); err != nil {
			return nil, false, err
		}
		if source != nil {
			return nil, true, nil // Conflicting source identities cannot select a PR.
		}
		source = &GitHubSource{Owner: strings.ToLower(next.Owner), Repo: strings.ToLower(next.Repo)}
	}
	return source, false, rows.Err()
}

// GetRepoView resolves a readable repository together with the viewer's write
// access and its upstream, in one call, so a client never has to infer either.
func (s *RepoService) GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (RepoView, error) {
	repository, err := s.resolveReadableRepo(ctx, viewer, owner, repo)
	if err != nil {
		return RepoView{}, err
	}
	view := RepoView{Repository: repository, ForkOf: s.upstreamFullName(ctx, repository)}
	if viewer == nil {
		return view, nil
	}
	canWrite, err := s.canWriteRepo(ctx, repository, viewer.ID)
	if err != nil {
		return RepoView{}, err
	}
	view.CanWrite = canWrite
	view.GitHubSourceUnavailable = s.pool == nil
	view.GitHubSource, view.GitHubSourceAmbiguous, err = s.githubSource(ctx, repository.ID)
	if err != nil {
		slog.WarnContext(ctx, "github import source unavailable", "repository_id", repository.ID, "error", err)
		view.GitHubSourceUnavailable = true
	}
	if !view.CanWrite && (view.GitHubSource != nil || view.GitHubSourceAmbiguous) {
		// A readable Cloud mirror does not grant GitHub source metadata.
		view.GitHubSource, view.GitHubSourceAmbiguous, view.GitHubSourceUnavailable = nil, false, true
	}
	return view, nil
}

// upstreamFullName renders "owner/name" for repository's fork parent. A parent
// that cannot be resolved (deleted, or a querier too thin to name its owner)
// yields "": the fork banner is then simply absent, which is honest, rather
// than a half-rendered "/name".
func (s *RepoService) upstreamFullName(ctx context.Context, repository db.Repository) string {
	if !repository.ForkID.Valid {
		return ""
	}
	parent, err := s.queries.GetRepoByID(ctx, repository.ForkID.Int64)
	if err != nil {
		return ""
	}
	parentOwner, err := s.canonicalRepositoryOwner(ctx, parent, "")
	if err != nil || strings.TrimSpace(parentOwner) == "" {
		return ""
	}
	return parentOwner + "/" + parent.Name
}

func (s *RepoService) GetRepoTopics(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error) {
	repository, err := s.resolveReadableRepo(ctx, viewer, owner, repo)
	if err != nil {
		return nil, err
	}
	if repository.Topics == nil {
		return []string{}, nil
	}
	return repository.Topics, nil
}

func (s *RepoService) ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
	if actor == nil {
		return nil, errors.Unauthorized("authentication required")
	}

	normalizedTopics, err := normalizeTopics(topics)
	if err != nil {
		return nil, err
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}

	allowed, err := s.canAdminRepo(ctx, repository, actor.ID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, errors.Forbidden("permission denied")
	}

	updated, err := s.queries.UpdateRepoTopics(ctx, db.UpdateRepoTopicsParams{
		ID:     repository.ID,
		Topics: normalizedTopics,
	})
	if err != nil {
		if isRepositoryStorageOperationConflict(err) {
			return nil, errors.Conflict("repository storage operation is already in progress")
		}
		return nil, errors.Internal("failed to update repository topics").WithCause(err)
	}
	if updated.Topics == nil {
		return []string{}, nil
	}
	return updated.Topics, nil
}

// Full bookmark enumeration follows bounded pages. Named lookups use GetBookmark.
const (
	bookmarkPageSize = 100
	bookmarkMaxPages = 100
)

// walkBookmarks calls visit for each page of the repo's bookmark list until
// visit returns false or the list is exhausted.
func (s *RepoService) walkBookmarks(ctx context.Context, owner, repoName string, visit func([]repohost.Bookmark) bool) error {
	cursor := ""
	for range bookmarkMaxPages {
		bookmarks, next, err := s.repoHost.ListBookmarks(ctx, owner, repoName, cursor, bookmarkPageSize)
		if err != nil {
			return err
		}
		if !visit(bookmarks) {
			return nil
		}
		if next == "" || next == cursor || len(bookmarks) == 0 {
			return nil
		}
		cursor = next
	}
	return nil
}

// resolveChangeRef resolves a ref string (bookmark name or change ID) to a change ID
// by looking up bookmarks from the repo-host. If the ref matches a bookmark name,
// its target change ID is returned; otherwise the ref is returned as-is (assumed
// to already be a change or commit ID).
func (s *RepoService) resolveChangeRef(ctx context.Context, owner, repoName, ref string) (string, error) {
	bookmark, _, err := repohost.LookupBookmark(ctx, s.repoHost, owner, repoName, ref)
	resolved := strings.TrimSpace(bookmark.TargetChangeID)
	if err != nil {
		if isRepoHostStatus(err, 404) {
			return "", errors.NotFound("repository storage not found")
		}
		return "", errors.Internal("failed to resolve bookmark").WithCause(err)
	}
	if resolved != "" {
		return resolved, nil
	}
	// Not a bookmark name — return as-is (could be a change/commit ID).
	return ref, nil
}

// ListRepoContentsPage returns one bounded page of immediate directory entries.
func immutableCommitSHA(ref string) bool {
	if len(ref) != 40 && len(ref) != 64 {
		return false
	}
	for i := 0; i < len(ref); i++ {
		c := ref[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func (s *RepoService) resolveContentsCommit(ctx context.Context, owner, repo, ref string) (string, error) {
	if immutableCommitSHA(ref) {
		return ref, nil
	}
	bookmark, found, err := repohost.LookupBookmark(ctx, s.repoHost, owner, repo, ref)
	change := ref
	commit := ""
	if found {
		change = strings.TrimSpace(bookmark.TargetChangeID)
		commit = strings.TrimSpace(bookmark.TargetCommitID)
	}
	if err != nil {
		if isRepoHostStatus(err, 404) {
			return "", errors.NotFound("repository storage not found")
		}
		return "", errors.Internal("failed to resolve bookmark").WithCause(err)
	}
	if commit != "" {
		if !immutableCommitSHA(commit) {
			return "", errors.Internal("invalid bookmark commit")
		}
		return commit, nil
	}
	if found && change == "" {
		return "", errors.NotFound("content not found")
	}
	reader, ok := s.repoHost.(interface {
		GetChange(context.Context, string, string, string) (repohost.Change, error)
	})
	if !ok {
		return "", errors.Internal("commit resolution unavailable")
	}
	resolved, err := reader.GetChange(ctx, owner, repo, change)
	if err != nil {
		if isRepoHostStatus(err, 404) {
			return "", errors.NotFound("content not found")
		}
		if isRepoHostStatus(err, 400) {
			return "", errors.BadRequest("invalid content revision")
		}
		return "", errors.Internal("failed to resolve change commit").WithCause(err)
	}
	if !immutableCommitSHA(resolved.CommitID) {
		return "", errors.Internal("invalid change commit")
	}
	return resolved.CommitID, nil
}

func (s *RepoService) ListRepoContentsPage(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath, after string, limit int) ([]RepoContent, string, string, error) {
	if limit < 1 || limit > 1000 {
		return nil, "", "", errors.BadRequest("directory page limit must be between 1 and 1000")
	}
	repository, err := s.resolveReadableRepo(ctx, viewer, owner, repo)
	if err != nil {
		return nil, "", "", err
	}
	changeRef := strings.TrimSpace(ref)
	if changeRef == "" {
		changeRef = repository.DefaultBookmark
	}
	trimmedOwner := strings.TrimSpace(owner)
	changeRef, err = s.resolveContentsCommit(ctx, trimmedOwner, repository.Name, changeRef)
	if err != nil {
		return nil, "", "", err
	}
	prefix := strings.Trim(dirPath, "/")
	if after != "" {
		name := after
		if prefix != "" {
			if !strings.HasPrefix(after, prefix+"/") {
				return nil, "", "", errors.BadRequest("invalid directory cursor")
			}
			name = strings.TrimPrefix(after, prefix+"/")
		}
		if name == "" || strings.Contains(name, "/") {
			return nil, "", "", errors.BadRequest("invalid directory cursor")
		}
	}
	directoryHost, ok := s.repoHost.(interface {
		ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error)
	})
	if !ok {
		return nil, "", "", errors.Internal("directory paging unavailable")
	}
	page, err := directoryHost.ListDirectory(ctx, trimmedOwner, repository.Name, changeRef, prefix, after, limit+1)
	if err != nil {
		if isRepoHostStatus(err, 404) {
			return nil, "", "", errors.NotFound("content not found")
		}
		if isRepoHostStatus(err, 400) {
			return nil, "", "", errors.BadRequest("invalid directory page")
		}
		return nil, "", "", errors.Internal("failed to list repository contents").WithCause(err)
	}
	if len(page) > limit+1 {
		return nil, "", "", errors.Internal("oversized directory page")
	}
	hasMore := len(page) > limit
	if hasMore {
		page = page[:limit]
	}
	entries := make([]RepoContent, 0, len(page))
	for _, entry := range page {
		name := strings.TrimPrefix(entry.Path, prefix+"/")
		if prefix == "" {
			name = entry.Path
		}
		entries = append(entries, RepoContent{Name: name, Path: entry.Path, Type: entry.Kind})
	}
	next := ""
	if hasMore {
		next = page[len(page)-1].Path
	}
	return entries, next, changeRef, nil
}

// ListRepoContents returns directory entries for the given path (or root if empty).
func (s *RepoService) ListRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]RepoContent, error) {
	repository, err := s.resolveReadableRepo(ctx, viewer, owner, repo)
	if err != nil {
		return nil, err
	}

	changeRef := strings.TrimSpace(ref)
	if changeRef == "" {
		changeRef = repository.DefaultBookmark
	}

	trimmedOwner := strings.TrimSpace(owner)
	changeRef, err = s.resolveChangeRef(ctx, trimmedOwner, repository.Name, changeRef)
	if err != nil {
		return nil, err
	}

	prefix := strings.Trim(dirPath, "/")
	if directoryHost, ok := s.repoHost.(interface {
		ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error)
	}); ok {
		entries := make([]RepoContent, 0)
		after := ""
		for {
			page, err := directoryHost.ListDirectory(ctx, trimmedOwner, repository.Name, changeRef, prefix, after, 1000)
			if err != nil {
				if isRepoHostStatus(err, 404) {
					return nil, errors.NotFound("content not found")
				}
				return nil, errors.Internal("failed to list repository contents").WithCause(err)
			}
			for _, entry := range page {
				name := strings.TrimPrefix(entry.Path, strings.TrimSuffix(prefix, "/")+"/")
				if prefix == "" {
					name = entry.Path
				}
				entries = append(entries, RepoContent{Name: name, Path: entry.Path, Type: entry.Kind})
			}
			if len(page) < 1000 {
				return entries, nil
			}
			next := page[len(page)-1].Path
			if next <= after {
				return nil, errors.Internal("invalid repository directory cursor")
			}
			after = next
		}
	}
	files, err := s.repoHost.ListFilesAtChange(ctx, trimmedOwner, repository.Name, changeRef, prefix)
	if err != nil {
		if isRepoHostStatus(err, 404) {
			return nil, errors.NotFound("content not found")
		}
		return nil, errors.Internal("failed to list repository contents").WithCause(err)
	}

	// Build immediate children only (filter to one level deep).
	seen := map[string]bool{}
	entries := make([]RepoContent, 0)
	for _, f := range files {
		rel := f.Path
		if prefix != "" {
			rel = strings.TrimPrefix(f.Path, prefix)
			rel = strings.TrimPrefix(rel, "/")
		}
		if rel == "" {
			continue
		}
		// Get first path component to find immediate children.
		parts := strings.SplitN(rel, "/", 2)
		name := parts[0]
		if seen[name] {
			continue
		}
		seen[name] = true

		entryType := "file"
		entryPath := f.Path
		if len(parts) > 1 {
			entryType = "dir"
			if prefix != "" {
				entryPath = prefix + "/" + name
			} else {
				entryPath = name
			}
		}
		entries = append(entries, RepoContent{
			Name: name,
			Path: entryPath,
			Type: entryType,
		})
	}
	return entries, nil
}

func (s *RepoService) GetRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, filePath string) (RepoContent, error) {
	repository, err := s.resolveReadableRepo(ctx, viewer, owner, repo)
	if err != nil {
		return RepoContent{}, err
	}

	if filePath == "" {
		return RepoContent{}, errors.BadRequest("path is required")
	}

	changeRef := strings.TrimSpace(ref)
	if changeRef == "" {
		changeRef = repository.DefaultBookmark
	}

	trimmedOwner := strings.TrimSpace(owner)
	changeRef, err = s.resolveChangeRef(ctx, trimmedOwner, repository.Name, changeRef)
	if err != nil {
		return RepoContent{}, err
	}

	file, err := s.repoHost.GetFileAtChange(ctx, trimmedOwner, repository.Name, changeRef, filePath)
	if err != nil {
		if isRepoHostStatus(err, 404) {
			return RepoContent{}, errors.NotFound("content not found")
		}
		return RepoContent{}, errors.Internal("failed to load repository content").WithCause(err)
	}

	if file.Path != "" {
		filePath = file.Path
	}
	return RepoContent{
		Name:     path.Base(filePath),
		Path:     filePath,
		SHA:      "",
		Type:     "file",
		Encoding: "utf-8",
		Content:  file.Content,
		Size:     int64(len(file.Content)),
	}, nil
}

func (s *RepoService) ListGitRefs(ctx context.Context, viewer *db.User, owner, repo string) ([]GitRef, error) {
	repository, err := s.resolveReadableRepo(ctx, viewer, owner, repo)
	if err != nil {
		return nil, err
	}

	var bookmarks []repohost.Bookmark
	err = s.walkBookmarks(ctx, strings.TrimSpace(owner), repository.Name, func(page []repohost.Bookmark) bool {
		remaining := bookmarkPageSize*bookmarkMaxPages - len(bookmarks)
		if len(page) > remaining {
			page = page[:remaining]
		}
		bookmarks = append(bookmarks, page...)
		return len(bookmarks) < bookmarkPageSize*bookmarkMaxPages
	})
	if err != nil {
		return nil, errors.Internal("failed to list git refs").WithCause(err)
	}

	notesReader, ok := s.repoHost.(repoHostNotesReader)
	if !ok {
		return nil, errors.Internal("repo-host does not support notes refs")
	}
	notes, err := notesReader.ListNotesRefs(ctx, strings.TrimSpace(owner), repository.Name)
	if err != nil || len(notes) > repohost.MaxNotesRefs {
		return nil, errors.Internal("failed to list notes refs")
	}

	refs := make([]GitRef, 0, len(bookmarks)+len(notes))
	for _, bookmark := range bookmarks {
		sha := strings.TrimSpace(bookmark.TargetCommitID)
		if sha == "" {
			sha = strings.TrimSpace(bookmark.TargetChangeID)
		}
		refs = append(refs, GitRef{
			Ref: "refs/heads/" + bookmark.Name,
			Object: GitRefObject{
				SHA:  sha,
				Type: "commit",
			},
		})
	}
	for _, note := range notes {
		refs = append(refs, GitRef{Ref: note.Ref, Object: GitRefObject{SHA: note.SHA, Type: "commit"}})
	}
	return refs, nil
}

func (s *RepoService) UpdateRepo(ctx context.Context, actor *db.User, owner, repo string, req UpdateRepoRequest) (db.Repository, error) {
	if actor == nil {
		return db.Repository{}, errors.Unauthorized("authentication required")
	}

	requestedName := ""
	if req.Name != nil {
		trimmedName := strings.TrimSpace(*req.Name)
		if err := validateRepoName(trimmedName); err != nil {
			return db.Repository{}, err
		}
		requestedName = trimmedName
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, err
	}
	allowed, err := s.canAdminRepo(ctx, repository, actor.ID)
	if err != nil {
		return db.Repository{}, err
	}
	if !allowed {
		return db.Repository{}, errors.Forbidden("permission denied")
	}

	name := repository.Name
	lowerName := repository.LowerName
	if req.Name != nil && requestedName != repository.Name {
		return db.Repository{}, errors.ValidationFailed(errors.FieldError{
			Resource: "Repository",
			Field:    "name",
			Code:     "invalid",
		})
	}

	description := repository.Description
	if req.Description != nil {
		description = *req.Description
	}

	isPublic := repository.IsPublic
	if req.Private != nil {
		isPublic = !*req.Private
	}
	privateTransition := repository.IsPublic && !isPublic

	defaultBookmark := repository.DefaultBookmark
	if req.DefaultBookmark != nil {
		defaultBookmark = strings.TrimSpace(*req.DefaultBookmark)
		if defaultBookmark == "" {
			return db.Repository{}, errors.ValidationFailed(errors.FieldError{
				Resource: "Repository",
				Field:    "default_bookmark",
				Code:     "invalid",
			})
		}
		if err := validateDefaultBookmark(defaultBookmark); err != nil {
			return db.Repository{}, err
		}
	}

	topics := repository.Topics
	if req.Topics != nil {
		topics = *req.Topics
	}

	landingQueueMode := repository.LandingQueueMode
	if req.LandingQueueMode != nil {
		landingQueueMode = strings.TrimSpace(*req.LandingQueueMode)
		if landingQueueMode == "" {
			landingQueueMode = "serialized"
		}
		if landingQueueMode != "serialized" && landingQueueMode != "parallel" {
			return db.Repository{}, errors.ValidationFailed(errors.FieldError{
				Resource: "Repository",
				Field:    "landing_queue_mode",
				Code:     "invalid",
			})
		}
	}

	landingQueueRequiredChecks := repository.LandingQueueRequiredChecks
	if req.LandingQueueRequiredChecks != nil {
		landingQueueRequiredChecks = normalizeStringList(*req.LandingQueueRequiredChecks)
	}

	params := db.UpdateRepoParams{
		ID:                         repository.ID,
		Name:                       name,
		LowerName:                  lowerName,
		Description:                description,
		IsPublic:                   isPublic,
		DefaultBookmark:            defaultBookmark,
		Topics:                     topics,
		LandingQueueMode:           landingQueueMode,
		LandingQueueRequiredChecks: landingQueueRequiredChecks,
	}
	bookmarkChanged := defaultBookmark != repository.DefaultBookmark
	repoHostBookmarkUpdated := false
	var updated db.Repository
	updateWithDefaultBookmark := func(workCtx context.Context, update func(context.Context) (db.Repository, error)) error {
		if bookmarkChanged {
			setter, ok := s.repoHost.(repoHostDefaultBookmarkSetter)
			if !ok {
				return errors.Internal("repository host cannot update the default bookmark")
			}
			if err := setter.SetDefaultBookmark(workCtx, owner, repository.Name, defaultBookmark); err != nil {
				return errors.Internal("failed to update repository default bookmark").WithCause(err)
			}
			repoHostBookmarkUpdated = true
		}
		var updateErr error
		updated, updateErr = update(workCtx)
		return updateErr
	}

	if s.ownershipTx != nil {
		// Existing-repository quota consumers take locks in repository -> owner
		// order. The owner lock encloses UpdateRepo's outer COMMIT, so another
		// private create cannot pass against the same pre-transition count.
		var authorizeCommit repoOwnershipCommitAuthorizer
		if privateTransition {
			authorizeCommit = func(workCtx context.Context, fresh db.Repository, commit func(context.Context) error) error {
				// A prior serialized request may already have made the repository
				// private. In that case this write does not consume another slot.
				if !fresh.IsPublic {
					return commit(workCtx)
				}
				ownerType, ownerID, valid := repositoryBillingOwner(fresh)
				if !valid {
					return errors.Internal("failed to resolve repository billing owner")
				}
				return authorizePrivateRepoThenCommit(workCtx, s.billing, ownerType, ownerID, true, commit)
			}
		}
		beginWorkContext := (func(context.Context) (context.Context, context.CancelFunc, error))(nil)
		if bookmarkChanged {
			beginWorkContext = func(ctx context.Context) (context.Context, context.CancelFunc, error) {
				return beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
			}
		}
		err = s.withOwnershipTxContext(ctx, repository, "failed to update repository", beginWorkContext, authorizeCommit, func(workCtx context.Context, tx repoOwnershipTx) error {
			return updateWithDefaultBookmark(workCtx, func(updateCtx context.Context) (db.Repository, error) {
				return tx.UpdateRepo(updateCtx, params)
			})
		})
	} else {
		ownerType, ownerID, valid := repositoryBillingOwner(repository)
		if privateTransition && !valid {
			return db.Repository{}, errors.Internal("failed to resolve repository billing owner")
		}
		workCtx := ctx
		cancelWork := func() {}
		if bookmarkChanged {
			workCtx, cancelWork, err = beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
			if err != nil {
				return db.Repository{}, errors.Internal("failed to update repository").WithCause(err)
			}
		}
		defer cancelWork()
		err = authorizePrivateRepoThenCommit(workCtx, s.billing, ownerType, ownerID, privateTransition, func(commitCtx context.Context) error {
			return updateWithDefaultBookmark(commitCtx, func(updateCtx context.Context) (db.Repository, error) {
				return s.queries.UpdateRepo(updateCtx, params)
			})
		})
	}
	if err != nil {
		if repoHostBookmarkUpdated {
			compensateCtx, cancel := repoHostCompensationContext(ctx)
			compensateErr := s.repoHost.(repoHostDefaultBookmarkSetter).SetDefaultBookmark(compensateCtx, owner, repository.Name, repository.DefaultBookmark)
			cancel()
			if compensateErr != nil {
				slog.Error("failed to restore repository default bookmark after database update failure", "repo_id", repository.ID, "error", compensateErr)
				return db.Repository{}, errors.Internal("failed to update repository default bookmark").WithCause(compensateErr)
			}
		}
		if apiErr := (*errors.APIError)(nil); stdErrors.As(err, &apiErr) {
			return db.Repository{}, err
		}
		if isRepoUniqueViolation(err) {
			return db.Repository{}, errors.Conflict("repository name already exists")
		}
		if isRepositoryStorageOperationConflict(err) {
			return db.Repository{}, errors.Conflict("repository storage operation is already in progress")
		}
		return db.Repository{}, errors.Internal("failed to update repository").WithCause(err)
	}

	return updated, nil
}

// repoOwnershipCommitAuthorizer wraps the consuming mutation and the outer
// ownership transaction COMMIT. It is invoked only after the repository lock
// is held and the authorized snapshot has been revalidated.
type repoOwnershipCommitAuthorizer func(
	ctx context.Context,
	fresh db.Repository,
	commit func(context.Context) error,
) error

func (s *RepoService) withOwnershipTxContext(
	ctx context.Context,
	snapshot db.Repository,
	failMsg string,
	beginWorkContext func(context.Context) (context.Context, context.CancelFunc, error),
	authorizeCommit repoOwnershipCommitAuthorizer,
	fn func(context.Context, repoOwnershipTx) error,
) error {
	tx, err := s.ownershipTx.BeginOwnershipTx(ctx, snapshot.ID)
	if err != nil {
		slog.Error("failed to begin repository ownership transaction", "repo_id", snapshot.ID, "error", err)
		return errors.Internal(failMsg)
	}
	committed := false
	rollbackParent := ctx
	defer func() {
		if !committed {
			rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(rollbackParent), repoProvisionDBCleanupTimeout)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()

	fresh, err := tx.GetRepoByIDForUpdate(ctx, snapshot.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return errors.NotFound("repository not found")
		}
		return errors.Internal(failMsg)
	}
	if !repoOwnershipUnchanged(fresh, snapshot) {
		return errors.Conflict("repository ownership changed concurrently")
	}

	workCtx := ctx
	cancelWork := func() {}
	if beginWorkContext != nil {
		workCtx, cancelWork, err = beginWorkContext(ctx)
		if err != nil {
			return errors.Internal(failMsg)
		}
		rollbackParent = workCtx
	}
	defer cancelWork()

	applyAndCommit := func(commitCtx context.Context) error {
		if err := fn(commitCtx, tx); err != nil {
			return err
		}
		if err := tx.Commit(commitCtx); err != nil {
			slog.Error("failed to commit repository ownership transaction", "repo_id", snapshot.ID, "error", err)
			return errors.Internal(failMsg)
		}
		committed = true
		return nil
	}
	if authorizeCommit == nil {
		return applyAndCommit(workCtx)
	}
	called := false
	err = authorizeCommit(workCtx, fresh, func(commitCtx context.Context) error {
		if called {
			return errors.Internal("repository commit called more than once")
		}
		called = true
		return applyAndCommit(commitCtx)
	})
	if err != nil {
		return err
	}
	if !called {
		return errors.Internal("repository was not committed")
	}
	return nil
}

func repositoryBillingOwner(repository db.Repository) (string, int64, bool) {
	if repository.OrgID.Valid && !repository.UserID.Valid && repository.OrgID.Int64 > 0 {
		return BillingOwnerTypeOrg, repository.OrgID.Int64, true
	}
	if repository.UserID.Valid && !repository.OrgID.Valid && repository.UserID.Int64 > 0 {
		return BillingOwnerTypeUser, repository.UserID.Int64, true
	}
	return "", 0, false
}

func (s *RepoService) DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	if actor == nil {
		return errors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}

	allowed, err := s.canOwnRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return errors.Forbidden("permission denied")
	}
	canonicalOwner, err := s.canonicalRepositoryOwner(ctx, repository, owner)
	if err != nil {
		return err
	}

	stagedRepoHost, ok := s.repoHost.(repoHostStagedDeleteClient)
	if !ok {
		slog.Error("repo-host client does not support staged repository deletion", "repo_id", repository.ID)
		return errors.Internal("failed to delete repository")
	}
	var prepared *repohost.StagedDelete
	if s.storageOperations != nil {
		preparedRepoHost, preparedOK := s.repoHost.(repoHostPreparedDeleteClient)
		if !preparedOK {
			slog.Error("repo-host client cannot prepare durable repository deletion", "repo_id", repository.ID)
			return errors.Internal("failed to delete repository")
		}
		staged, prepareErr := preparedRepoHost.PrepareStagedDelete(ctx, canonicalOwner, repository.Name)
		if prepareErr != nil {
			slog.Error("failed to prepare repository deletion", "repo_id", repository.ID, "error", prepareErr)
			return errors.Internal("failed to delete repository").WithCause(prepareErr)
		}
		if createErr := s.storageOperations.Create(ctx, newDeleteStorageOperation(repository, canonicalOwner, staged)); createErr != nil {
			if stdErrors.Is(createErr, errRepositoryStorageOperationExists) {
				return errors.Conflict("repository storage operation is already in progress")
			}
			if stdErrors.Is(createErr, errRepositoryStorageSourceChanged) {
				return errors.Conflict("repository ownership changed concurrently")
			}
			slog.Error("failed to persist repository deletion intent", "repo_id", repository.ID, "error", createErr)
			return errors.Internal("failed to delete repository").WithCause(createErr)
		}
		prepared = &staged
	}
	if s.ownershipTx != nil {
		err = s.deleteRepoSerialized(ctx, repository, canonicalOwner, stagedRepoHost, prepared)
	} else {
		err = s.deleteRepoCompensating(ctx, repository, canonicalOwner, stagedRepoHost)
	}
	if err != nil {
		return err
	}

	_ = s.dispatchRepositoryEvent(ctx, repository, actor, webhooks.EventTypeDelete, "deleted")

	return nil
}

// deleteRepoSerialized holds the ownership lock through a three-phase delete:
// the DB row is deleted inside the uncommitted transaction, repo-host renames
// all storage to a reversible tombstone, and only then does the DB commit. A
// failed commit restores the tombstone before the transaction rolls back.
func (s *RepoService) deleteRepoSerialized(
	ctx context.Context,
	repository db.Repository,
	owner string,
	repoHost repoHostStagedDeleteClient,
	prepared *repohost.StagedDelete,
) error {
	retainIntent := false
	if prepared != nil {
		defer func() {
			if !retainIntent {
				s.settleRepoDeleteIntent(ctx, repository, *prepared, repoHost, false)
			}
		}()
	}
	tx, err := s.ownershipTx.BeginOwnershipTx(ctx, repository.ID)
	if err != nil {
		slog.Error("failed to begin repository ownership transaction", "repo_id", repository.ID, "error", err)
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	committed := false
	rollbackParent := ctx
	defer func() {
		if !committed {
			rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(rollbackParent), repoProvisionDBCleanupTimeout)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()

	fresh, err := tx.GetRepoByIDForUpdate(ctx, repository.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return errors.NotFound("repository not found")
		}
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	if !repoOwnershipUnchanged(fresh, repository) {
		return errors.Conflict("repository ownership changed concurrently")
	}
	if prepared != nil {
		active, verifyErr := s.storageOperations.Verify(ctx, repository.ID, prepared.Token)
		if verifyErr != nil {
			slog.Error("failed to verify repository deletion intent", "repo_id", repository.ID, "error", verifyErr)
			return errors.Internal("failed to delete repository").WithCause(verifyErr)
		}
		if !active {
			return errors.Conflict("repository storage operation changed concurrently")
		}
		if authorizeErr := tx.AuthorizeStorageOperation(ctx, prepared.Token); authorizeErr != nil {
			slog.Error("failed to authorize repository deletion transaction", "repo_id", repository.ID, "error", authorizeErr)
			return errors.Internal("failed to delete repository").WithCause(authorizeErr)
		}
	}

	workCtx, cancelWork, err := beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
	if err != nil {
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	defer cancelWork()
	rollbackParent = workCtx

	if err := tx.DeleteRepo(workCtx, repository.ID); err != nil {
		slog.Error("failed to delete repository row", "repo_id", repository.ID, "error", err)
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	var staged repohost.StagedDelete
	if prepared != nil {
		staged = *prepared
		err = s.repoHost.(repoHostPreparedDeleteClient).ExecuteStagedDelete(workCtx, staged)
	} else {
		staged, err = repoHost.StageDeleteRepo(workCtx, owner, repository.Name)
	}
	if err != nil {
		slog.Error("failed to stage repository data for deletion", "owner", owner, "repo_name", repository.Name, "error", err)
		restoreCtx, cancelRestore := repoHostCompensationContext(workCtx)
		restoreErr := restoreStagedRepoDelete(restoreCtx, staged, repoHost)
		cancelRestore()
		if restoreErr != nil {
			slog.Error("failed to restore repository storage after stage-delete error",
				"repo_id", repository.ID, "owner", owner, "repo_name", repository.Name, "error", restoreErr)
		}
		return errors.Internal("failed to delete repository data").WithCause(err)
	}

	if err := tx.Commit(workCtx); err != nil {
		slog.Error("failed to commit repository deletion", "repo_id", repository.ID, "error", err)
		// A transport error from COMMIT is not proof that PostgreSQL rolled the
		// transaction back. Release/abort any transaction that is still live,
		// then reconcile through a separate pooled query before deciding whether
		// the tombstone must be restored or finalized.
		rollbackCtx, cancelRollback := context.WithTimeout(context.WithoutCancel(workCtx), repoProvisionDBCleanupTimeout)
		_ = tx.Rollback(rollbackCtx)
		cancelRollback()
		reconcileCtx, cancelReconcile := repoHostCompensationContext(workCtx)
		commitState, reconcileErr := s.repoDeleteCommitState(reconcileCtx, repository)
		cancelReconcile()
		if reconcileErr == nil && commitState == repoDeleteCommitApplied {
			committed = true
			retainIntent = true
			s.settleRepoDeleteIntent(workCtx, repository, staged, repoHost, true)
			return nil
		}
		if reconcileErr != nil {
			slog.Error("failed to reconcile ambiguous repository delete commit",
				"repo_id", repository.ID, "owner", owner, "repo_name", repository.Name, "error", reconcileErr)
		}
		if commitState == repoDeleteCommitUnknown {
			// A surviving row under changed ownership/name, or a failed read,
			// cannot prove whether this delete committed. Preserve the durable
			// tombstone and journal for explicit reconciliation instead of
			// guessing restore or finalize.
			retainIntent = true
			return errors.Internal("failed to delete repository")
		}
		restoreCtx, cancelRestore := repoHostCompensationContext(workCtx)
		restoreErr := restoreStagedRepoDelete(restoreCtx, staged, repoHost)
		cancelRestore()
		if restoreErr != nil {
			slog.Error("failed to restore repository storage after delete commit failure",
				"repo_id", repository.ID, "owner", owner, "repo_name", repository.Name, "error", restoreErr)
		}
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	committed = true
	retainIntent = true
	s.settleRepoDeleteIntent(workCtx, repository, staged, repoHost, true)
	return nil
}

type repoDeleteCommitOutcome uint8

const (
	repoDeleteCommitUnknown repoDeleteCommitOutcome = iota
	repoDeleteCommitNotApplied
	repoDeleteCommitApplied
)

// repoDeleteCommitState reconciles an ambiguous delete COMMIT by stable
// repository id. Absence proves deletion; the unchanged original row proves
// rollback. A surviving row whose owner or name changed may reflect a later
// operation and is deliberately left unresolved.
func (s *RepoService) repoDeleteCommitState(ctx context.Context, repository db.Repository) (repoDeleteCommitOutcome, error) {
	visible, err := s.queries.GetRepoByID(ctx, repository.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return repoDeleteCommitApplied, nil
		}
		return repoDeleteCommitUnknown, err
	}
	if visible.ID == repository.ID &&
		visible.UserID == repository.UserID &&
		visible.OrgID == repository.OrgID &&
		visible.Name == repository.Name &&
		visible.LowerName == repository.LowerName {
		return repoDeleteCommitNotApplied, nil
	}
	return repoDeleteCommitUnknown, nil
}

// deleteRepoCompensating provides the same reversible storage boundary for
// callers constructed without a transaction manager. Storage is restored if
// the direct DB delete fails.
func (s *RepoService) deleteRepoCompensating(ctx context.Context, repository db.Repository, owner string, repoHost repoHostStagedDeleteClient) error {
	workCtx, cancelWork, err := beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
	if err != nil {
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	defer cancelWork()

	staged, err := repoHost.StageDeleteRepo(workCtx, owner, repository.Name)
	if err != nil {
		slog.Error("failed to stage repository data for deletion", "owner", owner, "repo_name", repository.Name, "error", err)
		restoreCtx, cancelRestore := repoHostCompensationContext(workCtx)
		restoreErr := restoreStagedRepoDelete(restoreCtx, staged, repoHost)
		cancelRestore()
		if restoreErr != nil {
			slog.Error("failed to restore repository storage after stage-delete error",
				"repo_id", repository.ID, "owner", owner, "repo_name", repository.Name, "error", restoreErr)
		}
		return errors.Internal("failed to delete repository data").WithCause(err)
	}
	if err := s.queries.DeleteRepo(workCtx, repository.ID); err != nil {
		reconcileCtx, cancelReconcile := repoHostCompensationContext(workCtx)
		deleteState, reconcileErr := s.repoDeleteCommitState(reconcileCtx, repository)
		cancelReconcile()
		if reconcileErr == nil && deleteState == repoDeleteCommitApplied {
			_ = s.finalizeRepoDelete(workCtx, repository, staged, repoHost)
			return nil
		}
		if reconcileErr != nil {
			slog.Error("failed to reconcile ambiguous repository delete",
				"repo_id", repository.ID, "owner", owner, "repo_name", repository.Name, "error", reconcileErr)
		}
		if deleteState == repoDeleteCommitUnknown {
			return errors.Internal("failed to delete repository")
		}
		restoreCtx, cancelRestore := repoHostCompensationContext(workCtx)
		restoreErr := restoreStagedRepoDelete(restoreCtx, staged, repoHost)
		cancelRestore()
		if restoreErr != nil {
			slog.Error("failed to restore repository storage after DB delete failure",
				"repo_id", repository.ID, "owner", owner, "repo_name", repository.Name, "error", restoreErr)
		}
		return errors.Internal("failed to delete repository").WithCause(err)
	}
	_ = s.finalizeRepoDelete(workCtx, repository, staged, repoHost)
	return nil
}

// finalizeRepoDelete destroys only the tombstone after the DB outcome is
// durable. A failure leaves quarantined, unreachable storage rather than a
// live row pointing at missing data; it is logged for operator cleanup without
// falsely reporting that the already-committed logical deletion rolled back.
func (s *RepoService) finalizeRepoDelete(ctx context.Context, repository db.Repository, staged repohost.StagedDelete, repoHost repoHostStagedDeleteClient) error {
	finalizeCtx, cancelFinalize := repoHostCompensationContext(ctx)
	defer cancelFinalize()
	err := repoHost.FinalizeStagedDelete(finalizeCtx, staged)
	if err != nil {
		// Completion endpoints are idempotent. One immediate retry closes the
		// common ambiguity where repo-host completed the operation but the HTTP
		// response was lost, and also recovers a compensation request that spent
		// repo-host's first admission window waiting on the in-flight stage lock.
		err = repoHost.FinalizeStagedDelete(finalizeCtx, staged)
	}
	if err != nil {
		slog.Error("failed to finalize staged repository deletion",
			"repo_id", repository.ID, "repo_name", repository.Name, "error", err)
	}
	return err
}

func restoreStagedRepoDelete(ctx context.Context, staged repohost.StagedDelete, repoHost repoHostStagedDeleteClient) error {
	err := repoHost.RestoreStagedDelete(ctx, staged)
	if err != nil {
		err = repoHost.RestoreStagedDelete(ctx, staged)
	}
	return err
}

// settleRepoDeleteIntent performs the idempotent physical decision first and
// removes the durable DB handle only after repo-host confirms it. A failed
// action or failed intent deletion leaves enough state for the reconciler.
func (s *RepoService) settleRepoDeleteIntent(
	ctx context.Context,
	repository db.Repository,
	staged repohost.StagedDelete,
	repoHost repoHostStagedDeleteClient,
	finalize bool,
) {
	var actionErr error
	if finalize {
		actionErr = s.finalizeRepoDelete(ctx, repository, staged, repoHost)
	} else {
		restoreCtx, cancelRestore := repoHostCompensationContext(ctx)
		actionErr = restoreStagedRepoDelete(restoreCtx, staged, repoHost)
		cancelRestore()
		if actionErr != nil {
			slog.Error("failed to restore staged repository deletion",
				"repo_id", repository.ID, "repo_name", repository.Name, "error", actionErr)
		}
	}
	if actionErr != nil || s.storageOperations == nil {
		return
	}
	completeCtx, cancelComplete := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
	defer cancelComplete()
	if err := s.storageOperations.Complete(completeCtx, repository.ID, staged.Token); err != nil {
		slog.Error("failed to complete repository deletion intent",
			"repo_id", repository.ID, "repo_name", repository.Name, "error", err)
	}
}

// ArchiveRepo marks a repository as archived (read-only).
func (s *RepoService) ArchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	if actor == nil {
		return db.Repository{}, errors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, err
	}

	allowed, err := s.canAdminRepo(ctx, repository, actor.ID)
	if err != nil {
		return db.Repository{}, err
	}
	if !allowed {
		return db.Repository{}, errors.Forbidden("permission denied")
	}

	if repository.IsArchived {
		return repository, nil
	}

	updated, err := s.queries.ArchiveRepo(ctx, repository.ID)
	if err != nil {
		if isRepositoryStorageOperationConflict(err) {
			return db.Repository{}, errors.Conflict("repository storage operation is already in progress")
		}
		return db.Repository{}, errors.Internal("failed to archive repository").WithCause(err)
	}

	return updated, nil
}

// UnarchiveRepo removes the archived status from a repository.
func (s *RepoService) UnarchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	if actor == nil {
		return db.Repository{}, errors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, err
	}

	allowed, err := s.canAdminRepo(ctx, repository, actor.ID)
	if err != nil {
		return db.Repository{}, err
	}
	if !allowed {
		return db.Repository{}, errors.Forbidden("permission denied")
	}

	if !repository.IsArchived {
		return repository, nil
	}

	updated, err := s.queries.UnarchiveRepo(ctx, repository.ID)
	if err != nil {
		if isRepositoryStorageOperationConflict(err) {
			return db.Repository{}, errors.Conflict("repository storage operation is already in progress")
		}
		return db.Repository{}, errors.Internal("failed to unarchive repository").WithCause(err)
	}

	return updated, nil
}

func (s *RepoService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))

	if lowerOwner == "" {
		return db.Repository{}, errors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, errors.BadRequest("repository name is required")
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     lowerOwner,
		LowerName: lowerRepo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, errors.NotFound("repository not found")
		}
		return db.Repository{}, errors.Internal("failed to load repository").WithCause(err)
	}

	return repository, nil
}

func (s *RepoService) resolveReadableRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, err
	}

	if repository.IsPublic {
		return repository, nil
	}
	if viewer == nil {
		return db.Repository{}, errors.Forbidden("permission denied")
	}

	allowed, err := s.canReadRepo(ctx, repository, viewer.ID)
	if err != nil {
		return db.Repository{}, err
	}
	if !allowed {
		return db.Repository{}, errors.Forbidden("permission denied")
	}
	return repository, nil
}

func (s *RepoService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *RepoService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

// existingForkOf reports the caller's repository at owner/name when it is
// already a fork of sourceID. Any other answer — no such repository, or a
// repository of that name that is not a fork of this upstream — is reported as
// "not found" so the caller proceeds to the normal create path, where a name
// collision surfaces as a conflict instead of silently adopting someone
// else's repository.
func (s *RepoService) existingForkOf(ctx context.Context, owner, name string, sourceID int64) (db.Repository, bool) {
	existing, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     owner,
		LowerName: strings.ToLower(name),
	})
	if err != nil {
		return db.Repository{}, false
	}
	if !existing.ForkID.Valid || existing.ForkID.Int64 != sourceID {
		return db.Repository{}, false
	}
	return existing, true
}

func (s *RepoService) canAdminRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canAdminRepo(ctx, s.queries, repository, userID)
}

func (s *RepoService) canOwnRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canOwnRepo(ctx, s.queries, repository, userID)
}

func validateRepoName(name string) error {
	invalidNameErr := errors.ValidationFailed(errors.FieldError{
		Resource: "Repository",
		Field:    "name",
		Code:     "invalid",
	})

	if name == "" {
		return errors.ValidationFailed(errors.FieldError{
			Resource: "Repository",
			Field:    "name",
			Code:     "missing_field",
		})
	}
	if len(name) > 100 {
		return invalidNameErr
	}
	if !repoNameRegex.MatchString(name) {
		return invalidNameErr
	}

	lowerName := strings.ToLower(name)
	if strings.HasSuffix(lowerName, ".git") ||
		strings.HasSuffix(lowerName, ".wiki") ||
		strings.HasSuffix(lowerName, ".docs") {
		return invalidNameErr
	}
	if isReservedRepoName(name) {
		return invalidNameErr
	}

	return nil
}

func validateOwnerSegment(resource, field, name string) error {
	if name == "" {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource, Field: field, Code: "missing_field",
		})
	}
	if len(name) > 255 || !ownerSegmentRegex.MatchString(name) {
		return errors.ValidationFailed(errors.FieldError{
			Resource: resource, Field: field, Code: "invalid",
		})
	}
	return nil
}

func (s *RepoService) dispatchRepositoryEvent(
	ctx context.Context,
	repository db.Repository,
	actor *db.User,
	eventType webhooks.EventType,
	action string,
) error {
	if s.dispatcher == nil {
		return nil
	}

	sender := webhooks.UserPayload{}
	if actor != nil {
		sender = webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		}
	}

	payload := webhooks.RepositoryEventPayload{
		Action: action,
		Repository: webhooks.RepositoryPayload{
			ID:   repository.ID,
			Name: repository.Name,
		},
		Sender: sender,
	}

	if err := s.dispatcher.DispatchEvent(ctx, repository.ID, eventType, payload); err != nil {
		return errors.Internal("failed to enqueue webhook delivery").WithCause(err)
	}
	return nil
}

func normalizeTopics(topics []string) ([]string, error) {
	if len(topics) == 0 {
		return []string{}, nil
	}

	normalized := make([]string, 0, len(topics))
	seen := make(map[string]struct{}, len(topics))
	for _, topic := range topics {
		candidate := strings.ToLower(strings.TrimSpace(topic))
		if !repoTopicRegex.MatchString(candidate) {
			return nil, errors.ValidationFailed(errors.FieldError{
				Resource: "Repository",
				Field:    "topics",
				Code:     "invalid",
			})
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		normalized = append(normalized, candidate)
	}
	return normalized, nil
}

func normalizeStringList(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	normalized := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		candidate := strings.TrimSpace(value)
		if candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		normalized = append(normalized, candidate)
	}
	return normalized
}

func isRepoHostStatus(err error, status int) bool {
	statusErr, ok := repohost.IsStatusError(err)
	return ok && statusErr.StatusCode == status
}

func isRepoUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if stdErrors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	lowerErr := strings.ToLower(err.Error())
	return strings.Contains(lowerErr, "duplicate key") || strings.Contains(lowerErr, "unique")
}
