package compose

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The remote event/session source is a dependency fixture. Ingest fencing,
// PostgreSQL transaction, TODO projection and authenticated HTTP are real.
func TestMovedOffAuthenticatedIngestProjectsIndependentWaitThroughInstallHTTP(t *testing.T) {
	for _, choice := range []string{"keep-moved", "return-to-item", "race"} {
		t.Run(choice, func(t *testing.T) {
			f := presenceInstall(t)
			service := services.NewMythicalService(f.pool, nil)
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = "selfhost"
			cfg.Auth.SessionCookieName = "session"
			server := httptest.NewUnstartedServer(nil)
			cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
			cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
			server.Config.Handler = githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
			server.Start()
			defer server.Close()
			_, err := f.pool.Exec(t.Context(), `UPDATE mythical_items SET state='running',checks='{"waits":[{"id":"other-question","kind":"question","prompt":"Which?","since":"2026-10-07T00:00:00Z"}]}' WHERE repository_id=$1 AND number=1`, f.row.RepositoryID)
			require.NoError(t, err)
			registry := &machined.Registry{}
			boot := [16]byte{1}
			secret := []byte("moved-boot")
			require.NoError(t, registry.BindBoot(f.row.ID, "vm", boot, secret))
			connection, err := registry.Admit(boot, secret, io.NopCloser(strings.NewReader("")))
			require.NoError(t, err)
			defer connection.Close()
			prepare := service.PrepareMovedOffEvent(func(_ context.Context, branch string, actor wire.Actor) (json.RawMessage, error) {
				if branch != f.row.ID || actor.Kind != 2 || actor.Session != 7 {
					return nil, machined.ErrUnauthorized
				}
				return json.RawMessage(`{"kind":"person","login":"presence-owner","name":"Alice","avatar_url":"https://example.com/alice.png","color_index":1}`), nil
			})
			ingest := &machined.Ingestor{Pool: f.pool, Prepare: prepare}
			literal, err := hex.DecodeString("04000000290102000000050100000007020000000000000001031234567890abcdef1234567890abcdef12345678")
			require.NoError(t, err)
			event := machined.Event{Seq: 1, EventID: [16]byte{8}, Payload: literal}
			ack, err := ingest.Commit(t.Context(), connection, f.row.ID, event)
			require.NoError(t, err)
			require.Equal(t, machined.AckApplied, ack.Outcome)
			read := func() map[string]any {
				request, err := http.NewRequest(http.MethodGet, server.URL+"/api/todos/1", nil)
				require.NoError(t, err)
				request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
				response, err := http.DefaultClient.Do(request)
				require.NoError(t, err)
				defer response.Body.Close()
				var card map[string]any
				require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
				require.Equal(t, http.StatusOK, response.StatusCode, "%v", card)
				return card
			}
			source, reason := f.p.source(t.Context(), f.row.ID, f.row.RepositoryID, f.row.UserID, "presence/repo")
			require.Empty(t, reason)
			branchRaw, err := source.Build(t.Context())
			require.NoError(t, err)
			var branch map[string]any
			require.NoError(t, json.Unmarshal(branchRaw, &branch))
			moved := branch["moved_off"].(map[string]any)
			require.Equal(t, float64(1), moved["item"])
			require.Equal(t, "Alice", moved["by"].(map[string]any)["name"])
			require.NotContains(t, moved, "pre_move_commit")
			require.NotContains(t, moved, "wait")
			card := read()
			require.Equal(t, "needs_you", card["state"])
			waits := card["waits"].([]any)
			require.Len(t, waits, 2)
			require.Equal(t, "moved_off", waits[0].(map[string]any)["kind"])
			require.Equal(t, "Alice moved this branch off T1", waits[0].(map[string]any)["prompt"])
			postWaitControl := func(op, key, wait string) (int, map[string]any) {
				body, _ := json.Marshal(map[string]any{"op": op, "id": wait})
				request, err := http.NewRequest(http.MethodPost, server.URL+"/api/todos/1", strings.NewReader(string(body)))
				require.NoError(t, err)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Idempotency-Key", key)
				request.Header.Set("Origin", server.URL)
				request.Header.Set("X-CSRF-Token", "moved-csrf")
				request.AddCookie(&http.Cookie{Name: "__csrf", Value: "moved-csrf"})
				request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
				response, err := http.DefaultClient.Do(request)
				require.NoError(t, err)
				defer response.Body.Close()
				var result map[string]any
				require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
				return response.StatusCode, result
			}
			postControl := func(op, key string) (int, map[string]any) {
				return postWaitControl(op, key, waits[0].(map[string]any)["id"].(string))
			}
			status, result := postWaitControl("keep-moved", "stale-wait", "earlier-move")
			require.Equal(t, http.StatusNotFound, status, "%v", result)
			require.Equal(t, "wait_not_found", result["code"])
			status, result = postWaitControl("keep-moved", "unrelated-wait", "other-question")
			require.Equal(t, http.StatusNotFound, status, "%v", result)
			require.NotContains(t, read()["waits"].([]any)[0].(map[string]any), "answered_by")
			status, result = postControl("return-to-item", "unavailable-return")
			require.Equal(t, http.StatusServiceUnavailable, status, "%v", result)
			require.NotContains(t, read()["waits"].([]any)[0].(map[string]any), "answered_by", "unavailable provider must not consume the choice")
			service.SetMovedOffReturn(movedReturnBoundary{})
			if choice == "race" {
				var group sync.WaitGroup
				statuses := make(chan int, 2)
				for _, op := range []string{"keep-moved", "return-to-item"} {
					group.Add(1)
					go func(op string) { defer group.Done(); status, _ := postControl(op, "race-"+op); statuses <- status }(op)
				}
				group.Wait()
				close(statuses)
				counts := map[int]int{}
				for status := range statuses {
					counts[status]++
				}
				require.Equal(t, map[int]int{http.StatusAccepted: 1, http.StatusConflict: 1}, counts)
			} else {
				status, result = postControl(choice, "choice-once")
				require.Equal(t, http.StatusAccepted, status, "%v", result)
				status, result = postControl(choice, "choice-once")
				require.Equal(t, http.StatusAccepted, status, "%v", result)
				status, result = postControl(choice, "choice-again")
				require.Equal(t, http.StatusConflict, status, "%v", result)
				require.Equal(t, "presence-owner", result["answered_by"])
			}
			require.Len(t, read()["waits"].([]any), 2, "Keep leaves both independent waits open")
			ack, err = ingest.Commit(t.Context(), connection, f.row.ID, event)
			require.NoError(t, err)
			require.Equal(t, machined.AckDuplicate, ack.Outcome)
			// A second durable event still cannot replace the wait or pre-move target.
			event.Seq = 2
			event.EventID = [16]byte{9}
			_, err = ingest.Commit(t.Context(), connection, f.row.ID, event)
			require.NoError(t, err)
			require.Len(t, read()["waits"].([]any), 2)
			_, err = ingest.Commit(t.Context(), connection, "11111111-1111-4111-8111-111111111111", event)
			require.ErrorIs(t, err, machined.ErrUnauthorized)
			returned, err := hex.DecodeString("040000002b0102000000050100000007020000000000000001031234567890abcdef1234567890abcdef123456780401")
			require.NoError(t, err)
			event.Seq = 3
			event.EventID = [16]byte{10}
			event.Payload = returned
			_, err = ingest.Commit(t.Context(), connection, f.row.ID, event)
			require.NoError(t, err)
			card = read()
			require.Equal(t, "needs_you", card["state"])
			waits = card["waits"].([]any)
			require.Len(t, waits, 1)
			require.Equal(t, "other-question", waits[0].(map[string]any)["id"])
			var fact []byte
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT moved_off FROM workspaces WHERE id=$1`, f.row.ID).Scan(&fact))
			require.Empty(t, fact)
			branchRaw, err = source.Build(t.Context())
			require.NoError(t, err)
			branch = nil
			require.NoError(t, json.Unmarshal(branchRaw, &branch))
			require.NotContains(t, branch, "moved_off")
			topics := &liveTopics{changePool: f.pool, presence: f.p}
			activity, reason := topics.branchChanges(t.Context(), "branch:"+f.row.ID+":activity", f.row.RepositoryID, f.user.ID)
			require.Empty(t, reason)
			page, err := activity.Log.Page(t.Context(), nil)
			require.NoError(t, err)
			var entries []map[string]any
			require.NoError(t, json.Unmarshal(page.Data, &entries))
			require.Len(t, entries, 2, "redelivery and Keep cannot duplicate the moved activity")
			require.Equal(t, "moved this branch off T1", entries[0]["text"])
			require.Equal(t, "returned to T1", entries[1]["text"])
			require.Equal(t, "Alice", entries[1]["actor"].(map[string]any)["name"])
			require.NotContains(t, entries[1], "versions")

		})
	}
}

// Only machine readiness is a dependency fixture. The request must persist and
// return without invoking the rewrite; the production stack worker owns it.
type movedReturnBoundary struct{}

func (movedReturnBoundary) RequireReady(string) error { return nil }
func (movedReturnBoundary) ReturnToItem(context.Context, string, []byte) (machined.RewriteResult, error) {
	panic("HTTP admission executed Return")
}
