package services

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// CodeSearchBackfillInterval is how often the worker indexes repositories
// that have no code-search watermark.
const CodeSearchBackfillInterval = 15 * time.Minute

const (
	codeSearchBackfillPageSize          = 100
	codeSearchBackfillRepositoryTimeout = 5 * time.Minute
)

// SearchIndexBackfillResult counts one backfill sweep's repositories.
type SearchIndexBackfillResult struct {
	Indexed int
	Failed  int
}

// Backfill indexes the default-bookmark head of every repository without a
// code-search watermark: repositories created before push indexing, and ones
// whose first index failed. Indexing writes the watermark, so a rerun finds
// nothing to do; a failed repository stays in the backlog for the next sweep.
func (s *SearchIndexer) Backfill(ctx context.Context) (SearchIndexBackfillResult, error) {
	var result SearchIndexBackfillResult
	if s == nil || s.queries == nil || s.repoHost == nil {
		return result, fmt.Errorf("code search indexer dependencies are not configured")
	}
	var afterID int64
	var firstErr error
	for {
		page, err := s.queries.ListCodeSearchUnindexedRepositories(ctx, db.ListCodeSearchUnindexedRepositoriesParams{
			AfterID:  afterID,
			RowLimit: codeSearchBackfillPageSize,
		})
		if err != nil {
			return result, fmt.Errorf("list unindexed repositories: %w", err)
		}
		for _, repository := range page {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			afterID = repository.ID
			if err := s.backfillRepository(ctx, repository); err != nil {
				if ctx.Err() != nil {
					return result, ctx.Err()
				}
				result.Failed++
				if firstErr == nil {
					firstErr = fmt.Errorf("repository %d: %w", repository.ID, err)
				}
				slog.Warn("code search backfill failed", "repo_id", repository.ID, "error", err)
				continue
			}
			result.Indexed++
		}
		if len(page) < codeSearchBackfillPageSize {
			break
		}
	}
	if result.Failed > 0 {
		return result, fmt.Errorf("%d code search backfills failed (first: %w)", result.Failed, firstErr)
	}
	return result, nil
}

func (s *SearchIndexer) backfillRepository(ctx context.Context, repository db.ListCodeSearchUnindexedRepositoriesRow) error {
	ctx, cancel := context.WithTimeout(ctx, codeSearchBackfillRepositoryTimeout)
	defer cancel()
	return s.indexRepository(ctx, SearchIndexPushInput{
		RepositoryID:   repository.ID,
		Owner:          repository.OwnerSlug,
		RepositoryName: repository.Name,
		backfill:       true,
	})
}

// RunCodeSearchBackfill backfills immediately and then every interval until
// ctx is cancelled. It is a worker duty.
func RunCodeSearchBackfill(ctx context.Context, indexer *SearchIndexer, interval time.Duration) {
	if indexer == nil || interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		result, err := indexer.Backfill(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			slog.Warn("code search backfill sweep failed", "indexed", result.Indexed, "failed", result.Failed, "error", err)
		} else if result.Indexed > 0 {
			slog.Info("code search backfill completed", "indexed", result.Indexed)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
