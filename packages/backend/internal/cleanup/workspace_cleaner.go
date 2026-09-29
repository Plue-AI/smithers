package cleanup

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// WorkspaceCleanupStore defines the interface for workspace cleanup operations.
type WorkspaceCleanupStore interface {
	CleanupIdleSessions(ctx context.Context) error
	CleanupStalePendingWorkspaces(ctx context.Context) error
	CleanupIdleWorkspaces(ctx context.Context) error
	CleanupOverQuotaWorkspaces(ctx context.Context) error
	CleanupAbandonedWorkspaces(ctx context.Context) error
}

// WorkspaceCleaner periodically cleans up idle sessions, suspends idle or
// over-quota workspaces, and reclaims workspaces whose client lease lapsed.
type WorkspaceCleaner struct {
	periodicRunner
	store WorkspaceCleanupStore
}

const defaultWorkspaceCleanupInterval = 5 * time.Minute

// NewWorkspaceCleaner creates a new WorkspaceCleaner.
func NewWorkspaceCleaner(store WorkspaceCleanupStore, interval time.Duration) *WorkspaceCleaner {
	c := &WorkspaceCleaner{store: store}
	c.init("workspace", interval, defaultWorkspaceCleanupInterval)
	return c
}

// Start begins the periodic cleanup loop.
func (c *WorkspaceCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

// sweep performs a single cleanup pass.
func (c *WorkspaceCleaner) sweep(ctx context.Context) error {
	var errs []error

	if err := c.store.CleanupIdleSessions(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup idle sessions: %w", err))
	}
	if err := c.store.CleanupStalePendingWorkspaces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup stale pending workspaces: %w", err))
	}
	if err := c.store.CleanupIdleWorkspaces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup idle workspaces: %w", err))
	}
	if err := c.store.CleanupOverQuotaWorkspaces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup over-quota workspaces: %w", err))
	}
	if err := c.store.CleanupAbandonedWorkspaces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("cleanup abandoned workspaces: %w", err))
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
