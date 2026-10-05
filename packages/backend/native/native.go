// Package native composes the shared backend with packaged PostgreSQL for a desktop installation.
package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/postgres"
)

type Config struct {
	StateDir string
	// StopBudget bounds preview drain and PostgreSQL shutdown; zero preserves install shutdown.
	StopBudget time.Duration
	// Release optionally asserts bundle metadata; the binary remains authoritative.
	Release  Version
	Postgres postgres.Config
	App      app.Config
}

func Run(ctx context.Context, cfg Config) error {
	root := cfg.StateDir
	if root == "" {
		if cfg.Postgres.StateDir == "" {
			return errors.New("install state directory is required")
		}
		root = filepath.Dir(cfg.Postgres.StateDir)
	}
	if err := requireCompleteUpgrade(root); err != nil {
		return err
	}
	head, err := product.HeadVersion()
	if err != nil {
		return err
	}
	release := Version{compose.BuildVersion, fmt.Sprint(head), fmt.Sprint(cfg.Postgres.Major)}
	if err := release.validate(); err != nil {
		return err
	}
	if cfg.Release != (Version{}) && cfg.Release != release {
		return &GuardError{Reason: "bundle version manifest does not match this binary"}
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	bundle, err := ReadVersion(filepath.Join(filepath.Dir(executable), "version.env"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("load bundle version manifest: %w", err)
	}
	if err == nil && bundle != release {
		return &GuardError{Reason: "bundle version manifest does not match this binary"}
	}
	if err := EnsureVersion(root, release); err != nil {
		return err
	}
	database, err := postgres.Start(ctx, cfg.Postgres)
	if err != nil {
		return fmt.Errorf("start owned postgres: %w", err)
	}
	previous, existed := os.LookupEnv("SMITHERS_DATABASE_URL")
	if err := os.Setenv("SMITHERS_DATABASE_URL", database.ConnectionString); err != nil {
		_ = stop(database, cfg.StopBudget)
		return err
	}
	defer func() {
		if existed {
			_ = os.Setenv("SMITHERS_DATABASE_URL", previous)
		} else {
			_ = os.Unsetenv("SMITHERS_DATABASE_URL")
		}
	}()
	if err := app.Migrate(ctx, database.ConnectionString); err != nil {
		if errors.Is(err, product.ErrUnsupportedVersion) {
			err = &GuardError{Reason: "database schema is newer than this binary; restore a verified backup", Backup: "<backup>", Cause: err}
		}
		return errors.Join(fmt.Errorf("migrate owned postgres: %w", err), stop(database, cfg.StopBudget))
	}
	if err := WriteVersion(root, release); err != nil {
		return errors.Join(fmt.Errorf("publish state version: %w", err), stop(database, cfg.StopBudget))
	}
	appCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	appDone := make(chan error, 1)
	go func() { appDone <- app.Run(appCtx, cfg.App) }()
	select {
	case appErr := <-appDone:
		cancel()
		return errors.Join(appErr, stop(database, cfg.StopBudget))
	case <-database.Done():
		cancel()
		appErr := <-appDone
		_ = database.Stop(context.Background())
		pgErr := database.Err()
		if pgErr == nil {
			pgErr = errors.New("owned postgres exited unexpectedly")
		} else {
			pgErr = fmt.Errorf("owned postgres exited: %w", pgErr)
		}
		return errors.Join(pgErr, appErr)
	case <-ctx.Done():
		cancel()
		appErr, stopErr := drainAndStop(appDone, database, cfg.StopBudget)
		if appErr != nil && !errors.Is(appErr, context.Canceled) {
			return errors.Join(appErr, stopErr)
		}
		if stopErr != nil {
			return stopErr
		}
		return ctx.Err()
	}
}

func stop(database *postgres.Instance, budget time.Duration) error {
	if budget <= 0 {
		budget = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	return database.Stop(ctx)
}

// Zero preserves the install's unbounded app drain followed by a fresh 15s
// database stop budget. Preview callers reserve up to 3s for PostgreSQL.
func drainAndStop(appDone <-chan error, database *postgres.Instance, budget time.Duration) (error, error) {
	if budget <= 0 {
		return <-appDone, stop(database, 0)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), budget)
	defer stopCancel()
	reserve := 3 * time.Second
	if reserve > budget/2 {
		reserve = budget / 2
	}
	drainCtx, drainCancel := context.WithTimeout(context.Background(), budget-reserve)
	defer drainCancel()
	var appErr error
	select {
	case appErr = <-appDone:
	case <-drainCtx.Done():
		appErr = drainCtx.Err()
	}
	return appErr, database.Stop(stopCtx)
}
