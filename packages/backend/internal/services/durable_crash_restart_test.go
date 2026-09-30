package services

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// The crash suite runs the worker of each durable subsystem in a child
// process, kills it with SIGKILL at a named point, restarts the work in this
// process and requires exactly one completion, one external effect and a
// replayable history. A stale owner that wakes after takeover must be fenced.
//
// Kill points, shared by both subsystems:
//   - pre-commit: the request's transaction is open and uncommitted.
//   - post-commit: the request is durable; no worker has claimed it.
//   - pre-launch: the claimed work is prepared; its external call is not made.
//   - post-launch: the external call happened; its outcome is not recorded.
//   - stale-owner: a frozen owner loses its lease, another process finishes,
//     then the frozen owner resumes and tries to finish too.
const (
	crashChildEnv = "SMITHERS_CRASH_CHILD"
	crashPointEnv = "SMITHERS_CRASH_POINT"
	crashDBEnv    = "SMITHERS_CRASH_DATABASE_URL"
	crashArgsEnv  = "SMITHERS_CRASH_ARGS"
	crashMarker   = "CRASH-POINT "
	crashOutcome  = "CRASH-OUTCOME "
)

var crashPoints = []string{"pre-commit", "post-commit", "pre-launch", "post-launch", "stale-owner"}

// TestDurableCrashRestartChildProcess is the child side of the suite. It does
// nothing unless the parent test started this binary to be killed.
func TestDurableCrashRestartChildProcess(t *testing.T) {
	subject := os.Getenv(crashChildEnv)
	if subject == "" {
		return
	}
	ctx := context.Background()
	pool, err := postgresfixture.Open(ctx, os.Getenv(crashDBEnv), 4)
	if err != nil {
		crashChildFail(err)
	}
	point := os.Getenv(crashPointEnv)
	args := strings.Split(os.Getenv(crashArgsEnv), "|")
	switch subject {
	case "jobs":
		crashJobsChild(ctx, pool, point, args)
	case "stack":
		crashStackChild(ctx, pool, point, args)
	}
	crashChildFail(fmt.Errorf("unknown crash child %q at %q", subject, point))
}

func crashChildFail(err error) {
	fmt.Fprintln(os.Stderr, "crash child:", err)
	os.Exit(3)
}

// crashReached announces a kill point and never returns: the parent kills the
// process here. The stale owner instead waits to be resumed.
func crashReached(point string, detail ...string) {
	fmt.Println(crashMarker + strings.Join(append([]string{point}, detail...), " "))
	if point == "stale-owner" {
		// SIGSTOP freezes the whole process, heartbeats included; after
		// SIGCONT the parent writes one line to let the owner continue.
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			crashChildFail(err)
		}
		return
	}
	select {}
}

type crashChild struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string
	stderr *strings.Builder
}

func startCrashChild(t *testing.T, subject, point, databaseURL string, args ...string) *crashChild {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestDurableCrashRestartChildProcess$", "-test.count=1")
	cmd.Env = append(os.Environ(), crashChildEnv+"="+subject, crashPointEnv+"="+point, crashDBEnv+"="+databaseURL, crashArgsEnv+"="+strings.Join(args, "|"))
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	child := &crashChild{cmd: cmd, stdin: stdin, lines: make(chan string, 64), stderr: &strings.Builder{}}
	cmd.Stderr = child.stderr
	require.NoError(t, cmd.Start())
	go func() {
		defer close(child.lines)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			child.lines <- scanner.Text()
		}
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGCONT)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return child
}

// await returns the fields after prefix on the first matching line.
func (c *crashChild) await(t *testing.T, prefix string) []string {
	t.Helper()
	timeout := time.After(2 * time.Minute)
	for {
		select {
		case line, ok := <-c.lines:
			if !ok {
				t.Fatalf("crash child exited before %q: %s", prefix, c.stderr.String())
			}
			if rest, found := strings.CutPrefix(line, prefix); found {
				return strings.Fields(rest)
			}
		case <-timeout:
			t.Fatalf("crash child never reached %q: %s", prefix, c.stderr.String())
		}
	}
}

