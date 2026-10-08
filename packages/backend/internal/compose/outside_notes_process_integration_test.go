package compose

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The reference driver starts this binary as its own OS process. Only the
// response transport is faulted: the production worker claims the real intent,
// verifies the pinned guest identity and sends the canonical signal. The parent
// kills only this child, after the guest commit and before host settlement.
func TestOutsideNoteDispatcherProcess(t *testing.T) {
	database := os.Getenv("SMITHERS_NOTE_CHILD_DATABASE")
	if database == "" {
		t.Skip("child of the real microVM dispatcher driver")
	}
	pool, err := postgresfixture.Open(t.Context(), database, 4)
	require.NoError(t, err)
	defer pool.Close()
	var target flowruntime.Target
	require.NoError(t, json.Unmarshal([]byte(os.Getenv("SMITHERS_NOTE_CHILD_TARGET")), &target))
	transport := http.RoundTripper(http.DefaultTransport)
	if marker := os.Getenv("SMITHERS_NOTE_CHILD_DROP"); marker != "" {
		transport = outsideNoteCrashTransport{base: transport, marker: marker}
	}
	bridge, err := runtimebridge.New(runtimebridge.Config{Endpoint: os.Getenv("SMITHERS_NOTE_CHILD_ENDPOINT"), Credential: "outside-note-child", HTTPClient: &http.Client{Transport: transport}})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(_ context.Context, requested flowruntime.Target) (flowruntime.Runtime, error) {
		if requested != target {
			return nil, errors.New("outside-note child: foreign target refused")
		}
		return bridge, nil
	}), RuntimeCallTimeout: 5 * time.Minute})
	require.NoError(t, err)
	require.NoError(t, store.RunWorker(t.Context(), jobs.WorkerConfig{WorkerID: "outside-note-child", Capacity: 1, Lease: 2 * time.Second, HeartbeatInterval: 250 * time.Millisecond, PollInterval: 100 * time.Millisecond, RecoveryInterval: 250 * time.Millisecond, Operations: []string{flowdispatch.OperationSignal}}, dispatcher.Handle))
}

type outsideNoteCrashTransport struct {
	base   http.RoundTripper
	marker string
}

func (tr outsideNoteCrashTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := tr.base.RoundTrip(request)
	if err != nil || request.URL.Path != "/runtime/v1/command" || response.StatusCode != 200 {
		return response, err
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		return nil, err
	}
	var envelope struct {
		OK    bool `json:"ok"`
		Value struct {
			Receipt struct {
				Tag string `json:"_tag"`
			} `json:"receipt"`
		} `json:"value"`
	}
	if json.Unmarshal(body, &envelope) != nil || !envelope.OK || (envelope.Value.Receipt.Tag != "Accepted" && envelope.Value.Receipt.Tag != "AlreadyApplied") {
		response.Body = io.NopCloser(strings.NewReader(string(body)))
		return response, nil
	}
	if err := os.WriteFile(tr.marker, []byte("guest committed; host acknowledgement withheld\n"), 0600); err != nil {
		return nil, err
	}
	<-request.Context().Done()
	return nil, request.Context().Err()
}

