package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/localbootstrap"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/native"
	"github.com/smithersai/smithers/packages/backend/operator"
	"github.com/smithersai/smithers/packages/backend/postgres"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run returns nil for a clean signal stop and reports every cleanup failure.
func run(ctx context.Context, args []string, testFlowHostConfigs ...flowhost.WorkspaceLauncherConfig) error {
	// Only programmatic integration tests supply this configuration. The install
	// entry point has no environment setting that enables trusted coding hosts.
	if len(testFlowHostConfigs) > 1 {
		return fmt.Errorf("at most one Flow host test configuration is allowed")
	}
	var testFlowHostConfig flowhost.WorkspaceLauncherConfig
	if len(testFlowHostConfigs) == 1 {
		testFlowHostConfig = testFlowHostConfigs[0]
	}
	return serve(ctx, args, os.Executable, testFlowHostConfig)
}

// serve runs the backend. executable answers the running backend's path
// (os.Executable; startup tests pass a bundle fixture's).
func serve(ctx context.Context, args []string, executable func() (string, error), testFlowHostConfig flowhost.WorkspaceLauncherConfig) (runErr error) {
	var cleanupErr error
	defer func() { runErr = stopResult(ctx, runErr, cleanupErr) }()
	// Schema maintenance is server-free. The native path migrates its owned
	// PostgreSQL after the supervisor reports readiness.
	if len(args) > 0 && args[0] == "migrate" {
		if _, err := externalDatabaseURL(); err != nil {
			return err
		}
		return app.Run(ctx, app.Config{Args: args})
	}
	if handled, err := operator.Dispatch(ctx, args, operator.Config{
		OpenDatabase: func(ctx context.Context) (*pgxpool.Pool, error) {
			databaseURL, err := externalDatabaseURL()
			if err != nil {
				return nil, err
			}
			return pgxpool.New(ctx, databaseURL)
		},
		Stdout: os.Stdout, Stderr: os.Stderr,
	}); handled {
		return err
	}
	// `microvm doctor` inspects microVM isolation read-only; server-free.
	if len(args) > 0 && args[0] == "microvm" {
		return runMicroVM(ctx, args[1:], executable)
	}
	mode, err := workspaceIsolation(testFlowHostConfig.AllowTrustedProcessForTests)
	if err != nil {
		return err
	}
	// A microVM backend pins its installed bundle before it loads anything
	// else, and verifies every path it was handed against it.
	var inputs hostInputs
	if mode == isolationMicroVM {
		path, err := executable()
		if err != nil {
			return fmt.Errorf("locate the backend executable: %w", err)
		}
		if inputs, err = installedInputs(path, os.Getenv); err != nil {
			return fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w", err)
		}
		// The startup receipt an operator or CI compares with the manifest
		// the release build produced.
		slog.Info("approved installed bundle", "bundle", inputs.bundle.Root(), "revision", inputs.bundle.Revision(), "manifest_sha256", inputs.bundle.ManifestSHA256())
	} else if inputs, err = processInputs(os.Getenv); err != nil {
		return err
	}
	registry := inputs.registry

	var databaseURL string
	if inputs.postgresBin == "" {
		var err error
		databaseURL, err = externalDatabaseURL()
		if err != nil {
			return err
		}
	}

	// Every git the backend starts runs the verified bundle's helpers and
	// templates and reads no configuration file.
	for name, value := range inputs.environment {
		if err := os.Setenv(name, value); err != nil {
			return err
		}
	}
	// The repository engine dlopens exactly the verified bundle library,
	// checked again immediately before it is loaded.
	if inputs.ffi != nil {
		if err := inputs.ffi.Check(); err != nil {
			return fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: SMITHERS_FFI_LIBRARY_PATH: %w", err)
		}
		if err := os.Setenv("SMITHERS_FFI_LIBRARY_PATH", inputs.ffi.Path()); err != nil {
			return err
		}
	}
	local, err := localbootstrap.Prepare(inputs.dataRoot)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cleanupErr = errors.Join(cleanupErr, local.Shutdown(shutdownCtx))
	}()

	runtimes, err := openExecutionRuntimes(ctx, inputs.dataRoot, inputs.bundle, registry.Coding.Executable, testFlowHostConfig.AllowTrustedProcessForTests)
	if err != nil {
		return err
	}
	workspaceRuntime := runtimes.workspace
	// app.Run normally owns the workspace runtime's close. Retain a final
	// close for migration or startup failures before app.Run gets control.
	defer func() { cleanupErr = errors.Join(cleanupErr, runtimes.Close()) }()
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{
		Runtime:    runtimes.control,
		NodeBinary: inputs.node,
		BundlePath: inputs.modelHost,
	})
	if err != nil {
		return fmt.Errorf("configure local model host: %w", err)
	}
	resolver, err := modelhost.NewOwnerSecretResolver(
		func() string { return os.Getenv("SMITHERS_DATABASE_URL") },
		func() string { return os.Getenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY") },
		modelhost.WithPreviousSecretKeys(func() string { return os.Getenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS") }),
	)
	if err != nil {
		return err
	}
	chatHost, err := modelhost.New(resolver, launcher)
	if err != nil {
		return err
	}
	recommender, err := modelhost.NewJevRecommender(modelhost.OwnerGatewayKeys{Resolver: resolver}, os.Getenv("SMITHERS_JEV_ENDPOINT"), nil)
	if err != nil {
		return fmt.Errorf("configure owner recommender: %w", err)
	}

	appConfig := app.Config{
		HostProfile:      runtimes.profile,
		Args:             args,
		Repository:       local.Client(),
		Workspace:        workspaceRuntime,
		FlowHostRegistry: &registry,
		FlowHostConfig:   testFlowHostConfig,
		ChatHost:         chatHost,
		Recommender:      recommender,
	}

	if inputs.postgresBin != "" {
		return native.Run(ctx, native.Config{
			App: appConfig,
			Postgres: postgres.Config{
				BinDir:   inputs.postgresBin,
				StateDir: filepath.Join(inputs.stateRoot, "postgres"),
				Major:    18,
			},
		})
	}
	if err := app.Migrate(ctx, databaseURL); err != nil {
		return fmt.Errorf("migrate product database: %w", err)
	}
	return app.Run(ctx, appConfig)
}

// stopResult keeps cleanup failures apart from the serve error so the
// cancellation a stop signal causes never hides a failed shutdown.
func stopResult(ctx context.Context, runErr, cleanupErr error) error {
	if ctx.Err() != nil && errors.Is(runErr, context.Canceled) {
		runErr = nil
	}
	return errors.Join(runErr, cleanupErr)
}

func externalDatabaseURL() (string, error) {
	if databaseURL := strings.TrimSpace(os.Getenv("SMITHERS_DATABASE_URL")); databaseURL != "" {
		return databaseURL, nil
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return "", errors.New("SMITHERS_DATABASE_URL or DATABASE_URL is required for an external PostgreSQL backend")
	}
	if err := os.Setenv("SMITHERS_DATABASE_URL", databaseURL); err != nil {
		return "", err
	}
	return databaseURL, nil
}
