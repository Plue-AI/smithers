package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/stretchr/testify/require"
)

func TestConversationTimelineInstallBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_CONVERSATION_TIMELINE_BROWSER") != "1" {
		t.Skip("set SMITHERS_CONVERSATION_TIMELINE_BROWSER=1; build apps/app first")
	}
	_, source, _, _ := runtime.Caller(0)
	app := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app"))
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", filepath.Join(app, "dist"))
	require.FileExists(t, filepath.Join(app, "dist/index.html"))
	r := newRehearsal(t, "SMITHERS_CONVERSATION_TIMELINE_BROWSER", "C-UI-04", "timeline-")
	require.True(t, r.install("Install ready"))
	alice, err := r.member("alice", 81, "write")
	require.NoError(t, err)
	todos := map[string]int64{}
	for _, item := range []struct{ key, title, prompt, state string }{
		{"ready", "Ready entry", "[PR] [FILE ready.md] Add a greeting to ready.md", "in_review"},
		{"ask", "Question entry", "[ASK] [FILE ask.md] Add a greeting to ask.md", "needs_you"},
		{"live", "Live entry", "[HOLD timeline] [FILE live.md] Add a greeting to live.md", "working"},
	} {
		n, err := r.file(item.title, item.prompt)
		require.NoError(t, err)
		_, err = r.waitTodoWithin(n, 3*time.Minute, item.state)
		require.NoError(t, err)
		todos[item.key] = n
		if item.key == "ask" {
			// Retain an earlier failed item as initial PostgreSQL data. This
			// qualifies the UI's failure path independently of the coding
			// flow's automatic repair loop; publication still runs through a
			// person's production Move command, never a mocked projection.
			todos["fail"] = seedConversationFailure(t, r, "alice", "Failure entry")
			_, err = r.expectAs(r.jar, "POST", fmt.Sprintf("/api/todos/%d", todos["fail"]), `{"op":"move","direction":"up"}`, 202)
			require.NoError(t, err)
		}
	}
	runConversationTimelineBrowser(t, r, alice, todos, "^shared TODO entries")
	require.NoError(t, r.release("timeline"))
}

// Attention and live entries can be exercised without a guest file mutation.
// Keep this independent of the Ready journey, which needs an authenticated
// coding machine to create its candidate. Both subjects still enter via the
// install's TODO command and publish through the production conversation seam.
func TestConversationAttentionInstallBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_CONVERSATION_ATTENTION_BROWSER") != "1" {
		t.Skip("set SMITHERS_CONVERSATION_ATTENTION_BROWSER=1; build apps/app first")
	}
	_, source, _, _ := runtime.Caller(0)
	app := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app"))
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", filepath.Join(app, "dist"))
	require.FileExists(t, filepath.Join(app, "dist/index.html"))
	r := newRehearsal(t, "SMITHERS_CONVERSATION_ATTENTION_BROWSER", "C-UI-04", "attention-")
	t.Cleanup(func() { require.NoError(t, r.release("attention-live")) })
	require.True(t, r.install("Install ready"))
	alice, err := r.member("alice", 81, "write")
	require.NoError(t, err)
	todos := map[string]int64{}
	for _, item := range []struct{ key, title, prompt, state string }{
		{"ask", "Question entry", "[ASK] [HOLD attention-answer] Ask which greeting to use", "needs_you"},
		{"live", "Live entry", "[HOLD attention-live] Add a greeting", "working"},
	} {
		n, err := r.file(item.title, item.prompt)
		require.NoError(t, err)
		_, err = r.waitTodoWithin(n, 3*time.Minute, item.state)
		require.NoError(t, err)
		todos[item.key] = n
	}
	// Persist historical failures as initial database state. The browser's
	// authenticated Move commands publish their entries; no coding provider
	// or synthetic live frame participates in the read and toast proof.
	todos["aliceFail"] = seedConversationFailure(t, r, "alice", "Alice failure")
	todos["mayaFail"] = seedConversationFailure(t, r, "rehearsal-owner", "Maya failure")
	runConversationTimelineBrowser(t, r, alice, todos, "shared attention and live entries")
}

