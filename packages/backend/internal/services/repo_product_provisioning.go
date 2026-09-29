package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const productRepositoryStorageID = "local"

var errProductCreationBusy = stdErrors.New("repository creation is already running")

// productCreationSpec is an invisible namespace reservation. It contains only
// product identity and immutable creation inputs, never cluster placement.
type productCreationSpec struct {
	RepositoryID                            int64
	Token                                   string
	OperationType                           string
	ActorID                                 int64
	UserID, OrgID                           pgtype.Int8
	OwnerName, Name, LowerName, Description string
	IsPublic                                bool
	DefaultBookmark                         string
	AutoInit                                bool
	SourceRepositoryID                      pgtype.Int8
	SourceOwner, SourceRepo                 string
}

func (s productCreationSpec) staged() repohost.StagedProvision {
	return repohost.StagedProvision{
		StorageSetID: productRepositoryStorageID, Token: s.Token,
		OperationType: s.OperationType, Owner: s.OwnerName, Repo: s.Name,
		DefaultBookmark: s.DefaultBookmark, AutoInit: s.AutoInit,
		SrcOwner: s.SourceOwner, SrcRepo: s.SourceRepo,
	}
}

func (s productCreationSpec) same(wanted productCreationSpec) bool {
	return s.OperationType == wanted.OperationType && s.ActorID == wanted.ActorID &&
		s.UserID == wanted.UserID && s.OrgID == wanted.OrgID &&
		s.OwnerName == wanted.OwnerName && s.Name == wanted.Name &&
		s.LowerName == wanted.LowerName && s.Description == wanted.Description &&
		s.IsPublic == wanted.IsPublic && s.DefaultBookmark == wanted.DefaultBookmark &&
		s.AutoInit == wanted.AutoInit && s.SourceRepositoryID == wanted.SourceRepositoryID &&
		s.SourceOwner == wanted.SourceOwner && s.SourceRepo == wanted.SourceRepo
}

type productRepositoryProvisioner struct {
	pool *pgxpool.Pool
	host repoHostProvisioningClient
}

func (s *RepoService) createProductRepository(ctx context.Context, wanted productCreationSpec, ownerType string, ownerID int64) (db.Repository, error) {
	if s.productProvisioning == nil {
		return db.Repository{}, errors.Internal("product repository provisioning is unavailable")
	}
	var staged repohost.StagedProvision
	var err error
	if wanted.OperationType == repositoryProvisionFork {
		staged, err = s.productProvisioning.host.PrepareStagedFork(ctx, productRepositoryStorageID,
			wanted.SourceOwner, wanted.SourceRepo, wanted.OwnerName, wanted.Name)
	} else {
		staged, err = s.productProvisioning.host.PrepareStagedInit(ctx, productRepositoryStorageID,
			wanted.OwnerName, wanted.Name, wanted.DefaultBookmark, wanted.AutoInit)
	}
	if err != nil {
		return db.Repository{}, errors.Internal("failed to prepare repository storage").WithCause(err)
	}
	wanted.Token = staged.Token
	var repository db.Repository
	run := func(commitCtx context.Context) error {
		return s.productProvisioning.withNamespaceLock(commitCtx, wanted, false, func(conn *pgxpool.Conn) error {
			reserved, reserveErr := s.productProvisioning.reserve(commitCtx, conn, wanted)
			if reserveErr != nil {
				return reserveErr
			}
			consistencyCtx, cancel := context.WithTimeout(context.WithoutCancel(commitCtx), repoHostMutationConsistencyTimeout)
			defer cancel()
			var settleErr error
			repository, settleErr = s.productProvisioning.settle(consistencyCtx, conn, reserved)
			return settleErr
		})
	}
	var exact bool
	exact, err = s.productProvisioning.findExact(ctx, wanted)
	if err == nil {
		if exact {
			err = run(ctx)
		} else {
			err = authorizePrivateRepoThenCommit(ctx, s.billing, ownerType, ownerID, !wanted.IsPublic, run)
			if err != nil {
				// The matching reservation may have appeared after the first read.
				// Its row already consumes quota, so finish that same operation.
				if retry, retryErr := s.productProvisioning.findExact(ctx, wanted); retryErr == nil && retry {
					err = run(ctx)
				}
			}
		}
	}
	if err != nil {
		if stdErrors.Is(err, errRepositoryProvisionConflict) || stdErrors.Is(err, errRepositoryProvisionMismatch) {
			return db.Repository{}, errors.Conflict(fmt.Sprintf("repository '%s' already exists", wanted.Name))
		}
		if stdErrors.Is(err, errProductCreationBusy) {
			return db.Repository{}, errors.Conflict("repository creation is already in progress")
		}
		slog.Error("product repository creation did not settle", "owner", wanted.OwnerName, "repo", wanted.Name, "error", err)
		return db.Repository{}, errors.Internal("failed to create repository").WithCause(err)
	}
	return repository, nil
}

