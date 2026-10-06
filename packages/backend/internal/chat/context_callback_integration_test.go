package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

// Repository reads are the only fixture here: the callback must derive the
// author, prompt and shared history from real admission and PostgreSQL. The
// source adapter's snapshot confinement is a separate integration boundary.
var contextSession = func() middleware.Credential {
	sum := sha256.Sum256([]byte("context-session-credential"))
	return middleware.Credential{SessionHash: hex.EncodeToString(sum[:])}
}()

const repositoryContext = `{"state":"ready","candidates":[{"item":{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123"},"text":"export const retries = 3"}],"tokenBudget":24000}`

type contextFixture struct {
	handler *Handler
	scope   Scope
	server  *httptest.Server
}

func newContextFixture(t *testing.T) contextFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	uid, err := seed.CreateUser(ctx, pool, "context-ben")
	require.NoError(t, err)
	q := db.New(pool)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: uid, Valid: true}, Name: "context", LowerName: "context", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, uid)
	require.NoError(t, err)
	setting, _ := json.Marshal(map[string]any{"owner_login": "context-ben", "repository_name": "context", "repository_id": repo.ID})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: setting}))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: uid, Username: "context-ben", SessionKey: contextSession.SessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	store, err := NewStore(pool)
	require.NoError(t, err)
	scope := Scope{UserID: uid, RepositoryID: repo.ID, Owner: "context-ben"}
	handler := &Handler{Store: store, credentials: newTurnCredentials(), ResolveBranch: func(_ context.Context, s Scope, branch string) (string, error) {
		if s.UserID != uid || s.RepositoryID != repo.ID || branch != "main" {
			return "", ErrForbidden
		}
		return branch, nil
	}, ContextRepository: func(_ context.Context, credential middleware.Credential, userID, repoID int64, branch string) (json.RawMessage, error) {
		if credential != contextSession || userID != uid || repoID != repo.ID || branch != "main" {
			return nil, ErrForbidden
		}
		return json.RawMessage(repositoryContext), nil
	}}
	router := chi.NewRouter()
	router.Group(func(public chi.Router) {
		public.Use(middleware.AuthLoader(q, config.AuthConfig{SessionCookieName: "context_session"}))
		public.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Repository: &repo}, middleware.PermissionWrite)
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
		handler.MountPublic(public)
	})
	handler.MountProducerCallbacks(router)
	server := httptest.NewServer(router)
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	origin, err := url.Parse(server.URL)
	require.NoError(t, err)
	jar.SetCookies(origin, []*http.Cookie{{Name: "context_session", Value: "context-session-credential"}})
	server.Client().Jar = jar
	t.Cleanup(server.Close)
	return contextFixture{handler, scope, server}
}

func (f contextFixture) admit(t *testing.T, run, prompt string, shared, claim, complete bool) ProducerGrant {
	t.Helper()
	journal := testJournal()
	request, err := json.Marshal(map[string]any{"runId": run, "conversationId": "main", "sharedConversation": shared, "instructions": "Answer", "messages": []map[string]string{{"role": "user", "content": prompt}}})
	require.NoError(t, err)
	accepted, err := f.handler.Store.Admit(t.Context(), AdmitInput{Scope: f.scope, RunID: run, Journal: journal, Request: request})
	require.NoError(t, err)
	f.handler.credentials.admit(turnKey{userID: f.scope.UserID, runID: run, legID: journal.LegID}, contextSession)
	if !claim {
		return ProducerGrant{TurnID: accepted.TurnID, RunID: run}
	}
	grant, err := f.handler.Store.Claim(t.Context(), f.scope, accepted.TurnID, time.Minute)
	require.NoError(t, err)
	if complete {
		_, err = f.handler.Store.Commit(t.Context(), CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame(run, "Answer "), frame(run, prompt), done(run, "stop")}})
		require.NoError(t, err)
	}
	return grant
}

