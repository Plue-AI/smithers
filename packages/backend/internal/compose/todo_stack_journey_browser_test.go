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
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

// The T-STK-02 steps of C-J4-02 and C-J7-01 (apps/app/e2e/real/
// todo-stack-actions.browser.ts and todo-placement.browser.ts) against the
// composed install: the production router, command dispatcher, PostgreSQL,
// live channel and app. Opt-in because it launches Vite and Chromium:
//
//	SMITHERS_STACK_JOURNEY_BROWSER=1 go test ./internal/compose -run 'TestTodo(Placement|StackMove)JourneyComposedInstall' -count=1
//
// This control-only composition boots no guest. The fixture `todo` flow's
// settled outcomes are recorded as the engine facts its runtime projects
// (stackJourneyFixtureFlow); every placement the browser makes runs through
// the product. The full journeys (todo-stack-actions.spec.ts,
// todo-placement.spec.ts) need the fixture flow running and stay with the
// reference install.

// stackJourneyAnswer is the app agent's answer, streamed while the person acts.
var stackJourneyAnswer = []string{"Webhook retries live in ", "the delivery worker's ", "backoff loop."}

// stackJourneyChatHost streams a deterministic answer through the real
// authenticated producer commit door, one delta every interval, so the
// person's actions run while the turn is still answering.
type stackJourneyChatHost struct{ interval time.Duration }

func (h stackJourneyChatHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	expected, err := json.Marshal(grant.Cursor)
	if err != nil {
		return err
	}
	frames := make([]any, 0, len(stackJourneyAnswer)+1)
	for _, text := range stackJourneyAnswer {
		frames = append(frames, map[string]string{"runId": grant.RunID, "type": "delta", "kind": "text", "text": text})
	}
	frames = append(frames, map[string]string{"runId": grant.RunID, "type": "done", "reason": "stop"})
	for i, frame := range frames {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(h.interval):
			}
		}
		raw, err := json.Marshal(map[string]any{"turnId": grant.TurnID, "generation": grant.Generation, "expected": json.RawMessage(expected), "frames": []any{frame}})
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
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("chat producer refused: %d %s", response.StatusCode, body)
		}
		var committed struct {
			Cursor json.RawMessage `json:"cursor"`
		}
		if err := json.Unmarshal(body, &committed); err != nil {
			return err
		}
		expected = committed.Cursor
	}
	return nil
}

var stackJourneyHold = regexp.MustCompile(`\[HOLD [A-Za-z0-9._-]+\]`)

// stackJourneyQuestion is the question an [ASK] TODO raises (C-J4-02 T2),
// the same words distribution/fake-todo-turns.mjs asks on the rehearsal.
const stackJourneyQuestion = "Which greeting should the file carry?"

// stackJourneyFixtureFlow settles each filed TODO as the fixture `todo` flow
// would (C-J4-02 setup): [PR] opens a PR (in_review), [ASK] raises a
// question (needs_you), [FAIL] fails its check step (failed) and [HOLD key]
// keeps its implement step working. A TODO without a marker is left to the
// engine's admission. The guest is the one part stood in for: the outcome is
// recorded as the facts the flow runtime projects onto mythical_items, once
// per TODO, and every later transition is the product's own.
func stackJourneyFixtureFlow(ctx context.Context, pool *pgxpool.Pool, repo int64, main string, failures chan<- error) {
	settled := map[int64]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
		rows, err := pool.Query(ctx, `SELECT number, coalesce(revisions->0->>'text', '') FROM mythical_items
			WHERE repository_id=$1 AND checks->>'todo'='true' AND state='queued' AND number IS NOT NULL`, repo)
		if err != nil {
			if ctx.Err() == nil {
				failures <- err
			}
			return
		}
		type filed struct {
			n      int64
			prompt string
		}
		var pending []filed
		for rows.Next() {
			var item filed
			if err := rows.Scan(&item.n, &item.prompt); err != nil {
				rows.Close()
				failures <- err
				return
			}
			if !settled[item.n] {
				pending = append(pending, item)
			}
		}
		rows.Close()
		for _, item := range pending {
			settled[item.n] = true
			head := fmt.Sprintf("%040x", sha256.Sum256([]byte(fmt.Sprintf("%s:%d", main, item.n))))[:40]
			const run = `{"run_launched":true,"run_attached":true}`
			var statement string
			args := []any{repo, item.n, fmt.Sprintf("run-t%d", item.n)}
			switch {
			case strings.Contains(item.prompt, "[ASK]"):
				waits, _ := json.Marshal([]map[string]any{{"id": fmt.Sprintf("question-t%d", item.n), "kind": "question", "prompt": stackJourneyQuestion, "since": time.Now().UTC()}})
				statement = `UPDATE mythical_items SET state='running', attempt=1, request_run_id=$3, checks=checks || $4::jsonb || jsonb_build_object('waits', $5::jsonb) WHERE repository_id=$1 AND number=$2 AND state='queued'`
				args = append(args, run, string(waits))
			case strings.Contains(item.prompt, "[FAIL]") && !strings.Contains(item.prompt, "[FIXED]"):
				statement = `UPDATE mythical_items SET state='blocked', reason='checks failed', attempt=1, request_run_id=$3, request_outcome='failed', checks=checks || $4::jsonb WHERE repository_id=$1 AND number=$2 AND state='queued'`
				args = append(args, run)
			case stackJourneyHold.MatchString(item.prompt):
				statement = `UPDATE mythical_items SET state='running', attempt=1, request_run_id=$3, checks=checks || $4::jsonb WHERE repository_id=$1 AND number=$2 AND state='queued'`
				args = append(args, run)
			case strings.Contains(item.prompt, "[PR]"):
				// No candidate commits: this install has no repository
				// history, so the card carries only the PR GitHub reports.
				statement = `UPDATE mythical_items SET state='proposed', attempt=1, request_run_id=$3, checks=checks || $4::jsonb,
					pr_number=$2, pr_url='https://github.com/will/canary/pull/' || $2::text, pr_state='open', pr_head=$5
					WHERE repository_id=$1 AND number=$2 AND state='queued'`
				args = append(args, run, head)
			default:
				continue
			}
			if _, err := pool.Exec(ctx, statement, args...); err != nil {
				if ctx.Err() == nil {
					failures <- fmt.Errorf("T%d outcome: %w", item.n, err)
				}
				return
			}
		}
	}
}