func (p *productRepositoryProvisioner) findExact(ctx context.Context, wanted productCreationSpec) (bool, error) {
	reserved, err := scanProductCreation(p.pool.QueryRow(ctx, `SELECT `+productCreationColumns+` FROM public.repository_creation_jobs
		WHERE lower_name=$1 AND (($2::bigint IS NOT NULL AND user_id=$2) OR ($3::bigint IS NOT NULL AND org_id=$3))`,
		wanted.LowerName, nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID)))
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !reserved.same(wanted) {
		return false, errRepositoryProvisionMismatch
	}
	return true, nil
}

func (p *productRepositoryProvisioner) withNamespaceLock(ctx context.Context, spec productCreationSpec, try bool, work func(*pgxpool.Conn) error) error {
	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var locked bool
	if try {
		err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(public.smithers_product_repository_namespace_key($1,$2,$3))`,
			nullableInt8(spec.UserID), nullableInt8(spec.OrgID), spec.LowerName).Scan(&locked)
	} else {
		_, err = conn.Exec(ctx, `SELECT pg_advisory_lock(public.smithers_product_repository_namespace_key($1,$2,$3))`,
			nullableInt8(spec.UserID), nullableInt8(spec.OrgID), spec.LowerName)
		locked = err == nil
	}
	if err != nil {
		return err
	}
	if !locked {
		return errProductCreationBusy
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(unlockCtx, `SELECT pg_advisory_unlock(public.smithers_product_repository_namespace_key($1,$2,$3))`,
			nullableInt8(spec.UserID), nullableInt8(spec.OrgID), spec.LowerName).Scan(&unlocked); err != nil || !unlocked {
			_ = conn.Conn().Close(context.Background())
		}
	}()
	return work(conn)
}

const productCreationColumns = `repository_id, token, operation_type, actor_id, user_id, org_id,
	owner_name, name, lower_name, description, is_public, default_bookmark, auto_init,
	source_repository_id, source_owner, source_repo`

func scanProductCreation(row pgx.Row) (productCreationSpec, error) {
	var operation productCreationSpec
	var sourceOwner, sourceRepo pgtype.Text
	err := row.Scan(&operation.RepositoryID, &operation.Token, &operation.OperationType,
		&operation.ActorID, &operation.UserID, &operation.OrgID, &operation.OwnerName,
		&operation.Name, &operation.LowerName, &operation.Description, &operation.IsPublic,
		&operation.DefaultBookmark, &operation.AutoInit, &operation.SourceRepositoryID,
		&sourceOwner, &sourceRepo)
	operation.SourceOwner, operation.SourceRepo = sourceOwner.String, sourceRepo.String
	return operation, err
}

func (p *productRepositoryProvisioner) reserve(ctx context.Context, conn *pgxpool.Conn, wanted productCreationSpec) (_ productCreationSpec, retErr error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return productCreationSpec{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	reserved, err := scanProductCreation(tx.QueryRow(ctx, `SELECT `+productCreationColumns+` FROM public.repository_creation_jobs
		WHERE lower_name=$1 AND (($2::bigint IS NOT NULL AND user_id=$2) OR ($3::bigint IS NOT NULL AND org_id=$3))`,
		wanted.LowerName, nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID)))
	if err == nil {
		if !reserved.same(wanted) {
			return productCreationSpec{}, errRepositoryProvisionMismatch
		}
		return reserved, tx.Commit(ctx)
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return productCreationSpec{}, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.repositories WHERE lower_name=$1
		AND (($2::bigint IS NOT NULL AND user_id=$2) OR ($3::bigint IS NOT NULL AND org_id=$3)))`,
		wanted.LowerName, nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID)).Scan(&exists); err != nil {
		return productCreationSpec{}, err
	}
	if exists {
		return productCreationSpec{}, errRepositoryProvisionConflict
	}
	if err := tx.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('public.repositories','id'))`).Scan(&wanted.RepositoryID); err != nil {
		return productCreationSpec{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO public.repository_creation_jobs (`+productCreationColumns+`)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		wanted.RepositoryID, wanted.Token, wanted.OperationType, wanted.ActorID,
		nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID), wanted.OwnerName,
		wanted.Name, wanted.LowerName, wanted.Description, wanted.IsPublic,
		wanted.DefaultBookmark, wanted.AutoInit, nullableInt8(wanted.SourceRepositoryID),
		nullableProductText(wanted.SourceOwner), nullableProductText(wanted.SourceRepo))
	if err != nil {
		var pgErr *pgconn.PgError
		if stdErrors.As(err, &pgErr) && pgErr.Code == "23505" {
			return productCreationSpec{}, errRepositoryProvisionConflict
		}
		return productCreationSpec{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		// The commit may have succeeded even when its acknowledgement was lost.
		recovered, recoverErr := scanProductCreation(conn.QueryRow(context.WithoutCancel(ctx),
			`SELECT `+productCreationColumns+` FROM public.repository_creation_jobs WHERE token=$1`, wanted.Token))
		if recoverErr == nil && recovered.same(wanted) {
			return recovered, nil
		}
		return productCreationSpec{}, err
	}
	return wanted, nil
}

func nullableProductText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (p *productRepositoryProvisioner) published(ctx context.Context, conn *pgxpool.Conn, spec productCreationSpec) (db.Repository, bool, error) {
	repository, err := db.New(conn).GetRepoByID(ctx, spec.RepositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, false, nil
	}
	if err != nil {
		return db.Repository{}, false, err
	}
	if repository.UserID != spec.UserID || repository.OrgID != spec.OrgID ||
		repository.Name != spec.Name || repository.LowerName != spec.LowerName ||
		repository.Description != spec.Description || repository.IsPublic != spec.IsPublic ||
		repository.DefaultBookmark != spec.DefaultBookmark || repository.IsFork != (spec.OperationType == repositoryProvisionFork) ||
		repository.ForkID != spec.SourceRepositoryID {
		return db.Repository{}, false, errRepositoryProvisionMismatch
	}
	return repository, true, nil
}

func (p *productRepositoryProvisioner) publish(ctx context.Context, conn *pgxpool.Conn, spec productCreationSpec) (_ db.Repository, retErr error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return db.Repository{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('smithers.product_repository_creation_token',$1,true)`, spec.Token); err != nil {
		return db.Repository{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO public.repositories
		(id,user_id,org_id,name,lower_name,description,is_public,default_bookmark,is_fork,fork_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, spec.RepositoryID,
		nullableInt8(spec.UserID), nullableInt8(spec.OrgID), spec.Name, spec.LowerName,
		spec.Description, spec.IsPublic, spec.DefaultBookmark,
		spec.OperationType == repositoryProvisionFork, nullableInt8(spec.SourceRepositoryID))
	if err != nil {
		return db.Repository{}, err
	}
	repository, err := db.New(tx).GetRepoByID(ctx, spec.RepositoryID)
	if err != nil {
		return db.Repository{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		// An ambiguous commit is adopted only by the reserved stable ID.
		recovered, found, lookupErr := p.published(context.WithoutCancel(ctx), conn, spec)
		if lookupErr == nil && found {
			return recovered, nil
		}
		return db.Repository{}, err
	}
	return repository, nil
}

func (p *productRepositoryProvisioner) settle(ctx context.Context, conn *pgxpool.Conn, spec productCreationSpec) (repository db.Repository, retErr error) {
	defer func() {
		if retErr != nil {
			_, _ = conn.Exec(context.WithoutCancel(ctx), `UPDATE public.repository_creation_jobs
				SET last_error=$2, updated_at=now() WHERE repository_id=$1`, spec.RepositoryID, retErr.Error())
		}
	}()
	_, _ = conn.Exec(ctx, `UPDATE public.repository_creation_jobs SET attempts=attempts+1, last_error=NULL, updated_at=now()
		WHERE repository_id=$1`, spec.RepositoryID)
	repository, found, err := p.published(ctx, conn, spec)
	if err != nil {
		return db.Repository{}, err
	}
	staged := spec.staged()
	if !found {
		if err := p.host.ExecuteStagedProvision(ctx, staged); err != nil {
			return db.Repository{}, p.abortDefinitiveConflict(ctx, conn, spec, err)
		}
		if err := p.host.PublishStagedProvision(ctx, staged); err != nil {
			return db.Repository{}, p.abortDefinitiveConflict(ctx, conn, spec, err)
		}
		repository, err = p.publish(ctx, conn, spec)
		if err != nil {
			return db.Repository{}, err
		}
	}
	if err := p.host.FinalizeStagedProvision(ctx, staged); err != nil {
		// The row and live jj store are already published. Retain the job for
		// recovery, while returning the successful repository to the caller.
		slog.Error("product repository staging cleanup requires retry", "repo_id", spec.RepositoryID, "error", err)
		return repository, nil
	}
	if _, err := conn.Exec(ctx, `DELETE FROM public.repository_creation_jobs WHERE repository_id=$1 AND token=$2`, spec.RepositoryID, spec.Token); err != nil {
		slog.Error("product repository creation receipt requires retry", "repo_id", spec.RepositoryID, "error", err)
	}
	return repository, nil
}

func (p *productRepositoryProvisioner) abortDefinitiveConflict(ctx context.Context, conn *pgxpool.Conn, spec productCreationSpec, cause error) error {
	if !isDefinitiveProvisionConflict(cause) {
		return cause
	}
	if err := p.host.AbortStagedProvision(ctx, spec.staged()); err != nil {
		return stdErrors.Join(cause, fmt.Errorf("abort staged repository: %w", err))
	}
	if _, err := conn.Exec(ctx, `DELETE FROM public.repository_creation_jobs WHERE repository_id=$1 AND token=$2`, spec.RepositoryID, spec.Token); err != nil {
		return stdErrors.Join(cause, fmt.Errorf("release repository reservation: %w", err))
	}
	return errRepositoryProvisionConflict
}

// ReconcileProductRepositoryCreates completes persisted reservations after a
// crash. It is safe to call at startup and while requests are running.
func (s *RepoService) ReconcileProductRepositoryCreates(ctx context.Context) error {
	if !s.productOnly || s.productProvisioning == nil {
		return nil
	}
	rows, err := s.productProvisioning.pool.Query(ctx, `SELECT `+productCreationColumns+`
		FROM public.repository_creation_jobs ORDER BY updated_at LIMIT 100`)
	if err != nil {
		return err
	}
	var pending []productCreationSpec
	for rows.Next() {
		operation, scanErr := scanProductCreation(rows)
		if scanErr != nil {
			rows.Close()
			return scanErr
		}
		pending = append(pending, operation)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var failures error
	for _, operation := range pending {
		if err := s.productProvisioning.withNamespaceLock(ctx, operation, true, func(conn *pgxpool.Conn) error {
			consistencyCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoHostMutationConsistencyTimeout)
			defer cancel()
			// The pending list is only a hint. Compensation or another recovery
			// may have completed it before this namespace lock was acquired.
			current, err := scanProductCreation(conn.QueryRow(consistencyCtx, `SELECT `+productCreationColumns+`
				FROM public.repository_creation_jobs WHERE repository_id=$1 AND token=$2`, operation.RepositoryID, operation.Token))
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			_, settleErr := s.productProvisioning.settle(consistencyCtx, conn, current)
			return settleErr
		}); err != nil && !stdErrors.Is(err, errProductCreationBusy) {
			slog.Error("product repository creation recovery failed", "repo_id", operation.RepositoryID, "error", err)
			failures = stdErrors.Join(failures, fmt.Errorf("repository %d: %w", operation.RepositoryID, err))
		}
	}
	return failures
}

// StartProductRepositoryCreationReconciler runs the recovery pass immediately
// and on a bounded interval until the host shuts down.
func (s *RepoService) StartProductRepositoryCreationReconciler(ctx context.Context) {
	if !s.productOnly || s.productProvisioning == nil {
		return
	}
	if err := s.ReconcileProductRepositoryCreates(ctx); err != nil {
		slog.Error("product repository recovery failed", "error", err)
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.ReconcileProductRepositoryCreates(ctx); err != nil {
				slog.Error("product repository recovery failed", "error", err)
			}
		}
	}
}