func (f contextFixture) context(t *testing.T, grant ProducerGrant, extra map[string]any) (int, string) {
	t.Helper()
	input := map[string]any{"turnId": grant.TurnID, "generation": grant.Generation}
	for k, v := range extra {
		input[k] = v
	}
	body, err := json.Marshal(input)
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPost, f.server.URL+ContextPath, strings.NewReader(string(body)))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := f.server.Client().Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	if response.StatusCode != http.StatusOK {
		return response.StatusCode, string(raw)
	}
	require.Equal(t, "application/x-ndjson", response.Header.Get("Content-Type"))
	require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	var header struct {
		Type    string
		Version int
		Value   map[string]any
	}
	require.NoError(t, decoder.Decode(&header))
	require.Equal(t, "input", header.Type)
	require.Equal(t, 1, header.Version)
	recent, candidates := []any{}, []any{}
	for {
		var record struct {
			Type               string
			Value              any
			Recent, Candidates int
		}
		require.NoError(t, decoder.Decode(&record))
		if record.Type == "end" {
			require.Equal(t, len(recent), record.Recent)
			require.Equal(t, len(candidates), record.Candidates)
			require.ErrorIs(t, decoder.Decode(&record), io.EOF)
			break
		}
		switch record.Type {
		case "recent":
			recent = append(recent, record.Value)
		case "candidate":
			candidates = append(candidates, record.Value)
		default:
			t.Fatalf("unexpected context record %q", record.Type)
		}
	}
	header.Value["recent"], header.Value["candidates"] = recent, candidates
	raw, err = json.Marshal(header.Value)
	require.NoError(t, err)
	return response.StatusCode, string(raw)
}

func TestContextCallbackReadsOnlyAdmittedSharedHistory(t *testing.T) {
	f := newContextFixture(t)
	for i := 0; i < 5; i++ {
		f.admit(t, fmt.Sprintf("earlier-%d", i), fmt.Sprintf("Prompt %d", i), true, true, true)
	}
	f.admit(t, "private", "canary-private", false, true, true)
	current := f.admit(t, "current", "Where do we retry?", true, true, false)
	f.admit(t, "later", "canary-queued", true, false, false)
	status, body := f.context(t, current, nil)
	require.Equal(t, 200, status, body)
	require.JSONEq(t, `{"prompt":"Where do we retry?","author":"context-ben","branch":"main","state":"ready","recent":[{"title":"Prompt 0","text":""},{"title":"Prompt 1","text":""},{"title":"Prompt 2","text":"Prompt 2\nAnswer Prompt 2"},{"title":"Prompt 3","text":"Prompt 3\nAnswer Prompt 3"},{"title":"Prompt 4","text":"Prompt 4\nAnswer Prompt 4"}],"candidates":[{"item":{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123"},"text":"export const retries = 3"}],"tokenBudget":24000,"wikiOnly":false}`, body)
	for _, key := range []string{"prompt", "author", "branch", "recent", "candidates", "tokenBudget"} {
		status, body = f.context(t, current, map[string]any{key: "forged"})
		require.Equal(t, 400, status, body)
	}
	for _, bad := range []ProducerGrant{{TurnID: current.TurnID, Generation: current.Generation, Token: "wrong"}, {TurnID: current.TurnID, Generation: current.Generation + 1, Token: current.Token}, {TurnID: current.TurnID, Generation: current.Generation}} {
		status, body = f.context(t, bad, nil)
		require.Equal(t, 401, status, body)
	}
}

