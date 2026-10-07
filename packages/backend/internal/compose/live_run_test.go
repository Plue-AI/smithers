package compose

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Literal journal input is the remote runtime contract; PostgreSQL, the
// checkpoint lookup, branch policy, session, and install socket are real.
// Native execution itself belongs to the reference-host qualification.
type liveRunFixture struct {
	browserFlowDispatcher
	mu         sync.Mutex
	head       int64
	floor      int64
	wrongRun   bool
	wrongOrder bool
	reads      int
	flowID     string
}

func (f *liveRunFixture) CallRPC(_ context.Context, _ flowruntime.Target, procedure string, raw json.RawMessage) (json.RawMessage, error) {
	if procedure != "Projection.Snapshot" {
		return nil, fmt.Errorf("unexpected mutation %s", procedure)
	}
	var request struct {
		Selector struct {
			Tag   string `json:"_tag"`
			RunID string `json:"runId"`
		} `json:"selector"`
		After *runProjectionCursor `json:"after"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	cursor := runProjectionCursor{Selector: map[string]string{"_tag": request.Selector.Tag, "runId": request.Selector.RunID}, Projection: request.Selector.Tag, RunID: request.Selector.RunID, Value: f.head}
	rows := []json.RawMessage{}
	switch request.Selector.Tag {
	case "run-summary":
		f.reads++
		state := "running"
		if f.head == 8 {
			state = "completed"
		}
		flow := f.flowID
		if flow == "" {
			flow = "fixture"
		}
		rows = append(rows, json.RawMessage(fmt.Sprintf(`{"runId":"fixture-run","flowId":%q,"status":%q,"statusRollup":{"sampledAt":%d}}`, flow, state, f.reads)))
	case "run-tree":
		if f.head >= 4 {
			state := "running"
			if f.head == 8 {
				state = "completed"
			}
			rows = append(rows, json.RawMessage(fmt.Sprintf(`{"nodeId":"step","label":"Read","status":%q,"startedAt":1000}`, state)))
		}
	case "run-events":
		cursor.Value = request.After.Value
		cursor.Offset = request.After.Offset
		// Two events share journal entry 4. Pages deliberately split it.
		for _, event := range []struct {
			seq, offset int64
			kind        string
		}{{1, 0, "control.run.running"}, {4, 0, "step.started"}, {4, 1, "step.output"}, {8, 0, "step.finished"}} {
			if event.seq < f.floor || event.seq > f.head || event.seq < request.After.Value || event.seq == request.After.Value && event.offset <= request.After.Offset {
				continue
			}
			seq := event.seq
			if f.wrongOrder && seq == 8 {
				seq = 2
			}
			rows = append(rows, json.RawMessage(fmt.Sprintf(`{"sequence":%d,"kind":%q,"runId":"fixture-run","occurredAt":1000,"payload":{}}`, seq, event.kind)))
			cursor.Value, cursor.Offset = event.seq, event.offset
			break
		}
	default:
		return nil, fmt.Errorf("unexpected projection")
	}
	if f.head == 4 && request.Selector.Tag != "run-events" {
		cursor.Offset = 1
	}
	if f.wrongRun {
		cursor.RunID = "another-run"
	}
	return json.Marshal(map[string]any{"ok": true, "payload": runProjectionSnapshot{Cursor: cursor, Rows: rows}})
}

func TestLiveRunComposedCheckpointAndReplay(t *testing.T) {
	f := presenceInstall(t)
	provider := &liveRunFixture{head: 1}
	f.p.dispatcher = provider
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: f.row.ID, BindingKind: "mythical-item", BindingID: "fixture"}
	receipt, err := store.Admit(t.Context(), jobs.Admission{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, Operation: flowdispatch.OperationLaunch, RequestID: "live-run", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile, EffectKey: "live-run"})
	require.NoError(t, err)
	checkpoint, err := json.Marshal(flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, RunID: "fixture-run"})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, receipt.OperationID, checkpoint)
	require.NoError(t, err)
	socket := f.dial(t)
	sendPresenceFrame(t, socket, `{"t":"sub","id":1,"topic":"run:fixture-run"}`)
	initial := readPresenceFrame(t, socket)
	require.Equal(t, "snap", initial.T)
	require.EqualValues(t, 1, *initial.Cursor)
	require.JSONEq(t, `{"summary":{"runId":"fixture-run","flowId":"fixture","status":"running"},"steps":[],"events":[]}`, string(initial.Data))
	// Readers at the same source position get the same bytes, even when the
	// gateway's independently sampled health freshness has advanced.
	other := f.dial(t)
	sendPresenceFrame(t, other, `{"t":"sub","id":1,"topic":"run:fixture-run"}`)
	repeated := readPresenceFrame(t, other)
	require.Equal(t, initial.Cursor, repeated.Cursor)
	require.Equal(t, initial.Data, repeated.Data)
	other.CloseNow()
	// The shipped LiveChannel decodes the real socket frames and carries its
	// own cursor across a dropped connection. No route or socket is mocked.
	client := exec.CommandContext(t.Context(), "bun", "testdata/live/run-client.mjs", f.origin, f.cookie)
	client.Stderr = os.Stderr
	stdout, err := client.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, client.Start())
	t.Cleanup(func() { _ = client.Process.Kill() })
	output := bufio.NewScanner(stdout)
	require.True(t, output.Scan())
	require.Equal(t, "ready", output.Text())
	provider.mu.Lock()
	provider.head = 4
	provider.mu.Unlock()
	started := readPresenceFrame(t, socket)
	require.Equal(t, "delta", started.T)
	require.EqualValues(t, 4, *started.Cursor)
	require.Contains(t, string(started.Data), `"step.started"`)
	require.Contains(t, string(started.Data), `"step.output"`)
	require.True(t, output.Scan())
	require.Equal(t, "disconnected", output.Text())
	socket.CloseNow()
	provider.mu.Lock()
	provider.head = 8
	provider.mu.Unlock()
	resumed := f.dial(t)
	sendPresenceFrame(t, resumed, `{"t":"sub","id":1,"topic":"run:fixture-run","cursor":4}`)
	finished := readPresenceFrame(t, resumed)
	require.Equal(t, "delta", finished.T)
	require.EqualValues(t, 8, *finished.Cursor)
	require.Contains(t, string(finished.Data), `"step.finished"`)
	require.NotContains(t, string(finished.Data), `"step.started"`)
	require.Contains(t, string(finished.Data), `"status":"completed"`)
	require.True(t, output.Scan())
	require.Equal(t, "replayed", output.Text())
	require.NoError(t, client.Wait())
	sendPresenceFrame(t, resumed, `{"t":"sub","id":2,"topic":"run:unknown"}`)
	require.Equal(t, "unknown_topic", readPresenceFrame(t, resumed).Code)
	// A missing source entry yields a gap; the client's cursor-free retry gets
	// the committed snapshot, never a partial replay of the retained suffix.
	provider.mu.Lock()
	provider.floor = 8
	provider.mu.Unlock()
	sendPresenceFrame(t, resumed, `{"t":"sub","id":3,"topic":"run:fixture-run","cursor":4}`)
	require.Equal(t, "gap", readPresenceFrame(t, resumed).T)
	sendPresenceFrame(t, resumed, `{"t":"sub","id":3,"topic":"run:fixture-run"}`)
	require.Equal(t, "snap", readPresenceFrame(t, resumed).T)
	// The source is still known, but a revoked branch binding grants no read.
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET deleted_at=clock_timestamp() WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	denied := f.dial(t)
	sendPresenceFrame(t, denied, `{"t":"sub","id":1,"topic":"run:fixture-run"}`)
	require.Equal(t, "forbidden", readPresenceFrame(t, denied).Code)
}

func TestLiveRunReaderRejectsInvalidSource(t *testing.T) {
	for _, test := range []struct {
		name                         string
		future, wrongRun, wrongOrder bool
		floor                        int64
	}{
		{name: "future", future: true}, {name: "wrong run", wrongRun: true}, {name: "order", wrongOrder: true}, {name: "retention", floor: 8},
	} {
		t.Run(test.name, func(t *testing.T) {
			provider := &liveRunFixture{head: 8, floor: test.floor, wrongRun: test.wrongRun, wrongOrder: test.wrongOrder}
			reader := runProjectionReader{call: provider.CallRPC, run: "fixture-run"}
			cursor := int64(1)
			if test.future {
				cursor = 100
			}
			page, err := reader.page(t.Context(), &cursor)
			if test.wrongRun || test.wrongOrder {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.True(t, page.Gap)
			}
		})
	}
}
