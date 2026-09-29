// Package egressusage reserves proxy byte allowances before the provider forwards them.
// A failed or unreadable transaction authorizes no traffic. Receipts are
// conservative: a connection failure after commit can leave charged bytes
// unused (at most one allowance per proxy), but a worker crash cannot erase spend or reset the daily quota.
package egressusage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxChargeBytes bounds an ahead-of-use allowance to 1 MiB.
const MaxChargeBytes int64 = 1 << 20

type ChargeRequest struct {
	ID              string
	SandboxID       string
	BillingUserID   int64
	DailyQuotaBytes int64
	Bytes           int64
	Day             time.Time
}

var ErrConflict = errors.New("egress usage receipt conflicts with its original request")

// Charge joins the controller's placement authorization transaction. Callers
// must commit before using the returned allowance. The daily owner row orders
// all sandboxes and survives replacement; ID makes a lost-response retry safe.
// A retry replays the original allowance even if the trusted daily quota has
// changed since the receipt was committed.
func Charge(ctx context.Context, tx pgx.Tx, request ChargeRequest) (int64, error) {
	if _, err := uuid.Parse(request.ID); err != nil || request.SandboxID == "" || len(request.SandboxID) > 200 || request.BillingUserID < 0 || request.DailyQuotaBytes < -1 || request.Bytes <= 0 || request.Bytes > MaxChargeBytes || request.Day.IsZero() || !request.Day.Equal(request.Day.UTC().Truncate(24*time.Hour)) {
		return 0, errors.New("invalid egress usage charge")
	}
	// PostgreSQL date encoding uses the value's calendar fields. Normalize
	// equivalent midnight instants so offsets cannot select another day.
	request.Day = request.Day.UTC()
	if tx == nil {
		return 0, errors.New("egress ledger is unavailable")
	}
	scope := fmt.Sprintf("user:%d", request.BillingUserID)
	if request.BillingUserID == 0 {
		scope = "sandbox:" + request.SandboxID
	}
	_, err := tx.Exec(ctx, `INSERT INTO sandbox_egress_daily_usage(scope, day) VALUES ($1,$2) ON CONFLICT DO NOTHING`, scope, request.Day)
	if err != nil {
		return 0, err
	}
	var used int64
	if err := tx.QueryRow(ctx, `SELECT bytes FROM sandbox_egress_daily_usage WHERE scope=$1 AND day=$2 FOR UPDATE`, scope, request.Day).Scan(&used); err != nil {
		return 0, err
	}
	var previous ChargeRequest
	var allowed int64
	err = tx.QueryRow(ctx, `SELECT sandbox_id,billing_user_id,day,requested_bytes,bytes FROM sandbox_egress_usage WHERE id=$1`, request.ID).Scan(&previous.SandboxID, &previous.BillingUserID, &previous.Day, &previous.Bytes, &allowed)
	if err == nil {
		if previous.SandboxID != request.SandboxID || previous.BillingUserID != request.BillingUserID || !previous.Day.Equal(request.Day) || previous.Bytes != request.Bytes {
			return 0, ErrConflict
		}
		return allowed, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	allowed = request.Bytes
	if request.DailyQuotaBytes >= 0 {
		allowed = max(0, min(allowed, request.DailyQuotaBytes-used))
	}
	// Refusals consume no budget and create no per-request row. Repeated
	// attempts against an exhausted grant must not grow the billing ledger.
	if allowed == 0 {
		return 0, nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sandbox_egress_usage(id,sandbox_id,billing_user_id,day,requested_bytes,bytes,quota_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)`, request.ID, request.SandboxID, request.BillingUserID, request.Day, request.Bytes, allowed, request.DailyQuotaBytes); err != nil {
		return 0, err
	}
	_, err = tx.Exec(ctx, `UPDATE sandbox_egress_daily_usage SET bytes=bytes+$3 WHERE scope=$1 AND day=$2`, scope, request.Day, allowed)
	return allowed, err
}
