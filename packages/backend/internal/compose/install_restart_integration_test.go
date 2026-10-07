package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This child is the compiled Go host with the production setup router, job
// worker and machine readiness persistence. The external image service is an
// independent idempotent fixture; this does not certify microVM isolation.
func TestInstallRestartHostProcess(t *testing.T) {
	raw := os.Getenv("SMITHERS_RESTART_CHILD_DATABASE")
	if raw == "" {
		t.Skip("only invoked by the restart parent")
	}
	ctx := t.Context()
	pool, err := postgresfixture.Open(ctx, raw, 4)
	require.NoError(t, err)
	defer pool.Close()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	setup := &services.InstallSetupService{Pool: pool, Jobs: store}
	require.NoError(t, setup.Initialize(ctx))
	setup.BindMachineProvider(fencedSetupSource{}, restartImage{endpoint: os.Getenv("SMITHERS_RESTART_EFFECT")})
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	origin := "http://localhost:4000"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	h := &routes.GitHubAppSetupHandler{Setup: setup, Owners: db.New(pool), Origins: middleware.FixedOrigins(origin)}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	server := &http.Server{Handler: githubAppSetupComposeRouter(cfg, pool, h), ReadHeaderTimeout: time.Second}
	go server.Serve(listener)
	defer server.Close()
	require.NoError(t, os.WriteFile(os.Getenv("SMITHERS_RESTART_READY"), []byte("http://"+listener.Addr().String()), 0600))
	if os.Getenv("SMITHERS_RESTART_ADMISSION_ONLY") == "1" {
		<-ctx.Done()
		return
	}
	require.NoError(t, store.RunWorker(ctx, jobs.WorkerConfig{WorkerID: fmt.Sprintf("restart-%d", os.Getpid()), Capacity: 1, Lease: time.Minute, PollInterval: 10 * time.Millisecond, Operations: []string{"install.setup.machine"}}, setup.Handle))
}

type restartImage struct {
	endpoint string
}

