package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Settings reads the same host profile and sync receipts as the host and
// GitHub cards. Unknown rate headers stay absent, never a fabricated budget.
func (s *InstallSetupService) SettingsHealth(ctx context.Context) (map[string]any, error) {
	var postgresBytes int64
	if err := s.Pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&postgresBytes); err != nil {
		return nil, err
	}
	disk := float64(0)
	if s.Capacity != nil {
		disk = float64(s.Capacity.Profile.DiskFreeBytes) / (1 << 30)
	}
	github := map[string]any{"health": "stale"}
	process := "ok"
	if s.SyncHealth != nil {
		health, err := s.SyncHealth(ctx)
		if err != nil {
			process = "degraded"
			github["cause"] = err.Error()
		} else {
			github["health"] = health.State
			if health.Cause != "" {
				github["cause"] = health.Cause
			}
			if health.RetryAt != nil {
				github["retry_at"] = health.RetryAt
			}
		}
	}
	if s.GitHubBudget != nil {
		app, err := db.New(s.Pool).GetGithubApp(ctx)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil && app.InstallationID.Valid {
			budget := s.GitHubBudget.Status(app.InstallationID.Int64)
			if budget.Limit > 0 {
				github["rate_remaining"], github["rate_limit"] = budget.Remaining, budget.Limit
			}
		}
	}
	return map[string]any{"process": process, "postgres_bytes": postgresBytes, "disk_free_gb": disk, "github": github}, nil
}
