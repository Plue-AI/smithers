package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// An admitted TODO attempt survives restart unchanged. A later attempt reads
// the new main overlay, never the TODO's mutable working copy.
func installCodingProject(pool *pgxpool.Pool, sources workspaceapi.SourceFiles) func(context.Context, flowhost.HostLaunch) ([]byte, error) {
	return func(ctx context.Context, launch flowhost.HostLaunch) ([]byte, error) {
		key := "coding.snapshot:" + launch.Binding.ID
		existingSnapshotOnly := false
		if launch.Authority.Target.BindingKind == flowdispatch.StackBindingKind {
			id, err := uuid.Parse(launch.Authority.Target.BindingID)
			if err != nil {
				return nil, err
			}
			item, err := db.New(pool).GetMythicalItem(ctx, pgtype.UUID{Bytes: [16]byte(id), Valid: true})
			if err != nil {
				return nil, err
			}
			if item.RepositoryID != launch.Binding.RepositoryID {
				return nil, fmt.Errorf("coding configuration repository differs")
			}
			key = fmt.Sprintf("coding.snapshot:todo:%s:%d", id.String(), item.Attempt)
		} else if launch.Authority.Target.BindingKind == "browser-flow" {
			execution, err := services.ResolveTodoWorkspaceExecution(ctx, db.New(pool), launch.Binding.RepositoryID, launch.Binding.WorkspaceID)
			if err != nil {
				return nil, err
			}
			if execution != nil {
				if launch.Authority.ExecutionPin == nil || *launch.Authority.ExecutionPin != execution.Pin || launch.Authority.SourceRevision != execution.Pin.SourceCommit {
					return nil, fmt.Errorf("coding execution changed before configuration read")
				}
				key = fmt.Sprintf("coding.snapshot:todo:%s:%d", execution.ItemID, execution.Attempt)
				existingSnapshotOnly = true
			} else if launch.Authority.ExecutionPin != nil {
				return nil, fmt.Errorf("coding execution disappeared before configuration read")
			}
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
			return nil, err
		}
		q := db.New(tx)
		row, err := q.GetInstallSetting(ctx, key)
		if err == nil {
			return row.Value, tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if existingSnapshotOnly {
			return nil, fmt.Errorf("coding attempt configuration snapshot is unavailable")
		}
		stored, err := services.StoredCodingProject(ctx, q)
		if err != nil {
			return nil, err
		}
		repo, err := q.GetRepoOwnerSlugAndNameByID(ctx, launch.Binding.RepositoryID)
		if err != nil {
			return nil, err
		}
		slug := repo.OwnerSlug + "/" + repo.RepoName
		revision, err := sources.ResolveSourceRevision(ctx, slug, "main")
		if err != nil {
			return nil, err
		}
		repository, err := sources.ReadSourceFile(ctx, workspaceapi.WorkspaceSource{Repository: slug, Revision: revision}, ".smithers/coding-project.json")
		if errors.Is(err, fs.ErrNotExist) {
			repository = nil
		} else if err != nil {
			return nil, err
		}
		if len(repository) > 256*1024 {
			return nil, fmt.Errorf("invalid .smithers/coding-project.json: exceeds 256 KiB")
		}
		merged, err := services.MergeCodingProject(stored, repository)
		if err != nil {
			return nil, err
		}
		if !json.Valid(merged) {
			return nil, fmt.Errorf("invalid merged coding configuration")
		}
		if err = q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: merged}); err != nil {
			return nil, err
		}
		persisted, err := q.GetInstallSetting(ctx, key)
		if err != nil {
			return nil, err
		}
		return persisted.Value, tx.Commit(ctx)
	}
}
