package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
)

// A deterministic model answer uses the real authenticated producer commit
// door, journal and shared conversation. No browser API response is mocked.
type liveBrowserChatHost struct{}

func (liveBrowserChatHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	raw, err := json.Marshal(map[string]any{"turnId": grant.TurnID, "generation": grant.Generation, "expected": grant.Cursor, "frames": []any{
		map[string]string{"runId": grant.RunID, "type": "delta", "kind": "text", "text": "Chat answered while the TODO waits"},
		map[string]string{"runId": grant.RunID, "type": "done", "reason": "stop"},
	}})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, grant.ProducerBaseURL+chat.CommitPath, strings.NewReader(string(raw)))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		return fmt.Errorf("chat producer refused: %d %s", response.StatusCode, body)
	}
	return nil
}

// Opt-in browser proof over the complete install composition. PostgreSQL,
// command dispatch, TODO cards and live replay are real; only network delivery
// is interrupted. This control-only journey does not execute repository code.
// The queue contract uses the reference profile without a provisioned VM.
// All admission ordering is real; no guest is booted by this control journey.
type liveBrowserAdmissionRuntime struct{ microsandbox.Runtime }

func (*liveBrowserAdmissionRuntime) FreeDisk(context.Context) (int64, error) {
	return 400 << 30, nil
}

func TestLiveTodoBrowserPostgres(t *testing.T)    { testLiveInstallBrowser(t, false) }
func TestLiveSecretsBrowserPostgres(t *testing.T) { testLiveInstallBrowser(t, true) }

func testLiveInstallBrowser(t *testing.T, secrets bool) {
	if os.Getenv("SMITHERS_LIVE_BROWSER") != "1" {
		t.Skip("set SMITHERS_LIVE_BROWSER=1 for the composed live browser journey")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	_, _, pool := splitProcessDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya", DisplayName: "Maya"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, person := range []db.User{owner, other} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, person.ID)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(person.Username + "-browser-session"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano)))}))
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	runtime := new(liveBrowserAdmissionRuntime)
	profile := microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}
	engine, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "live-native", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	require.NoError(t, engine.Client().InitRepo(ctx, owner.Username, repo.Name, "main", true))
	api := startSplitProcess(t, Options{Repository: engine.Client(), ChatHost: liveBrowserChatHost{}, Workspace: runtime, HostProfile: &profile, FlowHostProductAPIURL: origin})
	t.Cleanup(func() { require.Zero(t, runtime.InUse(), "the control-path journey never boots a VM") })
	app, err := filepath.Abs("../../../../apps/app")
	require.NoError(t, err)
	script := "e2e/real/live-todo.browser.ts"
	if secrets {
		script = "e2e/real/live-secrets.browser.ts"
	}
	command := exec.CommandContext(ctx, "bun", script)
	command.Dir = app
	command.Env = append(os.Environ(), "SMITHERS_LIVE_ORIGIN="+origin)
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	stdin, err := command.StdinPipe()
	require.NoError(t, err)
	command.Stderr = os.Stderr
	require.NoError(t, command.Start())
	t.Cleanup(func() { cancel(); _ = command.Process.Kill() })
	scanner := bufio.NewScanner(stdout)
	var vite *url.URL
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "LIVE_BROWSER_READY ") {
			vite, err = url.Parse(strings.TrimPrefix(line, "LIVE_BROWSER_READY "))
			require.NoError(t, err)
			break
		}
		t.Log(line)
	}
	require.NotNil(t, vite, "browser fixture did not start")
	proxy := httputil.NewSingleHostReverseProxy(vite)
	held := atomic.Bool{}
	release := make(chan struct{})
	var releaseOnce sync.Once
	unhold := func() { releaseOnce.Do(func() { close(release) }) }
	defer unhold()
	admission := make(chan struct{})
	var admissionOnce sync.Once
	admit := func() { admissionOnce.Do(func() { close(admission) }) }
	defer admit()
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Test-only network control around the production handler. A held
		// request has neither reached admission nor committed a source event.
		if r.URL.Path == "/__live_test/held" {
			if held.Load() {
				w.WriteHeader(http.StatusNoContent)
			} else {
				w.WriteHeader(http.StatusConflict)
			}
			return
		}
		if r.URL.Path == "/__live_test/release" {
			unhold()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path == "/__live_test/admit" {
			admit()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/todos" {
			if !held.Swap(true) {
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			} else {
				// Commit through the real handler, but let Live deliver the
				// source model before the client receives admission.
				recorder := httptest.NewRecorder()
				api.ServeHTTP(recorder, r)
				select {
				case <-admission:
				case <-r.Context().Done():
					return
				}
				for name, values := range recorder.Header() {
					w.Header()[name] = values
				}
				w.WriteHeader(recorder.Code)
				_, _ = w.Write(recorder.Body.Bytes())
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
		} else {
			proxy.ServeHTTP(w, r)
		}
	})
	server.Start()
	defer func() { unhold(); admit(); server.Close() }()
	_, err = fmt.Fprintln(stdin, "ready")
	require.NoError(t, err)
	_ = stdin.Close()
	for scanner.Scan() {
		t.Log(scanner.Text())
	}
	require.NoError(t, scanner.Err())
	require.NoError(t, command.Wait())
	if secrets {
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_secrets`).Scan(&count))
		require.Zero(t, count, "browser deleted the declared secret")
		return
	}
	var drops int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&drops))
	require.Equal(t, 2, drops, "both browser changes have committed source events")
}
