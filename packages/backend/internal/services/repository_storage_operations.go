package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	repositoryStorageOperationDelete = "delete"
	repositoryStorageOperationMove   = "move"

	// The ordinary coordinated mutation is bounded to ten minutes. Reconcile
	// only after a longer grace, and take the same per-repository advisory lock
	// before deciding, so a slow live request always wins over crash recovery.
	repositoryStorageOperationGrace      = repoHostMutationConsistencyTimeout + 5*time.Minute
	repositoryStorageOperationClaimLease = 15 * time.Minute
	repositoryStorageOperationInterval   = time.Minute
	repositoryStorageOperationBatchSize  = int32(100)
)

var (
	errRepositoryStorageOperationExists = stdErrors.New("repository storage operation already exists")
	errRepositoryStorageSourceChanged   = stdErrors.New("repository storage operation source changed")
	errRepositoryStorageTargetChanged   = stdErrors.New("repository storage operation target changed")
	errRepositoryStorageStateUnknown    = stdErrors.New("repository storage operation state is ambiguous")
)

// repositoryStorageOperation is the complete durable handle needed to settle
// a repo-host journal without the API process that created it. Owner IDs are
// the decision identity; exact names are the physical repo-host path identity.
type repositoryStorageOperation struct {
	RepositoryID    int64
	OperationType   string
	Token           string
	StorageRouteKey string
	SourceOwner     string
	SourceRepo      string
	SourceUserID    pgtype.Int8
	SourceOrgID     pgtype.Int8
	TargetOwner     pgtype.Text
	TargetRepo      pgtype.Text
	TargetUserID    pgtype.Int8
	TargetOrgID     pgtype.Int8
	ClaimToken      pgtype.Text
	ClaimedAt       pgtype.Timestamptz
	Attempts        int32
	LastError       pgtype.Text
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

func newDeleteStorageOperation(repository db.Repository, owner string, staged repohost.StagedDelete) repositoryStorageOperation {
	return repositoryStorageOperation{
		RepositoryID:    repository.ID,
		OperationType:   repositoryStorageOperationDelete,
		Token:           staged.Token,
		StorageRouteKey: staged.StorageRouteKey,
		SourceOwner:     owner,
		SourceRepo:      repository.Name,
		SourceUserID:    repository.UserID,
		SourceOrgID:     repository.OrgID,
	}
}

type repositoryStorageOperationStore interface {
	Create(context.Context, repositoryStorageOperation) error
	Verify(context.Context, int64, string) (bool, error)
	Complete(context.Context, int64, string) error
}

type repositoryStorageOperationCoordinator interface {
	repositoryStorageOperationStore
	Claim(context.Context, string, time.Duration, time.Duration, int32) ([]repositoryStorageOperation, error)
	ProcessClaim(
		context.Context,
		repositoryStorageOperation,
		string,
		func(context.Context, repositoryStorageOperation, *db.Repository) error,
	) (bool, error)
}

type postgresRepositoryStorageOperationStore struct {
	pool *pgxpool.Pool
}

func newPostgresRepositoryStorageOperationStore(pool *pgxpool.Pool) *postgresRepositoryStorageOperationStore {
	return &postgresRepositoryStorageOperationStore{pool: pool}
}

// Create serializes with repository ownership transactions before installing
// the unique intent. The intent commit is deliberately separate from the
// later ownership transaction: it must survive an API process stop at any
// point after repo-host is allowed to see the prepared token.
func (s *postgresRepositoryStorageOperationStore) Create(ctx context.Context, operation repositoryStorageOperation) (retErr error) {
	if strings.TrimSpace(operation.StorageRouteKey) == "" {
		return fmt.Errorf("durable repository storage operation has no trusted route key")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin repository storage operation: %w", err)
	}
	defer func() {
		rollbackErr := tx.Rollback(context.Background())
		if rollbackErr != nil && !stdErrors.Is(rollbackErr, pgx.ErrTxClosed) && retErr == nil {
			retErr = fmt.Errorf("rollback repository storage operation: %w", rollbackErr)
		}
	}()

	if _, err := tx.Exec(ctx, repoOwnershipLockSQL, operation.RepositoryID); err != nil {
		return fmt.Errorf("lock repository storage operation: %w", err)
	}
	current, err := loadRepositoryStorageIdentity(ctx, tx, operation.RepositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return errRepositoryStorageSourceChanged
	}
	if err != nil {
		return fmt.Errorf("load repository storage operation source: %w", err)
	}
	if !repositoryMatchesStorageIdentity(current, operation.SourceUserID, operation.SourceOrgID, operation.SourceRepo) {
		return errRepositoryStorageSourceChanged
	}
	canonicalSource, err := repositoryOwnerNameInTx(ctx, tx, operation.SourceUserID, operation.SourceOrgID)
	if err != nil {
		return fmt.Errorf("load repository storage operation source owner: %w", err)
	}
	if canonicalSource != operation.SourceOwner {
		return errRepositoryStorageSourceChanged
	}
	if operation.OperationType == repositoryStorageOperationMove {
		canonicalTarget, err := repositoryOwnerNameInTx(ctx, tx, operation.TargetUserID, operation.TargetOrgID)
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return errRepositoryStorageTargetChanged
		}
		if err != nil {
			return fmt.Errorf("load repository storage operation target owner: %w", err)
		}
		if !operation.TargetOwner.Valid || canonicalTarget != operation.TargetOwner.String ||
			!operation.TargetRepo.Valid || operation.TargetRepo.String != operation.SourceRepo {
			return errRepositoryStorageTargetChanged
		}
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, source_org_id,
			target_owner, target_repo, target_user_id, target_org_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	`,
		operation.RepositoryID, operation.OperationType, operation.Token, operation.StorageRouteKey,
		operation.SourceOwner, operation.SourceRepo, nullableInt8(operation.SourceUserID), nullableInt8(operation.SourceOrgID),
		nullableText(operation.TargetOwner), nullableText(operation.TargetRepo), nullableInt8(operation.TargetUserID), nullableInt8(operation.TargetOrgID),
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if stdErrors.As(err, &pgErr) && pgErr.Code == "23505" {
			return errRepositoryStorageOperationExists
		}
		return fmt.Errorf("insert repository storage operation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit repository storage operation: %w", err)
	}
	return nil
}

func (s *postgresRepositoryStorageOperationStore) Verify(ctx context.Context, repositoryID int64, token string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM repository_storage_operations
			WHERE repository_id = $1 AND token = $2
		)
	`, repositoryID, token).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("verify repository storage operation: %w", err)
	}
	return exists, nil
}

