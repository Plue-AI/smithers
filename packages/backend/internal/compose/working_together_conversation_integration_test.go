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
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/webapp"
	"github.com/stretchr/testify/require"
)

// Model responses are scripted and GitHub credential readiness uses the roster
// fixture: no real GitHub calls occur. Admission, authentication, author
// delegation, native context reads, dispatcher, packaged host and journal are real.
type conversationRehearsal struct {
	local    *localChat
	origin   string
	slow     chan struct{}
	release  chan struct{}
	mu       sync.Mutex
	requests []string
}

func workingConversation(t *testing.T) *conversationRehearsal {
	t.Helper()
	f := &conversationRehearsal{slow: make(chan struct{}, 4), release: make(chan struct{})}
	publicListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = publicListener.Close() })
	f.origin = "http://" + publicListener.Addr().String()
	var publicAPI http.Handler
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", 400)
			return
		}
		f.mu.Lock()
		f.requests = append(f.requests, string(raw))
		f.mu.Unlock()
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.Unmarshal(raw, &body) != nil {
			http.Error(w, "json", 400)
			return
		}
		answer := "[]"
		if body.Model == "answer" {
			prompt := ""
			for _, message := range body.Messages {
				if message.Role == "user" {
					prompt = message.Content
				}
			}
			if strings.Contains(prompt, "SLOW") {
				f.slow <- struct{}{}
				select {
				case <-f.release:
				case <-r.Context().Done():
					return
				}
			}
			answer = "Host answer."
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": answer}, "finish_reason": "stop"}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
	}))
	t.Cleanup(provider.Close)
	local := startConfiguredLocalChat(t, func(local *localChat, options *chat.RuntimeOptions) {
		q, ctx := db.New(local.pool), local.ctx
		_, err := local.pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		binding, _ := json.Marshal(map[string]any{"repository_id": local.repoID, "owner_login": "chatowner", "repository_name": "chatrepo", "last_access_check_at": time.Now().UTC().Format(time.RFC3339)})
		for _, key := range []string{"github.repository", "owner.access"} {
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
		}
		for _, login := range []string{"chatowner", "ben", "alice"} {
			id := local.ownerID
			if login != "chatowner" {
				require.NoError(t, local.pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, login).Scan(&id))
			}
			permission := "admin"
			if login == "alice" {
				permission = "write"
			}
			_, err = local.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, local.repoID, id, permission)
			require.NoError(t, err)
			sum := sha256.Sum256([]byte("w17-" + login))
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: id, Username: login, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
		}
		cfg := testConfigAllFlagsOn()
		cfg.Auth.Mode = "selfhost"
		cfg.Auth.SessionCookieName = "session"
		auth := services.NewAuthService(q, cfg.Auth, nil, nil)
		auth.Members = &services.Members{Pool: local.pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
		options.API = services.InstallAPI{Auth: auth}
		reader := conversationContextSource(t, local)
		options.ContextRepository = reader.Read
		local.api = func(runtime *chat.Runtime) http.Handler {
			cfg.Server.PublicURL = f.origin
			branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(local.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
			runtime.Handler.ResolveBranch = conversationBranchResolver(branches)
			fn := reflect.ValueOf(buildRouter)
			args := make([]reflect.Value, fn.Type().NumIn())
			for i := range args {
				args[i] = reflect.Zero(fn.Type().In(i))
				for _, value := range []any{cfg, q, local.pool, &routes.AuthHandler{Service: auth, AuthConfig: cfg.Auth, PublicOrigin: f.origin}, &routes.UserHandler{TokenService: auth, ProfileService: services.NewUserService(q), SessionService: auth}} {
					v := reflect.ValueOf(value)
					if v.Type() == fn.Type().In(i) {
						args[i] = v
					}
				}
			}
			topics := &liveTopics{queries: q, members: auth.Members, viewState: runtime.Handler.Store.ReadMemberViewState}
			topics.conversation = func(ctx context.Context, member int64, branch string) (json.RawMessage, error) {
				scope := chat.Scope{RepositoryID: local.repoID, UserID: member}
				canonical, err := runtime.Handler.ResolveBranch(ctx, scope, branch)
				if err != nil {
					return nil, err
				}
				entries, err := runtime.Handler.Store.SharedEntries(ctx, scope, canonical)
				if err != nil {
					return nil, err
				}
				return json.Marshal(entries)
			}
			args[len(args)-1] = reflect.ValueOf([]any{routerExtras{Members: &routes.MembersHandler{Service: auth.Members}, Live: &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Origins: func() []string { return []string{f.origin} }, Queries: q, Topics: topics.resolver}}})
			router := fn.CallSlice(args)[0].Interface().(chi.Router)
			mountChatPublic(router, runtime, q, cfg)
			if root := os.Getenv("SMITHERS_W17_WEB_ROOT"); root != "" {
				assets, err := webapp.New(root, webapp.SelfHosted)
				require.NoError(t, err)
				t.Cleanup(func() { require.NoError(t, assets.Close()) })
				router.NotFound(assets.ServeHTTP)
			}
			publicAPI = withAppBootstrap(router, newAppBootstrap(bootstrapFeatures{role: localTopology, install: true, identity: true, agent: true}), cors.Options{})
			return publicAPI
		}
	})
	f.local = local
	public := httptest.NewUnstartedServer(publicAPI)
	public.Listener = publicListener
	public.Start()
	t.Cleanup(public.Close)
	t.Cleanup(func() { local.stop(t) })
	local.enroll(t, "W17_MODEL", provider.URL, "w17-private-key")
	for role, model := range map[string]string{"app": "answer", "fast": "selector", "coding": "selector"} {
		value, _ := json.Marshal(map[string]string{"protocol": "openai-chat", "modelId": model, "credential": "W17_MODEL", "baseUrl": provider.URL})
		require.NoError(t, db.New(local.pool).AssignInstallAgentModel(local.ctx, role, value))
	}
	return f
}

