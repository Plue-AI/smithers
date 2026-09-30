package modelproxy

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DailySpendCapEnv names the deployment's global platform-key model budget
// in USD per UTC day. Blank means no cap.
const DailySpendCapEnv = "SMITHERS_MODEL_DAILY_SPEND_CAP_USD"

// ErrSpendCapReached refuses a call whose bound would take the day's
// platform-key spend, across every owner, past the daily cap.
var ErrSpendCapReached = errors.New("modelproxy: daily platform model spend cap reached")

// spendCapLog is the line the supplier spend-cap alert counts; it is shared
// with a provider's own account cap so either one pages.
const spendCapLog = "model provider spend cap reached: platform model calls are parked"

// ParseDailySpendCap reads a DailySpendCapEnv value as USD nanos.
func ParseDailySpendCap(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	usd, err := strconv.ParseFloat(value, 64)
	nanos := math.Round(usd * 1e9)
	if err != nil || math.IsNaN(usd) || nanos < 1 || nanos > math.MaxInt64/2 {
		return 0, fmt.Errorf("modelproxy: %s must be a positive USD amount, got %q", DailySpendCapEnv, value)
	}
	return int64(nanos), nil
}

// spentToday is every owner's platform-key model spend since 00:00 UTC in
// USD nanos: a settled call at its charge, an open reservation at its bound,
// and a released call at nothing.
func spentToday(ctx context.Context, db *pgxpool.Pool) (int64, error) {
	var nanos int64
	err := db.QueryRow(ctx, `SELECT COALESCE(SUM(COALESCE(r.charged_nanos, r.reserved_nanos)), 0)::bigint
		FROM model_usage u JOIN credit_reservations r ON r.id = u.reservation_id
		WHERE u.created_at >= date_trunc('day', now(), 'UTC')`).Scan(&nanos)
	return nanos, err
}
