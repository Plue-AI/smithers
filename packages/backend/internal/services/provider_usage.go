package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// ProviderUsedPercent reads successful-response subscription utilization. A
// missing or malformed meter is unknown, never a fabricated zero. Use the
// greatest reported window so one fresh low window cannot hide a full week.
func ProviderUsedPercent(headers http.Header) (float64, bool) {
	value, found := 0.0, false
	for _, meter := range []struct {
		name  string
		scale float64
	}{
		{"x-codex-primary-used-percent", 1}, {"x-codex-secondary-used-percent", 1},
		{"anthropic-ratelimit-unified-7d-utilization", 100},
	} {
		raw := strings.TrimSpace(headers.Get(meter.name))
		if raw == "" {
			continue
		}
		n, err := strconv.ParseFloat(raw, 64)
		n *= meter.scale
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 100 {
			continue
		}
		if !found || n > value {
			value = n
		}
		found = true
	}
	return value, found
}

// RecordUsage preserves the provider's current meter without rate-limiting
// direct work. Only scheduled repository jobs consult this observation.
func (s *ProviderConnectionService) RecordUsage(ctx context.Context, connectionID string, headers http.Header) error {
	percent, ok := ProviderUsedPercent(headers)
	if !ok {
		return nil
	}
	store, ok := s.q.(interface {
		RecordProviderUsage(context.Context, db.RecordProviderUsageParams) error
	})
	if !ok {
		return errors.New("provider usage store unavailable")
	}
	return store.RecordProviderUsage(ctx, db.RecordProviderUsageParams{ID: connectionID, UsedPercent: pgtype.Float8{Float64: percent, Valid: true}})
}

func (s *RepositoryJobService) ownerAutonomyPaused(ctx context.Context, userID int64) (bool, error) {
	store, ok := s.q.(interface {
		OwnerAutonomyPaused(context.Context, pgtype.Int8) (bool, error)
	})
	if !ok {
		return false, errors.New("provider utilization store unavailable")
	}
	return store.OwnerAutonomyPaused(ctx, pgtype.Int8{Int64: userID, Valid: true})
}