func (f *conversationRehearsal) call(t *testing.T, login, method, path, body string, status int) []byte {
	t.Helper()
	req, err := http.NewRequest(method, f.origin+path, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Origin", f.origin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", "csrf")
	req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	req.AddCookie(&http.Cookie{Name: "session", Value: "w17-" + login})
	res, err := f.local.client.Do(req)
	require.NoError(t, err)
	raw, err := io.ReadAll(res.Body)
	res.Body.Close()
	require.NoError(t, err)
	require.Equal(t, status, res.StatusCode, string(raw))
	return raw
}
func (f *conversationRehearsal) prompt(t *testing.T, login, prompt string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"prompt": prompt, "idempotencyKey": uuid.NewString()})
	var admitted struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal(f.call(t, login, "POST", "/api/conversations/main/prompt", string(body), 202), &admitted))
	return admitted.TurnID
}
func (f *conversationRehearsal) terminal(t *testing.T, id, state string, timeout time.Duration) {
	t.Helper()
	require.Eventually(t, func() bool {
		var got string
		err := f.local.pool.QueryRow(f.local.ctx, `SELECT state FROM chat_turns WHERE id=$1`, id).Scan(&got)
		return err == nil && got == state
	}, timeout, 20*time.Millisecond, f.local.logs.String())
}