func (s *postgresRepositoryStorageOperationStore) Complete(ctx context.Context, repositoryID int64, token string) error {
	result, err := s.pool.Exec(ctx, `
		DELETE FROM repository_storage_operations
		WHERE repository_id = $1 AND token = $2
	`, repositoryID, token)
	if err != nil {
		return fmt.Errorf("complete repository storage operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("complete repository storage operation: expected 1 row, got %d", result.RowsAffected())
	}
	return nil
}

func (s *postgresRepositoryStorageOperationStore) Claim(
	ctx context.Context,
	claimToken string,
	grace time.Duration,
	lease time.Duration,
	limit int32,
) ([]repositoryStorageOperation, error) {
	graceSeconds := durationSeconds(grace)
	leaseSeconds := durationSeconds(lease)
	rows, err := s.pool.Query(ctx, `
		WITH candidates AS (
			SELECT repository_id
			FROM repository_storage_operations
			WHERE created_at <= NOW() - make_interval(secs => $1::int)
			  AND (
				claim_token IS NULL
				OR claimed_at <= NOW() - make_interval(secs => $2::int)
			  )
			-- A released failure updates updated_at. Ordering by that retry
			-- timestamp moves poison operations behind untouched work instead
			-- of allowing the oldest batch to starve every later journal.
			ORDER BY updated_at, created_at, repository_id
			FOR UPDATE SKIP LOCKED
			LIMIT $3
		)
		UPDATE repository_storage_operations AS operation
		SET claim_token = $4,
			claimed_at = NOW(),
			updated_at = NOW()
		FROM candidates
		WHERE operation.repository_id = candidates.repository_id
		RETURNING operation.repository_id, operation.operation_type, operation.token,
			operation.storage_route_key, operation.source_owner, operation.source_repo,
			operation.source_user_id, operation.source_org_id,
			operation.target_owner, operation.target_repo,
			operation.target_user_id, operation.target_org_id,
			operation.claim_token, operation.claimed_at, operation.attempts,
			operation.last_error, operation.created_at, operation.updated_at
	`, graceSeconds, leaseSeconds, limit, claimToken)
	if err != nil {
		return nil, fmt.Errorf("claim repository storage operations: %w", err)
	}
	defer rows.Close()

	operations := make([]repositoryStorageOperation, 0)
	for rows.Next() {
		operation, err := scanRepositoryStorageOperation(rows)
		if err != nil {
			return nil, fmt.Errorf("scan repository storage operation: %w", err)
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate repository storage operations: %w", err)
	}
	return operations, nil
}

// ProcessClaim holds the repository advisory lock and operation row lock while
// reading DB state and issuing the idempotent repo-host completion. That lock
// makes a slow live ownership transaction finish before recovery can decide,
// and prevents any later ownership mutation from racing the decision.
func (s *postgresRepositoryStorageOperationStore) ProcessClaim(
	ctx context.Context,
	claimed repositoryStorageOperation,
	claimToken string,
	reconcile func(context.Context, repositoryStorageOperation, *db.Repository) error,
) (processed bool, retErr error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin repository storage reconciliation: %w", err)
	}
	defer func() {
		rollbackErr := tx.Rollback(context.Background())
		if rollbackErr != nil && !stdErrors.Is(rollbackErr, pgx.ErrTxClosed) && retErr == nil {
			retErr = fmt.Errorf("rollback repository storage reconciliation: %w", rollbackErr)
		}
	}()

	if _, err := tx.Exec(ctx, repoOwnershipLockSQL, claimed.RepositoryID); err != nil {
		return false, fmt.Errorf("lock repository for storage reconciliation: %w", err)
	}
	row := tx.QueryRow(ctx, `
		SELECT repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, source_org_id,
			target_owner, target_repo, target_user_id, target_org_id,
			claim_token, claimed_at, attempts, last_error, created_at, updated_at
		FROM repository_storage_operations
		WHERE repository_id = $1 AND claim_token = $2
		FOR UPDATE
	`, claimed.RepositoryID, claimToken)
	locked, err := scanRepositoryStorageOperation(row)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lock claimed repository storage operation: %w", err)
	}

	var current *db.Repository
	repository, err := loadRepositoryStorageIdentity(ctx, tx, locked.RepositoryID)
	if err == nil {
		current = &repository
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("load repository for storage reconciliation: %w", err)
	}

	reconcileErr := reconcile(ctx, locked, current)
	if reconcileErr != nil {
		_, releaseErr := tx.Exec(ctx, `
			UPDATE repository_storage_operations
			SET claim_token = NULL,
				claimed_at = NULL,
				attempts = attempts + 1,
				last_error = LEFT($3, 4096),
				updated_at = NOW()
			WHERE repository_id = $1 AND claim_token = $2
		`, locked.RepositoryID, claimToken, reconcileErr.Error())
		if releaseErr != nil {
			return false, stdErrors.Join(reconcileErr, fmt.Errorf("release repository storage operation claim: %w", releaseErr))
		}
		if err := tx.Commit(ctx); err != nil {
			return false, stdErrors.Join(reconcileErr, fmt.Errorf("commit repository storage operation retry: %w", err))
		}
		return false, reconcileErr
	}

	result, err := tx.Exec(ctx, `
		DELETE FROM repository_storage_operations
		WHERE repository_id = $1 AND claim_token = $2
	`, locked.RepositoryID, claimToken)
	if err != nil {
		return false, fmt.Errorf("delete reconciled repository storage operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return false, fmt.Errorf("delete reconciled repository storage operation: expected 1 row, got %d", result.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit repository storage reconciliation: %w", err)
	}
	return true, nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanRepositoryStorageOperation(row rowScanner) (repositoryStorageOperation, error) {
	var operation repositoryStorageOperation
	err := row.Scan(
		&operation.RepositoryID, &operation.OperationType, &operation.Token, &operation.StorageRouteKey,
		&operation.SourceOwner, &operation.SourceRepo, &operation.SourceUserID, &operation.SourceOrgID,
		&operation.TargetOwner, &operation.TargetRepo, &operation.TargetUserID, &operation.TargetOrgID,
		&operation.ClaimToken, &operation.ClaimedAt, &operation.Attempts, &operation.LastError,
		&operation.CreatedAt, &operation.UpdatedAt,
	)
	return operation, err
}

func nullableInt8(value pgtype.Int8) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func nullableText(value pgtype.Text) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func repositoryOwnerNameInTx(ctx context.Context, tx pgx.Tx, userID, orgID pgtype.Int8) (string, error) {
	var owner string
	switch {
	case userID.Valid && !orgID.Valid:
		err := tx.QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, userID.Int64).Scan(&owner)
		return owner, err
	case orgID.Valid && !userID.Valid:
		err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id = $1`, orgID.Int64).Scan(&owner)
		return owner, err
	default:
		return "", fmt.Errorf("invalid repository owner identity")
	}
}

// loadRepositoryStorageIdentity deliberately selects only the columns needed
// for reconciliation. Besides avoiding unrelated decoding work, this keeps the
// recovery path independent of generated model additions such as tsvector.
func loadRepositoryStorageIdentity(ctx context.Context, tx pgx.Tx, repositoryID int64) (db.Repository, error) {
	var repository db.Repository
	err := tx.QueryRow(ctx, `
		SELECT id, user_id, org_id, name, lower_name
		FROM repositories
		WHERE id = $1
		FOR UPDATE
	`, repositoryID).Scan(
		&repository.ID,
		&repository.UserID,
		&repository.OrgID,
		&repository.Name,
		&repository.LowerName,
	)
	return repository, err
}

func durationSeconds(value time.Duration) int32 {
	seconds := value / time.Second
	if seconds < 1 {
		return 1
	}
	if seconds > time.Duration(^uint32(0)>>1) {
		return int32(^uint32(0) >> 1)
	}
	return int32(seconds)
}

// RepositoryStorageOperationReconciler drains abandoned repo-host journals.
// It never guesses: only exact source/target ownership by stable repository ID
// (or absence for delete) can select an action. Ambiguous rows remain durable
// with an operator-visible last_error and are retried later.
type RepositoryStorageOperationReconciler struct {
	coordinator repositoryStorageOperationCoordinator
	repoHost    interface {
		repoHostStagedDeleteClient
		repoHostStagedMoveClient
	}
	interval  time.Duration
	grace     time.Duration
	lease     time.Duration
	batchSize int32
}

func NewRepositoryStorageOperationReconciler(pool *pgxpool.Pool, repoHost *repohost.Client) *RepositoryStorageOperationReconciler {
	return &RepositoryStorageOperationReconciler{
		coordinator: newPostgresRepositoryStorageOperationStore(pool),
		repoHost:    repoHost,
		interval:    repositoryStorageOperationInterval,
		grace:       repositoryStorageOperationGrace,
		lease:       repositoryStorageOperationClaimLease,
		batchSize:   repositoryStorageOperationBatchSize,
	}
}

func (r *RepositoryStorageOperationReconciler) Start(ctx context.Context) {
	r.runSweep(ctx)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.runSweep(ctx)
		}
	}
}

func (r *RepositoryStorageOperationReconciler) runSweep(ctx context.Context) {
	processed, err := r.sweep(ctx)
	if err != nil {
		slog.Warn("repository storage reconciliation failed", "processed", processed, "error", err)
	} else if processed > 0 {
		slog.Info("repository storage reconciliation completed", "processed", processed)
	}
}

func (r *RepositoryStorageOperationReconciler) sweep(ctx context.Context) (int, error) {
	claimToken := uuid.NewString()
	operations, err := r.coordinator.Claim(ctx, claimToken, r.grace, r.lease, r.batchSize)
	if err != nil {
		return 0, err
	}

	processed := 0
	var sweepErr error
	for _, operation := range operations {
		done, err := r.coordinator.ProcessClaim(ctx, operation, claimToken, r.reconcile)
		if done {
			processed++
		}
		if err != nil {
			sweepErr = stdErrors.Join(sweepErr, fmt.Errorf("repository %d: %w", operation.RepositoryID, err))
		}
	}
	return processed, sweepErr
}

func (r *RepositoryStorageOperationReconciler) reconcile(
	ctx context.Context,
	operation repositoryStorageOperation,
	current *db.Repository,
) error {
	actionCtx, cancel := context.WithTimeout(ctx, repoHostMutationConsistencyTimeout)
	defer cancel()

	switch operation.OperationType {
	case repositoryStorageOperationDelete:
		staged := repohost.StagedDelete{
			StorageRouteKey: operation.StorageRouteKey,
			Token:           operation.Token,
			Owner:           operation.SourceOwner,
			Repo:            operation.SourceRepo,
		}
		if current == nil {
			return r.repoHost.FinalizeStagedDelete(actionCtx, staged)
		}
		if repositoryMatchesStorageIdentity(*current, operation.SourceUserID, operation.SourceOrgID, operation.SourceRepo) {
			return r.repoHost.RestoreStagedDelete(actionCtx, staged)
		}
		return fmt.Errorf("%w: delete repository is neither absent nor at its exact source identity", errRepositoryStorageStateUnknown)

	case repositoryStorageOperationMove:
		if current == nil {
			return fmt.Errorf("%w: moved repository no longer exists", errRepositoryStorageStateUnknown)
		}
		staged := repohost.StagedMove{
			StorageRouteKey: operation.StorageRouteKey,
			Token:           operation.Token,
			SrcOwner:        operation.SourceOwner,
			SrcRepo:         operation.SourceRepo,
			DstOwner:        operation.TargetOwner.String,
			DstRepo:         operation.TargetRepo.String,
		}
		if repositoryMatchesStorageIdentity(*current, operation.TargetUserID, operation.TargetOrgID, operation.TargetRepo.String) {
			return r.repoHost.FinalizeStagedMove(actionCtx, staged)
		}
		if repositoryMatchesStorageIdentity(*current, operation.SourceUserID, operation.SourceOrgID, operation.SourceRepo) {
			return r.repoHost.RollbackStagedMove(actionCtx, staged)
		}
		return fmt.Errorf("%w: moved repository is at neither its exact source nor target identity", errRepositoryStorageStateUnknown)
	default:
		return fmt.Errorf("%w: unsupported operation type %q", errRepositoryStorageStateUnknown, operation.OperationType)
	}
}

func repositoryMatchesStorageIdentity(repository db.Repository, userID, orgID pgtype.Int8, exactRepoName string) bool {
	return repository.UserID == userID &&
		repository.OrgID == orgID &&
		repository.Name == exactRepoName &&
		repository.LowerName == strings.ToLower(exactRepoName)
}