// kill ends the child as a crash would: no deferred cleanup, no release.
func (c *crashChild) kill(t *testing.T) {
	t.Helper()
	require.NoError(t, c.cmd.Process.Signal(syscall.SIGKILL))
	err := c.cmd.Wait()
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, syscall.SIGKILL, exit.Sys().(syscall.WaitStatus).Signal())
}

func (c *crashChild) freeze(t *testing.T) {
	t.Helper()
	require.NoError(t, c.cmd.Process.Signal(syscall.SIGSTOP))
}

func (c *crashChild) resume(t *testing.T) {
	t.Helper()
	require.NoError(t, c.cmd.Process.Signal(syscall.SIGCONT))
	_, err := io.WriteString(c.stdin, "continue\n")
	require.NoError(t, err)
}

func crashDatabase(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	pool := newProductTestPool(t)
	return pool, pool.Config().ConnString()
}

// ---- durable jobs ----

const crashJobOperation = "crash.effect"

var crashJobScope = jobs.Scope{TenantID: "tenant:crash", PrincipalID: "user:crash"}

func crashJobAdmission(policy jobs.EffectPolicy) jobs.Admission {
	return jobs.Admission{Scope: crashJobScope, Operation: crashJobOperation, RequestID: "request-1",
		Payload: json.RawMessage(`{"charge":1}`), AuthorizationContext: json.RawMessage(`{"role":"owner"}`), EffectPolicy: policy}
}

// crashEffectSchema is the external system: it records every delivery and
// applies each idempotency key once.
const crashEffectSchema = `
CREATE TABLE crash_deliveries (id bigserial PRIMARY KEY, effect_key text NOT NULL, worker text NOT NULL);
CREATE TABLE crash_effects (effect_key text PRIMARY KEY, worker text NOT NULL);`

func deliverCrashEffect(ctx context.Context, pool *pgxpool.Pool, lease *jobs.Lease, worker string) (string, error) {
	key := fmt.Sprintf("%s:%d", lease.Claim().OperationID, lease.DeliveryAttempt())
	if _, err := pool.Exec(ctx, `INSERT INTO crash_deliveries(effect_key, worker) VALUES ($1, $2)`, key, worker); err != nil {
		return "", err
	}
	_, err := pool.Exec(ctx, `INSERT INTO crash_effects(effect_key, worker) VALUES ($1, $2) ON CONFLICT (effect_key) DO NOTHING`, key, worker)
	return key, err
}

func crashJobHandler(pool *pgxpool.Pool, worker, point string) jobs.Handler {
	return func(ctx context.Context, lease *jobs.Lease) error {
		if point == "pre-launch" {
			crashReached(point)
		}
		if err := lease.StartExternal(ctx, json.RawMessage(`{"phase":"deliver"}`)); err != nil {
			return err
		}
		key, err := deliverCrashEffect(ctx, pool, lease, worker)
		if err != nil {
			return err
		}
		switch point {
		case "post-launch":
			crashReached(point)
		case "stale-owner":
			crashReached(point)
			// Settle outside the handler context: only the store's fence may
			// refuse this owner.
			err := lease.Complete(context.Background(), json.RawMessage(`{"worker":"stale"}`))
			fmt.Println(crashOutcome + fmt.Sprint(errors.Is(err, jobs.ErrClaimLost)))
			select {}
		}
		receipt, _ := json.Marshal(map[string]string{"worker": worker, "effect": key})
		return lease.Complete(ctx, receipt)
	}
}

func crashJobsChild(ctx context.Context, pool *pgxpool.Pool, point string, args []string) {
	store, err := jobs.NewStore(pool)
	if err != nil {
		crashChildFail(err)
	}
	policy := jobs.EffectPolicy(args[0])
	switch point {
	case "pre-commit":
		tx, err := pool.Begin(ctx)
		if err != nil {
			crashChildFail(err)
		}
		if _, err := store.AdmitInTx(ctx, tx, crashJobAdmission(policy)); err != nil {
			crashChildFail(err)
		}
		crashReached(point)
	case "post-commit":
		receipt, err := store.Admit(ctx, crashJobAdmission(policy))
		if err != nil {
			crashChildFail(err)
		}
		crashReached(point, receipt.OperationID)
	default:
		err := store.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "doomed", Capacity: 1, Lease: time.Second,
			HeartbeatInterval: 100 * time.Millisecond, PollInterval: 20 * time.Millisecond}, crashJobHandler(pool, "doomed", point))
		crashChildFail(fmt.Errorf("worker stopped: %v", err))
	}
}

