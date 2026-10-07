package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/apiclient"
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

func TestInstallSetupCookieBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	digest := sha256.Sum256([]byte("printed-fixture-token"))
	value, _ := json.Marshal(hex.EncodeToString(digest[:]))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.token", Value: value}))
	authority := &services.InstallSetupSessions{Pool: pool}
	setup := &services.InstallSetupService{Pool: pool, Jobs: store}
	handler := &routes.GitHubAppSetupHandler{Sessions: authority, Owners: q, Origins: middleware.FixedOrigins(origin), Setup: setup}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, handler)
	server.Start()
	defer server.Close()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exchange, err := client.Get(origin + "/setup?token=printed-fixture-token")
	require.NoError(t, err)
	exchange.Body.Close()
	require.Equal(t, 303, exchange.StatusCode)
	require.Equal(t, "/", exchange.Header.Get("Location"))
	require.NotContains(t, exchange.Header.Get("Location"), "token")
	for _, cookie := range exchange.Cookies() {
		if cookie.Name == "smithers_setup_session" {
			require.True(t, cookie.HttpOnly)
			require.Equal(t, "", cookie.Domain)
			require.Equal(t, "/", cookie.Path)
			require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
			require.False(t, cookie.Secure)
		}
	}
	api := &apiclient.Client{BaseURL: origin, HTTPClient: client}
	status, err := api.GetAPIInstall(ctx)
	require.NoError(t, err)
	require.Len(t, status.Steps, 7)
	require.Equal(t, "app_manifest", status.Steps[1].ID)
	request := func(path, body string, bearer bool) *http.Response {
		r, err := http.NewRequestWithContext(ctx, "POST", origin+path, strings.NewReader(body))
		require.NoError(t, err)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("Idempotency-Key", "setup-boundary")
		for _, cookie := range jar.Cookies(r.URL) {
			if cookie.Name == "__csrf" {
				r.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		c := client
		if bearer {
			r.Header.Set("Authorization", "Bearer printed-fixture-token")
			c = &http.Client{}
		}
		response, err := c.Do(r)
		require.NoError(t, err)
		return response
	}
	for _, test := range []struct {
		path, body string
		want       int
	}{{"/api/install/setup/address", `{}`, 400}, {"/api/install/setup/address", `{"bind":42,"origins":[]}`, 400}, {"/api/install/setup/address", `{"bind":"127.0.0.1:4000","origins":[],"unknown":true}`, 400}, {"/api/install/setup/app", `{"owner":"smithersai","kind":"org"}`, 400}, {"/api/install/setup/models", `{}`, 403}, {"/api/install/setup/github_app", `{}`, 404}, {"/api/install/setup/app_manifest", `{}`, 404}} {
		response := request(test.path, test.body, false)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		require.Equal(t, test.want, response.StatusCode, string(body))
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation LIKE 'install.setup.%'`).Scan(&count))
	require.Zero(t, count)
	response := request("/api/install/setup/address", `{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`, true)
	response.Body.Close()
	require.Equal(t, 401, response.StatusCode)
	response = request("/api/install/setup/address", `{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`, false)
	var receipt jobs.RequestReceipt
	require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
	response.Body.Close()
	require.Equal(t, 202, response.StatusCode)
	// A request admitted before a worker crash is retried through the same HTTP door.
	old, err := store.ClaimForOperations(ctx, "interrupted-boundary-worker", time.Minute, []string{"install.setup.address"})
	require.NoError(t, err)
	_, err = store.BeginExternal(ctx, old, json.RawMessage(`{"phase":"setup"}`))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.address'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, receipt.OperationID)
	require.NoError(t, err)
	// New request identity permits recovery; operation identity must stay fixed.
	recoverRequest, err := http.NewRequestWithContext(ctx, "POST", origin+"/api/install/setup/address", strings.NewReader(`{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`))
	require.NoError(t, err)
	recoverRequest.Header.Set("Content-Type", "application/json")
	recoverRequest.Header.Set("Origin", origin)
	recoverRequest.Header.Set("Idempotency-Key", "setup-boundary-recovery")
	for _, cookie := range jar.Cookies(recoverRequest.URL) {
		if cookie.Name == "__csrf" {
			recoverRequest.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	recoveredResponse, err := client.Do(recoverRequest)
	require.NoError(t, err)
	require.Equal(t, 202, recoveredResponse.StatusCode)
	var recovered jobs.RequestReceipt
	require.NoError(t, json.NewDecoder(recoveredResponse.Body).Decode(&recovered))
	recoveredResponse.Body.Close()
	require.Equal(t, receipt.OperationID, recovered.OperationID)
	require.ErrorIs(t, store.Complete(ctx, old, json.RawMessage(`{"stale":true}`)), jobs.ErrClaimLost)
	steps, err := setup.Steps(ctx)
	require.NoError(t, err)
	require.Greater(t, steps[0].Attempt, old.Attempt)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "boundary-worker", Capacity: 1, Lease: time.Second, Operations: []string{"install.setup.address"}}, setup.Handle)
	}()
	require.Eventually(t, func() bool {
		status, err := api.GetAPIInstall(ctx)
		return err == nil && status.Steps[0].State == "done"
	}, 5*time.Second, 20*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
	// Sign-in admission returns while OAuth has no completion receipt yet.
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step.app_manifest", Value: []byte(`{"status":"done"}`)}))
	response = request("/api/install/setup/sign_in", `{}`, false)
	require.Equal(t, 202, response.StatusCode)
	var signIn jobs.RequestReceipt
	require.NoError(t, json.NewDecoder(response.Body).Decode(&signIn))
	response.Body.Close()
	response = request("/api/install/setup/sign_in", `{}`, false)
	require.Equal(t, 202, response.StatusCode)
	var replay jobs.RequestReceipt
	require.NoError(t, json.NewDecoder(response.Body).Decode(&replay))
	response.Body.Close()
	require.Equal(t, signIn.OperationID, replay.OperationID)
	workerCtx, cancel = context.WithCancel(ctx)
	done = make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "sign-in-worker", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond, Operations: []string{"install.setup.sign_in"}}, setup.Handle)
	}()
	require.Eventually(t, func() bool {
		var n int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.waiting'`, signIn.OperationID).Scan(&n)
		return err == nil && n > 0
	}, 5*time.Second, 20*time.Millisecond)
	steps, err = setup.Steps(ctx)
	require.NoError(t, err)
	require.Equal(t, services.InstallRunning, steps[2].Status)
	require.Equal(t, signIn.OperationID, steps[2].OperationID)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "sign-in-owner", LowerUsername: "sign-in-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		steps, err := setup.Steps(ctx)
		return err == nil && steps[2].Status == services.InstallReady && steps[2].OperationID == signIn.OperationID
	}, 5*time.Second, 20*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
	var completions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, signIn.OperationID).Scan(&completions))
	require.Equal(t, 1, completions)
}