func seedConversationFailure(t *testing.T, r *rehearsal, login, title string) int64 {
	t.Helper()
	q := db.New(r.pool)
	repository, err := q.InstallRepositoryID(r.ctx)
	require.NoError(t, err)
	person, err := q.GetUserByLowerUsername(r.ctx, login)
	require.NoError(t, err)
	// Match the production revision's actor wire shape. A string author makes
	// the shared card frame invalid and rejects the entire conversation read.
	revisions, err := json.Marshal([]any{map[string]any{
		"rev": 1, "text": "Checks failed", "acceptance": []any{}, "at": "2026-10-08T00:00:00Z",
		"by": map[string]any{"kind": "person", "login": person.Username, "name": person.DisplayName, "avatar_url": "https://example.test/avatar.png", "color_index": 0},
	}})
	require.NoError(t, err)
	var number int64
	err = pgx.BeginFunc(r.ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		row, err := q.InsertMythicalTodo(r.ctx, repository, person.ID, title, "Checks failed", revisions, json.RawMessage(`{"todo":true}`))
		if err != nil {
			return err
		}
		row.State = "blocked"
		row, err = q.SaveMythicalItem(r.ctx, row)
		if err == nil {
			number = row.Number.Int64
		}
		return err
	})
	require.NoError(t, err)
	return number
}

func runConversationTimelineBrowser(t *testing.T, r *rehearsal, alice http.CookieJar, todos map[string]int64, grep string) {
	t.Helper()
	_, source, _, _ := runtime.Caller(0)
	app := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app"))
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	cookies := func(jar http.CookieJar) []map[string]string {
		result := []map[string]string{}
		for _, c := range jar.Cookies(origin) {
			result = append(result, map[string]string{"name": c.Name, "value": c.Value})
		}
		return result
	}
	descriptor, err := json.Marshal(map[string]any{"origin": r.origin, "repository": "rehearsal-owner/app", "members": map[string]any{"Maya": cookies(r.jar), "Alice": cookies(alice)}, "todos": todos})
	require.NoError(t, err)
	host := filepath.Join(t.TempDir(), "timeline-install.json")
	require.NoError(t, os.WriteFile(host, descriptor, 0600))
	command := exec.CommandContext(t.Context(), "pnpm", "exec", "playwright", "test", "--config", "e2e/real/working-together.config.ts", "timeline.spec.ts")
	command.Dir = app
	if grep != "" {
		command.Args = append(command.Args, "--grep", grep)
	}
	command.Env = append(os.Environ(), "SMITHERS_W17_URL="+r.origin, "SMITHERS_TIMELINE_INSTALL="+host)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	t.Log(string(output))
}

