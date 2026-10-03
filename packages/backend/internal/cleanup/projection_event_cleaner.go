package cleanup

import (
	"context"
	"log/slog"
	"time"
)

// ProjectionEventPruner deletes projection_events past retention
// (services.ProjectionRetention, spec §3.3) and answers how many.
type ProjectionEventPruner interface {
	Prune(ctx context.Context, now time.Time) (int64, error)
}

// ProjectionEventCleaner runs the projection_events retention job: every
// interval, each topic loses its rows older than 24 hours beyond its newest
// 10,000.
type ProjectionEventCleaner struct {
	periodicRunner
	pruner ProjectionEventPruner
	now    func() time.Time
}

const defaultProjectionEventCleanupInterval = 10 * time.Minute

// NewProjectionEventCleaner prunes through pruner every interval.
func NewProjectionEventCleaner(pruner ProjectionEventPruner, interval time.Duration) *ProjectionEventCleaner {
	c := &ProjectionEventCleaner{pruner: pruner, now: time.Now}
	c.init("projection_events", interval, defaultProjectionEventCleanupInterval)
	c.initialSweep = true
	return c
}

// Start begins the periodic retention loop.
func (c *ProjectionEventCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

func (c *ProjectionEventCleaner) sweep(ctx context.Context) error {
	deleted, err := c.pruner.Prune(ctx, c.now())
	if err != nil {
		return err
	}
	if deleted > 0 {
		slog.Info("projection events pruned", "deleted", deleted)
	}
	return nil
}
