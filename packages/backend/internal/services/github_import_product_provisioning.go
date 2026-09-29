package services

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// productImportProvisioningStore uses the already durable import_jobs claim as
// the local repository reservation. No fleet placement or cluster journal is
// needed: the single owner has one repository engine and one product database.
type productImportProvisioningStore struct{ pool *pgxpool.Pool }

var _ githubImportProvisioningStore = (*productImportProvisioningStore)(nil)

// WithGitHubImportProductProvisioning selects the product-only reservation
// protocol while retaining the common import worker and public job receipts.
// It must be passed only for the single-owner role. The clustered host keeps
// its independent placement/provisioning journal.
func WithGitHubImportProductProvisioning(pool *pgxpool.Pool) GitHubImportOption {
	return func(service *GitHubImportService) {
		if pool != nil {
			service.pool = pool
			service.provisioning = &productImportProvisioningStore{pool: pool}
		}
	}
}

func (store *productImportProvisioningStore) Reserve(ctx context.Context, wanted repositoryProvisioningOperation) (_ repositoryProvisioningOperation, retErr error) {
	if wanted.OperationType != repositoryProvisionImport || wanted.ImportJobID == "" || wanted.ImportJobClaimToken == "" ||
		wanted.UserID.Valid == wanted.OrgID.Valid || (wanted.UserID.Valid && wanted.UserID.Int64 != wanted.ActorID) {
		return repositoryProvisioningOperation{}, errRepositoryProvisionMismatch
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("begin product import reservation: %w", err)
	}
	defer tx.Rollback(context.Background())
	var jobUserID int64
	var jobOwner, jobName, githubOwner, githubRepo, claimToken string
	var boundID pgtype.Int8
	var boundToken pgtype.Text
	err = tx.QueryRow(ctx, `SELECT user_id, repo_owner, repo_name, github_owner, github_repo,
		claim_token, provisioning_repository_id, provisioning_token
		FROM import_jobs WHERE id=$1 AND status='cloning' FOR UPDATE`, wanted.ImportJobID).
		Scan(&jobUserID, &jobOwner, &jobName, &githubOwner, &githubRepo, &claimToken, &boundID, &boundToken)
	if err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("lock product import reservation: %w", err)
	}
	if claimToken != wanted.ImportJobClaimToken || jobUserID != wanted.ActorID || jobOwner != wanted.OwnerName ||
		(!strings.EqualFold(jobName, githubRepo) && !strings.EqualFold(jobName, wanted.Name)) {
		return repositoryProvisioningOperation{}, errRepositoryProvisionMismatch
	}
	if wanted.OrgID.Valid {
		var member bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM org_members
			WHERE organization_id=$1 AND user_id=$2)`, wanted.OrgID.Int64, wanted.ActorID).Scan(&member); err != nil {
			return repositoryProvisioningOperation{}, err
		}
		if !member {
			return repositoryProvisioningOperation{}, errRepositoryProvisionMismatch
		}
	}
	if boundToken.Valid {
		if !boundID.Valid || boundToken.String != wanted.Token || !strings.EqualFold(jobName, wanted.Name) {
			return repositoryProvisioningOperation{}, errRepositoryProvisionMismatch
		}
		wanted.RepositoryID = boundID.Int64
		if err := tx.Commit(ctx); err != nil {
			return repositoryProvisioningOperation{}, err
		}
		return wanted, nil
	}
	if err := verifyProvisionOwners(ctx, tx, wanted); err != nil {
		return repositoryProvisioningOperation{}, err
	}
	if err := lockRepositoryProvisionNamespace(ctx, tx, wanted); err != nil {
		return repositoryProvisioningOperation{}, err
	}
	var occupied bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM repositories WHERE user_id IS NOT DISTINCT FROM $1
		AND org_id IS NOT DISTINCT FROM $2 AND lower_name=$3)
		OR EXISTS (SELECT 1 FROM import_jobs WHERE id<>$4
		AND lower(repo_owner)=lower($5) AND lower(repo_name)=lower($6)
		AND status='cloning' AND provisioning_token IS NOT NULL)`,
		wanted.UserID, wanted.OrgID, wanted.LowerName, wanted.ImportJobID, wanted.OwnerName, wanted.Name).Scan(&occupied)
	if err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("inspect product import namespace: %w", err)
	}
	if occupied {
		return repositoryProvisioningOperation{}, errRepositoryProvisionConflict
	}
	if err := tx.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('repositories', 'id'))`).Scan(&wanted.RepositoryID); err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("reserve product repository ID: %w", err)
	}
	result, err := tx.Exec(ctx, `UPDATE import_jobs SET provisioning_repository_id=$1, provisioning_token=$2,
		repo_name=$3, default_bookmark=$4, publish_ready=false, updated_at=NOW()
		WHERE id=$5 AND status='cloning' AND claim_token=$6 AND provisioning_token IS NULL`,
		wanted.RepositoryID, wanted.Token, wanted.Name, wanted.DefaultBookmark,
		wanted.ImportJobID, wanted.ImportJobClaimToken)
	if err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("bind product import reservation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return repositoryProvisioningOperation{}, errRepositoryProvisionInProgress
	}
	if err := tx.Commit(ctx); err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("commit product import reservation: %w", err)
	}
	return wanted, nil
}

func (store *productImportProvisioningStore) GetByToken(ctx context.Context, token string) (repositoryProvisioningOperation, error) {
	return scanProductImportProvision(store.pool.QueryRow(ctx, `SELECT provisioning_repository_id, provisioning_token,
		user_id, repo_owner, repo_name, github_owner, github_repo, default_bookmark,
		publish_ready, claim_token, id,
		(SELECT id FROM organizations WHERE lower_name=lower(import_jobs.repo_owner))
		FROM import_jobs WHERE provisioning_token=$1 AND status='cloning'`, token))
}

func scanProductImportProvision(row pgx.Row) (repositoryProvisioningOperation, error) {
	var operation repositoryProvisioningOperation
	var githubOwner, githubRepo, jobID string
	var claimToken pgtype.Text
	if err := row.Scan(&operation.RepositoryID, &operation.Token, &operation.ActorID,
		&operation.OwnerName, &operation.Name, &githubOwner, &githubRepo,
		&operation.DefaultBookmark, &operation.PublishReady, &claimToken, &jobID, &operation.OrgID); err != nil {
		return repositoryProvisioningOperation{}, err
	}
	operation.OperationType = repositoryProvisionImport
	operation.StorageSetID = DefaultStorageSetID
	if !operation.OrgID.Valid {
		operation.UserID = pgtype.Int8{Int64: operation.ActorID, Valid: true}
	}
	operation.LowerName = strings.ToLower(operation.Name)
	operation.Description = "Imported from github.com/" + githubOwner + "/" + githubRepo
	operation.ClaimToken = claimToken
	operation.ImportJobID = jobID
	return operation, nil
}

func (store *productImportProvisioningStore) confirmClaim(ctx context.Context, repositoryID int64, token, claimToken string) error {
	result, err := store.pool.Exec(ctx, `UPDATE import_jobs SET claimed_at=NOW(), updated_at=NOW()
		WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND claim_token=$3
		AND status='cloning'`, repositoryID, token, claimToken)
	if err != nil {
		return fmt.Errorf("renew product import reservation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionInProgress
	}
	return nil
}

func (store *productImportProvisioningStore) AcquireProcessing(ctx context.Context, repositoryID int64, token, claimToken string) error {
	return store.confirmClaim(ctx, repositoryID, token, claimToken)
}

func (store *productImportProvisioningStore) RenewClaim(ctx context.Context, repositoryID int64, token, claimToken string) error {
	return store.confirmClaim(ctx, repositoryID, token, claimToken)
}

func (store *productImportProvisioningStore) MarkPublishReady(ctx context.Context, repositoryID int64, token, claimToken string) error {
	result, err := store.pool.Exec(ctx, `UPDATE import_jobs SET publish_ready=true, claimed_at=NOW(), updated_at=NOW()
		WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND claim_token=$3
		AND default_bookmark<>'' AND status='cloning'`, repositoryID, token, claimToken)
	if err != nil {
		return fmt.Errorf("seal product import mirror: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionInProgress
	}
	return nil
}

func productImportRepositoryMatches(repository db.Repository, operation repositoryProvisioningOperation) bool {
	return repository.ID == operation.RepositoryID && repository.UserID == operation.UserID && repository.OrgID == operation.OrgID && repository.Name == operation.Name &&
		repository.LowerName == operation.LowerName && repository.Description == operation.Description &&
		!repository.IsPublic && repository.DefaultBookmark == operation.DefaultBookmark
}

func (store *productImportProvisioningStore) GetPublished(ctx context.Context, operation repositoryProvisioningOperation) (db.Repository, bool, error) {
	repository, err := db.New(store.pool).GetRepoByID(ctx, operation.RepositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, false, nil
	}
	if err != nil {
		return db.Repository{}, false, err
	}
	if !productImportRepositoryMatches(repository, operation) {
		return db.Repository{}, false, errRepositoryProvisionConflict
	}
	return repository, true, nil
}

func (store *productImportProvisioningStore) Publish(ctx context.Context, operation repositoryProvisioningOperation, claimToken string) (_ db.Repository, retErr error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return db.Repository{}, fmt.Errorf("begin product import publication: %w", err)
	}
	defer tx.Rollback(context.Background())
	current, err := scanProductImportProvision(tx.QueryRow(ctx, `SELECT provisioning_repository_id, provisioning_token,
		user_id, repo_owner, repo_name, github_owner, github_repo, default_bookmark,
		publish_ready, claim_token, id,
		(SELECT id FROM organizations WHERE lower_name=lower(import_jobs.repo_owner)) FROM import_jobs
		WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND status='cloning' FOR UPDATE`,
		operation.RepositoryID, operation.Token))
	if err != nil {
		return db.Repository{}, fmt.Errorf("lock product import publication: %w", err)
	}
	if !current.PublishReady || !current.ClaimToken.Valid || current.ClaimToken.String != claimToken ||
		!sameRepositoryProvision(current, operation) {
		return db.Repository{}, errRepositoryProvisionMismatch
	}
	queries := db.New(tx)
	repository, err := queries.GetRepoByID(ctx, operation.RepositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO repositories
			(id, user_id, org_id, name, lower_name, description, is_public, default_bookmark)
			VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
			current.RepositoryID, current.UserID, current.OrgID, current.Name,
			current.LowerName, current.Description, current.DefaultBookmark)
		if err != nil {
			return db.Repository{}, fmt.Errorf("publish product imported repository: %w", err)
		}
		repository, err = queries.GetRepoByID(ctx, operation.RepositoryID)
	}
	if err != nil {
		return db.Repository{}, err
	}
	if !productImportRepositoryMatches(repository, current) {
		return db.Repository{}, errRepositoryProvisionConflict
	}
	result, err := tx.Exec(ctx, `UPDATE import_jobs SET repository_id=$1, updated_at=NOW()
		WHERE id=$2 AND claim_token=$3 AND provisioning_repository_id=$1 AND provisioning_token=$4`,
		current.RepositoryID, current.ImportJobID, claimToken, current.Token)
	if err != nil {
		return db.Repository{}, fmt.Errorf("bind published product import: %w", err)
	}
	if result.RowsAffected() != 1 {
		return db.Repository{}, errRepositoryProvisionInProgress
	}
	if err := tx.Commit(ctx); err != nil {
		return db.Repository{}, fmt.Errorf("commit product import publication: %w", err)
	}
	return repository, nil
}

func (store *productImportProvisioningStore) Complete(ctx context.Context, repositoryID int64, token, claimToken string) error {
	var exists bool
	if err := store.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM import_jobs
		WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND claim_token=$3
		AND repository_id=$1 AND status='cloning')`, repositoryID, token, claimToken).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errRepositoryProvisionMissing
	}
	// The subsequent markDurableImportReady transaction owns the final receipt.
	// Keep the binding until then so a crash in that small window can resume.
	return nil
}

func (store *productImportProvisioningStore) Abort(ctx context.Context, operation repositoryProvisioningOperation, claimToken string, abortStorage func(context.Context) error) error {
	if abortStorage == nil {
		return errors.New("product import abort requires storage callback")
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var published bool
	err = tx.QueryRow(ctx, `SELECT repository_id IS NOT NULL FROM import_jobs
		WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND claim_token=$3
		AND status='cloning' FOR UPDATE`, operation.RepositoryID, operation.Token, claimToken).Scan(&published)
	if err != nil {
		return err
	}
	if published {
		return errRepositoryProvisionConflict
	}
	if err := abortStorage(ctx); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE import_jobs SET provisioning_repository_id=NULL,
		provisioning_token=NULL, default_bookmark='', publish_ready=false, updated_at=NOW()
		WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND claim_token=$3
		AND repository_id IS NULL AND status='cloning'`, operation.RepositoryID, operation.Token, claimToken)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionInProgress
	}
	return tx.Commit(ctx)
}

func (*productImportProvisioningStore) ReleaseClaim(context.Context, repositoryProvisioningOperation, string, error) {
	// import_jobs owns the only lease. handleDurableImportFailure releases it
	// with a retry schedule after any physical compensation is complete.
}