// A TODO entered through the composed install's command door, not a projector
// fixture. Both members read the same source transaction on HTTP and /api/live.
func TestConversationEntriesInstall(t *testing.T) {
	if os.Getenv("SMITHERS_CONVERSATION_ENTRIES_BROWSER") == "1" {
		_, source, _, _ := runtime.Caller(0)
		spa := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app/dist"))
		require.FileExists(t, filepath.Join(spa, "index.html"))
		t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	}
	r := newRehearsal(t, "SMITHERS_CONVERSATION_ENTRIES", "C-UI-04", "entries-")
	require.True(t, r.install("Install ready"))
	alice, err := r.member("alice", 81, "write")
	require.NoError(t, err)
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	var sockets []*websocket.Conn
	for _, jar := range []http.CookieJar{r.jar, alice} {
		cookies := []string{}
		for _, cookie := range jar.Cookies(origin) {
			cookies = append(cookies, cookie.Name+"="+cookie.Value)
		}
		socket, _, err := websocket.Dial(r.ctx, "ws"+strings.TrimPrefix(r.origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {strings.Join(cookies, "; ")}, "Origin": {r.origin}}})
		require.NoError(t, err)
		t.Cleanup(func() { socket.CloseNow() })
		require.NoError(t, socket.Write(r.ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"conversation:main"}`)))
		readCtx, cancel := context.WithTimeout(r.ctx, 10*time.Second)
		_, raw, err := socket.Read(readCtx)
		cancel()
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, "snap", frame.T)
		sockets = append(sockets, socket)
	}
	_, err = r.pool.Exec(r.ctx, `CREATE FUNCTION delay_first_working_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.entry_subject->>'state'='starting' AND NEW.entry_subject->>'state'='working' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$; CREATE TRIGGER delay_first_working_entry BEFORE UPDATE ON chat_turns FOR EACH ROW EXECUTE FUNCTION delay_first_working_entry()`)
	require.NoError(t, err)
	n, err := r.file("Shared entry", "[HOLD entries] Add a greeting to entries.md")
	require.NoError(t, err)
	read := func(jar http.CookieJar) chat.SharedConversation {
		raw, err := r.expectAs(jar, "GET", "/api/conversations/main", "", 200)
		require.NoError(t, err)
		var result chat.SharedConversation
		require.NoError(t, json.Unmarshal(raw, &result))
		return result
	}
	require.Eventually(t, func() bool {
		for _, entry := range read(r.jar).Entries {
			if entry.Subject != nil && entry.Subject.Number == n && entry.Subject.State == "starting" {
				return true
			}
		}
		return false
	}, 40*time.Second, 100*time.Millisecond)

	ownerHistory, aliceHistory := read(r.jar), read(alice)
	ownerBytes, err := json.Marshal(ownerHistory)
	require.NoError(t, err)
	aliceBytes, err := json.Marshal(aliceHistory)
	require.NoError(t, err)
	require.Equal(t, ownerBytes, aliceBytes)
	states := map[string]string{}
	for _, entry := range ownerHistory.Entries {
		if entry.Subject != nil && entry.Subject.Number == n {
			require.Equal(t, "Shared entry", entry.Title)
			require.Equal(t, entry.Title, entry.Subject.Title)
			require.Equal(t, entry.Tone, entry.Subject.Tone)
			states[entry.Subject.State] = entry.Subject.Tone
			require.NotEmpty(t, entry.EntrySequences)
		}
	}
	require.Equal(t, "live", states["starting"])
	// Each subscriber must reach the same literal committed Starting fact, even
	// if a fast source advances to Working between transport refreshes.
	for _, socket := range sockets {
		readCtx, cancel := context.WithTimeout(r.ctx, 20*time.Second)
		found := false
		for !found {
			_, raw, err := socket.Read(readCtx)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			var history chat.SharedConversation
			require.NoError(t, json.Unmarshal(frame.Data, &history))
			for _, entry := range history.Entries {
				if entry.Subject != nil && entry.Subject.Number == n && entry.Subject.State == "starting" {
					require.Equal(t, "live", entry.Tone)
					require.Equal(t, "Shared entry", entry.Title)
					found = true
				}
			}
		}
		cancel()
	}
	_, err = r.waitTodo(n, "working")
	require.NoError(t, err)
	working := read(r.jar)
	require.Len(t, working.Entries, 1)
	require.Equal(t, ownerHistory.Entries[0].ID, working.Entries[0].ID)
	require.Equal(t, ownerHistory.Entries[0].Sequence, working.Entries[0].Sequence)
	require.Equal(t, "working", working.Entries[0].Subject.State)
	require.Equal(t, "live", working.Entries[0].Tone)
	_, err = r.pool.Exec(r.ctx, `DROP TRIGGER delay_first_working_entry ON chat_turns; DROP FUNCTION delay_first_working_entry()`)
	require.NoError(t, err)
	// Failure after source/event creation must roll back the source, journal and
	// publication together. No uncommitted title reaches either reader.
	_, err = r.pool.Exec(r.ctx, `CREATE FUNCTION refuse_subject_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_payload->'subject'->>'title'='Rollback entry' THEN RAISE EXCEPTION 'entry fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_subject_entry BEFORE INSERT ON chat_turns FOR EACH ROW EXECUTE FUNCTION refuse_subject_entry()`)
	require.NoError(t, err)
	code, _, err := r.keyed("POST", "/api/todos", `{"title":"Rollback entry","prompt":"Never publish","place":{"mode":"append"}}`, "entries-rollback")
	require.NoError(t, err)
	require.GreaterOrEqual(t, code, 400)
	var count int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE title='Rollback entry'`).Scan(&count))
	require.Zero(t, count)
	for _, jar := range []http.CookieJar{r.jar, alice} {
		raw, _ := json.Marshal(read(jar))
		require.NotContains(t, string(raw), "Rollback entry")
	}
	_, err = r.pool.Exec(r.ctx, `DROP TRIGGER refuse_subject_entry ON chat_turns; DROP FUNCTION refuse_subject_entry()`)
	require.NoError(t, err)
	// The caller cannot select a different member's private view state.
	_, err = r.expectAs(alice, "PUT", "/api/conversations/main/view-state", `{"toasts_hidden":true,"member_id":1}`, 200)
	require.NoError(t, err)
	own, err := r.expect("GET", "/api/conversations/main/view-state", "", 200)
	require.NoError(t, err)
	require.NotContains(t, string(own), `"toasts_hidden":true`)
	_, err = r.expectAs(alice, "GET", "/api/conversations/main/view-state/owner", "", 404)
	require.NoError(t, err)
	response, err := http.Get(r.origin + "/api/conversations/main")
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 401, response.StatusCode)
	if os.Getenv("SMITHERS_CONVERSATION_ENTRIES_BROWSER") == "1" {
		runConversationTimelineBrowser(t, r, alice, map[string]int64{"live": n}, "a committed live TODO")
	}
	require.NoError(t, r.release("entries"))
	t.Logf("HTTP/live shared queued, Starting, working; rollback and private views: T%d", n)
}