func (image restartImage) ResolveWorkspaceLayer(ctx context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	// The layer identity is main's immutable revision, just as the production
	// layer cache reuses already published artifacts after an interrupted host.
	req, err := http.NewRequestWithContext(ctx, "POST", image.endpoint+"/"+spec.Source.Revision, nil)
	if err != nil {
		return microsandbox.Layer{}, err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return microsandbox.Layer{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return microsandbox.Layer{}, fmt.Errorf("image status %d", response.StatusCode)
	}
	return microsandbox.Layer{Key: "published-main-image"}, nil
}

func TestInstallCompiledHostMachineKillRecoveryHTTPPostgres(t *testing.T) {
	for _, boundary := range []string{"running admission", "image published before completion"} {
		t.Run(boundary, func(t *testing.T) {
			pool, databaseURL := postgresfixture.NewProductDatabase(t)
			ctx := t.Context()
			q := db.New(pool)
			owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "restartowner", LowerUsername: "restartowner"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
			require.NoError(t, err)
			hash := sha256.Sum256([]byte("restart-owner-session"))
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			setup := &services.InstallSetupService{Pool: pool}
			require.NoError(t, setup.Initialize(ctx))
			for _, id := range []string{"address", "app_manifest", "sign_in", "repository", "models", "source"} {
				_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{status}','"done"') WHERE key=$1`, "setup.step."+id)
				require.NoError(t, err)
			}
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.source.repository", Value: []byte(`"restartowner/app"`)}))
			var mu sync.Mutex
			artifacts := map[string]bool{}
			calls := 0
			published := make(chan struct{}, 1)
			release := make(chan struct{})
			defer close(release)
			effect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				calls++
				artifacts[r.URL.Path] = true
				first := calls == 1
				mu.Unlock()
				if first && boundary == "image published before completion" {
					published <- struct{}{}
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				w.WriteHeader(200)
			}))
			defer effect.Close()
			executable, err := os.Executable()
			require.NoError(t, err)
			start := func(admissionOnly bool) (string, func()) {
				ready := filepath.Join(t.TempDir(), "ready")
				logPath := filepath.Join(t.TempDir(), "host.log")
				log, err := os.Create(logPath)
				require.NoError(t, err)
				command := exec.Command(executable, "-test.run=^TestInstallRestartHostProcess$", "-test.timeout=90s")
				command.Env = append(os.Environ(), "SMITHERS_RESTART_CHILD_DATABASE="+databaseURL, "SMITHERS_RESTART_READY="+ready, "SMITHERS_RESTART_EFFECT="+effect.URL, fmt.Sprintf("SMITHERS_RESTART_ADMISSION_ONLY=%d", map[bool]int{true: 1, false: 0}[admissionOnly]))
				command.Stdout, command.Stderr = log, log
				require.NoError(t, command.Start())
				var once sync.Once
				stop := func() {
					once.Do(func() {
						require.NoError(t, command.Process.Kill())
						require.Error(t, command.Wait())
						require.NoError(t, log.Close())
					})
				}
				t.Cleanup(stop)
				var origin string
				require.Eventually(t, func() bool { value, err := os.ReadFile(ready); origin = string(value); return err == nil }, 15*time.Second, 20*time.Millisecond, "compiled host did not start; log: %s", logPath)
				return origin, stop
			}
			request := func(origin, method, key string) []byte {
				req, err := http.NewRequestWithContext(ctx, method, origin+"/api/install"+map[string]string{"POST": "/setup/machine"}[method], strings.NewReader(`{}`))
				require.NoError(t, err)
				req.Host = "localhost:4000"
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "restart-owner-session"})
				req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
				req.Header.Set("Origin", "http://localhost:4000")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", "csrf")
				req.Header.Set("Idempotency-Key", key)
				response, err := http.DefaultClient.Do(req)
				require.NoError(t, err)
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				expected := 200
				if method == "POST" {
					expected = 202
				}
				require.Equal(t, expected, response.StatusCode, string(body))
				return body
			}
			origin, stop := start(boundary == "running admission")
			var admitted jobs.RequestReceipt
			require.NoError(t, json.Unmarshal(request(origin, "POST", "first-image"), &admitted))
			require.NotEmpty(t, admitted.OperationID)
			var old jobs.Claim
			store, err := jobs.NewStore(pool)
			require.NoError(t, err)
			if boundary == "running admission" {
				old, err = store.ClaimForOperations(ctx, "dead-admission-worker", time.Minute, []string{"install.setup.machine"})
				require.NoError(t, err)
			} else {
				select {
				case <-published:
				case <-time.After(15 * time.Second):
					t.Fatal("image did not publish")
				}
			}
			// No graceful cancellation or synthetic restoration of a completed row.
			stop()
			var status, operation string
			require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'status',value->>'operation_id' FROM install_settings WHERE key='setup.step.machine'`).Scan(&status, &operation))
			require.Equal(t, "running", status)
			require.Equal(t, admitted.OperationID, operation)
			_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, operation)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.machine'`)
			require.NoError(t, err)
			// Restart without a worker so the owner's Retry demonstrably readmits
			// the same operation before redelivery begins.
			origin, stopRetry := start(true)
			var retry jobs.RequestReceipt
			require.NoError(t, json.Unmarshal(request(origin, "POST", "retry-image"), &retry))
			require.Equal(t, admitted.OperationID, retry.OperationID)
			stopRetry()
			origin, _ = start(false)
			require.Eventually(t, func() bool {
				var view struct{ Steps []struct{ ID, State string } }
				if json.Unmarshal(request(origin, "GET", ""), &view) != nil || len(view.Steps) != 7 {
					return false
				}
				return view.Steps[5].ID == "source" && view.Steps[5].State == "done" && view.Steps[6].ID == "machine" && view.Steps[6].State == "done"
			}, 15*time.Second, 30*time.Millisecond)
			var completions, attempt int
			var layer string
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation).Scan(&completions))
			require.Equal(t, 1, completions)
			require.NoError(t, pool.QueryRow(ctx, `SELECT (value->>'attempt')::int,value->>'layer_key' FROM install_settings WHERE key='setup.step.machine'`).Scan(&attempt, &layer))
			require.GreaterOrEqual(t, attempt, 2)
			require.Equal(t, "published-main-image", layer)
			mu.Lock()
			require.Equal(t, 1, len(artifacts), "one effective image, even when the published image is requested again")
			require.Equal(t, map[bool]int{true: 1, false: 2}[boundary == "running admission"], calls)
			mu.Unlock()
			if boundary == "running admission" {
				_, err = store.Checkpoint(ctx, old, json.RawMessage(`{"stale":true}`))
				require.ErrorIs(t, err, jobs.ErrClaimLost)
			}
		})
	}
}
