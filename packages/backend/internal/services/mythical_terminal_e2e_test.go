package services_test

// The coding factory loop driven from the terminal (#2785): a person makes
// a TODO with `smthrs history todo` (T1, no GitHub issue), watches the
// factory take it with `smthrs history watch T1`, reads its check receipts,
// sees it land when a maintainer merges its PR on GitHub or stop with a
// typed reason, and resumes it with `smthrs history retry`.
//
// Every command is the real `smthrs` process from this checkout, talking
// HTTP to the real mythical routes, auth and repository middleware, stack
// service, Postgres rows and event hints. Only the world outside the
// backend is scripted: GitHub (a bare repository with recorded issues and
// pull requests) and the Cloud lanes' flow runs, whose results the test
// hands to the stack as flowdispatch would. That is why this walkthrough is
// not the live Cloud receipt #2785 still needs.
//
// SMITHERS_TERMINAL_RECEIPTS names a directory to record the transcript and
// the item JSON the CLI read at each step; the committed receipts live in
// factory/receipts/terminal-loop.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

const terminalRepo = "smithers-canary/smithers"

// terminal is the person's shell: the smthrs executable of this checkout
// signed in to the backend, and the transcript of everything it printed.
type terminal struct {
	t          *testing.T
	node, cli  string
	env        []string
	home       string
	origin     string
	token      string
	mu         sync.Mutex
	transcript strings.Builder
	receipts   string
	snapshots  int
}

// session is one running smthrs process whose output is read as it prints.
type session struct {
	cmd  *exec.Cmd
	mu   sync.Mutex
	out  bytes.Buffer
	done chan error
}

func (s *session) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.out.Write(p)
}

func (s *session) output() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.out.String()
}

// until waits for the process to print want.
func (s *session) until(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for !strings.Contains(s.output(), want) {
		select {
		case err := <-s.done:
			s.done <- err
			require.Contains(t, s.output(), want, "smthrs exited (%v) before printing %q", err, want)
			return
		default:
		}
		require.True(t, time.Now().Before(deadline), "smthrs never printed %q:\n%s", want, s.output())
		time.Sleep(50 * time.Millisecond)
	}
}

// exit waits for the process and answers its exit status.
func (s *session) exit(t *testing.T) int {
	t.Helper()
	select {
	case err := <-s.done:
		if err == nil {
			return 0
		}
		var exitErr *exec.ExitError
		require.ErrorAs(t, err, &exitErr, "smthrs failed to run:\n%s", s.output())
		return exitErr.ExitCode()
	case <-time.After(2 * time.Minute):
		_ = s.cmd.Process.Kill()
		t.Fatalf("smthrs did not exit:\n%s", s.output())
		return -1
	}
}

func (term *terminal) note(line string) {
	term.mu.Lock()
	defer term.mu.Unlock()
	term.transcript.WriteString("# " + line + "\n")
}

// start runs `smthrs <args> --repo … --audience human` in the background.
func (term *terminal) start(args ...string) *session {
	term.t.Helper()
	full := append(append([]string{term.cli}, args...), "--repo", terminalRepo, "--audience", "human")
	cmd := exec.Command(term.node, full...)
	cmd.Dir, cmd.Env = term.home, term.env
	s := &session{cmd: cmd, done: make(chan error, 1)}
	// This exercises a human terminal. Pipes intentionally select structured
	// CLI output and cannot prove the interactive rendering/streaming contract.
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 160})
	require.NoError(term.t, err)
	term.t.Cleanup(func() { _ = cmd.Process.Kill(); _ = master.Close() })
	copied := make(chan struct{})
	go func() { _, _ = io.Copy(s, master); close(copied) }()
	go func() {
		err := cmd.Wait()
		<-copied
		_ = master.Close()
		s.done <- err
	}()
	return s
}

// record writes the finished command and its output to the transcript.
func (term *terminal) record(s *session, args []string, code int) {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = arg
		if strings.ContainsAny(arg, " \"'") {
			quoted[i] = fmt.Sprintf("%q", arg)
		}
	}
	term.mu.Lock()
	defer term.mu.Unlock()
	fmt.Fprintf(&term.transcript, "$ smthrs %s --repo %s\n%s[exit %d]\n\n", strings.Join(quoted, " "), terminalRepo, s.output(), code)
}

// run runs one smthrs command to completion.
func (term *terminal) run(args ...string) (string, int) {
	term.t.Helper()
	s := term.start(args...)
	code := s.exit(term.t)
	term.record(s, args, code)
	return s.output(), code
}

