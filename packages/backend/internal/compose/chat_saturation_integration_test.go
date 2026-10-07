package compose

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
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
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

type saturationTurn struct{ runID, turnID, branch string }

// TestAPIStaysResponsiveWhileChatWorkersAreSaturated fills every chat
// dispatch worker of the composed product with turns that never finish.
// Admission, reads, writes and replay must keep answering at once; the turns
// beyond capacity wait durably and run when a worker frees.
func TestAPIStaysResponsiveWhileChatWorkersAreSaturated(t *testing.T) {
	const concurrency = 2
	_, _, pool := splitProcessDatabase(t)
	t.Setenv("SMITHERS_CHAT_CONCURRENCY", fmt.Sprint(concurrency))
	host := &saturatingChatHost{started: make(chan string, 16), release: make(chan struct{})}
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	// Worker saturation uses trusted fixture processes; it does not prove VM isolation.
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: host, Workspace: runtime, BranchMachines: rehearsalBranchMachines(pool), FlowHostProductAPIURL: "http://127.0.0.1:4000"}))
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
	session := "saturation-owner-session"
	digest := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(digest[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "busy", LowerName: "busy", DefaultBookmark: "main"})
	require.NoError(t, err)

	binding := fmt.Sprintf(`{"owner_login":"saturated","repository_name":"busy","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
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
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "saturation-csrf"})
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("X-CSRF-Token", "saturation-csrf")
		req.Host = "127.0.0.1:4000"
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

	// Separate owned branches can fill the worker pool; each branch remains serialized.
	startTurn := func() *saturationTurn {
		branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: uuid.NewString(), TargetBookmark: "scratch/" + uuid.NewString(), Kind: "vm", Status: "stopped"})
		require.NoError(t, err)
		status, raw, took := call("POST", "/api/conversations/"+branch.ID+"/prompt", map[string]string{"prompt": "hello", "idempotencyKey": uuid.NewString()})
		require.Equal(t, 202, status, string(raw))
		require.Less(t, took, 2*time.Second)
		var receipt struct {
			RunID  string `json:"runId"`
			TurnID string `json:"turnId"`
		}
		require.NoError(t, json.Unmarshal(raw, &receipt))
		return &saturationTurn{runID: receipt.RunID, turnID: receipt.TurnID, branch: branch.ID}
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
	status, body, took := call("GET", "/api/conversations/"+queued[0].branch, nil)
	budget("waiting conversation", status, body, took, 200)
	require.NotContains(t, string(body), "credential_missing")
	release()
	for _, turn := range busy {
		require.Eventually(t, func() bool {
			status, body, _ := call("GET", "/api/conversations/"+turn.branch, nil)
			require.Equal(t, 200, status, string(body))
			var conversation chat.SharedConversation
			require.NoError(t, json.Unmarshal(body, &conversation))
			for _, entry := range conversation.Entries {
				if entry.ID == turn.turnID && entry.State == chat.StateFailed {
					require.Contains(t, string(body), "credential_missing")
					return true
				}
			}
			return false
		}, 30*time.Second, 20*time.Millisecond)
	}

	_, peak, calls = host.snapshot()
	require.Equal(t, concurrency, peak, "the pool never ran more turns than its capacity")
	require.Equal(t, len(busy), calls, "each turn ran exactly once")
	t.Logf("slowest API answer while saturated: %s", slowest)
}
