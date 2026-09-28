package services

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/robfig/cron/v3"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CronSchedulerQuerier contains the database methods needed by the cron scheduler.
type CronSchedulerQuerier interface {
	ClaimDueWorkflowScheduleSpecs(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error)
	UpdateWorkflowScheduleFireTimes(ctx context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error
}

// CronSchedulerRunDispatcher dispatches workflow runs for schedule events.
type CronSchedulerRunDispatcher interface {
	DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
}

// CronSchedulerWorker polls for due workflow schedules and fires them.
type CronSchedulerWorker struct {
	queries    CronSchedulerQuerier
	dispatcher CronSchedulerRunDispatcher
	logger     *slog.Logger
	interval   time.Duration
	claimLimit int32
}

func NewCronSchedulerWorker(
	queries CronSchedulerQuerier,
	dispatcher CronSchedulerRunDispatcher,
) *CronSchedulerWorker {
	return &CronSchedulerWorker{
		queries:    queries,
		dispatcher: dispatcher,
		logger:     slog.Default(),
		interval:   30 * time.Second,
		claimLimit: 50,
	}
}

// Start runs the polling loop until ctx is cancelled.
func (w *CronSchedulerWorker) Start(ctx context.Context) {
	w.logger.Info("starting cron scheduler worker", "interval", w.interval)

	defer func() {
		if r := recover(); r != nil {
			w.logger.Error("cron scheduler worker panicked", "panic", r)
		}
	}()

	for {
		err := w.PollOnce(ctx)
		if err != nil {
			w.logger.Error("cron scheduler poll error", "error", err)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("stopping cron scheduler worker")
			return
		case <-time.After(w.interval):
			// wait before next poll
		}
	}
}

// PollOnce atomically claims due schedules and fires workflow runs.
// The claim uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent pollers
// on different API instances never double-fire the same spec.
func (w *CronSchedulerWorker) PollOnce(ctx context.Context) error {
	return w.pollOnce(ctx, time.Now())
}

func (w *CronSchedulerWorker) pollOnce(ctx context.Context, now time.Time) error {
	// ClaimDueWorkflowScheduleSpecs atomically locks and sets next_fire_at
	// to a short reclaim lease (not a far-future sentinel), so a crashed or
	// failed worker's specs become due again automatically once the lease
	// expires, preventing other pollers from seeing them in the meantime.
	specs, err := w.queries.ClaimDueWorkflowScheduleSpecs(ctx, w.claimLimit)
	if err != nil {
		return err
	}

	for _, spec := range specs {
		// check if context cancelled before processing each item
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Fire run
		_, err := w.dispatcher.DispatchForEvent(ctx, DispatchForEventInput{
			RepositoryID:         spec.RepositoryID,
			WorkflowDefinitionID: &spec.WorkflowDefinitionID,
			Event: TriggerEvent{
				Type: "schedule",
			},
		})
		if err != nil {
			attrs := []any{"spec_id", spec.ID, "repository_id", spec.RepositoryID,
				"workflow_definition_id", spec.WorkflowDefinitionID, "error", err}
			if !isRefusedScheduleDispatch(err) {
				// Leave the lease in place so a transient failure retries.
				w.logger.Error("failed to dispatch scheduled workflow run", attrs...)
				continue
			}
			// A user-state refusal must consume this occurrence. Retrying it
			// after the lease expires can run stale work when the state clears.
			w.logger.Warn("skipped refused scheduled workflow run", attrs...)
		}

		// Compute and write the real next fire time (claim set it to a lease).
		nextFire, err := nextFireTime(spec.CronExpression, now)
		if err != nil {
			// Unreachable for stored specs: cron expressions are validated
			// with this same parser at sync time (workflow_sync.go). If it
			// ever does happen, the lease self-heals the spec rather than
			// stranding it, and the occurrence is retried.
			w.logger.Error("failed to compute next fire time", "spec_id", spec.ID, "error", err)
			continue
		}

		err = w.queries.UpdateWorkflowScheduleFireTimes(ctx, db.UpdateWorkflowScheduleFireTimesParams{
			ID:         spec.ID,
			PrevFireAt: pgtype.Timestamptz{Time: now, Valid: true},
			NextFireAt: nextFire,
		})
		if err != nil {
			// The lease self-heals: this spec is re-claimed once the lease
			// expires and may fire one duplicate occurrence (at-least-once),
			// which is strictly better than being permanently stranded.
			w.logger.Error("failed to update schedule fire times", "spec_id", spec.ID, "error", err)
		}
	}

	return nil
}

func isRefusedScheduleDispatch(err error) bool {
	var apiErr *pkgerrors.APIError
	return errors.As(err, &apiErr) && apiErr.Fault == pkgerrors.FaultUser
}

// nextFireTime computes the next fire time from a cron expression.
// Unprefixed repository schedules are UTC regardless of the host's local zone.
func nextFireTime(cronExpr string, from time.Time) (time.Time, error) {
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	expr := cronExpr
	if !strings.HasPrefix(expr, "CRON_TZ=") {
		expr = "CRON_TZ=UTC " + expr
	}
	schedule, err := parser.Parse(expr)
	if err != nil {
		return time.Time{}, err
	}
	next := schedule.Next(from)
	// robfig/cron repeats a fixed wall-clock minute during fall-back. A
	// repository schedule fires that minute only at its first occurrence.
	if strings.HasPrefix(cronExpr, "CRON_TZ=") {
		location := schedule.(*cron.SpecSchedule).Location
		previous := from.In(location)
		local := next.In(location)
		_, previousOffset := previous.Zone()
		_, nextOffset := local.Zone()
		if previousOffset != nextOffset && previous.Year() == local.Year() &&
			previous.YearDay() == local.YearDay() && previous.Hour() == local.Hour() &&
			previous.Minute() == local.Minute() {
			next = schedule.Next(next)
		}
	}
	return next, nil
}
