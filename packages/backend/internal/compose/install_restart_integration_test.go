package compose

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
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
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This child is the compiled Go host with the production setup router, job
// worker and readiness persistence. The external mirror/image service is an
// independent idempotent fixture with filesystem artifacts; this does not
// certify microVM isolation or execute an image recipe.
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
	step := os.Getenv("SMITHERS_RESTART_STEP")
	if step == "source" {
		codec, err := webhook.NewSecretCodec("restart-sealing-key")
		require.NoError(t, err)
		app := services.NewGitHubAppCredentialStore(pool, codec)
		connections := services.NewRepoConnectionService(pool, app)
		setup.BindRepositoryProviders(nil, app, connections, restartImports{endpoint: os.Getenv("SMITHERS_RESTART_EFFECT"), setup: setup}, &services.Members{Pool: pool, Credentials: app, Minter: connections}, services.NewMythicalService(pool, nil))
	} else {
		setup.BindMachineProvider(fencedSetupSource{}, restartImage{endpoint: os.Getenv("SMITHERS_RESTART_EFFECT")})
	}
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
	require.NoError(t, store.RunWorker(ctx, jobs.WorkerConfig{WorkerID: fmt.Sprintf("restart-%d", os.Getpid()), Capacity: 1, Lease: time.Minute, PollInterval: 10 * time.Millisecond, Operations: []string{"install.setup." + step}}, setup.Handle))
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