func TestContextCallbackRefusesUnavailableOrRevokedInputs(t *testing.T) {
	for _, mode := range []string{"missing-provider", "missing-branch", "wrong-branch", "private-turn", "missing-credential", "revoked-before", "provider-error", "invalid-repository", "oversized-repository", "oversized-response", "oversized-candidate", "oversized-entry", "null-candidates", "cancel-during-read", "suspend-during-read", "revoke-during-read", "branch-revoked-during-read"} {
		t.Run(mode, func(t *testing.T) {
			f := newContextFixture(t)
			if mode == "oversized-entry" {
				history := f.admit(t, "large-history", "Large answer", true, true, false)
				for i := 0; i < 40; i++ {
					frames := []json.RawMessage{frame(history.RunID, strings.Repeat("h", 60000))}
					if i == 39 {
						frames = append(frames, done(history.RunID, "stop"))
					}
					ack, err := f.handler.Store.Commit(t.Context(), CommitInput{TurnID: history.TurnID, Generation: history.Generation, Token: history.Token, Expected: history.Cursor, Frames: frames})
					require.NoError(t, err)
					history.Cursor = ack.Cursor
				}
			}
			current := f.admit(t, "current", "Where do we retry?", mode != "private-turn", true, false)
			want := 503
			switch mode {
			case "missing-provider":
				f.handler.ContextRepository = nil
			case "missing-branch":
				f.handler.ResolveBranch = nil
			case "wrong-branch":
				f.handler.ResolveBranch = func(context.Context, Scope, string) (string, error) { return "other", nil }
				want = 403
			case "private-turn":
				want = 403
			case "missing-credential":
				f.handler.credentials = newTurnCredentials()
				want = 403
			case "revoked-before":
				_, err := f.handler.Store.pool.Exec(t.Context(), `DELETE FROM auth_sessions WHERE session_key=$1`, contextSession.SessionHash)
				require.NoError(t, err)
				want = 403
			default:
				f.handler.ContextRepository = func(ctx context.Context, _ middleware.Credential, _, _ int64, _ string) (json.RawMessage, error) {
					switch mode {
					case "provider-error":
						return nil, errors.New("private provider diagnostic")
					case "invalid-repository":
						return json.RawMessage(`{"state":"ready","candidates":[]}`), nil
					case "oversized-repository":
						return json.RawMessage(strings.Repeat(" ", maxPayloadBytes+1)), nil
					case "null-candidates":
						return json.RawMessage(`{"state":"ready","candidates":null,"tokenBudget":24000}`), nil
					case "oversized-candidate":
						raw, err := json.Marshal(map[string]any{"state": "ready", "candidates": []any{map[string]any{"item": map[string]string{"kind": "file", "label": "big", "ref": "big", "revision": "abc123"}, "text": strings.Repeat("x", maxPayloadBytes)}}, "tokenBudget": 24000})
						return raw, err
					case "oversized-response":
						raw, err := json.Marshal(map[string]any{"state": strings.Repeat("a", maxPayloadBytes-70), "candidates": []any{}, "tokenBudget": 24000})
						return raw, err
					case "cancel-during-read":
						_, err := f.handler.Store.Cancel(ctx, f.scope, current.RunID)
						return json.RawMessage(repositoryContext), err
					case "suspend-during-read":
						_, err := f.handler.Store.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, f.scope.UserID)
						return json.RawMessage(repositoryContext), err
					case "revoke-during-read":
						_, err := f.handler.Store.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE session_key=$1`, contextSession.SessionHash)
						return json.RawMessage(repositoryContext), err
					case "branch-revoked-during-read":
						f.handler.ResolveBranch = func(context.Context, Scope, string) (string, error) { return "", ErrForbidden }
					}
					return json.RawMessage(repositoryContext), nil
				}
				if mode == "cancel-during-read" || mode == "suspend-during-read" {
					want = 401
				}
				if mode == "revoke-during-read" || mode == "branch-revoked-during-read" {
					want = 403
				}
			}
			status, body := f.context(t, current, nil)
			require.Equal(t, want, status, body)
			require.NotContains(t, body, "retries")
			require.NotContains(t, body, "private provider diagnostic")
		})
	}
}

// This crosses Go HTTP admission, the production TypeScript environment
// resolver/recall/answer runner, and durable PostgreSQL writes. Only repository
// candidates and the provider endpoint are fixtures; no literal preflight is
// injected into the resolver. It does not qualify the still-unwired source and
// owner-fast-model adapters or the browser's Context/Inspect actions.
func TestSharedPromptThroughPackagedHostSelectsAndPersistsContext(t *testing.T) {
	f := newContextFixture(t)
	for i := 0; i < 500; i++ {
		f.admit(t, fmt.Sprintf("history-%03d", i), fmt.Sprintf("shared-%03d", i), true, true, true)
	}
	f.admit(t, "private-own", "canary-B", false, true, true)
	f.admit(t, "private-legacy-c", "canary-C", false, true, true)
	f.admit(t, "private-newest", "canary-D src/webhooks/retry.ts", false, true, true)
	requests := make(chan string, 3)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read failed", 500)
			return
		}
		requests <- string(raw)
		answer := "Retries three times"
		if strings.Contains(string(raw), "Choose relevant context") {
			answer = `[{"index":0,"reason":"Retry implementation"}]`
		}
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": answer}, "finish_reason": nil}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", chunk)
	}))
	defer model.Close()
	fixture := startFixtureHost(t, f.server.URL, model.URL)
	defer fixture.stop()
	host, err := NewHTTPChatHost(fixture.origin, nil, "deterministic-host-token")
	require.NoError(t, err)
	entered, release := make(chan struct{}), make(chan struct{})
	provider := f.handler.ContextRepository
	f.handler.ContextRepository = func(ctx context.Context, credential middleware.Credential, userID, repoID int64, branch string) (json.RawMessage, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return provider(ctx, credential, userID, repoID, branch)
	}
	runtime, err := NewRuntime(f.handler.Store.pool, host, f.server.URL, RuntimeOptions{QueueSize: 8, Concurrency: 1, Lease: time.Minute, ContextRepository: f.handler.ContextRepository})
	require.NoError(t, err)
	runtime.Handler.ResolveBranch = f.handler.ResolveBranch
	*f.handler = *runtime.Handler
	ctx, stop := context.WithCancel(t.Context())
	finished := make(chan struct{})
	go func() { defer close(finished); _ = runtime.Run(ctx) }()
	defer func() {
		stop()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("dispatcher failed to stop")
		}
	}()
	anonymous := postJSON(t, http.DefaultClient, f.server.URL+"/api/conversations/main/prompt", []byte(`{"prompt":"not admitted","idempotencyKey":"anonymous"}`))
	require.Equal(t, 403, anonymous.StatusCode)
	anonymous.Body.Close()
	var admittedCount int
	require.NoError(t, f.handler.Store.pool.QueryRow(t.Context(), `SELECT count(*) FROM chat_turns WHERE run_id LIKE 'prompt-%'`).Scan(&admittedCount))
	require.Zero(t, admittedCount)
	require.Empty(t, requests)
	response := postJSON(t, f.server.Client(), f.server.URL+"/api/conversations/main/prompt", []byte(`{"prompt":"Where do we retry webhooks?","idempotencyKey":"context-prompt"}`))
	var admitted struct {
		TurnID string `json:"turnId"`
		RunID  string `json:"runId"`
	}
	require.Equal(t, 202, response.StatusCode)
	require.NoError(t, json.NewDecoder(response.Body).Decode(&admitted))
	response.Body.Close() // Dispatch must survive the browser's disconnect.
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("context callback never started")
	}
	require.Empty(t, requests, "model called before context was available")
	var terminal bool
	require.NoError(t, f.handler.Store.pool.QueryRow(t.Context(), `SELECT terminal FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&terminal))
	require.False(t, terminal)
	close(release)
	var calls []string
	for range 2 {
		select {
		case call := <-requests:
			calls = append(calls, call)
		case <-time.After(15 * time.Second):
			t.Fatal("missing model call")
		}
	}
	for _, call := range calls {
		for _, secret := range []string{"canary-B", "canary-C", "canary-D", "fixture-secret-do-not-persist"} {
			require.NotContains(t, call, secret)
		}
	}
	require.Contains(t, calls[0], "Choose relevant context")
	require.Contains(t, calls[0], "shared-000")
	require.Contains(t, calls[0], "src/webhooks/retry.ts")
	for i := 0; i < 497; i++ {
		require.NotContains(t, calls[1], fmt.Sprintf("shared-%03d", i))
	}
	for i := 497; i < 500; i++ {
		require.Contains(t, calls[1], fmt.Sprintf("shared-%03d", i))
	}
	require.Contains(t, calls[1], "export const retries = 3")
	require.Contains(t, calls[1], "Where do we retry webhooks?")
	require.Eventually(t, func() bool {
		err := f.handler.Store.pool.QueryRow(t.Context(), `SELECT terminal FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&terminal)
		return err == nil && terminal
	}, 10*time.Second, 20*time.Millisecond)
	stop()
	<-finished
	for range 2 { // Reload reads the stored selection without another model call.
		shared, err := f.handler.Store.SharedEntries(t.Context(), f.scope, "main")
		require.NoError(t, err)
		require.Len(t, shared.Entries, 501)
		answer := shared.Entries[len(shared.Entries)-1]
		require.Equal(t, admitted.RunID, answer.RunID)
		require.NotNil(t, answer.Context)
		require.Len(t, *answer.Context, 1)
		require.JSONEq(t, `{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123","reason":"Retry implementation"}`, string((*answer.Context)[0]))
		wire, err := json.Marshal(answer.Frames)
		require.NoError(t, err)
		require.Contains(t, string(wire), "Retries three times")
	}
	require.Empty(t, requests)
}
