package compose

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// saturatingChatHost holds every turn it is given until released, so the
// dispatcher's workers stay busy for as long as the test needs.
type saturatingChatHost struct {
	mu      sync.Mutex
	running int
	peak    int
	calls   int
	started chan string
	release chan struct{}
}

func (h *saturatingChatHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	h.mu.Lock()
	h.running++
	h.calls++
	h.peak = max(h.peak, h.running)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.running--
		h.mu.Unlock()
	}()
	h.started <- grant.RunID
	select {
	case <-h.release:
		// A missing credential is a terminal, user-visible failure.
		return ports.ErrModelCredentialMissing
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *saturatingChatHost) snapshot() (running, peak, calls int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.running, h.peak, h.calls
}

type saturationTurn struct {
	runID   string
	journal map[string]any
	lines   chan string
	done    chan struct{}
}

// TestAPIStaysResponsiveWhileChatWorkersAreSaturated fills every chat
// dispatch worker of the composed product with turns that never finish.
// Admission, reads, writes and replay must keep answering at once; the turns
// beyond capacity wait durably and run when a worker frees.
func TestAPIStaysResponsiveWhileChatWorkersAreSaturated(t *testing.T) {
	const concurrency = 2
	_, _, pool := splitProcessDatabase(t)
	t.Setenv("SMITHERS_CHAT_CONCURRENCY", fmt.Sprint(concurrency))
	host := &saturatingChatHost{started: make(chan string, 16), release: make(chan struct{})}
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: host}))
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(host.release) }) }
	// A failed assertion must not leave held streams blocking shutdown.
	t.Cleanup(func() {
		release()
		server.CloseClientConnections()
		server.Close()
	})
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "saturated", LowerUsername: "saturated", DisplayName: "saturated"})
	require.NoError(t, err)
	// The single trusted owner of this installation.
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES ($1)`, owner.ID)
	require.NoError(t, err)
	token, _ := isolationToken(t, q, owner, "saturated-all")
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "busy", LowerName: "busy", DefaultBookmark: "main"})
	require.NoError(t, err)

	call := func(method, path string, body any) (int, []byte, time.Duration) {
		var reader io.Reader
		if body != nil {
			encoded, marshalErr := json.Marshal(body)
			require.NoError(t, marshalErr)
			reader = bytes.NewReader(encoded)
		}
		requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		req, reqErr := http.NewRequestWithContext(requestCtx, method, server.URL+path, reader)
		require.NoError(t, reqErr)
		req.Header.Set("Authorization", "Bearer "+token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		began := time.Now()
		response, doErr := server.Client().Do(req)
		require.NoError(t, doErr, "%s %s did not answer", method, path)
		defer response.Body.Close()
		data, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		return response.StatusCode, data, time.Since(began)
	}

	// startTurn opens a chat turn and returns once its admission line arrives.
	startTurn := func() *saturationTurn {
		turn := &saturationTurn{runID: "busy-" + uuid.NewString(), lines: make(chan string, 64), done: make(chan struct{}),
			journal: map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("c", 48)}}
		body, marshalErr := json.Marshal(map[string]any{"runId": turn.runID, "journal": turn.journal, "repositoryId": repo.ID,
			"instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "hello"}}})
		require.NoError(t, marshalErr)
		req, reqErr := http.NewRequest(http.MethodPost, server.URL+chat.TurnPath, bytes.NewReader(body))
		require.NoError(t, reqErr)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		began := time.Now()
		response, doErr := server.Client().Do(req)
		require.NoError(t, doErr)
		require.Equal(t, http.StatusOK, response.StatusCode)
		go func() {
			defer close(turn.done)
			defer response.Body.Close()
			scanner := bufio.NewScanner(response.Body)
			scanner.Buffer(make([]byte, 1<<20), 1<<20)
			for scanner.Scan() {
				turn.lines <- scanner.Text()
			}
		}()
		select {
		case line := <-turn.lines:
			require.Contains(t, line, `"type":"accepted"`)
		case <-time.After(2 * time.Second):
			t.Fatalf("turn %s was not acknowledged", turn.runID)
		}
		require.Less(t, time.Since(began), 2*time.Second, "admission waited for a worker")
		return turn
	}

	// Fill every worker.
	busy := []*saturationTurn{startTurn(), startTurn()}
	for range concurrency {
		select {
		case <-host.started:
		case <-time.After(10 * time.Second):
			t.Fatal("the chat workers never took the first turns")
		}
	}

	// Past capacity, admission still answers at once and the turns wait.
	queued := []*saturationTurn{startTurn(), startTurn(), startTurn()}
	busy = append(busy, queued...)
	select {
	case runID := <-host.started:
		t.Fatalf("turn %s started while every worker was busy", runID)
	case <-time.After(1500 * time.Millisecond):
	}
	running, peak, calls := host.snapshot()
	require.Equal(t, concurrency, running)
	require.Equal(t, concurrency, peak)
	require.Equal(t, concurrency, calls)

	// Every other surface answers while the workers are held.
	var slowest time.Duration
	budget := func(label string, status int, body []byte, took time.Duration, want int) {
		t.Helper()
		require.Equal(t, want, status, "%s: %s", label, body)
		require.Less(t, took, 2*time.Second, "%s waited on the saturated workers", label)
		slowest = max(slowest, took)
	}
	repoPath := "/api/repos/" + owner.Username + "/" + repo.Name
	var wg sync.WaitGroup
	type result struct {
		label  string
		status int
		want   int
		body   []byte
		took   time.Duration
	}
	results := make(chan result, 64)
	for round := range 5 {
		for _, probe := range []struct {
			label, method, path string
			body                any
			want                int
		}{
			{"health", http.MethodGet, "/api/health", nil, http.StatusOK},
			{"current user", http.MethodGet, "/api/user", nil, http.StatusOK},
			{"repository", http.MethodGet, repoPath, nil, http.StatusOK},
			{"issue list", http.MethodGet, repoPath + "/issues", nil, http.StatusOK},
			{"issue create", http.MethodPost, repoPath + "/issues", map[string]string{"title": fmt.Sprintf("while busy %d", round), "body": "b"}, http.StatusCreated},
		} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, body, took := call(probe.method, probe.path, probe.body)
				results <- result{probe.label, status, probe.want, body, took}
			}()
		}
	}
	wg.Wait()
	close(results)
	for r := range results {
		budget(r.label, r.status, r.body, r.took, r.want)
	}

	// A waiting turn stays visible as accepted work, not an error.
	status, body, took := call(http.MethodPost, chat.ReplayPath, map[string]any{"runId": queued[0].runID, "journal": queued[0].journal})
	budget("waiting turn replay", status, body, took, http.StatusOK)
	var waiting chat.ReplayResult
	require.NoError(t, json.Unmarshal(body, &waiting))
	require.False(t, waiting.Terminal, "a waiting turn is not terminal: %s", body)

	// Freeing the workers runs the waiting turns; each ends with its own
	// visible outcome.
	release()
	for _, turn := range busy {
		select {
		case <-turn.done:
		case <-time.After(30 * time.Second):
			t.Fatalf("turn %s never finished after the workers freed", turn.runID)
		}
		status, body, _ := call(http.MethodPost, chat.ReplayPath, map[string]any{"runId": turn.runID, "journal": turn.journal})
		require.Equal(t, http.StatusOK, status, string(body))
		var replay chat.ReplayResult
		require.NoError(t, json.Unmarshal(body, &replay))
		require.True(t, replay.Terminal, string(body))
		require.Contains(t, string(body), "credential_missing")
	}
	_, peak, calls = host.snapshot()
	require.Equal(t, concurrency, peak, "the pool never ran more turns than its capacity")
	require.Equal(t, len(busy), calls, "each turn ran exactly once")
	t.Logf("slowest API answer while saturated: %s", slowest)
}