func TestBranchConversationOrderedReplay(t *testing.T) {
	f := workingConversation(t)
	first := f.prompt(t, "ben", "SLOW")
	select {
	case <-f.slow:
	case <-time.After(20 * time.Second):
		t.Fatal(f.local.logs.String())
	}
	// While Ben is running Alice's accepted prompt remains private, and there
	// can be no second model execution on the branch.
	second := f.prompt(t, "alice", "Alice follow-up")
	require.NotContains(t, string(f.call(t, "ben", "GET", "/api/conversations/main", "", 200)), "Alice follow-up")
	close(f.release)
	f.terminal(t, first, "completed", 20*time.Second)
	f.terminal(t, second, "completed", 20*time.Second)
	ben := f.call(t, "ben", "GET", "/api/conversations/main", "", 200)
	alice := f.call(t, "alice", "GET", "/api/conversations/main", "", 200)
	require.JSONEq(t, string(ben), string(alice))
	var shared chat.SharedConversation
	require.NoError(t, json.Unmarshal(ben, &shared))
	require.Len(t, shared.Entries, 2)
	require.Equal(t, []string{first, second}, []string{shared.Entries[0].ID, shared.Entries[1].ID})
	for _, entry := range shared.Entries {
		require.Equal(t, chat.State("completed"), entry.State)
		require.NotEmpty(t, entry.Frames)
	}
	f.call(t, "ben", "PATCH", "/api/conversations/main/turns/"+first, `{"prompt":"rewrite"}`, 409)
	f.call(t, "ben", "DELETE", "/api/conversations/main/turns/"+first, "", 409)
}

func TestHostTurnAuthorRevocation(t *testing.T) {
	f := workingConversation(t)
	running := f.prompt(t, "alice", "SLOW")
	select {
	case <-f.slow:
	case <-time.After(20 * time.Second):
		t.Fatal(f.local.logs.String())
	}
	queued := f.prompt(t, "alice", "must never start")
	next := f.prompt(t, "ben", "Ben next")
	started := time.Now()
	f.call(t, "chatowner", "DELETE", "/api/members/alice", "", 204)
	f.terminal(t, running, "cancelled", 5*time.Second-time.Since(started))
	f.terminal(t, queued, "cancelled", 5*time.Second-time.Since(started))
	require.Less(t, time.Since(started), 5*time.Second)
	f.terminal(t, next, "completed", 20*time.Second)
	var generations int
	require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT producer_generation FROM chat_turns WHERE id=$1`, queued).Scan(&generations))
	require.Zero(t, generations)
	var credentials int
	require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, "app-turn-"+running+"/1").Scan(&credentials))
	require.Zero(t, credentials)
	f.call(t, "alice", "POST", "/api/conversations/main/prompt", `{"prompt":"revoked","idempotencyKey":"revoked"}`, 401)
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, raw := range f.requests {
		require.NotContains(t, raw, "must never start")
	}
	close(f.release)
}

func TestHostTurnPrivateContext(t *testing.T) {
	f := workingConversation(t)
	// Drafts are browser state; maliciously carrying one over prompt admission
	// must refuse rather than silently feeding it to the host model.
	f.call(t, "alice", "POST", "/api/conversations/main/prompt", `{"prompt":"hello","idempotencyKey":"draft","draft":"canary-7Q4"}`, 400)
	f.call(t, "alice", "PUT", "/api/conversations/main/view-state", `{"card_view":{"private":"canary-7Q4"}}`, 200)
	_, err := f.local.pool.Exec(f.local.ctx, `INSERT INTO approvals(id,repository_id,state,kind,title,member_id,credential_id,command,subject,revision,payload,expires_at) SELECT $1,$2,'pending','one_click','confirm-canary',$3,'fixture','todo.drop','{"kind":"todo","ref":"T1"}','revision-1','{"private":"confirm-canary"}',now()+interval '1 hour'`, uuid.NewString(), f.local.repoID, f.local.ownerID)
	require.NoError(t, err)
	turn := f.prompt(t, "ben", "Say hello")
	f.terminal(t, turn, "completed", 20*time.Second)
	f.mu.Lock()
	defer f.mu.Unlock()
	require.GreaterOrEqual(t, len(f.requests), 2)
	for _, raw := range f.requests {
		require.NotContains(t, raw, "canary-7Q4")
		require.NotContains(t, raw, "confirm-canary")
		require.NotContains(t, raw, "w17-private-key")
	}
}

// Use the production native repository reader without launching a CLI harness
// or adding the unrelated preflight benchmark's 500-file workload.
func conversationContextSource(t *testing.T, local *localChat) services.InstallContext {
	t.Helper()
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, library, "native repository library required")
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "w17-source", FFILibraryPath: library}
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	path := cfg.RepoPath("chatowner", "chatrepo")
	_, err := native.InitRepo(path)
	require.NoError(t, err)
	changes, err := native.ListChanges(path, 1, 10)
	require.NoError(t, err)
	require.NotEmpty(t, changes.Items)
	_, err = native.CreateBookmark(path, "main", changes.Items[0].CommitID)
	require.NoError(t, err)
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: httpServer.URL}, cfg.AuthToken)
	q := db.New(local.pool)
	for key, value := range map[string]string{"setup.source.repository": `"chatowner/chatrepo"`, "setup.step.source": `{"status":"done"}`} {
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://127.0.0.1:9", SigningKey: []byte(strings.Repeat("c", 32))})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	wiki := services.NewWikiService(q, nil, services.WithWikiContent(content))
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(local.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	return services.InstallContext{Source: services.InstallSource{Pool: local.pool, Repos: services.NewRepoService(q, client, ""), Members: identity.NewMemberBoundary(q)}, Wiki: wiki, Branches: branches}
}

func TestBranchConversationCutover(t *testing.T) {
	f := workingConversation(t)
	var before int
	require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM chat_turns`).Scan(&before))
	for _, path := range []string{"/api/agent/turn", "/api/agent/turn/cancel", "/api/agent/turn/retire", "/api/chat/turn", "/api/chat/cancel", "/api/app-timelines"} {
		f.call(t, "ben", "POST", path, `{"runId":"legacy","prompt":"must not start"}`, 404)
	}
	for _, method := range []string{"GET", "PUT", "PATCH", "DELETE"} {
		f.call(t, "ben", method, "/api/app-timelines/retired", "", 404)
	}
	var after int
	require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM chat_turns`).Scan(&after))
	require.Equal(t, before, after)
	f.call(t, "ben", "GET", "/api/agent/conversations", "", 200)
	var table *string
	require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT to_regclass('app_timelines')::text`).Scan(&table))
	require.Nil(t, table)
	f.mu.Lock()
	defer f.mu.Unlock()
	require.Empty(t, f.requests)
}

