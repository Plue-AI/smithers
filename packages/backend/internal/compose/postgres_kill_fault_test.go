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
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This case owns an entire PostgreSQL cluster. Never signal the shared server
// from SMITHERS_TEST_DATABASE_URL. The hook is a test database trigger, not a
// release-binary kill selector. It holds the real Drop transaction after the
// item update and before its event insert can commit.
func TestTodoPostgresCrashThroughRoute(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	evidence := filepath.Join(filepath.Dir(source), "../../../..", ".artifacts/checks/C-DUR-01", time.Now().UTC().Format("20060102T150405.000000000Z"), "postgres-transition")
	require.NoError(t, os.MkdirAll(evidence, 0700))
	cluster := newFaultPostgres(t)
	t.Cleanup(func() {
		raw, err := os.ReadFile(cluster.log.Name())
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "postgres.log"), raw, 0600))
	})
	t.Setenv("SMITHERS_TEST_DATABASE_URL", cluster.url)
	t.Setenv("SMITHERS_REQUIRE_DATABASE_TESTS", "1")
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr_t_rel_04_r5")
	pool, _ := postgresfixture.NewProductDatabase(t, 4)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "fault-owner", LowerUsername: "fault-owner", DisplayName: "Fault owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1;`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"fault-owner","repository_name":"app","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"last_access_check_at":%q,"owner_login":"fault-owner","repository_name":"app","repository_id":%d}`, time.Now().UTC().Format(time.RFC3339Nano), repo.ID))}))
	digest := sha256.Sum256([]byte("fault-browser"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(digest[:]), owner.ID, owner.Username)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 100, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	var number int64
	var itemID pgtype.UUID
	// Fixtures precede dispatch. Only the production route mutates the TODO.
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,revisions,owner_id) VALUES($1,'todo','queued','Crash fixture','Crash fixture','[{"rev":1,"text":"Crash fixture"}]',$2) RETURNING id,number`, repo.ID, owner.ID).Scan(&itemID, &number))
	scope := jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: "todo:" + uuid.UUID(itemID.Bytes).String()}
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "todo.created", "queued", json.RawMessage(`{"to":"queued"}`))
		return err
	}))
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: services.NewMythicalService(pool, nil)})
	server.Start()
	t.Cleanup(server.Close)
	var exchangesMu sync.Mutex
	var exchanges []map[string]any
	t.Cleanup(func() {
		exchangesMu.Lock()
		defer exchangesMu.Unlock()
		raw, err := json.MarshalIndent(exchanges, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "http.json"), raw, 0600))
	})
	call := func(method, path, body string) (int, []byte, error) {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		if err != nil {
			return 0, nil, err
		}
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "fault-browser"})
		if method == "POST" {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", origin)
			req.Header.Set("Idempotency-Key", "postgres-kill-drop")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "fault-csrf"})
			req.Header.Set("X-CSRF-Token", "fault-csrf")
		}
		client := &http.Client{Timeout: 20 * time.Second}
		res, err := client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		exchangesMu.Lock()
		exchanges = append(exchanges, map[string]any{"method": method, "path": path, "status": res.StatusCode, "response": string(raw)})
		exchangesMu.Unlock()
		return res.StatusCode, raw, err
	}
	path := fmt.Sprintf("/api/todos/%d", number)
	read := func(want string) {
		t.Helper()
		status, raw, err := call("GET", path, "")
		require.NoError(t, err)
		require.Equal(t, 200, status, string(raw))
		var card struct {
			State string `json:"state"`
		}
		require.NoError(t, json.Unmarshal(raw, &card))
		require.Equal(t, want, card.State)
	}
	read("queued")
	// application_name is visible while the trigger sleeps; observing it from
	// another connection proves the route is inside its uncommitted event write.
	_, err = pool.Exec(ctx, `CREATE FUNCTION fault_hold_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event_type='todo.dropped' THEN PERFORM set_config('application_name','fr-t-rel-04-postgres-transition',false); RAISE LOG 'CRASH-POINT postgres-transition'; PERFORM pg_sleep(60); END IF; RETURN NEW; END $$;
 CREATE TRIGGER fault_hold_transition BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION fault_hold_transition()`)
	require.NoError(t, err)
	// Flush fixture setup before the fault; recovery should exercise this
	// transition rather than replay every schema migration in the cluster.
	_, err = pool.Exec(ctx, "CHECKPOINT")
	require.NoError(t, err)
	type response struct {
		status int
		body   []byte
		err    error
	}
	done := make(chan response, 1)
	go func() { status, raw, err := call("POST", path, `{"op":"drop"}`); done <- response{status, raw, err} }()
	require.Eventually(t, func() bool {
		var count int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name='fr-t-rel-04-postgres-transition' AND state='active' AND wait_event='PgSleep'`).Scan(&count)
		return err == nil && count == 1
	}, 15*time.Second, 20*time.Millisecond, "route never reached transaction kill point")
	read("queued")
	var beforeEvents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&beforeEvents))
	require.Zero(t, beforeEvents, "uncommitted state cannot escape through replay")
	childLog, err := os.ReadFile(cluster.log.Name())
	require.NoError(t, err)
	require.Contains(t, string(childLog), "CRASH-POINT postgres-transition", "PostgreSQL child must log its boundary before SIGKILL")
	fmt.Println("CRASH-POINT postgres-transition subject todo-drop")
	cluster.kill(t)
	result := <-done
	require.NoError(t, result.err)
	require.Equal(t, http.StatusServiceUnavailable, result.status, string(result.body))
	cluster.start(t)
	require.Eventually(t, func() bool { return pool.Ping(ctx) == nil }, 15*time.Second, 50*time.Millisecond)
	read("queued")
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE id=$1`, itemID).Scan(&state))
	require.Equal(t, "queued", state)
	var lastState string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 ORDER BY sequence DESC LIMIT 1`, scope.TenantID, scope.PrincipalID).Scan(&lastState))
	require.Equal(t, state, lastState)
	_, err = pool.Exec(ctx, `DROP TRIGGER fault_hold_transition ON product_job_events; DROP FUNCTION fault_hold_transition()`)
	require.NoError(t, err)
	// The failed press was not acknowledged. Retry with the same request key;
	// both this press and its replay must acknowledge one committed write.
	for range 2 {
		status, raw, err := call("POST", path, `{"op":"drop"}`)
		require.NoError(t, err)
		require.Equal(t, 202, status, string(raw))
	}
	read("dropped")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped' AND data->>'item'=$1`, uuid.UUID(itemID.Bytes).String()).Scan(&count))
	require.Equal(t, 1, count)
	status, raw, err := call("GET", path+"/events", "")
	require.NoError(t, err)
	require.Equal(t, 200, status, string(raw))
	var replay jobs.ReplayPage
	require.NoError(t, json.Unmarshal(raw, &replay))
	require.Len(t, replay.Events, 2)
	require.Equal(t, "todo.created", replay.Events[0].Type)
	require.Equal(t, "todo.dropped", replay.Events[1].Type)
	require.Equal(t, jobs.State("dropped"), replay.Events[1].State)
	events, err := json.MarshalIndent(replay, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(evidence, "product-events.json"), events, 0600))
	fmt.Println("fault observations:", evidence)
	fmt.Println(`CRASH-OBSERVATION {"point":"postgres-transition","subject":"todo-drop","stepsReRun":0,"effectsSeen":0,"writesAcknowledged":1,"writesFound":1}`)
}

