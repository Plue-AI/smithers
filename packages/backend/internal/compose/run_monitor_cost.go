package compose

import (
	"context"
	"errors"
	"math"
	"time"
)

// errRunMeteringUnavailable refuses a monitor whose spend cannot be priced:
// a step made model calls that no metered row names, or a metered row's spend
// is unknown. An unknown total is never shown as zero.
var errRunMeteringUnavailable = errors.New("native run metering unavailable")

// dispatchUsage is one native dispatch's settled, metered model spend.
type dispatchUsage struct {
	tokens  int64
	nanos   int64
	unknown bool
}

// priceRunMonitor replaces each native step's metered dispatches ("meter",
// from the host's monitor) with its usage priced from the model proxy's own
// rows on the run's workspace (T-FLW-07), and sets the run's token and USD
// totals to their sum. A step with no model call keeps no usage. Calls still
// in flight are not yet spend.
func (m *runMonitors) priceRunMonitor(ctx context.Context, workspace string, value map[string]any) error {
	type meteredStep struct {
		step   map[string]any
		meter  []string
		models float64
	}
	var steps []meteredStep
	keys := []string{}
	// Model tokens a legacy journal recorded outside any native dispatch can
	// never be joined to metered rows. Native steps still in flight are priced
	// once their node settles and names its dispatches.
	unmetered, _ := value["unmetered_tokens"].(float64)
	delete(value, "unmetered_tokens")
	if unmetered > 0 {
		return errRunMeteringUnavailable
	}
	attempts, _ := value["attempts"].([]any)
	for _, a := range attempts {
		attempt, _ := a.(map[string]any)
		rows, _ := attempt["steps"].([]any)
		for _, r := range rows {
			step, _ := r.(map[string]any)
			if step == nil {
				continue
			}
			meter := []string{}
			if raw, ok := step["meter"].([]any); ok {
				for _, key := range raw {
					if text, ok := key.(string); ok && text != "" {
						meter = append(meter, text)
					}
				}
			}
			models, _ := step["model_calls"].(float64)
			delete(step, "meter")
			delete(step, "model_calls")
			delete(step, "tokens")
			delete(step, "usage")
			steps = append(steps, meteredStep{step: step, meter: meter, models: models})
			keys = append(keys, meter...)
		}
	}
	// A harness that calls the proxy without naming its dispatch (a wrapped
	// CLI seat) leaves spend no step can claim. Any such call on the run's
	// workspace while its journal was being written refuses the total.
	if first, last, ok := journalWindow(value); ok {
		var unattributed bool
		if err := m.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM model_usage WHERE workspace_id = $1 AND source = 'flow_host'
				AND native_step IS NULL AND created_at BETWEEN $2 AND $3)`, workspace, first, last).Scan(&unattributed); err != nil {
			return err
		}
		if unattributed {
			return errRunMeteringUnavailable
		}
	}
	usage := map[string]dispatchUsage{}
	if len(keys) > 0 {
		rows, err := m.pool.Query(ctx, `SELECT native_step,
				COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE outcome <> 'pending'), 0)::bigint,
				COALESCE(SUM(cost_nanos) FILTER (WHERE outcome <> 'pending'), 0)::bigint,
				COALESCE(bool_or(outcome = 'unknown' OR (outcome = 'succeeded' AND cost_nanos IS NULL AND input_tokens + output_tokens > 0)), false)
			FROM model_usage WHERE workspace_id = $1 AND native_step = ANY($2) GROUP BY native_step`, workspace, keys)
		if err != nil {
			return err
		}
		for rows.Next() {
			var key string
			var row dispatchUsage
			if err := rows.Scan(&key, &row.tokens, &row.nanos, &row.unknown); err != nil {
				rows.Close()
				return err
			}
			usage[key] = row
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	var runTokens, runNanos int64
	for _, s := range steps {
		var tokens, nanos int64
		metered := false
		for _, key := range s.meter {
			row, ok := usage[key]
			if !ok {
				continue
			}
			if row.unknown {
				return errRunMeteringUnavailable
			}
			metered = true
			tokens += row.tokens
			nanos += row.nanos
		}
		if !metered {
			if s.models > 0 {
				return errRunMeteringUnavailable
			}
			continue
		}
		s.step["usage"] = map[string]any{"tokens": tokens, "cost_usd": usd(nanos)}
		runTokens += tokens
		runNanos += nanos
	}
	value["tokens"] = runTokens
	value["cost_usd"] = usd(runNanos)
	return nil
}

// usd is nanodollars as dollars, rounded to the nanodollar.
func usd(nanos int64) float64 {
	return math.Round(float64(nanos)) / 1e9
}

// journalWindow is the first and last time the monitor's journal records.
func journalWindow(value map[string]any) (time.Time, time.Time, bool) {
	var first, last time.Time
	journal, _ := value["journal"].([]any)
	for _, entry := range journal {
		row, _ := entry.(map[string]any)
		stamp, _ := row["at"].(string)
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil || at.Unix() <= 0 {
			continue
		}
		if first.IsZero() || at.Before(first) {
			first = at
		}
		if at.After(last) {
			last = at
		}
	}
	return first, last, !first.IsZero()
}