// Runs Chromium against the production app served by the composed router. The
// marker comes from the browser only after its author's page has closed.
func TestBranchConversationTabClose(t *testing.T) {
	if os.Getenv("SMITHERS_W17_BROWSER_PROOF") != "1" {
		t.Skip("set SMITHERS_W17_BROWSER_PROOF=1 after building the app")
	}
	f := workingConversation(t)
	_, source, _, _ := runtime.Caller(0)
	app := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app"))
	command := exec.CommandContext(t.Context(), "pnpm", "exec", "playwright", "test", "--config", "e2e/real/working-together.config.ts", "branch-conversations.spec.ts", "--workers", "1")
	command.Dir = app
	command.Env = append(os.Environ(), "SMITHERS_W17_URL="+f.origin)
	output := &tabCloseOutput{release: f.release}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	require.NoError(t, err, output.String())
	var completed int
	require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM chat_turns WHERE state='completed'`).Scan(&completed))
	require.Equal(t, 1, completed)
	t.Log(output.String())
}

type tabCloseOutput struct {
	mu      sync.Mutex
	body    strings.Builder
	release chan struct{}
	once    sync.Once
}

func (o *tabCloseOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.body.Write(p)
	if strings.Contains(o.body.String(), "W17_AUTHOR_TAB_CLOSED") {
		o.once.Do(func() { close(o.release) })
	}
	return len(p), nil
}
func (o *tabCloseOutput) String() string { o.mu.Lock(); defer o.mu.Unlock(); return o.body.String() }
