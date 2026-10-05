package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
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
func run(ctx context.Context, args []string, testFlowHostConfigs ...flowhost.WorkspaceLauncherConfig) (runErr error) {
	// Only programmatic integration tests supply this configuration. The install
	// entry point has no environment setting that enables trusted coding hosts.
	if len(testFlowHostConfigs) > 1 {
		return fmt.Errorf("at most one Flow host test configuration is allowed")
	}
	var testFlowHostConfig flowhost.WorkspaceLauncherConfig
	if len(testFlowHostConfigs) == 1 {
		testFlowHostConfig = testFlowHostConfigs[0]
	}
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
		return runMicroVM(ctx, args[1:])
	}
	if _, err := workspaceIsolation(testFlowHostConfig.AllowTrustedProcessForTests); err != nil {
		return err
	}
	manifestPath := strings.TrimSpace(os.Getenv("SMITHERS_FLOW_HOST_MANIFEST"))
	if manifestPath == "" {
		return errors.New("SMITHERS_FLOW_HOST_MANIFEST is required to serve the packaged Flow hosts")
	}
	registry, err := flowmanifest.Load(manifestPath)
	if err != nil {
		return fmt.Errorf("load bundled Flow hosts: %w", err)
	}

	nativeBin := strings.TrimSpace(os.Getenv("SMITHERS_NATIVE_POSTGRES_BIN"))
	var databaseURL string
	if nativeBin == "" {
		var err error
		databaseURL, err = externalDatabaseURL()
		if err != nil {
			return err
		}

	}

	local, err := localbootstrap.Prepare(os.Getenv("SMITHERS_DATA_ROOT"))
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cleanupErr = errors.Join(cleanupErr, local.Shutdown(shutdownCtx))
	}()

	dataRoot := os.Getenv("SMITHERS_DATA_ROOT")
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate the backend executable: %w", err)
	}
	runtimes, err := openExecutionRuntimes(ctx, dataRoot, executable, manifestPath, registry.Coding.Executable, testFlowHostConfig.AllowTrustedProcessForTests)
	if err != nil {
		return err
	}
	workspaceRuntime := runtimes.workspace
	// app.Run normally owns the workspace runtime's close. Retain a final
	// close for migration or startup failures before app.Run gets control.
	defer func() { cleanupErr = errors.Join(cleanupErr, runtimes.Close()) }()
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{
		Runtime:    runtimes.control,
		NodeBinary: strings.TrimSpace(os.Getenv("SMITHERS_NODE_BINARY")),
		BundlePath: strings.TrimSpace(os.Getenv("SMITHERS_MODEL_HOST_BUNDLE")),
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

	if nativeBin != "" {
		stateRoot := strings.TrimSpace(os.Getenv("SMITHERS_NATIVE_STATE_DIR"))
		if stateRoot == "" {
			stateRoot = dataRoot
		}
		return native.Run(ctx, native.Config{
			App: appConfig,
			Postgres: postgres.Config{
				BinDir:   nativeBin,
				StateDir: filepath.Join(stateRoot, "postgres"),
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
