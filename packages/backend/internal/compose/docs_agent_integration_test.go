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
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// C-UI-09's agent case on the composed install (T-APP-20): a member asks the
// main conversation "How do I put HTTPS in front?" through the production
// prompt route. The packaged model host, built by apps/model-host/build.mjs
// with the app's bundled docs, offers `docs`, runs the read on the host, and
// the answer the conversation serves cites the quickstart's shipped Markdown.
// Asked to open the page, the agent embeds the Docs card at the heading, and
// the shared conversation serves it.
// Prompt authentication, admission, the dispatcher, the host, its callbacks
// and the journal are real; only the model endpoint is scripted. The
// repository candidate reader answers an empty repository: the docs come
// from the host's bundle, not the repository, and the native repository
// library the real reader needs is not on every developer machine
// (TestLocalSharedPreflight covers that reader).
func TestInstallAgentAnswersHowDoIFromBundledDocs(t *testing.T) {
	quickstart := shippedDocsPage(t, "quickstart")
	require.Contains(t, quickstart, "## Put HTTPS in front")
	require.Contains(t, quickstart, "tailscale serve --bg --https=443 http://127.0.0.1:4000")

	const (
		howDo = "How do I put HTTPS in front?"
		open  = "Open the quickstart at Put HTTPS in front."
	)
	var mu sync.Mutex
	var systems, reads []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			http.Error(w, "json", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		delta, finish := map[string]any{"content": "[]"}, "stop"
		if input.Model == "answer" {
			var system, read string
			opening := false
			for _, message := range input.Messages {
				opening = opening || message.Role == "user" && strings.Contains(string(message.Content), open)
				var text string
				if json.Unmarshal(message.Content, &text) != nil {
					continue
				}
				switch message.Role {
				case "system":
					system = text
				case "tool":
					read = text
				}
			}
			mu.Lock()
			systems = append(systems, system)
			if read != "" {
				reads = append(reads, read)
			}
			mu.Unlock()
			execute := func(args string) {
				arguments, _ := json.Marshal(map[string]string{"action": "execute", "name": "docs", "args": args})
				delta = map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "docs-call", "type": "function",
					"function": map[string]string{"name": "commands", "arguments": string(arguments)}}}}
				finish = "tool_calls"
			}
			switch {
			case read != "" && opening:
				delta = map[string]any{"content": read}
			case read != "":
				delta = map[string]any{"content": "From docs.read quickstart: " + read}
			case !strings.Contains(system, `run docs with {"mode":"read","page":"<page>"}`):
				delta = map[string]any{"content": "The instructions offer no docs."}
			case opening:
				execute("quickstart#put-https-in-front")
			default:
				execute(`{"mode":"read","page":"quickstart"}`)
			}
		}
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
	}))
	defer provider.Close()

	const session = "docs-agent-session"
	local := startConfiguredLocalChat(t, func(local *localChat, options *chat.RuntimeOptions) {
		q := db.New(local.pool)
		ctx := local.ctx
		_, err := local.pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		binding := fmt.Sprintf(`{"owner_login":"chatowner","repository_name":"chatrepo","repository_id":%d}`, local.repoID)
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-07T09:00:00Z"}`)}))
		_, err = local.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, local.repoID, local.ownerID)
		require.NoError(t, err)
		hash := sha256.Sum256([]byte(session))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		cfg := testConfigAllFlagsOn()
		cfg.Auth.Mode = "selfhost"
		cfg.Auth.SessionCookieName = "session"
		cfg.Server.PublicURL = "http://127.0.0.1:4000"
		cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
		auth := services.NewAuthService(q, cfg.Auth, nil, nil)
		auth.Members = &services.Members{Pool: local.pool}
		options.API = services.InstallAPI{Auth: auth}
		options.ContextRepository = func(context.Context, middleware.Credential, int64, int64, string) (json.RawMessage, error) {
			return json.RawMessage(`{"state":"main","candidates":[],"tokenBudget":24000}`), nil
		}
		local.api = func(runtime *chat.Runtime) http.Handler {
			branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(local.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
			runtime.Handler.ResolveBranch = conversationBranchResolver(branches)
			router := chi.NewRouter()
			mountChatPublic(router, runtime, q, cfg)
			return router
		}
	})
	defer local.stop(t)
	local.enroll(t, "DOCS_MODEL_KEY", provider.URL, "docs-model-private-key")
	q := db.New(local.pool)
	for role, model := range map[string]string{"app": "answer", "fast": "selector", "coding": "selector"} {
		value, _ := json.Marshal(map[string]string{"protocol": "openai-chat", "modelId": model, "credential": "DOCS_MODEL_KEY", "baseUrl": provider.URL})
		require.NoError(t, q.AssignInstallAgentModel(local.ctx, role, value))
	}

	origin := "http://" + local.composition.listener.Addr().String()
	call := func(method, path, body string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(local.ctx, method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "localhost:4000"
		req.Header.Set("Origin", "http://localhost:4000")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.AddCookie(&http.Cookie{Name: "session", Value: session})
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		response, err := local.client.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, raw
	}
	ask := func(prompt, key string) string {
		t.Helper()
		body, err := json.Marshal(map[string]string{"prompt": prompt, "idempotencyKey": key})
		require.NoError(t, err)
		status, raw := call(http.MethodPost, "/api/conversations/main/prompt", string(body))
		require.Equal(t, http.StatusAccepted, status, string(raw))
		var admitted struct {
			TurnID string `json:"turnId"`
		}
		require.NoError(t, json.Unmarshal(raw, &admitted))
		var state string
		require.Eventually(t, func() bool {
			err := local.pool.QueryRow(local.ctx, `SELECT state FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&state)
			return err == nil && (state == "completed" || state == "failed" || state == "uncertain")
		}, 30*time.Second, 20*time.Millisecond, local.logs.String())
		require.Equal(t, "completed", state, local.logs.String())
		return admitted.TurnID
	}
	// calls is the journal's record of the turn's host calls, in order.
	calls := func(turnID string) []string {
		t.Helper()
		rows, err := local.pool.Query(local.ctx, `SELECT f FROM chat_turn_batches b, jsonb_array_elements(b.frames) f WHERE b.turn_id=$1 AND f->>'type' IN ('call.started','call.settled','gate.rejected') ORDER BY b.batch_number`, turnID)
		require.NoError(t, err)
		defer rows.Close()
		var recorded []string
		for rows.Next() {
			var frame struct{ Type, Name, Verdict, Message string }
			require.NoError(t, rows.Scan(&frame))
			recorded = append(recorded, strings.TrimSpace(strings.Join([]string{frame.Type, frame.Name, frame.Verdict, frame.Message}, " ")))
		}
		require.NoError(t, rows.Err())
		return recorded
	}
	type servedCard struct {
		ID      string `json:"id"`
		Kind    string `json:"kind"`
		Title   string `json:"title"`
		Payload struct {
			Page     string `json:"page"`
			Markdown string `json:"markdown"`
			Anchor   string `json:"anchor"`
			NotFound string `json:"not_found"`
			Toc      []struct{ Slug, Title string }
		} `json:"payload"`
	}
	type servedEntry struct {
		prompt string
		answer string
		cards  []servedCard
	}
	// conversation is what the app renders: the shared main conversation as the member reads it.
	conversation := func() map[string]servedEntry {
		t.Helper()
		status, raw := call(http.MethodGet, "/api/conversations/main", "")
		require.Equal(t, http.StatusOK, status, string(raw))
		var served struct {
			Entries []struct {
				ID     string            `json:"id"`
				Prompt string            `json:"prompt"`
				Frames []json.RawMessage `json:"frames"`
			} `json:"entries"`
		}
		require.NoError(t, json.Unmarshal(raw, &served))
		entries := map[string]servedEntry{}
		for _, entry := range served.Entries {
			view := servedEntry{prompt: entry.Prompt}
			var answer strings.Builder
			for _, rawFrame := range entry.Frames {
				var frame struct {
					Type string     `json:"type"`
					Kind string     `json:"kind"`
					Text string     `json:"text"`
					Card servedCard `json:"card"`
				}
				require.NoError(t, json.Unmarshal(rawFrame, &frame))
				if frame.Type == "delta" && frame.Kind == "text" {
					answer.WriteString(frame.Text)
				}
				if frame.Type == "card" {
					view.cards = append(view.cards, frame.Card)
				}
			}
			view.answer = answer.String()
			entries[entry.ID] = view
		}
		return entries
	}

	asked := ask(howDo, "docs-https")
	// The host listed docs among the commands it runs and told the model to read before answering.
	mu.Lock()
	require.Len(t, systems, 2, "one leg asks, one answers from the read")
	require.Contains(t, systems[0], "- /docs — Read the docs in the app")
	require.Contains(t, systems[0], `Asked how to do something in Smithers, first run docs with {"mode":"read","page":"<page>"} for the page that covers it (pages: quickstart, flows)`)
	// The model read the quickstart exactly as the app ships it.
	require.Len(t, reads, 1)
	var page struct{ Title, Summary, Markdown string }
	require.NoError(t, json.Unmarshal([]byte(reads[0]), &page))
	mu.Unlock()
	require.Equal(t, "Quickstart", page.Title)
	require.Equal(t, quickstart, page.Markdown)
	require.Equal(t, []string{"call.started docs", "call.settled docs run"}, calls(asked))
	// The conversation the app renders serves the cited answer, and a read embeds nothing.
	served := conversation()[asked]
	require.Equal(t, howDo, served.prompt)
	require.True(t, strings.HasPrefix(served.answer, "From docs.read quickstart: "), served.answer)
	require.Contains(t, served.answer, "tailscale serve --bg --https=443 http://127.0.0.1:4000")
	require.Empty(t, served.cards)

	opened := ask(open, "docs-open")
	require.Equal(t, []string{"call.started docs", "call.settled docs run"}, calls(opened))
	shown := conversation()[opened]
	require.Equal(t, "Embedded the Quickstart docs page.", shown.answer)
	require.Len(t, shown.cards, 1, "the shared conversation serves the Docs card")
	card := shown.cards[0]
	require.Equal(t, "docs-quickstart", card.ID)
	require.Equal(t, "docs", card.Kind)
	require.Equal(t, "Quickstart", card.Title)
	require.Equal(t, "quickstart", card.Payload.Page)
	require.Equal(t, "put-https-in-front", card.Payload.Anchor)
	require.Empty(t, card.Payload.NotFound)
	require.Equal(t, quickstart, card.Payload.Markdown)
	require.Equal(t, []struct{ Slug, Title string }{{"quickstart", "Quickstart"}, {"flows", "Flows reference"}}, card.Payload.Toc)
}

// shippedDocsPage is a page's Markdown after its frontmatter, read from the
// file the app and the host both bundle.
func shippedDocsPage(t *testing.T, slug string) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	require.True(t, ok)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../../../apps/app/src/docs/pages", slug+".md"))
	require.NoError(t, err)
	parts := strings.SplitN(string(raw), "\n---\n", 2)
	require.Len(t, parts, 2, "the page opens with frontmatter")
	return strings.TrimLeft(parts[1], "\n")
}