func TestInstallCompiledHostKillRecoveryHTTPPostgres(t *testing.T) {
	for _, step := range []string{"machine", "source"} {
		for _, boundary := range []string{"running admission", "external effect before publication", "external effect published before completion", "provider returned before completion"} {
			t.Run(step+"/"+boundary, func(t *testing.T) {
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
				ids := []string{"address", "app_manifest", "sign_in", "repository", "models"}
				if step == "machine" {
					ids = append(ids, "source")
				}
				for _, id := range ids {
					_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{status}','"done"') WHERE key=$1`, "setup.step."+id)
					require.NoError(t, err)
				}
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.source.repository", Value: []byte(`"restartowner/app"`)}))
				mirrorRoot := t.TempDir()
				upstream := filepath.Join(mirrorRoot, "upstream.git")
				mirror := filepath.Join(mirrorRoot, "mirror.git")
				imagePath := filepath.Join(mirrorRoot, "published-main-image")
				if step == "source" {
					restartGit(t, "init", "--bare", upstream)
					tree := restartGit(t, "--git-dir="+upstream, "mktree")
					commit := restartGit(t, "--git-dir="+upstream, "commit-tree", tree, "-m", "Main")
					restartGit(t, "--git-dir="+upstream, "update-ref", "refs/heads/main", commit)
					var repoID int64
					require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,'app','app','main') RETURNING id`, owner.ID).Scan(&repoID))
					require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "repository", Value: []byte(`"restartowner/app"`)}))
				}
				// Both steps run with sealed App credentials present, so image
				// recovery must also keep them off its observable surfaces.
				restartGitHub(t, setup)
				var hostLogs []string
				var mu sync.Mutex
				artifacts := map[string]bool{}
				calls := 0
				publications := 0
				var beforePublication sync.Once
				published := make(chan struct{}, 1)
				release := make(chan struct{})
				defer close(release)
				effect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if boundary == "external effect before publication" {
						first := false
						beforePublication.Do(func() { first = true })
						if first {
							published <- struct{}{}
							select {
							case <-release:
							case <-r.Context().Done():
								return
							}
						}
					}
					mu.Lock()
					calls++
					if !artifacts[r.URL.Path] && step == "source" {
						command := exec.CommandContext(r.Context(), "git", "clone", "--mirror", upstream, mirror)
						output, err := command.CombinedOutput()
						if err != nil {
							mu.Unlock()
							http.Error(w, string(output), 500)
							return
						}
					}
					if !artifacts[r.URL.Path] && step == "machine" {
						if err := os.WriteFile(imagePath, []byte(r.URL.Path), 0600); err != nil {
							mu.Unlock()
							http.Error(w, "image publication failed", 500)
							return
						}
					}
					if !artifacts[r.URL.Path] {
						publications++
					}
					artifacts[r.URL.Path] = true
					first := calls == 1
					mu.Unlock()
					if first && boundary == "external effect published before completion" {
						published <- struct{}{}
						select {
						case <-release:
						case <-r.Context().Done():
							return
						}
					}
					w.WriteHeader(200)
					if step == "source" {
						_, _ = w.Write([]byte(`{"importJobId":"published-mirror","repoOwner":"restartowner","repoName":"app","status":"ready"}`))
					}
				}))
				defer effect.Close()
				executable, err := os.Executable()
				require.NoError(t, err)
				start := func(admissionOnly bool) (string, func()) {
					ready := filepath.Join(t.TempDir(), "ready")
					logPath := filepath.Join(t.TempDir(), "host.log")
					hostLogs = append(hostLogs, logPath)
					log, err := os.Create(logPath)
					require.NoError(t, err)
					command := exec.Command(executable, "-test.run=^TestInstallRestartHostProcess$", "-test.timeout=90s")
					command.Env = append(os.Environ(), "SMITHERS_RESTART_CHILD_DATABASE="+databaseURL, "SMITHERS_RESTART_READY="+ready, "SMITHERS_RESTART_EFFECT="+effect.URL, "SMITHERS_RESTART_STEP="+step, fmt.Sprintf("SMITHERS_RESTART_ADMISSION_ONLY=%d", map[bool]int{true: 1, false: 0}[admissionOnly]))
					command.Stdout, command.Stderr = log, log
					require.NoError(t, command.Start())
					var once sync.Once
					stop := func() {
						once.Do(func() {
							require.NoError(t, command.Process.Kill())
							err := command.Wait()
							var killed *exec.ExitError
							require.True(t, errors.As(err, &killed), "host must exit from SIGKILL")
							status, ok := killed.Sys().(syscall.WaitStatus)
							require.True(t, ok)
							require.True(t, status.Signaled())
							require.Equal(t, syscall.SIGKILL, status.Signal())
							require.NoError(t, log.Close())
						})
					}
					t.Cleanup(stop)
					var origin string
					require.Eventually(t, func() bool { value, err := os.ReadFile(ready); origin = string(value); return err == nil }, 15*time.Second, 20*time.Millisecond, "compiled host did not start; log: %s", logPath)
					return origin, stop
				}
				var responses []string
				request := func(origin, method, key string) []byte {
					req, err := http.NewRequestWithContext(ctx, method, origin+"/api/install"+map[string]string{"POST": "/setup/" + step}[method], strings.NewReader(`{}`))
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
					responses = append(responses, string(body))
					return body
				}
				// Hold the final readiness write after the provider has returned.
				// A database trigger is a test-only crash barrier, not a host hook.
				unlock := func() {}
				if boundary == "provider returned before completion" {
					conn, err := pool.Acquire(ctx)
					require.NoError(t, err)
					_, err = conn.Exec(ctx, `SELECT pg_advisory_lock(9345506)`)
					require.NoError(t, err)
					var once sync.Once
					unlock = func() {
						once.Do(func() {
							_, err := conn.Exec(ctx, `SELECT pg_advisory_unlock(9345506)`)
							require.NoError(t, err)
							conn.Release()
						})
					}
					defer unlock()
					_, err = pool.Exec(ctx, `CREATE FUNCTION restart_completion_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
						IF NEW.key = 'setup.step.`+step+`' AND NEW.value->>'status' = 'done' THEN
							PERFORM pg_advisory_xact_lock(9345506);
						END IF;
						RETURN NEW;
					END $$;
					CREATE TRIGGER restart_completion_barrier BEFORE UPDATE ON install_settings FOR EACH ROW EXECUTE FUNCTION restart_completion_barrier()`)
					require.NoError(t, err)
				}
				origin, stop := start(boundary == "running admission")
				var admitted jobs.RequestReceipt
				require.NoError(t, json.Unmarshal(request(origin, "POST", "first-image"), &admitted))
				require.NotEmpty(t, admitted.OperationID)
				var old jobs.Claim
				store, err := jobs.NewStore(pool)
				require.NoError(t, err)
				if boundary == "running admission" {
					old, err = store.ClaimForOperations(ctx, "dead-admission-worker", time.Minute, []string{"install.setup." + step})
					require.NoError(t, err)
				} else if boundary == "provider returned before completion" {
					require.Eventually(t, func() bool {
						var waiting bool
						err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9345506 AND NOT granted)`).Scan(&waiting)
						return err == nil && waiting
					}, 15*time.Second, 20*time.Millisecond, "provider did not reach readiness settlement")
					old.OperationID = admitted.OperationID
					require.NoError(t, pool.QueryRow(ctx, `SELECT generation,claim_token,worker_id,attempt FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&old.Generation, &old.Token, &old.WorkerID, &old.Attempt))
					if step == "source" {
						var receipt string
						require.NoError(t, pool.QueryRow(ctx, `SELECT external_receipt->>'import_id' FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&receipt))
						require.Equal(t, "published-mirror", receipt, "checkpoint survives before completion")
					}
				} else {
					select {
					case <-published:
						if boundary == "external effect before publication" {
							mu.Lock()
							require.Empty(t, artifacts)
							require.Zero(t, publications)
							mu.Unlock()
							path := imagePath
							if step == "source" {
								path = mirror
							}
							_, err := os.Stat(path)
							require.True(t, os.IsNotExist(err), "no external artifact before host termination")
						}
						if step == "machine" && boundary == "external effect published before completion" {
							artifact, err := os.ReadFile(imagePath)
							require.NoError(t, err)
							require.NotEmpty(t, artifact, "image is published before host termination")
						}
						old.OperationID = admitted.OperationID
						require.NoError(t, pool.QueryRow(ctx, `SELECT generation,claim_token,worker_id,attempt FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&old.Generation, &old.Token, &old.WorkerID, &old.Attempt))
					case <-time.After(15 * time.Second):
						t.Fatal("external effect did not publish")
					}
				}
				// No graceful cancellation or synthetic restoration of a completed row.
				stop()
				unlock()
				var status, operation string
				require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'status',value->>'operation_id' FROM install_settings WHERE key=$1`, "setup.step."+step).Scan(&status, &operation))
				require.Equal(t, "running", status)
				require.Equal(t, admitted.OperationID, operation)
				_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, operation)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key=$1`, "setup.step."+step)
				require.NoError(t, err)
				// Restart without a worker so the owner's Retry demonstrably readmits
				// the same operation before redelivery begins.
				origin, stopRetry := start(true)
				var retry jobs.RequestReceipt
				require.NoError(t, json.Unmarshal(request(origin, "POST", "retry-image"), &retry))
				require.Equal(t, admitted.OperationID, retry.OperationID)
				stopRetry()
				origin, stopRecovered := start(false)
				require.Eventually(t, func() bool {
					var view struct{ Steps []struct{ ID, State string } }
					if json.Unmarshal(request(origin, "GET", ""), &view) != nil || len(view.Steps) != 7 {
						return false
					}
					if step == "source" {
						return view.Steps[5].ID == "source" && view.Steps[5].State == "done" && view.Steps[6].State == "pending"
					}
					return view.Steps[5].ID == "source" && view.Steps[5].State == "done" && view.Steps[6].ID == "machine" && view.Steps[6].State == "done"
				}, 15*time.Second, 30*time.Millisecond)
				var completions, attempt int
				var layer string
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation).Scan(&completions))
				require.Equal(t, 1, completions)
				require.NoError(t, pool.QueryRow(ctx, `SELECT (value->>'attempt')::int,coalesce(value->>'layer_key','') FROM install_settings WHERE key=$1`, "setup.step."+step).Scan(&attempt, &layer))
				require.GreaterOrEqual(t, attempt, 2)
				if step == "machine" {
					require.Equal(t, "published-main-image", layer)
					artifact, err := os.ReadFile(imagePath)
					require.NoError(t, err)
					var revision string
					require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'revision' FROM install_settings WHERE key='setup.step.machine'`).Scan(&revision))
					require.Equal(t, "0123456789abcdef0123456789abcdef01234567", revision)
					require.Equal(t, "/"+revision, string(artifact), "recovery reuses the published main image")
				} else {
					require.Equal(t, restartGit(t, "--git-dir="+upstream, "rev-parse", "refs/heads/main"), restartGit(t, "--git-dir="+mirror, "rev-parse", "refs/heads/main"))
					var receipt string
					require.NoError(t, pool.QueryRow(ctx, `SELECT external_receipt->>'import_id' FROM product_job_dispatches WHERE operation_id=$1`, operation).Scan(&receipt))
					require.Equal(t, "published-mirror", receipt)
				}
				mu.Lock()
				require.Equal(t, 1, len(artifacts), "one effective publication, even when redelivery requests it again")
				require.Equal(t, 1, publications, "redelivery must reuse the external artifact")
				expectedCalls := 1
				if boundary == "external effect published before completion" || (boundary == "provider returned before completion" && step == "machine") {
					expectedCalls = 2
				}
				require.Equal(t, expectedCalls, calls)
				mu.Unlock()
				before, err := q.GetInstallSetting(ctx, "setup.step."+step)
				require.NoError(t, err)
				_, err = store.Checkpoint(ctx, old, json.RawMessage(`{"stale":true}`))
				require.ErrorIs(t, err, jobs.ErrClaimLost)
				tx, err := pool.Begin(ctx)
				require.NoError(t, err)
				require.ErrorIs(t, store.SettleInTx(ctx, tx, old, json.RawMessage(`{"stale":true}`), false), jobs.ErrClaimLost)
				require.NoError(t, tx.Rollback(ctx))
				after, err := q.GetInstallSetting(ctx, "setup.step."+step)
				require.NoError(t, err)
				require.JSONEq(t, string(before.Value), string(after.Value))
				stopRecovered()
				// Host API, durable job projections and captured process output must never
				// reveal the sealed App credential used by the real owner verifier.
				{
					codec, err := webhook.NewSecretCodec("restart-sealing-key")
					require.NoError(t, err)
					credential, err := services.NewGitHubAppCredentialStore(pool, codec).Load(ctx)
					require.NoError(t, err)
					var projection string
					require.NoError(t, pool.QueryRow(ctx, `SELECT coalesce(string_agg(data::text,E'\n'),'') FROM product_job_events WHERE operation_id=$1`, operation).Scan(&projection))
					var dispatch string
					require.NoError(t, pool.QueryRow(ctx, `SELECT coalesce(external_receipt::text,'') FROM product_job_dispatches WHERE operation_id=$1`, operation).Scan(&dispatch))
					surfaces := append(responses, string(before.Value), projection, dispatch)
					if step == "machine" {
						artifact, err := os.ReadFile(imagePath)
						require.NoError(t, err)
						surfaces = append(surfaces, string(artifact))
					}
					for _, path := range hostLogs {
						bytes, err := os.ReadFile(path)
						require.NoError(t, err)
						surfaces = append(surfaces, string(bytes))
					}
					for _, surface := range surfaces {
						for _, secret := range []string{credential.ClientSecret, credential.WebhookSecret, credential.PEM} {
							require.NotEmpty(t, secret)
							require.NotContains(t, surface, secret)
							encoded, err := json.Marshal(secret)
							require.NoError(t, err)
							require.NotContains(t, surface, string(encoded[1:len(encoded)-1]), "JSON-escaped secrets must also stay sealed")
						}
					}
				}
			})
		}
	}
}

