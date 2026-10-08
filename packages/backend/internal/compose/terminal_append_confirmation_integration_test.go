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
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// C-SEC-05's present-consumer path uses a terminal credential minted by the
// authenticated WebSocket lifecycle, then the compiled guest CLI and composed router.
// The PTY/filesystem double does not qualify packaged guest isolation.
func TestTerminalAppendConfirmationComposedInstall(t *testing.T) {
	terminalReplacementInstall(t, false, false, false, true)
}

func exerciseTerminalAppendConfirmation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, q *db.Queries, member db.User, repository int64, token string) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repository, member.ID)
	require.NoError(t, err)
	todos := services.NewMythicalService(pool, nil)
	todos.SetTodoFlow(func(ctx context.Context, repository int64, _ string) (string, error) {
		return services.ActiveFlowDigest(ctx, q, repository, "todo")
	})
	todos.EnableTodoSteering()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: todos,
		Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Fatal("terminal HTTP admission must not wait for a guest")
			return nil, nil
		})})
	require.NoError(t, err)
	todos.SetLauncher(dispatcher)
	approvals := services.NewApprovalsService(q, services.WithConfirmationTodos(pool, todos))
	server := httptest.NewUnstartedServer(nil)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: approvals})
	phase := os.Getenv("SMITHERS_TERMINAL_CONFIRM_PHASE_DIR")
	if phase != "" {
		t.Setenv("SMITHERS_PUBLIC_URL", cfg.Server.PublicURL)
		t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", cfg.Server.PublicURL)
		t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "smithers_session")
		api := startSplitProcess(t, Options{ChatHost: unusedChatHost{}, Duties: DutiesHTTP})
		spa, err := filepath.Abs("../../../../apps/app/dist")
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(spa, "index.html"))
		require.NoError(t, err, "build apps/app before the browser proof")
		files := http.FileServer(http.Dir(spa))
		server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				api.ServeHTTP(w, r)
			} else if filepath.Ext(r.URL.Path) == "" {
				http.ServeFile(w, r, filepath.Join(spa, "index.html"))
			} else {
				files.ServeHTTP(w, r)
			}
		})
	}
	server.Start()
	defer server.Close()
	invoke := packagedTerminalCLIInvoker(t, ctx, server.URL, token)
	argv := []string{"todo", "new", "--text", "Keep the terminal request private", "--title", "Terminal follow-up", "--idempotencyKey", "terminal-confirm"}
	code, receipt := invoke(argv...)
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	require.Equal(t, "Waiting for ben to confirm", receipt["message"])
	id, ok := receipt["confirmation"].(string)
	require.True(t, ok, receipt)
	// Feed the real installed-router CLI receipt (exit 3) through the same
	// parser that the native Claude driver runs. A Bash error flag for that
	// exit must preserve the pending id, never turn it into a failed skill.
	proof := exec.CommandContext(ctx, "bun", "-e", `import { terminalSkillProof } from "../../../../apps/app/e2e/real/support/terminal-skill-proof.ts"; console.log(terminalSkillProof(["todo new"], "todo new"))`)
	parser, err := proof.CombinedOutput()
	require.NoError(t, err, string(parser))
	encodedReceipt, err := json.Marshal(receipt)
	require.NoError(t, err)
	for _, toolError := range []bool{false, true} {
		messages := []any{
			map[string]any{"message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "name": "Bash", "id": "append", "input": map[string]any{"command": "smthrs todo new --json"}}}}},
			map[string]any{"message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "append", "is_error": toolError, "content": string(encodedReceipt)}}}},
			map[string]any{"type": "result", "subtype": "success", "is_error": false},
		}
		var transcript strings.Builder
		for _, message := range messages {
			encoded, err := json.Marshal(message)
			require.NoError(t, err)
			transcript.Write(encoded)
			transcript.WriteByte('\n')
		}
		parse := exec.CommandContext(ctx, "/usr/bin/python3", "-c", string(parser))
		parse.Stdin = strings.NewReader(transcript.String())
		output, err := parse.CombinedOutput()
		require.NoError(t, err, string(output))
		require.Equal(t, "J6CONFIRMATION="+id+"\nJ6SKILL=executed\n", string(output))
	}
	code, replay := invoke(argv...)
	require.Equal(t, 3, code)
	require.Equal(t, receipt, replay)
	count := func(table string) int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	require.Equal(t, 1, count("approvals"))
	require.Zero(t, count("mythical_items"))
	require.Zero(t, count("product_job_requests"))
	require.Zero(t, count("workflow_runs"))
	// Installing the append confirmation consumer must not widen terminal_s1.
	// Exercise the skill's compiled CLI door as well as the HTTP fixtures below:
	// placement refusals cannot create another card or launch background work.
	code, refusal := invoke("todo", "new", "--text", "Forbidden terminal placement", "--before", "T2", "--idempotencyKey", "terminal-confirm-before")
	require.Equal(t, 1, code, refusal)
	require.Equal(t, "permission", refusal["class"], refusal)
	require.Equal(t, "permission", refusal["code"])
	require.NotContains(t, refusal, "confirmation")
	require.Equal(t, 1, count("approvals"))
	require.Zero(t, count("mythical_items"))
	require.Zero(t, count("product_job_requests"))
	require.Zero(t, count("workflow_runs"))
	var credential, kind, via string
	require.NoError(t, pool.QueryRow(ctx, `SELECT credential_id FROM approvals WHERE id=$1 AND member_id=$2`, id, member.ID).Scan(&credential))
	require.NotEmpty(t, credential)
	// Scope and attribution were issued by the terminal lifecycle, not headers.
	require.NoError(t, pool.QueryRow(ctx, `SELECT system_issued::text,scopes FROM access_tokens WHERE name LIKE 'terminal-session-%' LIMIT 1`).Scan(&kind, &via))
	require.Equal(t, "true", kind)
	require.Contains(t, via, "via:terminal")
	require.Contains(t, via, "profile:terminal_s1")

	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repository, other.ID)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("other-terminal-confirm-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: other.ID, Username: other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	callAt := func(origin, method, path, body, cookie, bearer, key string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		req.Header.Set("Idempotency-Key", key)
		// Attribution and actor/profile claims cannot grant person authority.
		req.Header.Set("Smithers-Via", "browser")
		req.Header.Set("Smithers-Actor-Kind", "person")
		req.Header.Set("Smithers-Profile", "full")
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
	call := func(method, path, body, cookie, bearer, key string) (int, []byte) {
		return callAt(server.URL, method, path, body, cookie, bearer, key)
	}
	status, raw := call("GET", "/api/confirmations", "", "replacement-cookie", "", "")
	require.Equal(t, 200, status, string(raw))
	var private []struct {
		ID      string          `json:"id"`
		Payload json.RawMessage `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(raw, &private))
	require.Len(t, private, 1)
	require.Equal(t, id, private[0].ID)
	require.Contains(t, string(private[0].Payload), "Keep the terminal request private")
	status, raw = call("GET", "/api/confirmations", "", "other-terminal-confirm-cookie", "", "")
	require.Equal(t, 200, status, string(raw))
	require.JSONEq(t, `[]`, string(raw))
	for _, fixture := range []struct{ method, path, body, cookie, bearer string }{
		{"GET", "/api/confirmations", "", "", token},
		{"POST", "/api/confirmations/" + id + "/approve", `{}`, "", token},
		{"POST", "/api/confirmations/" + id + "/approve", `{}`, "other-terminal-confirm-cookie", ""},
		{"POST", "/api/confirmations", `{"command":"todo.new","payload":{"prompt":"forged explicit create"}}`, "", token},
		{"POST", "/api/todos", `{"title":"Insert","prompt":"Insert","place":{"mode":"before","n":2}}`, "", token},
		{"POST", "/api/todos", `{"title":"After","prompt":"After","place":{"mode":"after","n":2}}`, "", token},
		{"POST", "/api/todos", `{"title":"Amend","prompt":"Amend","place":{"mode":"amend","n":2}}`, "", token},
	} {
		status, raw = call(fixture.method, fixture.path, fixture.body, fixture.cookie, fixture.bearer, "terminal-forged")
		require.Equal(t, 403, status, string(raw))
		var refusal map[string]any
		require.NoError(t, json.Unmarshal(raw, &refusal))
		require.Equal(t, "permission", refusal["class"], refusal)
		require.Equal(t, "permission", refusal["code"])
		require.Zero(t, count("mythical_items"))
		require.Equal(t, 1, count("approvals"))
		require.Zero(t, count("product_job_requests"))
	}
	approvalKey := "terminal-owner-press"
	if phase != "" {
		fmt.Printf("TERMINAL_CONFIRM_READY %s %s\n", server.URL, id)
		waitTerminalConfirmBrowser(t, phase, "approved")
		key, err := os.ReadFile(filepath.Join(phase, "approved"))
		require.NoError(t, err)
		approvalKey = string(key)
		require.NotEmpty(t, approvalKey)
		require.Equal(t, 1, count("mythical_items"))
	}
	for range 2 {
		status, raw = call("POST", "/api/confirmations/"+id+"/approve", `{}`, "replacement-cookie", "", approvalKey)
		require.Equal(t, 200, status, string(raw))
		require.Equal(t, 1, count("mythical_items"))
	}
	var prompt string
	var author int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT issue_body,owner_id FROM mythical_items`).Scan(&prompt, &author))
	require.Equal(t, "Keep the terminal request private", prompt)
	require.Equal(t, member.ID, author)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, id).Scan(&state))
	require.Equal(t, "approved", state)
	if phase == "" {
		withoutConsumer := httptest.NewUnstartedServer(nil)
		missingConfig := *cfg
		missingConfig.Server.PublicURL = "http://" + withoutConsumer.Listener.Addr().String()
		missingConfig.Server.AllowedOrigins = []string{missingConfig.Server.PublicURL}
		withoutConsumer.Config.Handler = githubAppSetupComposeRouter(&missingConfig, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: services.NewApprovalsService(q)})
		withoutConsumer.Start()
		defer withoutConsumer.Close()
		missing := func(body, key string) (int, []byte) {
			return callAt(withoutConsumer.URL, "POST", "/api/todos", body, "", token, key)
		}
		exerciseTerminalRealServiceMatrix(t, ctx, pool, member, repository, token, invoke, call, missing)
	}
	t.Log(fmt.Sprintf("initial append: one private confirmation; one TODO by member %d after two presses", member.ID))
}

func waitTerminalConfirmBrowser(t *testing.T, directory, name string) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Minute)
	defer deadline.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(filepath.Join(directory, name)); err == nil {
			return
		}
		if _, err := os.Stat(filepath.Join(directory, "done")); err == nil {
			t.Fatalf("browser ended before %s", name)
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatalf("browser did not reach %s", name)
		case <-t.Context().Done():
			t.Fatal(t.Context().Err())
		}
	}
}
