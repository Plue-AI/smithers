package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type branchQueueHost struct {
	store   *Store
	started chan string
	release chan struct{}
}

func (h branchQueueHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	h.started <- grant.RunID
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-h.release:
	}
	_, err := h.store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame(grant.RunID, "answer"), done(grant.RunID, "stop")}})
	return err
}

// Admissions go through HTTP and two production dispatchers compete on the
// same database. The second member's prompt cannot start before the first ends.
func TestBranchTurnQueueHTTPSerializesMembers(t *testing.T) {
	store := needStore(t)
	ben, alice := testScope(), testScope()
	alice.RepositoryID = ben.RepositoryID
	host := branchQueueHost{store: store, started: make(chan string, 8), release: make(chan struct{})}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan struct{}, 2)
	servers := make([]*httptest.Server, 0, 2)
	for _, scope := range []Scope{ben, alice} {
		dispatcher, err := NewDispatcher(store, host, 8, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		dispatcher.scan = 10 * time.Millisecond
		go func() { _ = dispatcher.Run(ctx, 2); finished <- struct{}{} }()
		routes := authenticatedRoutes(&Handler{Store: store, Dispatcher: dispatcher}, scope.UserID, scope.Owner)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Repository: &db.Repository{ID: scope.RepositoryID}}, middleware.PermissionWrite)
			routes.ServeHTTP(w, r.WithContext(ctx))
		}))
		servers = append(servers, server)
	}
	defer func() {
		cancel()
		for _, s := range servers {
			s.CloseClientConnections()
			s.Close()
		}
		for range 2 {
			select {
			case <-finished:
			case <-time.After(dbWait):
				t.Error("dispatcher shutdown timed out")
			}
		}
	}()
	var readers []io.ReadCloser
	defer func() {
		for _, r := range readers {
			r.Close()
		}
	}()
	branch := "branch-" + uuid.NewString()
	start := func(server *httptest.Server, name string) string {
		runID := name + uuid.NewString()
		body, _ := json.Marshal(map[string]any{"runId": runID, "journal": testJournal(), "conversationId": branch, "instructions": "Answer", "messages": []any{map[string]string{"role": "user", "content": name}}})
		response := postJSON(t, server.Client(), server.URL+TurnPath, body)
		if response.StatusCode != 200 {
			raw, _ := io.ReadAll(response.Body)
			response.Body.Close()
			t.Fatalf("admit=%d %s", response.StatusCode, raw)
		}
		readers = append(readers, response.Body)
		line, err := bufio.NewReader(response.Body).ReadString('\n')
		if err != nil || !strings.Contains(line, `"type":"accepted"`) {
			t.Fatalf("acceptance=%s %v", line, err)
		}
		return runID
	}
	first := start(servers[0], "ben")
	select {
	case got := <-host.started:
		if got != first {
			t.Fatalf("started=%s", got)
		}
	case <-time.After(dbWait):
		t.Fatal("first prompt did not start")
	}
	second := start(servers[1], "alice")
	select {
	case got := <-host.started:
		t.Fatalf("overlapping host=%s", got)
	case <-time.After(150 * time.Millisecond):
	}
	var state string
	if err := store.pool.QueryRow(ctx, `SELECT state FROM chat_turns WHERE run_id=$1`, second).Scan(&state); err != nil || state != "queued" {
		t.Fatalf("waiting state=%s err=%v", state, err)
	}
	// Closing the author's browser is not cancellation.
	readers[0].Close()
	close(host.release)
	select {
	case got := <-host.started:
		if got != second {
			t.Fatalf("next=%s", got)
		}
	case <-time.After(dbWait):
		t.Fatal("queued prompt never started")
	}
}