// The image boundary is held deliberately; no repository recipe executes in
// this fixture. Real VM/root isolation remains a separate reference-host check.
type fencedSetupSource struct{}

func (fencedSetupSource) ResolveSourceRevision(context.Context, string, string) (string, error) {
	return "0123456789abcdef0123456789abcdef01234567", nil
}
func (fencedSetupSource) ReadSourceFile(context.Context, workspaceapi.WorkspaceSource, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}

type fencedSetupImage struct {
	started chan struct{}
	hold    bool
}

func (image fencedSetupImage) ResolveWorkspaceLayer(ctx context.Context, _ workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	if image.hold {
		close(image.started)
		<-ctx.Done()
		return microsandbox.Layer{}, ctx.Err()
	}
	return microsandbox.Layer{Key: "recovered-image"}, nil
}

func TestInstallMachineLeaseRecoveryHTTPPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "recoveryowner", LowerUsername: "recoveryowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("recovery-owner-session"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	setup := &services.InstallSetupService{Pool: pool, Jobs: store}
	require.NoError(t, setup.Initialize(ctx))
	for _, id := range []string{"address", "app_manifest", "sign_in", "repository", "models", "source"} {
		_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{status}','"done"') WHERE key=$1`, "setup.step."+id)
		require.NoError(t, err)
	}
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.source.repository", Value: []byte(`"recoveryowner/app"`)}))
	started := make(chan struct{})
	setup.BindMachineProvider(fencedSetupSource{}, fencedSetupImage{started: started, hold: true})
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	origin := "http://localhost:4000"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	handler := &routes.GitHubAppSetupHandler{Setup: setup, Owners: q, Origins: middleware.FixedOrigins(origin)}
	router := githubAppSetupComposeRouter(cfg, pool, handler)
	request := func(method, path, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, origin+path, strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "recovery-owner-session"})
		if method == "POST" {
			r.Header.Set("Origin", origin)
			r.Header.Set("Idempotency-Key", key)
			r.Header.Set("X-CSRF-Token", "csrf")
			r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	response := request("POST", "/api/install/setup/machine", "first-image")
	require.Equal(t, 202, response.Code, response.Body.String())
	var admitted jobs.RequestReceipt
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &admitted))
	run := func(service *services.InstallSetupService) (context.CancelFunc, chan error) {
		workerCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "image-recovery", Capacity: 1, Lease: time.Minute, PollInterval: 10 * time.Millisecond, Operations: []string{"install.setup.machine"}}, service.Handle)
		}()
		return cancel, done
	}
	cancel, done := run(setup)
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("image never started")
	}
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, admitted.OperationID)
	require.NoError(t, err)
	cancel()
	require.NoError(t, <-done)
	// Cancellation cleanup from an expired image worker must not publish failure.
	response = request("GET", "/api/install", "")
	require.Equal(t, 200, response.Code, response.Body.String())
	var status struct{ Steps []struct{ ID, State string } }
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Equal(t, "done", status.Steps[5].State)
	require.NotEqual(t, "failed", status.Steps[6].State)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.machine'`)
	require.NoError(t, err)
	response = request("POST", "/api/install/setup/machine", "retry-image")
	require.Equal(t, 202, response.Code, response.Body.String())
	var retry jobs.RequestReceipt
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &retry))
	require.Equal(t, admitted.OperationID, retry.OperationID)
	// Reconstruction reads all durable state and retains the admitted operation.
	recovered := &services.InstallSetupService{Pool: pool, Jobs: store}
	require.NoError(t, recovered.Initialize(ctx))
	recovered.BindMachineProvider(fencedSetupSource{}, fencedSetupImage{})
	handler.Setup = recovered
	cancel, done = run(recovered)
	defer func() { cancel(); require.NoError(t, <-done) }()
	require.Eventually(t, func() bool {
		response = request("GET", "/api/install", "")
		return response.Code == 200 && json.Unmarshal(response.Body.Bytes(), &status) == nil && status.Steps[6].State == "done"
	}, 10*time.Second, 20*time.Millisecond)
	var layer string
	require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'layer_key' FROM install_settings WHERE key='setup.step.machine'`).Scan(&layer))
	require.Equal(t, "recovered-image", layer)
	var completions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, admitted.OperationID).Scan(&completions))
	require.Equal(t, 1, completions)
}
