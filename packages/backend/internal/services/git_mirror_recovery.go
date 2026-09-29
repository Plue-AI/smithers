package services

import (
	"context"
	"log/slog"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RecoverMirrorSyncRuns interrupts expired work without replaying external Git
// writes. The run ID and terminal state fence every subsequent database write.
func (s *GitMirrorSyncService) RecoverMirrorSyncRuns(ctx context.Context) error {
	return s.recoverMirrorSyncRuns(ctx, 0)
}

func (s *GitMirrorSyncService) recoverMirrorSyncRuns(ctx context.Context, repositoryID int64) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := s.queries.ExpireGithubMirrorSyncRuns(ctx, repositoryID); err != nil {
		return pkgerrors.Internal("failed to recover interrupted git mirror sync").WithCause(err)
	}
	return nil
}

// StartRecovery sweeps immediately on restart and periodically thereafter. All
// replicas may run it; the database locks each abandoned run before settling it.
func (s *GitMirrorSyncService) StartRecovery(ctx context.Context) {
	s.runRecovery(ctx, time.Minute)
}

func (s *GitMirrorSyncService) runRecovery(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := s.RecoverMirrorSyncRuns(ctx); err != nil && ctx.Err() == nil {
			slog.Error("git mirror recovery failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
