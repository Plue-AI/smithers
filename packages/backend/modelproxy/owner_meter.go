package modelproxy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ErrDailyTokenBudget refuses an owner-paid call whose token bound does not
// fit what is left of its repository's daily token budget today.
var ErrDailyTokenBudget = errors.New("modelproxy: the repository's daily token budget is spent")

// OwnerUsage records an install's owner-paid calls (Handler.OwnerPaid) and
// holds them to their repository's daily token budget. Execute runs spend
// only after the call is admitted and recorded.
type OwnerUsage interface {
	Execute(ctx context.Context, caller Caller, call Call, spend func(context.Context) (Result, error)) error
}

// OwnerMeter is the OwnerUsage over model_usage (engineering spec §15.2.1,
// §15.2.2). The owner pays the provider, so a row has paid_by 'owner' and
// no credit account or reservation; Meter, which reserves Smithers credit at
// a price, cannot record it. A repository's call is admitted only when the
// tokens its work recorded today (MythicalRepositoryTokensSince, the TODO
// launch budget's own sum) plus this call's bound fit its daily budget. The
// check and the pending row commit under one per-repository lock, so
// concurrent calls on every worker each count the others' bounds. A call
// with no repository has no budget to hold and is only recorded.
type OwnerMeter struct {
	DB *pgxpool.Pool
	// DailyTokens is a repository's daily token budget: its committed
	// dailyTokens, or the default when it declares none.
	DailyTokens func(ctx context.Context, repositoryID int64) (int64, error)
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

func (m OwnerMeter) Execute(ctx context.Context, caller Caller, call Call, spend func(context.Context) (Result, error)) error {
	if m.DB == nil {
		return errors.New("modelproxy: owner model usage is not configured")
	}
	bound := call.Maximum.PromptTokens() + call.Maximum.OutputTokens
	if bound <= 0 {
		return errors.New("modelproxy: owner model call has no token bound")
	}
	var budget int64
	if caller.RepositoryID > 0 {
		if m.DailyTokens == nil {
			return errors.New("modelproxy: the daily token budget is not configured")
		}
		var err error
		if budget, err = m.DailyTokens(ctx, caller.RepositoryID); err != nil {
			return fmt.Errorf("modelproxy: read the daily token budget: %w", err)
		}
	}
	now := time.Now
	if m.Now != nil {
		now = m.Now
	}
	key := "model:" + uuid.NewString()
	err := pgx.BeginFunc(ctx, m.DB, func(tx pgx.Tx) error {
		if caller.RepositoryID > 0 {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('model_usage.daily_tokens:' || $1::bigint, 0))`, caller.RepositoryID); err != nil {
				return err
			}
			spent, err := db.New(tx).MythicalRepositoryTokensSince(ctx, caller.RepositoryID, now().UTC().Truncate(24*time.Hour))
			if err != nil {
				return err
			}
			if budget <= 0 || spent > budget-bound {
				slog.Warn("owner model call refused: daily token budget", "repository_id", caller.RepositoryID,
					"daily_tokens", budget, "spent", spent, "bound", bound, "provider", call.Provider, "model", call.Model)
				return ErrDailyTokenBudget
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO model_usage (request_key, paid_by, owner_type, owner_id, source,
				user_id, repository_id, workspace_id, workflow_run_id, reference, provider, model, stream, bound_tokens)
			VALUES ($1, 'owner', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			key, caller.OwnerType, caller.OwnerID, caller.Source,
			positive(caller.UserID), positive(caller.RepositoryID), nonEmpty(caller.WorkspaceID), positive(caller.WorkflowRunID),
			caller.Reference, call.Provider, strings.TrimSpace(call.Model), call.Stream, bound)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrDailyTokenBudget) {
			return err
		}
		return fmt.Errorf("modelproxy: record owner model usage: %w", err)
	}
	result, spendErr := spend(ctx)
	if result.Outcome == "" {
		result.Outcome = credits.ModelUnknown
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := finishUsage(finishCtx, m.DB, key, result.Outcome, result, nil); err != nil {
		slog.Error("owner model usage record not finished", "request_key", key, "error", err)
	}
	return spendErr
}

// untilNextUTCDay is a Retry-After value: whole seconds to 00:00 UTC.
func untilNextUTCDay(now time.Time) string {
	day := now.UTC().Truncate(24 * time.Hour)
	return strconv.FormatInt(int64(day.Add(24*time.Hour).Sub(now.UTC()).Seconds())+1, 10)
}