// runRestartedJobsWorker runs a fresh worker until the operation settles.
func runRestartedJobsWorker(t *testing.T, pool *pgxpool.Pool, store *jobs.Store, operationID string) jobs.Operation {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "restarted", Capacity: 1, Lease: 2 * time.Second,
			HeartbeatInterval: 200 * time.Millisecond, PollInterval: 20 * time.Millisecond, RecoveryInterval: 50 * time.Millisecond,
			RetryDelay: 20 * time.Millisecond}, crashJobHandler(pool, "restarted", ""))
	}()
	var operation jobs.Operation
	require.Eventually(t, func() bool {
		var err error
		operation, err = store.Get(context.Background(), crashJobScope, operationID)
		return err == nil && operation.State.Terminal()
	}, 30*time.Second, 20*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
	return operation
}

// jobHistory is the operation's replayed event types, in sequence order.
func jobHistory(t *testing.T, store *jobs.Store, operationID string) []string {
	t.Helper()
	var types []string
	var cursor, previous int64
	for {
		page, err := store.Replay(context.Background(), crashJobScope, cursor, 50)
		require.NoError(t, err)
		for _, event := range page.Events {
			require.Greater(t, event.Sequence, previous, "replay is strictly ordered")
			previous = event.Sequence
			if event.OperationID == operationID {
				types = append(types, event.Type)
			}
		}
		cursor = page.Cursor
		if !page.More {
			return types
		}
	}
}

func countOf(values []string, value string) int {
	count := 0
	for _, candidate := range values {
		if candidate == value {
			count++
		}
	}
	return count
}

func crashCount(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var count int
	require.NoError(t, pool.QueryRow(context.Background(), query, args...).Scan(&count))
	return count
}