// item reads the item the way `history watch` reads it, and keeps the JSON.
func (term *terminal) item(ref string, name string) map[string]any {
	term.t.Helper()
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/repos/%s/mythical/items/%s", term.origin, terminalRepo, ref), nil)
	require.NoError(term.t, err)
	request.Header.Set("Authorization", "token "+term.token)
	response, err := http.DefaultClient.Do(request)
	require.NoError(term.t, err)
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	require.NoError(term.t, err)
	require.Equal(term.t, http.StatusOK, response.StatusCode, string(body))
	var item map[string]any
	require.NoError(term.t, json.Unmarshal(body, &item))
	if term.receipts != "" {
		term.snapshots++
		var pretty bytes.Buffer
		require.NoError(term.t, json.Indent(&pretty, body, "", "  "))
		pretty.WriteString("\n")
		require.NoError(term.t, os.WriteFile(filepath.Join(term.receipts, fmt.Sprintf("%02d-%s.json", term.snapshots, name)), pretty.Bytes(), 0o644))
	}
	return item
}

// serveBackend mounts the mythical and TODO routes as the product router does:
// token auth, the repository context, and the read/write permission gates.
func serveBackend(t *testing.T, factory *services.TerminalFactory) *httptest.Server {
	t.Helper()
	pool := factory.Pool()
	queries := db.New(pool)
	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(context.Background()))
	t.Cleanup(broker.Stop)
	handler := &routes.MythicalHandler{Service: factory.Service(), Broker: broker}
	readRepo := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository),
		middleware.RequireRepoPermission(middleware.PermissionRead)}
	writeRepo := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository),
		middleware.RequireRepoPermission(middleware.PermissionWrite)}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(queries))
		r.With(readRepo...).Get("/mythical/events", handler.Events)
		r.With(readRepo...).Get("/mythical", handler.GetStack)
		r.With(readRepo...).Get("/mythical/items/{ref}", handler.GetItem)
		r.With(writeRepo...).Post("/mythical/items/{id}/retry", handler.Retry)
	})
	// The TODO routes, as the product router mounts them: no repository in
	// the path, the stack's repository named for the same permission gates.
	todos := &routes.TodoHandler{Service: factory.Service().Todos()}
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), todos.ResolveStackRepository,
		middleware.LoadRepoContext(queries), middleware.RequireRepoPermission(middleware.PermissionWrite)).Post("/api/todos", todos.Create)
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), todos.ResolveStackRepository,
		middleware.LoadRepoContext(queries), middleware.RequireRepoPermission(middleware.PermissionRead)).Get("/api/todos/{n}", todos.Get)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

// signIn issues the person a repository token and writes the CLI's auth
// file, as `smthrs auth login` would.
func signIn(t *testing.T, factory *services.TerminalFactory, origin string) (string, string) {
	t.Helper()
	ctx := context.Background()
	// A user token is smithers_ and 40 lowercase hex digits (63d9c50bba).
	raw := "smithers_" + strings.Repeat("0123456789abcdef", 3)[:40]
	sum := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(sum[:])
	_, err := factory.Pool().Exec(ctx, `INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
		VALUES ($1, 'terminal', $2, $3, 'read:repository,write:repository')`, factory.UserID(), hash, hash[len(hash)-8:])
	require.NoError(t, err)
	home := t.TempDir()
	auth := filepath.Join(home, "auth.json")
	// The CLI records the bare hostname, without the port (Session.save).
	parsed, err := url.Parse(origin)
	require.NoError(t, err)
	encoded, err := json.Marshal(map[string]string{"api_url": origin, "host": parsed.Hostname(), "token": raw})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(auth, encoded, 0o600))
	return raw, home
}