// stackJourneyRun is one composed install with the journey's members, the
// app on Vite behind the install's origin, and the spec run against it.
type stackJourneyRun struct {
	pool     *pgxpool.Pool
	repo     int64
	members  map[string]db.User
	evidence string
}

// runStackJourney composes the install, runs one spec's scenario through the
// real-tier Playwright config and answers the install for the caller's
// independent PostgreSQL oracle.
func runStackJourney(t *testing.T, check, script string) stackJourneyRun {
	if os.Getenv("SMITHERS_STACK_JOURNEY_BROWSER") != "1" {
		t.Skip("set SMITHERS_STACK_JOURNEY_BROWSER=1 for the composed C-J4-02 and C-J7-01 browser journeys")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Minute)
	defer cancel()
	_, _, pool := splitProcessDatabase(t)
	database := os.Getenv("SMITHERS_DATABASE_URL")
	require.NotEmpty(t, database)
	q := db.New(pool)
	members := map[string]db.User{}
	for _, person := range []struct{ login, name, permission string }{{"will", "Will", "admin"}, {"ben", "Ben", "write"}} {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: person.login, LowerUsername: person.login, DisplayName: person.name})
		require.NoError(t, err)
		members[person.name] = user
	}
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: members["Will"].ID, Valid: true}, Name: "canary", LowerName: "canary", DefaultBookmark: "main"})
	require.NoError(t, err)
	cookies := map[string][]map[string]string{}
	for name, permission := range map[string]string{"Will": "admin", "Ben": "write"} {
		person := members[name]
		_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, person.ID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, person.ID, permission)
		require.NoError(t, err)
		session := person.Username + "-journey-session"
		sum := sha256.Sum256([]byte(session))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		cookies[name] = []map[string]string{{"name": "session", "value": session}, {"name": "__csrf", "value": "journey-csrf"}}
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, members["Will"].ID)
	require.NoError(t, err)
	main := strings.Repeat("a", 40)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state,landed_main) VALUES($1,$2,'active',$3)`, repo.ID, members["Will"].ID, main)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"will","repository_name":"canary","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}

	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	// The install's wiki composes the repository's native library.
	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
		t.Setenv("SMITHERS_FFI_LIBRARY_PATH", filepath.Join(root, "target/release/libsmithers_ffi.dylib"))
	}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	evidence := filepath.Join(root, ".artifacts/checks", check, "composed", time.Now().UTC().Format("20060102T150405Z"))
	require.NoError(t, os.MkdirAll(evidence, 0o700))
	backendLog, err := os.Create(filepath.Join(evidence, "backend.log"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = backendLog.Close() })
	admission := new(liveBrowserAdmissionRuntime)
	profile := microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}
	api := startStackJourney(t, backendLog, Options{ChatHost: stackJourneyChatHost{interval: 3 * time.Second}, Workspace: admission, HostProfile: &profile, FlowHostProductAPIURL: origin})

	app := filepath.Join(root, "apps/app")
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	vitePort := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	vite := exec.CommandContext(ctx, filepath.Join(app, "node_modules/.bin/vite"), "--configLoader", "runner", "--host", "127.0.0.1", "--port", fmt.Sprint(vitePort), "--strictPort", "--logLevel", "warn")
	vite.Dir = app
	vite.Stdout, vite.Stderr = os.Stderr, os.Stderr
	require.NoError(t, vite.Start())
	t.Cleanup(func() { _ = vite.Process.Kill(); _ = vite.Wait() })
	viteURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", vitePort))
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		response, err := http.Get(viteURL.String() + "/")
		if err != nil {
			return false
		}
		response.Body.Close()
		return response.StatusCode == http.StatusOK
	}, time.Minute, 200*time.Millisecond, "Vite did not serve the app")
	proxy := httputil.NewSingleHostReverseProxy(viteURL)
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
		} else {
			proxy.ServeHTTP(w, r)
		}
	})
	server.Start()
	t.Cleanup(server.Close)

	failures := make(chan error, 1)
	flowCtx, stopFlow := context.WithCancel(ctx)
	defer stopFlow()
	go stackJourneyFixtureFlow(flowCtx, pool, repo.ID, main, failures)

	descriptor, err := json.Marshal(map[string]any{"origin": origin, "repository": "will/canary", "database": database,
		"evidence": evidence, "members": cookies})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(evidence, "install.json"), []byte(fmt.Sprintf(`{"install":"composed","commit":%q,"origin":%q}`, stackJourneyCommit(root), origin)), 0o600))
	host := filepath.Join(t.TempDir(), "composed-host.json")
	require.NoError(t, os.WriteFile(host, descriptor, 0o600))
	browser := exec.CommandContext(ctx, "bun", "e2e/real/"+script)
	browser.Dir = app
	browser.Env = append(os.Environ(), "SMITHERS_JOURNEY_COMPOSED_HOST="+host)
	browser.Stdout, browser.Stderr = os.Stdout, os.Stderr
	err = browser.Run()
	select {
	case failure := <-failures:
		require.NoError(t, failure, "fixture flow")
	default:
	}
	require.NoError(t, err, "%s against the composed install; evidence %s", script, evidence)
	t.Logf("%s passed against the composed install; evidence %s", script, evidence)
	return stackJourneyRun{pool: pool, repo: repo.ID, members: members, evidence: evidence}
}

// startStackJourney is startSplitProcess with the install's log kept as evidence.
func startStackJourney(t *testing.T, logs io.Writer, options Options) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan http.Handler, 1)
	finished := make(chan error, 1)
	go func() {
		finished <- StartWithOptions(ctx, nil, logs, logs, options, func(handler http.Handler) { ready <- handler })
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-finished:
			require.NoError(t, err)
		case <-time.After(30 * time.Second):
			t.Error("composition did not stop")
		}
	})
	select {
	case handler := <-ready:
		return handler
	case err := <-finished:
		t.Fatalf("composition stopped before ready: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("composition did not become ready")
	}
	return nil
}

// stackJourneyCommit names the checkout under test for the evidence.
func stackJourneyCommit(root string) string {
	output, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if err != nil || len(strings.TrimSpace(string(output))) != 40 {
		return "unknown"
	}
	return strings.TrimSpace(string(output))
}

// order answers the engine's order of unmerged, undropped TODOs.
func (run stackJourneyRun) order(t *testing.T) []int64 {
	rows, err := run.pool.Query(context.Background(), `SELECT number FROM mythical_items WHERE repository_id=$1 AND checks->>'todo'='true'
		AND state NOT IN ('landed','cancelled','rejected','declined') ORDER BY stack_position`, run.repo)
	require.NoError(t, err)
	defer rows.Close()
	order := []int64{}
	for rows.Next() {
		var n int64
		require.NoError(t, rows.Scan(&n))
		order = append(order, n)
	}
	require.NoError(t, rows.Err())
	return order
}

// facts answers the data of each product_job_events row of kind.
func (run stackJourneyRun) facts(t *testing.T, kind string) []map[string]any {
	rows, err := run.pool.Query(context.Background(), `SELECT data FROM product_job_events WHERE event_type=$1 ORDER BY sequence`, kind)
	require.NoError(t, err)
	defer rows.Close()
	facts := []map[string]any{}
	for rows.Next() {
		var raw []byte
		require.NoError(t, rows.Scan(&raw))
		var fact map[string]any
		require.NoError(t, json.Unmarshal(raw, &fact))
		facts = append(facts, fact)
	}
	require.NoError(t, rows.Err())
	return facts
}

// C-J7-01 steps 1-2 (T-STK-02): Ben's Draft places a TODO Before T3.
func TestTodoPlacementJourneyComposedInstall(t *testing.T) {
	run := runStackJourney(t, "C-J7-01", "todo-placement.browser.ts")
	require.Equal(t, []int64{1, 2, 4, 3}, run.order(t))
	var placed []map[string]any
	for _, fact := range run.facts(t, "todo.created") {
		if fact["n"] == float64(4) {
			placed = append(placed, fact)
		}
	}
	require.Len(t, placed, 1)
	require.Equal(t, float64(3), placed[0]["before"])
	require.Equal(t, float64(run.members["Ben"].ID), placed[0]["actor"])
}

// C-J4-02 step 4 (T-STK-02): the lead moves T4 above the failed T3 while chatting.
func TestTodoStackMoveJourneyComposedInstall(t *testing.T) {
	run := runStackJourney(t, "C-J4-02", "todo-stack-actions.browser.ts")
	require.Equal(t, []int64{1, 2, 4, 3}, run.order(t))
	moves := run.facts(t, "todo.moved")
	require.Len(t, moves, 1, "a double press moves once")
	require.Equal(t, float64(4), moves[0]["n"])
	require.Equal(t, "up", moves[0]["direction"])
	require.Equal(t, float64(3), moves[0]["past"])
}
