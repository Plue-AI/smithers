package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const refCaseCollisionRepairPage = 200

// RefCaseCollisionRepairQuerier lists every repository and its protected
// bookmark patterns.
type RefCaseCollisionRepairQuerier interface {
	ListRepositoryNamesAfter(ctx context.Context, arg db.ListRepositoryNamesAfterParams) ([]db.ListRepositoryNamesAfterRow, error)
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
}

// RefCaseCollisionRepairHost is repo-host's per-repository repair.
type RefCaseCollisionRepairHost interface {
	RepairRefCaseCollisions(ctx context.Context, owner, repo string, req repohost.RefCaseCollisionRequest) (repohost.RefCaseCollisionReport, error)
}

// RefCaseCollisionCounts is the repair's report across repositories.
type RefCaseCollisionCounts struct {
	Repositories int64 `json:"repositories"`
	// Affected counts repositories with at least one collision.
	Affected   int64 `json:"affected"`
	Collisions int64 `json:"collisions"`
	Removed    int64 `json:"removed"`
	Renamed    int64 `json:"renamed"`
	Reported   int64 `json:"reported"`
	// Missing repositories have no repo-host store; Failed ones are retried
	// on the next run.
	Missing int64 `json:"missing"`
	Failed  int64 `json:"failed"`
}

// RepairRefCaseCollisions asks repo-host to repair every repository's
// case-variant refs (#2237): a variant of mythical, the default bookmark or a
// protected bookmark is renamed to its canonical name or removed, keeping a
// backup ref; any other collision is reported for its owner. Each collision
// is logged with its refs, action and backups. The repair is idempotent, so
// every worker start runs it and a later run reports only what remains.
func RepairRefCaseCollisions(ctx context.Context, q RefCaseCollisionRepairQuerier, host RefCaseCollisionRepairHost, logger *slog.Logger) (RefCaseCollisionCounts, error) {
	var counts RefCaseCollisionCounts
	for after := int64(0); ; {
		rows, err := q.ListRepositoryNamesAfter(ctx, db.ListRepositoryNamesAfterParams{AfterID: after, PageSize: refCaseCollisionRepairPage})
		if err != nil {
			return counts, fmt.Errorf("list repositories: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			counts.Repositories++
			rules, err := q.ListAllProtectedBookmarksByRepo(ctx, row.ID)
			if err != nil {
				if ctx.Err() != nil {
					return counts, ctx.Err()
				}
				counts.Failed++
				logger.Warn("ref case collision repair failed", "repository_id", row.ID, "owner", row.Owner, "repo", row.Name, "error", err)
				continue
			}
			patterns := make([]string, 0, len(rules))
			for _, rule := range rules {
				patterns = append(patterns, rule.Pattern)
			}
			report, err := host.RepairRefCaseCollisions(ctx, row.Owner, row.Name, repohost.RefCaseCollisionRequest{ProtectedPatterns: patterns})
			var status *repohost.StatusError
			switch {
			case errors.As(err, &status) && status.StatusCode == 404:
				counts.Missing++
				continue
			case err != nil:
				if ctx.Err() != nil {
					return counts, ctx.Err()
				}
				counts.Failed++
				logger.Warn("ref case collision repair failed", "repository_id", row.ID, "owner", row.Owner, "repo", row.Name, "error", err)
				continue
			}
			if len(report.Collisions) > 0 {
				counts.Affected++
			}
			for _, collision := range report.Collisions {
				counts.Collisions++
				switch collision.Action {
				case repohost.RefCaseCollisionRemoved:
					counts.Removed++
				case repohost.RefCaseCollisionRenamed:
					counts.Renamed++
				default:
					counts.Reported++
				}
				logger.Info("ref case collision", "repository_id", row.ID, "owner", row.Owner, "repo", row.Name,
					"refs", collision.Refs, "canonical", collision.Canonical, "action", collision.Action, "backups", collision.Backups)
			}
		}
		if len(rows) < refCaseCollisionRepairPage {
			return counts, nil
		}
	}
}

// RunRefCaseCollisionRepair runs RepairRefCaseCollisions and logs its counts.
func RunRefCaseCollisionRepair(ctx context.Context, q RefCaseCollisionRepairQuerier, host RefCaseCollisionRepairHost) {
	logger := slog.Default()
	counts, err := RepairRefCaseCollisions(ctx, q, host, logger)
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("ref case collision repair failed", "error", err)
		}
		return
	}
	logger.Info("ref case collision repair completed",
		"repositories", counts.Repositories, "affected", counts.Affected, "collisions", counts.Collisions,
		"removed", counts.Removed, "renamed", counts.Renamed, "reported", counts.Reported,
		"missing", counts.Missing, "failed", counts.Failed)
}