// checkout finds this repository's smthrs entry and a Node that runs it.
func checkout(t *testing.T) (string, string) {
	t.Helper()
	wd, err := os.Getwd()
	require.NoError(t, err)
	cli := filepath.Join(wd, "..", "..", "..", "smithers", "bin", "smithers.mjs")
	if _, err := os.Stat(cli); err != nil {
		t.Skipf("no smthrs checkout at %s", cli)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	return node, cli
}

func TestTerminalFactoryLoop(t *testing.T) {
	node, cli := checkout(t)
	factory := services.NewTerminalFactory(t)
	server := serveBackend(t, factory)
	token, home := signIn(t, factory, server.URL)
	term := &terminal{t: t, node: node, cli: cli, home: home, origin: server.URL, token: token,
		receipts: strings.TrimSpace(os.Getenv("SMITHERS_TERMINAL_RECEIPTS"))}
	if term.receipts != "" {
		require.NoError(t, os.MkdirAll(term.receipts, 0o755))
	}
	term.env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"), "NODE_OPTIONS=",
		"SMITHERS_API_ORIGIN="+server.URL, "SMITHERS_AUTH_FILE="+filepath.Join(home, "auth.json"),
		"SMITHERS_DISABLE_SYSTEM_KEYRING=1", "SMITHERS_AUDIENCE=human", "NO_COLOR=1")

	// 1. Make a TODO. It is T1, with no GitHub issue, and the stack queues it.
	out, code := term.run("history", "todo", "Add the footer link", "--body", "Make it findable.")
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "T1 Add the footer link · queued")
	assert.Equal(t, "queued", term.item("T1", "made")["state"])
	assert.Equal(t, "queued", factory.TodoState(1))

	// 2. Watch the factory pick it up, implement it and open its pull request.
	watch := term.start("history", "watch", "T1")
	watch.until(t, "T1 Add the footer link · queued")
	term.note("factory: a lane picks T1 up and launches coding/request")
	factory.Wake()
	watch.until(t, "T1 Add the footer link · implementing")
	term.note("factory: the lane's coding/request validates the change; affected-lint and affected-test pass on the candidate")
	candidate := factory.Implement(1, "docs/footer.md")
	factory.Wake()
	factory.Wake()
	receipts := fmt.Sprintf("✓ affected-lint %s · ✓ affected-test %s", candidate[:7], candidate[:7])
	watch.until(t, "PR open")
	code = watch.exit(t)
	term.record(watch, []string{"history", "watch", "T1"}, code)
	require.Equal(t, 0, code, watch.output())
	assert.Contains(t, watch.output(), "T1 Add the footer link · PR open · checks passed")
	assert.Contains(t, watch.output(), receipts, "the check receipts name the candidate the checks measured")
	proposed := term.item("T1", "proposed")
	assert.Equal(t, "proposed", proposed["state"])
	checks := proposed["checks"].(map[string]any)
	assert.Equal(t, "passed", checks["state"])
	assert.Len(t, checks["receipts"], 2)
	assert.Equal(t, "in_review", factory.TodoState(1))

	// 3. The review approves; a maintainer merges the pull request on GitHub.
	term.note("factory: coding/review approves the pull request's head")
	factory.Review(`"approve\n- Looks right."`)
	term.note("github: roninjin10 merges the pull request")
	factory.MergeOnGitHub(1)
	factory.Wake()
	state, reason := factory.State(1)
	require.Equal(t, "landed", state, reason)
	require.NotEmpty(t, factory.Merged(1))
	assert.Equal(t, "merged", factory.TodoState(1))
	out, code = term.run("history", "watch", "T1")
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "T1 Add the footer link · landed")
	assert.Equal(t, "landed", term.item("T1", "landed")["state"])

	// 4. A second TODO stops with a typed reason, and the watch says so.
	out, code = term.run("history", "todo", "Add the header link")
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "T2 Add the header link · queued")
	watch = term.start("history", "watch", "T2")
	watch.until(t, "T2 Add the header link · queued")
	factory.Wake()
	watch.until(t, "T2 Add the header link · implementing")
	term.note("factory: T2's coding/request fails: the model provider refused the lane's credentials (user fault)")
	factory.Stop(2, "user", "flows/model/ModelError/authentication")
	factory.Wake()
	code = watch.exit(t)
	term.record(watch, []string{"history", "watch", "T2"}, code)
	assert.Equal(t, 1, code, "a stopped TODO ends the watch with exit 1:\n%s", watch.output())
	assert.Contains(t, watch.output(), "T2 Add the header link · blocked · The run was stopped")
	blocked := term.item("T2", "blocked")
	assert.Equal(t, "blocked", blocked["state"])
	// Typed failure copy never exposes the diagnostic tag (MVP errors).
	assert.Equal(t, "The run was stopped", blocked["reason"])
	assert.Equal(t, map[string]any{"kind": "stopped", "fault": "user"}, blocked["failure"])
	assert.NotContains(t, watch.output(), "flows/model/ModelError/authentication")
	assert.Equal(t, "failed", factory.TodoState(2))

	// 5. Retry: the person resumes it and it reaches its pull request.
	out, code = term.run("history", "retry", "T2")
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "T2 Add the header link · queued")
	assert.Equal(t, "queued", term.item("T2", "retried")["state"])
	assert.Equal(t, "queued", factory.TodoState(2))
	watch = term.start("history", "watch", "T2")
	watch.until(t, "T2 Add the header link · queued")
	term.note("factory: a lane picks T2 up again")
	factory.Wake()
	watch.until(t, "T2 Add the header link · implementing")
	term.note("factory: this time coding/request validates the change")
	candidate = factory.Implement(2, "docs/header.md")
	factory.Wake()
	factory.Wake()
	code = watch.exit(t)
	term.record(watch, []string{"history", "watch", "T2"}, code)
	require.Equal(t, 0, code, watch.output())
	assert.Contains(t, watch.output(), "T2 Add the header link · PR open · checks passed")
	assert.Contains(t, watch.output(), fmt.Sprintf("✓ affected-lint %s · ✓ affected-test %s", candidate[:7], candidate[:7]))
	assert.Equal(t, "proposed", term.item("T2", "retried-proposed")["state"])
	assert.Equal(t, 2, factory.Launches("coding/request")-1, "T2 ran twice, T1 once")

	// The history as the terminal shows it at the end.
	out, code = term.run("history", "show")
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "T1 Add the footer link")
	assert.Contains(t, out, "T2 Add the header link")

	if term.receipts != "" {
		require.NoError(t, os.WriteFile(filepath.Join(term.receipts, "transcript.txt"), []byte(term.transcript.String()), 0o644))
	}
}
