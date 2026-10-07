package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

const startFaultDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// The VM qualification is a test-only contract. No guest payload is executed;
// this host can prove admission and its restart, not microVM/run recovery.
type startFaultMachineContract struct{ workspaceapi.WorkspaceRuntime }

func (startFaultMachineContract) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (startFaultMachineContract) GuestIdentity() (string, int) { return "agent", 19999 }

type startFaultPolicy struct{ noPolicy }

func (startFaultPolicy) GetFileAtCommit(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
	if path == ".smithers/factory.json" {
		return repohost.FileContent{Content: `{"on":[],"github":{"dailyTokens":1000000000000}}`}, nil
	}
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
}

type startFaultStore struct{ *pgxpool.Pool }
type startFaultTx struct {
	pgx.Tx
	admitted bool
}

func (s startFaultStore) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(ctx)
	return &startFaultTx{Tx: tx}, err
}
func (tx *startFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "UPDATE mythical_items") && len(args) > 40 {
		if digest := args[40]; digest != nil {
			raw, _ := json.Marshal(digest)
			if strings.Contains(string(raw), startFaultDigest) {
				tx.admitted = true
			}
		}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}
func (tx *startFaultTx) Commit(ctx context.Context) error {
	err := tx.Tx.Commit(ctx)
	if err == nil && tx.admitted {
		faultprocess.Reached("start")
	}
	return err
}
func startFaultService(t *testing.T, pool *pgxpool.Pool, host string, killing bool) *services.MythicalService {
	var store services.MythicalStore = pool
	if killing {
		store = startFaultStore{pool}
	}
	service := services.NewMythicalService(store, &pollingGitHost{dir: host})
	codec, err := webhook.NewSecretCodec("merge-route-sealing-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	users := services.NewGitHubUserReposService(db.New(pool), ownerTokenDecrypter{})
	connections := services.NewRepoConnectionService(pool, credentials)
	connections.SetGitHubRepoAccessVerifier(users)
	workspaces := services.NewWorkspaceService(db.New(pool), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(db.New(pool)), startFaultMachineContract{})))
	jobStore, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: jobStore, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("first step must not run in admission fixture")
	})})
	require.NoError(t, err)
	service.SetOrchestration(services.NewMythicalGitHub(db.New(pool), connections, users, connections), dispatcher, services.NewWorkspaceMythicalLanes(workspaces))
	service.SetPolicyReader(startFaultPolicy{})
	service.EnableTodoAdmission()
	service.SetTodoFlow(func(ctx context.Context, repository int64, _ string) (string, error) {
		return services.ActiveFlowDigest(ctx, db.New(pool), repository, "todo")
	})
	return service
}
func startFaultCreate(t *testing.T, origin string) {
	r, err := http.NewRequest("POST", origin+"/api/todos", strings.NewReader(`{"title":"Start fixture","prompt":"Do it","place":{"mode":"append"}}`))
	require.NoError(t, err)
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", "fault-start")
	r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
	r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	r.Header.Set("X-CSRF-Token", "csrf")
	response, err := http.DefaultClient.Do(r)
	require.NoError(t, err)
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	require.NoError(t, err)
	require.Less(t, response.StatusCode, 300, string(raw))
}
func TestTodoStartCrashChild(t *testing.T) {
	if os.Getenv(faultprocess.ChildEnv) != "todo-start" {
		return
	}
	args := strings.Split(os.Getenv(faultprocess.ArgsEnv), "|")
	require.Len(t, args, 1)
	pool, err := postgresfixture.Open(t.Context(), os.Getenv(faultprocess.DBEnv), 0)
	require.NoError(t, err)
	defer pool.Close()
	service := startFaultService(t, pool, args[0], true)
	server := mergeFaultServer(t, pool, service)
	startFaultCreate(t, server.URL)
	service.Start(t.Context())
}
func TestTodoStartCrashThroughRoute(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", fmt.Sprintf("relstart%d", os.Getpid()))
	f := newMergeFaultFixture(t)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,'4f098b2e90ef23159043fd5dfecbc305e0017549',$2,'loaded')`, f.repo, startFaultDigest)
	require.NoError(t, err)
	child := faultprocess.Start(t, "TestTodoStartCrashChild", "todo-start", "start", f.pool.Config().ConnString(), f.host)
	child.Await(t, faultprocess.Marker+"start")
	child.Kill(t)
	require.Equal(t, 1, faultDatabaseCount(t, f.pool), "killed child must not orphan a suite database")
	fmt.Println(faultprocess.Marker + "start")
	var number int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT number FROM mythical_items WHERE title='Start fixture'`).Scan(&number))
	before, err := f.q.GetMythicalItemByNumber(ctx, f.repo, number)
	require.NoError(t, err)
	require.EqualValues(t, 1, before.Attempt)
	require.Equal(t, startFaultDigest, before.FlowDigest.String)
	require.Equal(t, "running", before.State)
	require.Empty(t, before.RequestRunID)
	// A fresh service reads the committed projection without a synthetic journal.
	server := mergeFaultServer(t, f.pool, startFaultService(t, f.pool, f.host, false))
	r, err := http.NewRequest("GET", server.URL+"/api/todos/"+strconv.FormatInt(number, 10), nil)
	require.NoError(t, err)
	r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
	response, err := http.DefaultClient.Do(r)
	require.NoError(t, err)
	var card map[string]any
	require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
	response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	require.Equal(t, "starting", card["state"])
	require.Equal(t, map[string]any{"flow_name": "todo", "source_commit": "4f098b2e90ef23159043fd5dfecbc305e0017549", "digest": startFaultDigest}, card["flow_version"])
	r, err = http.NewRequest("GET", server.URL+"/api/todos/"+strconv.FormatInt(number, 10)+"/events", nil)
	require.NoError(t, err)
	r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
	response, err = http.DefaultClient.Do(r)
	require.NoError(t, err)
	var replay jobs.ReplayPage
	require.NoError(t, json.NewDecoder(response.Body).Decode(&replay))
	response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	require.Len(t, replay.Events, 2)
	require.Equal(t, "todo.created", replay.Events[0].Type)
	require.Equal(t, "queued", string(replay.Events[0].State))
	require.Equal(t, "todo.started", replay.Events[1].Type)
	require.Equal(t, "starting", string(replay.Events[1].State))
	var started map[string]any
	require.NoError(t, json.Unmarshal(replay.Events[1].Data, &started))
	require.Equal(t, "starting", started["to"])
	var launches int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='todo'`).Scan(&launches))
	require.Equal(t, 1, launches)
	_, err = f.pool.Exec(ctx, `UPDATE workflow_definitions SET digest=$2 WHERE repository_id=$1 AND name='todo'`, f.repo, strings.Repeat("c", 64))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=now()-interval '1 second',next_attempt_at=now(),requested_generation=requested_generation+1 WHERE repository_id=$1`, f.repo)
	require.NoError(t, err)
	restart := startFaultService(t, f.pool, f.host, false)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); restart.Start(workerCtx) }()
	defer func() { cancel(); <-done }()
	require.Eventually(t, func() bool {
		var settled bool
		err := f.pool.QueryRow(ctx, `SELECT NOT running AND processed_generation=requested_generation FROM mythical_stacks WHERE repository_id=$1`, f.repo).Scan(&settled)
		return err == nil && settled
	}, 15*time.Second, 100*time.Millisecond)
	after, err := f.q.GetMythicalItemByNumber(ctx, f.repo, number)
	require.NoError(t, err)
	require.EqualValues(t, 1, after.Attempt)
	require.Equal(t, startFaultDigest, after.FlowDigest.String)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='todo'`).Scan(&launches))
	require.Equal(t, 1, launches, "restart joins the original durable launch despite a new Active flow")
	evidence := filepath.Join("../../../..", ".artifacts/checks/C-DUR-01", time.Now().UTC().Format("20060102T150405.000000000Z"), "start")
	require.NoError(t, os.MkdirAll(evidence, 0700))
	raw, err := json.MarshalIndent(map[string]any{"point": "start", "subject": fmt.Sprintf("todo:%d", number), "pin": card["flow_version"], "launches": launches, "state": card["state"], "machine": "test-only qualification contract; no guest execution", "events": replay.Events, "identity": faultprocess.Identity(t), "steps_re_run": 0, "steps_started": 0, "writes_acknowledged": 1, "writes_found": 1}, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(evidence, "observations.json"), raw, 0600))
}

// A failed Starting fact cannot acknowledge an attempt or leave a launch behind.
func TestTodoStartFactRollsBackAdmissionComposed(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", fmt.Sprintf("relatom%d", os.Getpid()))
	f := newMergeFaultFixture(t)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,'4f098b2e90ef23159043fd5dfecbc305e0017549',$2,'loaded')`, f.repo, startFaultDigest)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `CREATE SEQUENCE fault_start_attempts;
 CREATE FUNCTION fault_refuse_start_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.started' THEN PERFORM nextval('fault_start_attempts'); RAISE EXCEPTION 'fault start fact refused'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fault_start_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION fault_refuse_start_fact()`)
	require.NoError(t, err)
	service := startFaultService(t, f.pool, f.host, false)
	server := mergeFaultServer(t, f.pool, service)
	startFaultCreate(t, server.URL)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); service.Start(workerCtx) }()
	defer func() { cancel(); <-done }()
	require.Eventually(t, func() bool {
		var called bool
		err := f.pool.QueryRow(ctx, `SELECT is_called FROM fault_start_attempts`).Scan(&called)
		return err == nil && called
	}, 20*time.Second, 100*time.Millisecond)
	row, err := f.q.GetMythicalItemByNumber(ctx, f.repo, 2)
	require.NoError(t, err)
	require.EqualValues(t, 0, row.Attempt)
	require.False(t, row.FlowDigest.Valid)
	require.Equal(t, "queued", row.State)
	var launches int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='todo'`).Scan(&launches))
	require.Zero(t, launches)
	_, err = f.pool.Exec(ctx, `DROP TRIGGER fault_start_fact ON product_job_events; DROP FUNCTION fault_refuse_start_fact(); DROP SEQUENCE fault_start_attempts`)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=now() WHERE repository_id=$1`, f.repo)
	require.NoError(t, err)
	_, err = f.q.RequestMythicalStack(ctx, f.repo)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		row, err := f.q.GetMythicalItemByNumber(ctx, f.repo, 2)
		return err == nil && row.Attempt == 1 && row.FlowDigest.String == startFaultDigest
	}, 20*time.Second, 100*time.Millisecond)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND payload->>'flowId'='todo'`).Scan(&launches))
	require.Equal(t, 1, launches)
}
