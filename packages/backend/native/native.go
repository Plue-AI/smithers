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
		_ = stop(database)
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
		return errors.Join(fmt.Errorf("migrate owned postgres: %w", err), stop(database))
	}
	if err := WriteVersion(root, release); err != nil {
		return errors.Join(fmt.Errorf("publish state version: %w", err), stop(database))
	}
	appCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	appDone := make(chan error, 1)
	go func() { appDone <- app.Run(appCtx, cfg.App) }()
	select {
	case appErr := <-appDone:
		cancel()
		return errors.Join(appErr, stop(database))
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
		appErr, stopErr := stopAfterApp(appDone, func() error { return stop(database) }, databaseStopGrace)
		if appErr != nil && !errors.Is(appErr, context.Canceled) {
			return errors.Join(appErr, stopErr)
		}
		if stopErr != nil {
			return stopErr
		}
		return ctx.Err()
	}
}

// databaseStopGrace bounds how long a stopping backend waits for the app
// before it stops the owned PostgreSQL anyway. The launcher kills a backend
// that has not exited 25 s after its SIGTERM (NativeBackendProcess.ts), and
// launchd the launcher at 30 s; PostgreSQL runs in its own process group, so
// a kill before this stop left it running (the real-GitHub walk's install,
// whose app teardown with lane machines outlasted the launcher's grace).
const databaseStopGrace = 10 * time.Second

// stopAfterApp stops the database once the app returns or grace passes,
// whichever is first, and then waits for the app: a slow app teardown, such
// as stopping lane machines, never outlives the database it used.
func stopAfterApp(appDone <-chan error, stopDatabase func() error, grace time.Duration) (appErr, stopErr error) {
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case appErr = <-appDone:
		return appErr, stopDatabase()
	case <-timer.C:
		stopErr = stopDatabase()
		return <-appDone, stopErr
	}
}

func stop(database *postgres.Instance) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return database.Stop(ctx)
}