// This executes the process/lease fault mechanism on Linux with real PostgreSQL
// and the production dispatcher and bridge. The HTTP peer is a controlled wire
// receipt, so this test does not claim guest/tool or C-J3-03 evidence.
func TestOutsideNoteDispatcherProcessRecovery(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	target := flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:2", WorkspaceID: "branch", BindingKind: "mythical-item", BindingID: "item"}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission resolved runtime")
		return nil, errors.New("unavailable")
	})})
	require.NoError(t, err)
	receipt, err := dispatcher.Signal(t.Context(), flowdispatch.SignalRequest{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, RequestID: "fixed-burst", Target: target, FlowID: "todo", RunID: "pinned-run", Name: "outside_change", Payload: json.RawMessage(`{"kind":"outside_change","burstId":"fixed-burst","targetLineageId":"pinned-run","actor":{"kind":"person","id":"member:3","name":"Maya","via":"ssh"},"files":["retry.ts"]}`)})
	require.NoError(t, err)
	var mu sync.Mutex
	var ids []string
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer outside-note-child", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/health":
			_, _ = io.WriteString(w, `{"runtimeBridge":{"protocol":"smithers.flow-runtime/v1","runtimeArtifactDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ownerGeneration":1}}`)
		case "/runtime/v1/observe":
			_, _ = io.WriteString(w, `{"protocol":"smithers.flow-runtime/v1","ok":true,"value":{"run":{"runId":"pinned-run","flowId":"todo","status":"running"},"events":[],"hasMore":false,"terminal":false}}`)
		case "/runtime/v1/command":
			var command struct {
				Operation string `json:"operation"`
				ID        string `json:"applicationRequestId"`
				Run       string `json:"runId"`
				Signal    struct {
					Name    string          `json:"name"`
					Payload json.RawMessage `json:"payload"`
				} `json:"signal"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&command))
			require.Equal(t, "signal", command.Operation)
			require.Equal(t, "pinned-run", command.Run)
			require.Equal(t, "outside_change", command.Signal.Name)
			require.JSONEq(t, `{"kind":"outside_change","burstId":"fixed-burst","targetLineageId":"pinned-run","actor":{"kind":"person","id":"member:3","name":"Maya","via":"ssh"},"files":["retry.ts"]}`, string(command.Signal.Payload))
			mu.Lock()
			tag := "Accepted"
			if len(ids) > 0 {
				tag = "AlreadyApplied"
			}
			ids = append(ids, command.ID)
			mu.Unlock()
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"protocol": "smithers.flow-runtime/v1", "ok": true, "value": map[string]any{"operation": "signal", "applicationRequestId": command.ID, "receipt": map[string]any{"_tag": tag, "runId": "pinned-run", "receiptId": "fixed-receipt"}}}))
		default:
			http.NotFound(w, r)
		}
	}))
	defer peer.Close()
	marker := filepath.Join(t.TempDir(), "accepted")
	binary, err := os.Executable()
	require.NoError(t, err)
	raw, err := json.Marshal(target)
	require.NoError(t, err)
	start := func(drop bool) *exec.Cmd {
		command := exec.Command(binary, "-test.run=^TestOutsideNoteDispatcherProcess$", "-test.timeout=30s")
		command.Env = append(os.Environ(), "SMITHERS_RESTART_CHILD_DATABASE=outside-note-owned-child", "SMITHERS_NOTE_CHILD_DATABASE="+pool.Config().ConnString(), "SMITHERS_NOTE_CHILD_ENDPOINT="+peer.URL, "SMITHERS_NOTE_CHILD_TARGET="+string(raw))
		if drop {
			command.Env = append(command.Env, "SMITHERS_NOTE_CHILD_DROP="+marker)
		}
		require.NoError(t, command.Start())
		t.Cleanup(func() {
			if command.ProcessState == nil {
				_ = command.Process.Kill()
				_ = command.Wait()
			}
		})
		return command
	}
	crashed := start(true)
	require.Eventually(t, func() bool { _, e := os.Stat(marker); return e == nil }, 15*time.Second, 50*time.Millisecond)
	require.NoError(t, crashed.Process.Kill())
	require.Error(t, crashed.Wait())
	var state string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT state FROM product_job_requests WHERE id=$1`, receipt.OperationID).Scan(&state))
	require.Equal(t, "waiting", state)
	recovered := start(false)
	require.Eventually(t, func() bool {
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT state FROM product_job_requests WHERE id=$1`, receipt.OperationID).Scan(&state))
		return state == "completed"
	}, 15*time.Second, 50*time.Millisecond)
	require.NoError(t, recovered.Process.Kill())
	require.Error(t, recovered.Wait())
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, ids, 2)
	require.NotEmpty(t, ids[0])
	require.Equal(t, ids[0], ids[1], "OS process death preserves delivery identity")
}
