package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const todoDailyAdmissionsSetting = "todo_daily_admissions"
const todoDailyLimitReason = "Daily limit reached · starts tomorrow"

var errTodoDailyLimit = errors.New("TODO daily admission allowance exhausted")

// Old checkpoint fields retain their original executor until settlement.
// Activation waits for both domain work and durable dispatch/outbound work;
// terminal audit records do not block a new pinned attempt.
func todoLegacyDrained(ctx context.Context, store db.DBTX, repository int64) (bool, error) {
	var pending bool
	err := store.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM mythical_items WHERE repository_id=$1
			AND source IN ('todo','issue') AND flow_digest IS NULL AND attempt>0
			AND (state IN ('running','delivering','integrating','verifying','proposing')
				OR (pending_op IS NOT NULL AND pending_op <> '{}'::jsonb)))
		OR EXISTS(SELECT 1 FROM product_job_requests
			WHERE tenant_id='repository:' || $1::bigint::text
			AND operation='flow.runtime.launch'
			AND payload->>'flowId' IN ('coding/request','coding/vibe')
			AND state NOT IN ('completed','failed','cancelled'))`, repository).Scan(&pending)
	return !pending, err
}

// The stack's durable item retains its first admission even after Retry,
// Drop or merge. Resume, recovery and engine phases never spend an admission.
func todoDailyAllowance(ctx context.Context, store db.DBTX, now time.Time) error {
	limit, err := todoDailyAdmissionLimit(ctx, store)
	if err != nil {
		return err
	}
	day := now.UTC().Format("2006-01-02")
	var count int64
	if err := store.QueryRow(ctx, `SELECT count(*) FROM mythical_items
		WHERE source='todo' AND checks->>'admissionDay'=$1`, day).Scan(&count); err != nil {
		return err
	}
	if count >= limit {
		return errTodoDailyLimit
	}
	return nil
}

func todoDailyAdmissionLimit(ctx context.Context, store db.DBTX) (int64, error) {
	limit := int64(12)
	setting, err := db.New(store).GetInstallSetting(ctx, todoDailyAdmissionsSetting)
	if err == nil {
		var configured *int64
		if json.Unmarshal(setting.Value, &configured) != nil || configured == nil || *configured <= 0 {
			return 0, errors.New("invalid TODO daily admission setting")
		}
		limit = *configured
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	return limit, nil
}

func todoDailyQueued(item db.MythicalItem) *db.MythicalItem {
	next := item
	next.State, next.Reason = "queued", todoDailyLimitReason
	return &next
}