type faultPostgres struct {
	dir, bin, url string
	cmd           *exec.Cmd
	log           *os.File
}

func newFaultPostgres(t *testing.T) *faultPostgres {
	t.Helper()
	bin := os.Getenv("SMITHERS_FAULT_POSTGRES_BIN")
	if bin == "" {
		path, err := exec.LookPath("postgres")
		require.NoError(t, err, "PostgreSQL 18 binaries required; set SMITHERS_FAULT_POSTGRES_BIN")
		bin = filepath.Dir(path)
	}
	out, err := exec.Command(filepath.Join(bin, "postgres"), "--version").CombinedOutput()
	require.NoError(t, err, string(out))
	require.Contains(t, string(out), "PostgreSQL) 18.")
	dir := t.TempDir()
	out, err = exec.Command(filepath.Join(bin, "initdb"), "-D", filepath.Join(dir, "data"), "-A", "trust", "-U", "smithers", "--no-locale").CombinedOutput()
	require.NoError(t, err, string(out))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	log, err := os.Create(filepath.Join(dir, "postgres.log"))
	require.NoError(t, err)
	cluster := &faultPostgres{dir: dir, bin: bin, url: fmt.Sprintf("postgres://smithers@127.0.0.1:%d/postgres?sslmode=disable", port), log: log}
	t.Cleanup(func() {
		if cluster.cmd != nil {
			_ = cluster.cmd.Process.Signal(syscall.SIGCONT)
			_ = cluster.cmd.Process.Signal(syscall.SIGINT)
			_ = cluster.cmd.Wait()
			cluster.cmd = nil
		}
		_ = log.Close()
	})
	cluster.start(t)
	return cluster
}
func (p *faultPostgres) start(t *testing.T) {
	t.Helper()
	require.Nil(t, p.cmd)
	// Fixed test configuration, a loopback-only private port and no shared socket.
	p.cmd = exec.Command(filepath.Join(p.bin, "postgres"), "-D", filepath.Join(p.dir, "data"), "-h", "127.0.0.1", "-p", strings.Split(strings.Split(p.url, "127.0.0.1:")[1], "/")[0], "-k", "")
	p.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	p.cmd.Stdout, p.cmd.Stderr = p.log, p.log
	require.NoError(t, p.cmd.Start())
	ready := assert.Eventually(t, func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		conn, err := pgx.Connect(ctx, p.url)
		if err != nil {
			return false
		}
		_ = conn.Close(ctx)
		return true
	}, 20*time.Second, 50*time.Millisecond, "private PostgreSQL failed to start")
	if !ready {
		raw, _ := os.ReadFile(p.log.Name())
		t.Fatalf("private PostgreSQL startup log:\n%s", raw)
	}
}
func (p *faultPostgres) kill(t *testing.T) {
	t.Helper()
	require.NotNil(t, p.cmd)
	// Freeze only our postmaster before taking a kernel parent-PID inventory.
	// PostgreSQL 18 has auxiliary children that are absent from pg_stat_activity.
	// Signal only direct children of the process this test started.
	require.NoError(t, p.cmd.Process.Signal(syscall.SIGSTOP))
	raw, err := exec.Command("ps", "-axo", "pid=,ppid=").Output()
	require.NoError(t, err)
	var children []int
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		parent, err := strconv.Atoi(fields[1])
		require.NoError(t, err)
		if parent != p.cmd.Process.Pid {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		require.NoError(t, err)
		children = append(children, pid)
	}
	require.NotEmpty(t, children, "private PostgreSQL child inventory is empty")
	for _, pid := range children {
		err := syscall.Kill(pid, syscall.SIGKILL)
		require.True(t, err == nil || err == syscall.ESRCH, "kill private cluster child %d: %v", pid, err)
	}
	require.NoError(t, syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL))
	err = p.cmd.Wait()
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, syscall.SIGKILL, exit.Sys().(syscall.WaitStatus).Signal())
	p.cmd = nil
	require.Eventually(t, func() bool {
		for _, pid := range children {
			if syscall.Kill(pid, 0) != syscall.ESRCH {
				return false
			}
		}
		return true
	}, 5*time.Second, 20*time.Millisecond, "private cluster children have not exited")
}
