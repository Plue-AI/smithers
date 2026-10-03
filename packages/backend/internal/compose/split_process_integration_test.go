package compose

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// splitProcessEnvironment configures a single-owner product whose repository
// engine runs in a separate repo-host service, as in Plue's compose stack.
func splitProcessEnvironment(t *testing.T) (repositoryURL string, repositoryHealthChecks *atomic.Int32) {
	repositoryURL, repositoryHealthChecks, _ = splitProcessDatabase(t)
	return repositoryURL, repositoryHealthChecks
}

func splitProcessDatabase(t *testing.T) (repositoryURL string, repositoryHealthChecks *atomic.Int32, pool *pgxpool.Pool) {
	t.Helper()
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	var checks atomic.Int32
	repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			checks.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(repoHost.Close)
	for name, value := range map[string]string{
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT":       "10s",
		"SMITHERS_REPO_HOST_URL":                 repoHost.URL,
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "split-process-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "split-process-callback",
		"SMITHERS_AUTH_SESSION_SECRET":           "split-process-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "split-process-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "split-process-webhook-key",
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "false",
		"SMITHERS_OTEL_EXPORTER":                 "none",
		"SMITHERS_METRICS_TOKEN":                 "split-process-metrics",
		"SMITHERS_METRICS_ADDR":                  "",
	} {
		t.Setenv(name, value)
	}
	return repoHost.URL, &checks, pool
}

// startSplitProcess starts one composition and stops it at test cleanup.
func startSplitProcess(t *testing.T, options Options) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan http.Handler, 1)
	finished := make(chan struct{})
	var runErr error
	go func() {
		runErr = StartWithOptions(ctx, nil, io.Discard, io.Discard, options, func(handler http.Handler) { ready <- handler })
		close(finished)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
			require.NoError(t, runErr)
		case <-time.After(30 * time.Second):
			t.Error("composition did not stop")
		}
	})
	select {
	case handler := <-ready:
		return handler
	case <-finished:
		t.Fatalf("composition stopped before ready: %v", runErr)
	case <-time.After(60 * time.Second):
		t.Fatal("composition did not become ready")
	}
	return nil
}

// A remote repository client is probed at repo_host.url whatever the identity
// mode; only an in-process engine uses the embedded health route.
func TestSingleOwnerReadinessProbesRemoteRepositoryHost(t *testing.T) {
	repositoryURL, checks := splitProcessEnvironment(t)
	remote := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryURL}, "split-process-repo")
	handler := startSplitProcess(t, Options{Repository: remote})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, "ready", body.Status)
	require.Equal(t, "ok", body.Checks["repo_host"])
	require.Positive(t, checks.Load(), "readiness must reach the configured repo-host")
}

// A workers-only process mounts no product router, so it exports the product
// registry, including deployment collectors, on its own guarded listener.
func TestWorkersOnlyProcessExportsProductAndDeploymentMetrics(t *testing.T) {
	repositoryURL, _, pool := splitProcessDatabase(t)
	t.Setenv("SMITHERS_METRICS_ADDR", "127.0.0.1:0")
	// The worker's runtime collector reports one active agent session and one
	// queued landing task, deferred so the landing worker leaves it queued.
	ctx := context.Background()
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ('gauges', 'gauges', 'gauges@example.test', 'gauges@example.test', 'Gauges') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number)
		VALUES ($1, 'gauges', 'gauges', '', TRUE, 'main', 1) RETURNING id`, userID).Scan(&repoID))
	q := db.New(pool)
	_, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: uuid.NewString(), RepositoryID: repoID, UserID: userID, Title: "gauge", Status: "active"})
	require.NoError(t, err)
	request, err := q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: repoID, AuthorID: userID, Title: "gauge", TargetBookmark: "main", StackSize: 1})
	require.NoError(t, err)
	task, err := q.CreateLandingTask(ctx, db.CreateLandingTaskParams{LandingRequestID: request.ID, RepositoryID: repoID, Priority: 1})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE landing_tasks SET available_at = NOW() + interval '1 hour' WHERE id = $1`, task.ID)
	require.NoError(t, err)
	listeners := make(chan net.Listener, 1)
	original := netListen
	netListen = func(network, address string) (net.Listener, error) {
		listener, err := original(network, address)
		if err == nil {
			listeners <- listener
		}
		return listener, err
	}
	t.Cleanup(func() { netListen = original })

	private := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "deployment_private_sweeps_total", Help: "Deployment-owned test collector.",
	})
	private.Inc()
	remote := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryURL}, "split-process-repo")
	handler := startSplitProcess(t, Options{Duties: DutiesWorkers, Repository: remote, MetricsCollectors: []prometheus.Collector{private}})
	require.Nil(t, handler, "a workers-only process has no product handler")

	var address string
	select {
	case listener := <-listeners:
		address = listener.Addr().String()
	default:
		t.Fatal("workers-only process did not open its metrics listener")
	}
	scrape := func(token string) (int, string) {
		request, err := http.NewRequest(http.MethodGet, "http://"+address+"/metrics", nil)
		require.NoError(t, err)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, string(body)
	}
	status, _ := scrape("")
	require.Equal(t, http.StatusUnauthorized, status)
	status, _ = scrape("wrong")
	require.Equal(t, http.StatusUnauthorized, status)
	status, body := scrape("split-process-metrics")
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, body, "deployment_private_sweeps_total 1")
	require.True(t, strings.Contains(body, "smithers_db_connections_max"), "product metrics missing:\n%s", body)
	require.Eventually(t, func() bool {
		_, body := scrape("split-process-metrics")
		return strings.Contains(body, "\nsmithers_active_agent_sessions 1\n") &&
			strings.Contains(body, "\nsmithers_landing_queue_depth 1\n")
	}, 10*time.Second, 50*time.Millisecond, "runtime gauges were not collected")
}

func TestMetricsListenerRequiresWorkersOnlyDuties(t *testing.T) {
	for _, duties := range []Duties{DutiesAll, DutiesHTTP} {
		t.Run(string(duties), func(t *testing.T) {
			t.Setenv("SMITHERS_AUTH_MODE", "selfhost")
			t.Setenv("SMITHERS_METRICS_ADDR", "127.0.0.1:0")
			err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{Duties: duties})
			require.ErrorContains(t, err, "observability.metrics_addr applies only to worker duties")
		})
	}
}

// Collisions with product collectors registered early (the registry) or late
// (cleanup sweeps) both fail startup with an error instead of a panic.
func TestDeploymentCollectorConflictFailsStartup(t *testing.T) {
	splitProcessEnvironment(t)
	for _, duplicate := range []prometheus.Collector{
		prometheus.NewGauge(prometheus.GaugeOpts{Name: "smithers_db_connections_max", Help: "conflict"}),
		prometheus.NewCounterVec(prometheus.CounterOpts{Name: "smithers_cleanup_sweep_failures_total", Help: "Cleanup sweeps that failed, by cleaner."}, []string{"cleaner"}),
	} {
		err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{Duties: DutiesWorkers, MetricsCollectors: []prometheus.Collector{duplicate}})
		require.ErrorContains(t, err, "register deployment metrics")
	}
}