// The external importer publishes a real Git mirror independently of the host.
// Its stable operation key models the durable importer contract; production
// importer reconciliation is additionally exercised by install_source_recovery.
type restartImports struct {
	endpoint string
	setup    *services.InstallSetupService
}

func (imports restartImports) StartImport(ctx context.Context, input services.ImportGitHubRepoInput) (services.ImportJob, error) {
	var operation string
	if err := imports.setup.Pool.QueryRow(ctx, `SELECT value->>'operation_id' FROM install_settings WHERE key='setup.step.source'`).Scan(&operation); err != nil {
		return services.ImportJob{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", imports.endpoint+"/"+operation, nil)
	if err != nil {
		return services.ImportJob{}, err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return services.ImportJob{}, err
	}
	defer response.Body.Close()
	var job services.ImportJob
	err = json.NewDecoder(response.Body).Decode(&job)
	return job, err
}
func (imports restartImports) GetImportJob(context.Context, int64, string) (services.ImportJob, error) {
	return services.ImportJob{ImportJobID: "published-mirror", RepoOwner: "restartowner", RepoName: "app", Status: "ready"}, nil
}
func restartGit(t *testing.T, args ...string) string {
	t.Helper()
	command := exec.CommandContext(t.Context(), "git", args...)
	command.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Restart", "GIT_AUTHOR_EMAIL=restart@example.test", "GIT_COMMITTER_NAME=Restart", "GIT_COMMITTER_EMAIL=restart@example.test")
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	return strings.TrimSpace(string(output))
}
func restartGitHub(t *testing.T, setup *services.InstallSetupService) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	credentials := services.GitHubAppCredentials{ID: 42, Slug: "restart-app", OwnerLogin: "restartowner", OwnerKind: "user", ClientID: "client", ClientSecret: "restart-app-client-secret-never-emit", WebhookSecret: "restart-app-webhook-secret-never-emit", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{AppID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin, OwnerKind: credentials.OwnerKind, ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, PrivateKeyPEM: credentials.PEM, ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 98306, Repositories: []githubfake.Repository{{ID: 100, FullName: "restartowner/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
	response, err := http.Post(fake.URL+"/app-manifests/manifest-code/conversions", "application/x-www-form-urlencoded", nil)
	require.NoError(t, err)
	require.Equal(t, 201, response.StatusCode)
	require.NoError(t, response.Body.Close())
	codec, err := webhook.NewSecretCodec("restart-sealing-key")
	require.NoError(t, err)
	require.NoError(t, services.NewGitHubAppCredentialStore(setup.Pool, codec).Save(t.Context(), credentials))
}