func expireCrashJobLease(t *testing.T, pool *pgxpool.Pool, operationID string) {
	t.Helper()
	// The lease is one second; wait it out rather than rewriting it.
	require.Eventually(t, func() bool {
		return crashCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE operation_id=$1 AND lease_expires_at < clock_timestamp()`, operationID) == 1
	}, 10*time.Second, 20*time.Millisecond)
}

func testJobsCrash(t *testing.T, point string, policy jobs.EffectPolicy) {
	pool, url := crashDatabase(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, crashEffectSchema)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	var operationID string
	switch point {
	case "pre-commit":
		child := startCrashChild(t, "jobs", point, url, string(policy))
		child.await(t, crashMarker+point)
		child.kill(t)
		_, err := store.GetByRequest(ctx, crashJobScope, crashJobOperation, "request-1")
		require.ErrorIs(t, err, jobs.ErrNotFound, "an uncommitted request leaves nothing behind")
		receipt, err := store.Admit(ctx, crashJobAdmission(policy))
		require.NoError(t, err)
		require.False(t, receipt.Joined)
		operationID = receipt.OperationID
	case "post-commit":
		child := startCrashChild(t, "jobs", point, url, string(policy))
		fields := child.await(t, crashMarker+point)
		child.kill(t)
		receipt, err := store.Admit(ctx, crashJobAdmission(policy))
		require.NoError(t, err)
		require.True(t, receipt.Joined, "the retried request joins the committed one")
		require.Equal(t, fields[0], receipt.OperationID)
		operationID = receipt.OperationID
	default:
		receipt, err := store.Admit(ctx, crashJobAdmission(policy))
		require.NoError(t, err)
		operationID = receipt.OperationID
		child := startCrashChild(t, "jobs", point, url, string(policy))
		child.await(t, crashMarker+point)
		if point == "stale-owner" {
			child.freeze(t)
			expireCrashJobLease(t, pool, operationID)
			operation := runRestartedJobsWorker(t, pool, store, operationID)
			require.Equal(t, jobs.StateCompleted, operation.State)
			child.resume(t)
			require.Equal(t, []string{"true"}, child.await(t, crashOutcome), "the stale owner's completion is refused")
			child.kill(t)
		} else {
			child.kill(t)
			expireCrashJobLease(t, pool, operationID)
		}
	}
	operation := runRestartedJobsWorker(t, pool, store, operationID)
	history := jobHistory(t, store, operationID)
	require.Equal(t, "operation.accepted", history[0], history)
	require.Equal(t, 1, countOf(history, "operation.accepted"), history)
	deliveries := crashCount(t, pool, `SELECT count(*) FROM crash_deliveries`)
	if point == "post-launch" && policy == jobs.EffectUnsafe {
		// An unsafe effect that may have happened is never repeated: it
		// stays visible as uncertain until someone resolves it.
		require.Equal(t, jobs.StateUncertain, operation.State)
		require.Equal(t, 1, deliveries)
		require.Equal(t, 1, countOf(history, "operation.uncertain"), history)
		require.Zero(t, countOf(history, "operation.completed"), history)
		return
	}
	require.Equal(t, jobs.StateCompleted, operation.State)
	require.Equal(t, 1, countOf(history, "operation.completed"), history)
	require.Equal(t, "operation.completed", history[len(history)-1], history)
	require.Equal(t, 1, crashCount(t, pool, `SELECT count(*) FROM crash_effects`), "the external effect applied exactly once")
	var receipt struct{ Worker, Effect string }
	require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &receipt))
	require.Equal(t, "restarted", receipt.Worker)
	switch point {
	case "pre-commit", "post-commit", "pre-launch":
		require.Equal(t, 1, deliveries, "nothing was delivered before the crash")
	default:
		// At-least-once delivery reuses the committed attempt, so the
		// external system deduplicates the redelivery.
		require.Equal(t, 2, deliveries)
		require.Equal(t, 1, crashCount(t, pool, `SELECT count(DISTINCT effect_key) FROM crash_deliveries`))
	}
}

// ---- history stack ----

// crashStackHost is the repository host of the stack worker. Its receive-pack
// can stop the process before or after the refs move.
type crashStackHost struct {
	*recordingRepoHost
	point string
}

func (h *crashStackHost) ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
	switch h.point {
	case "pre-launch", "stale-owner":
		crashReached(h.point)
	case "post-launch":
		if err := h.recordingRepoHost.ProxyReceivePack(ctx, owner, repo, stdin, stdout, meta...); err != nil {
			return err
		}
		out, err := exec.Command("git", "--git-dir", h.dir, "rev-parse", repohost.MythicalBookmarkRef).Output()
		if err != nil {
			crashChildFail(err)
		}
		crashReached(h.point, strings.TrimSpace(string(out)))
	}
	return h.recordingRepoHost.ProxyReceivePack(ctx, owner, repo, stdin, stdout, meta...)
}

func crashStackChild(ctx context.Context, pool *pgxpool.Pool, point string, args []string) {
	hostDir, scratch := args[0], args[1]
	repositoryID, _ := strconv.ParseInt(args[2], 10, 64)
	userID, _ := strconv.ParseInt(args[3], 10, 64)
	host := &crashStackHost{recordingRepoHost: &recordingRepoHost{gitBackedRepoHost: &gitBackedRepoHost{dir: hostDir, home: scratch}}, point: point}
	if err := host.ImportRefs(ctx, "", ""); err != nil {
		crashChildFail(err)
	}
	service := NewMythicalService(pool, host)
	service.scratchRoot = filepath.Join(scratch, "stack")
	switch point {
	case "pre-commit":
		tx, err := pool.Begin(ctx)
		if err != nil {
			crashChildFail(err)
		}
		if _, err := db.New(tx).RequestMythicalBootstrap(ctx, repositoryID, userID, 100, false); err != nil {
			crashChildFail(err)
		}
		crashReached(point)
	case "post-commit":
		if _, err := service.RequestBootstrap(ctx, repositoryID, userID, 100, false); err != nil {
			crashChildFail(err)
		}
		crashReached(point)
	default:
		err := service.PollOnce(ctx)
		row, getErr := db.New(pool).GetMythicalStack(ctx, repositoryID)
		fmt.Println(crashOutcome+fmt.Sprint(err == nil && getErr == nil), row.TipCommit)
		select {}
	}
}

func testStackCrash(t *testing.T, point string) {
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: one", "a.txt", "a")
	f.commit("🐛 fix: two", "b.txt", "b")
	main := f.publish()
	url := f.pool.(*pgxpool.Pool).Config().ConnString()
	args := []string{f.hostDir, t.TempDir(), strconv.FormatInt(f.repoID, 10), strconv.FormatInt(f.userID, 10)}
	q := db.New(f.pool)
	expire := func() {
		// The stack lease is ten minutes; move it into the past instead.
		_, err := f.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at = NOW() - interval '1 second', next_attempt_at = NOW() WHERE repository_id = $1`, f.repoID)
		require.NoError(t, err)
	}
	var prepared mythicalOp
	var childTip string
	switch point {
	case "pre-commit":
		child := startCrashChild(t, "stack", point, url, args...)
		child.await(t, crashMarker+point)
		child.kill(t)
		_, err := q.GetMythicalStack(ctx, f.repoID)
		require.ErrorIs(t, err, pgx.ErrNoRows, "an uncommitted request leaves nothing behind")
		_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
		require.NoError(t, err)
	case "post-commit":
		child := startCrashChild(t, "stack", point, url, args...)
		child.await(t, crashMarker+point)
		child.kill(t)
		row, err := q.GetMythicalStack(ctx, f.repoID)
		require.NoError(t, err)
		require.Equal(t, "bootstrapping", row.State)
		// A repeated request joins the durable one.
		_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
		require.NoError(t, err)
	default:
		_, err := f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
		require.NoError(t, err)
		child := startCrashChild(t, "stack", point, url, args...)
		fields := child.await(t, crashMarker+point)
		row, err := q.GetMythicalStack(ctx, f.repoID)
		require.NoError(t, err)
		require.NotEmpty(t, row.PendingOp, "the write is prepared durably before the push")
		require.NoError(t, json.Unmarshal(row.PendingOp, &prepared))
		if point == "post-launch" {
			childTip = fields[0]
			require.Equal(t, prepared.NewTip, childTip)
		}
		if point == "stale-owner" {
			expire()
			settled := f.poll()
			require.Equal(t, "active", settled.State, settled.LastError)
			child.resume(t)
			outcome := child.await(t, crashOutcome)
			require.Equal(t, settled.TipCommit, f.hostRef(repohost.MythicalBookmarkRef), "the stale owner's push is refused: %v", outcome)
			after, err := q.GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			require.Equal(t, settled, after, "the stale owner's finish is fenced: it changes nothing")
			child.kill(t)
		} else {
			child.kill(t)
			expire()
		}
	}
	pushes := len(f.host.metas)
	row := f.poll()
	if point == "stale-owner" {
		require.Equal(t, pushes, len(f.host.metas), "nothing is left to do")
	}
	require.Equal(t, "active", row.State, row.LastError)
	require.Empty(t, row.PendingOp)
	require.Equal(t, main, row.LandedMain)
	require.Equal(t, row.TipCommit, f.hostRef(repohost.MythicalBookmarkRef))
	require.Equal(t, f.hostTree(main), f.hostTree(row.TipCommit), "the stack's tree is main's")
	switch point {
	case "post-launch":
		require.Equal(t, childTip, row.TipCommit, "the landed push is confirmed, not repeated")
		require.Equal(t, pushes, len(f.host.metas), "recovery never pushes twice")
	case "pre-launch":
		require.Equal(t, prepared.NewTip, row.TipCommit, "the prepared write is replayed exactly")
	}
	// Each main commit appears once in the stack: no duplicated replay.
	changes, err := q.ListMythicalChanges(ctx, f.repoID)
	require.NoError(t, err)
	require.Len(t, changes, 2)
	require.Equal(t, "2", strings.TrimSpace(f.git(f.hostDir, "rev-list", "--count", row.TipCommit)))
	// A second pass finds nothing to do.
	generation := row.Generation
	row = f.poll()
	require.Equal(t, generation, row.Generation)
}

func TestDurableWorkSurvivesProcessKill(t *testing.T) {
	if os.Getenv(crashChildEnv) != "" {
		return
	}
	for _, point := range crashPoints {
		t.Run("jobs/"+point, func(t *testing.T) { testJobsCrash(t, point, jobs.EffectReconcile) })
	}
	t.Run("jobs/post-launch-unsafe", func(t *testing.T) { testJobsCrash(t, "post-launch", jobs.EffectUnsafe) })
	for _, point := range crashPoints {
		t.Run("stack/"+point, func(t *testing.T) { testStackCrash(t, point) })
	}
}
