//go:build unix

package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The host really dies at a retained boot barrier. VM inventory is an independent
// recording transport, not a physical microVM or bundled guest/root receipt.
func TestAdmissionKilledHostInstallBoundary(t *testing.T) {
	pool, database := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "killowner", LowerUsername: "killowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"killowner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','killowner',20001)`, repo.ID, owner.ID)
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "retained", TargetBookmark: "scratch/killowner/retained", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	cookie := "admission-kill-session"
	sum := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	root := t.TempDir()
	machine := "vm-" + branch.ID
	wsSum := sha256.Sum256([]byte(branch.ID))
	dir := filepath.Join(root, "runtime", "workspaces", hex.EncodeToString(wsSum[:]))
	require.NoError(t, os.MkdirAll(dir, 0700))
	metadata, err := json.Marshal(map[string]any{"version": 1, "id": branch.ID, "machine": machine, "state": "stopped"})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "metadata.json"), metadata, 0600))
	// Killing the host cannot erase inventory or manufacture a stop receipt.
	script := fmt.Sprintf(`#!/bin/sh
case "$1" in
 list) if [ -f %q ]; then printf '[]\n'; elif [ -f %q ]; then printf '[{"name":%q,"status":"running"}]\n'; else printf '[{"name":%q,"status":"stopped"}]\n'; fi ;;
 start) touch %q; while :; do sleep 1; done ;;
 stop) touch %q ;;
 exec) cat >/dev/null ;;
 *) printf '[]\n' ;;
esac
`, filepath.Join(root, "stopped"), filepath.Join(root, "booting"), machine, machine, filepath.Join(root, "booting"), filepath.Join(root, "stop-requested"))
	require.NoError(t, os.WriteFile(filepath.Join(root, "msb"), []byte(script), 0700))
	exe, err := os.Executable()
	require.NoError(t, err)
	log, err := os.Create(filepath.Join(root, "host.log"))
	require.NoError(t, err)
	defer log.Close()
	t.Cleanup(func() {
		if t.Failed() {
			data, _ := os.ReadFile(log.Name())
			t.Logf("killed host log: %s", data)
		}
	})
	child := exec.Command(exe, "-test.run=^TestAdmissionKilledHostChild$", "-test.timeout=90s")
	child.Env = append(os.Environ(), "SMITHERS_ADMISSION_KILL_DATABASE="+database, "SMITHERS_ADMISSION_KILL_ROOT="+root)
	child.Stdout, child.Stderr = log, log
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, child.Start())
	killed := false
	t.Cleanup(func() {
		if !killed {
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
			_ = child.Wait()
		}
	})
	var origin string
	require.Eventually(t, func() bool {
		raw, e := os.ReadFile(filepath.Join(root, "ready"))
		origin = string(raw)
		return e == nil
	}, 15*time.Second, 10*time.Millisecond)
	request := func(origin string) services.WorkspaceSessionResponse {
		req, e := http.NewRequestWithContext(ctx, "POST", origin+"/api/terminals", strings.NewReader(fmt.Sprintf(`{"branch":%q}`, branch.ID)))
		require.NoError(t, e)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Idempotency-Key", "bde274cb-47ed-4dbb-9141-4c6d3dfe5f27")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		response, e := http.DefaultClient.Do(req)
		require.NoError(t, e)
		defer response.Body.Close()
		body, e := io.ReadAll(response.Body)
		require.NoError(t, e)
		require.Equal(t, 202, response.StatusCode, string(body))
		var receipt services.WorkspaceSessionResponse
		require.NoError(t, json.Unmarshal(body, &receipt))
		return receipt
	}
	before := request(origin)
	require.Eventually(t, func() bool { _, e := os.Stat(filepath.Join(root, "booting")); return e == nil }, 10*time.Second, 10*time.Millisecond)
	var grants int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.machine.granted'`).Scan(&grants))
	require.Equal(t, 1, grants)
	require.NoError(t, syscall.Kill(-child.Process.Pid, syscall.SIGKILL))
	waitErr := child.Wait()
	killed = true
	exit, ok := waitErr.(*exec.ExitError)
	require.True(t, ok)
	status, ok := exit.Sys().(syscall.WaitStatus)
	require.True(t, ok)
	require.Equal(t, syscall.SIGKILL, status.Signal())
	fresh, service, server := admissionKillHost(t, pool, root, true)
	require.Equal(t, 1, fresh.InUse(), "inventory keeps the slot after host death")
	require.NoError(t, service.RecoverOwnerTerminalRequests(ctx))
	done := make(chan error, 1)
	go func() { done <- service.ReconstructMachineAdmission(ctx) }()
	require.Eventually(t, func() bool { _, e := os.Stat(filepath.Join(root, "stop-requested")); return e == nil }, 5*time.Second, 10*time.Millisecond)
	for until := time.Now().Add(200 * time.Millisecond); time.Now().Before(until); time.Sleep(10 * time.Millisecond) {
		require.Equal(t, 1, fresh.InUse())
		select {
		case e := <-done:
			t.Fatalf("recovery escaped before confirmed stop: %v", e)
		default:
		}
	}
	require.NoError(t, os.WriteFile(filepath.Join(root, "stopped"), nil, 0600))
	select {
	case e := <-done:
		require.NoError(t, e)
	case <-time.After(3 * time.Second):
		t.Fatal("confirmed stop did not settle recovery")
	}
	require.Zero(t, fresh.InUse())
	after := request(server.URL)
	require.Equal(t, before.ID, after.ID)
	require.Equal(t, "failed", after.Status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.machine.granted'`).Scan(&grants))
	require.Equal(t, 1, grants, "replaying the lost request cannot grant a second time")
	require.Empty(t, fresh.AdmissionSnapshot())
	t.Log("PASS C-MCH-11 compiled host SIGKILL, retained boot inventory, confirmed-stop recovery and idempotent HTTP replay")
}

