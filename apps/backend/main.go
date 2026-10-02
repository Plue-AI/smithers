package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/localbootstrap"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/native"
	"github.com/smithersai/smithers/packages/backend/operator"
	"github.com/smithersai/smithers/packages/backend/ports"
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
	upstreams, err := modelproxy.ParseUpstreams(os.Getenv(modelproxy.UpstreamsEnv))
	if err != nil {
		return err
	}
	platformKeys, err := platformModelKeys()
	if err != nil {
		return err
	}
	if upstreams != nil && platformKeys == nil {
		return fmt.Errorf("%s needs %s", modelproxy.UpstreamsEnv, modelproxy.KeysFileEnv)
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
		if err := requireExternalBootstrapToken(os.Getenv("SMITHERS_DATA_ROOT")); err != nil {
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
	runtimes, err := openExecutionRuntimes(ctx, dataRoot, filepath.Dir(registry.Coding.Executable))
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
	var recommender ports.Recommender
	if platformKeys != nil && slices.Contains(platformKeys.PlatformModelProviders(), modelproxy.ProviderVercel) {
		// Metered: the key file is what the install pays for.
		endpoint := os.Getenv("SMITHERS_JEV_ENDPOINT")
		if origin, ok := upstreams[modelproxy.ProviderVercel]; ok && strings.TrimSpace(endpoint) == "" {
			// The Vercel upstream moves every call on the platform key.
			endpoint = strings.TrimRight(origin, "/") + "/v4/ai/evaluation-model"
		}
		recommender, err = modelhost.NewJevRecommender(platformKeys, endpoint, nil)
		if err != nil {
			return fmt.Errorf("configure recommender: %w", err)
		}
	} else if key := strings.TrimSpace(os.Getenv("AI_GATEWAY_API_KEY")); key != "" {
		// The owner's own key: a single-owner installation is not metered.
		recommender, err = modelhost.NewJevRecommender(modelproxy.NewStaticKeys(map[string]string{modelproxy.ProviderVercel: key}), os.Getenv("SMITHERS_JEV_ENDPOINT"), nil)
		if err != nil {
			return fmt.Errorf("configure recommender: %w", err)
		}
	}

	appConfig := app.Config{
		Args:             args,
		Repository:       local.Client(),
		Workspace:        workspaceRuntime,
		FlowHostRegistry: &registry,
		FlowHostConfig:   testFlowHostConfig,
		ChatHost:         chatHost,
		Recommender:      recommender,
	}
	if platformKeys != nil {
		appConfig.PlatformModelKeys = platformKeys
		appConfig.ModelProxyUpstreams = upstreams
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

func requireExternalBootstrapToken(dataRoot string) error {
	if strings.TrimSpace(os.Getenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN")) != "" {
		return nil
	}
	if strings.TrimSpace(dataRoot) == "" {
		dataRoot = localbootstrap.DefaultDataRoot
	}
	secretsPath := filepath.Join(dataRoot, "config", "secrets.json")
	if _, err := os.Stat(secretsPath); err == nil {
		// Existing installations reopen their protected, durable setup secret.
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect local secrets: %w", err)
	}
	return errors.New("SMITHERS_AUTH_BOOTSTRAP_TOKEN is required for first setup with external PostgreSQL")
}

// platformModelKeys opens SMITHERS_PLATFORM_MODEL_KEYS_FILE, the keys the
// install pays for. Every call on them is metered in the credit ledger and
// each key is read from the file per call. Nil when unset.
func platformModelKeys() (*modelproxy.FileKeys, error) {
	path := strings.TrimSpace(os.Getenv(modelproxy.KeysFileEnv))
	if path == "" {
		return nil, nil
	}
	if strings.TrimSpace(os.Getenv("AI_GATEWAY_API_KEY")) != "" {
		return nil, fmt.Errorf("set the AI Gateway key as \"vercel\" in %s instead of AI_GATEWAY_API_KEY", modelproxy.KeysFileEnv)
	}
	return modelproxy.OpenKeysFile(path)
}