func TestAdmissionKilledHostChild(t *testing.T) {
	raw := os.Getenv("SMITHERS_ADMISSION_KILL_DATABASE")
	if raw == "" {
		t.Skip("started by admission kill parent")
	}
	pool, err := postgresfixture.Open(t.Context(), raw, 8)
	require.NoError(t, err)
	defer pool.Close()
	_, _, server := admissionKillHost(t, pool, os.Getenv("SMITHERS_ADMISSION_KILL_ROOT"), false)
	require.NoError(t, os.WriteFile(filepath.Join(os.Getenv("SMITHERS_ADMISSION_KILL_ROOT"), "ready"), []byte(server.URL), 0600))
	<-t.Context().Done()
}

func admissionKillHost(t *testing.T, pool *pgxpool.Pool, root string, recover bool) (*microsandbox.Runtime, *services.WorkspaceService, *httptest.Server) {
	t.Helper()
	ctx := t.Context()
	q := db.New(pool)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	profile := microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, DiskFreeBytes: 140 << 30}
	runtime, err := microsandbox.New(ctx, microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: filepath.Join(root, "msb"), SkipQualification: true, RecoverAdmission: recover, HostProfile: &profile, MaxRunningVMs: 1, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768})
	require.NoError(t, err)
	t.Cleanup(func() { _ = runtime.Close() })
	runtime.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: pool}
	branches := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)), services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceCredentialIssuer(auth), services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"), services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())))
	branches.EnableMachineAdmission(func(context.Context) (int64, error) { return 140 << 30, nil })
	branches.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { return nil })
	stack := services.NewMythicalService(pool, nil)
	composeAdmissionPublication(runtime, stack)
	handler := &routes.WorkspaceTerminalHandler{OwnerOnly: true, AllowedOrigins: cfg.Server.AllowedOrigins}
	manager := handler.SharedTerminalSessions()
	t.Cleanup(manager.Close)
	auth.TerminalSubject = manager.OwnsSubject
	provider := &installOwnerTerminals{queries: q, branches: branches, registry: runtime.MachinedRegistry()}
	provider.Bind(manager)
	handler.Service, handler.OwnerTerminals = branches, provider
	server := httptest.NewServer(parallelInstallRouter(cfg, q, pool, handler, routerExtras{}))
	t.Cleanup(server.Close)
	return runtime, branches, server
}
