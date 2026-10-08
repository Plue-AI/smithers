//go:build unix

package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type livePauseFaultConfig struct{ Endpoint, Credential string }
type livePauseFaultRuntime struct {
	flowruntime.Runtime
	point string
}

func (r livePauseFaultRuntime) Signal(ctx context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	result, err := r.Runtime.Signal(ctx, input)
	if err == nil && (result.Receipt.Tag == "Accepted" || result.Receipt.Tag == "AlreadyApplied") {
		faultprocess.Reached(r.point)
	}
	return result, err
}
func TestTodoLivePauseCrashChild(t *testing.T) {
	if os.Getenv(faultprocess.ChildEnv) != "todo-live-pause" {
		return
	}
	pool, err := postgresfixture.Open(t.Context(), os.Getenv(faultprocess.DBEnv), 0)
	require.NoError(t, err)
	defer pool.Close()
	raw, err := os.ReadFile(os.Getenv(faultprocess.ArgsEnv))
	require.NoError(t, err)
	var config livePauseFaultConfig
	require.NoError(t, json.Unmarshal(raw, &config))
	client, err := runtimebridge.New(runtimebridge.Config{Endpoint: config.Endpoint, Credential: config.Credential})
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
		t.Fatal("Stop or Resume resolved Active")
		return "", nil
	})
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	runtime := livePauseFaultRuntime{Runtime: client, point: os.Getenv(faultprocess.PointEnv)}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	server := mergeFaultServer(t, pool, service)
	go func() {
		err := dispatcher.RunWorker(t.Context(), jobs.WorkerConfig{WorkerID: "pause-live-child", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	fmt.Println("PAUSE-READY " + server.URL)
	<-t.Context().Done()
}

// Backend SIGKILL at a real packaged engine's Stop/Resume delivery crossing.
// The unprivileged guest continues to own its journal while the backend dies.
// This is a trusted-process install proof; it does not qualify a microVM kill.
func TestTodoStartPauseResumeCrashThroughRoutes(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_PAUSE_HOST_KILL") != "1" {
		t.Skip("set SMITHERS_TODO_PAUSE_HOST_KILL=1 for packaged pause qualification")
	}
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr12_r2pause")
	t.Setenv("TODO_HOLD_STEP", "coding/draft-plan")
	r := newRehearsal(t, "SMITHERS_TODO_PAUSE_HOST_KILL", "C-DUR-01", "pause-live-", 25)
	require.True(t, r.install("Install through Machine ready"))
	number, err := r.file("Pause survives a killed backend", "Add a greeting to JOURNEY.md. [HOLD pause-live]")
	require.NoError(t, err)
	if err := r.waitHeld("pause-live", 3*time.Minute); err != nil {
		var diagnostics []byte
		queryErr := r.pool.QueryRow(r.ctx, `SELECT coalesce(jsonb_agg(jsonb_build_object('operation',r.operation,'state',r.state,'last_error',d.last_error,'plan_id',d.external_receipt->>'planId','run_id',d.external_receipt->>'runId')), '[]'::jsonb) FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.operation LIKE 'flow.runtime.%'`).Scan(&diagnostics)
		require.NoError(t, queryErr)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "pause-setup-diagnostics.json"), diagnostics, 0600))
		t.Logf("runtime setup: %s", diagnostics)
		require.NoError(t, err)
	}
	before, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, before.Run)
	require.NotNil(t, before.FlowVersion)
	beforeSteps := livePauseModelSteps(t, r)
	require.Equal(t, 1, beforeSteps["route"])
	require.Equal(t, 1, beforeSteps["coding/draft-plan"])
	workspace, service, err := r.todoHostBinding(number)
	require.NoError(t, err)
	host, err := r.processRuntime.InspectService(r.ctx, workspace, service)
	require.NoError(t, err)
	require.Positive(t, host.PID)
	var encrypted string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT credential_ciphertext FROM flow_runtime_host_bindings WHERE workspace_id::text=$1 AND catalog_key='coding'`, workspace).Scan(&encrypted))
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	require.NoError(t, err)
	credential, err := codec.DecryptString(encrypted)
	require.NoError(t, err)
	config, err := json.Marshal(livePauseFaultConfig{Endpoint: "http://" + host.Address, Credential: credential})
	require.NoError(t, err)
	configFile := filepath.Join(t.TempDir(), "runtime.json")
	require.NoError(t, os.WriteFile(configFile, config, 0600))
	// Reserve only fault-control signal deliveries for the child worker. Other
	// install workers and every run continue normally. This scheduling hook
	// neither creates an operation nor changes the guest's signal semantics.
	_, err = r.pool.Exec(r.ctx, `CREATE FUNCTION pause_fault_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.worker_id IS NOT NULL AND NEW.worker_id <> 'pause-live-child' AND EXISTS(SELECT 1 FROM product_job_requests WHERE id=NEW.operation_id AND operation='flow.runtime.signal') THEN RAISE EXCEPTION 'pause fault controller owns delivery'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER pause_fault_claim BEFORE UPDATE ON product_job_dispatches FOR EACH ROW EXECUTE FUNCTION pause_fault_claim()`)
	require.NoError(t, err)
	for _, op := range []string{"stop", "resume"} {
		t.Run(op, func(t *testing.T) {
			child := faultprocess.Start(t, "TestTodoLivePauseCrashChild", "todo-live-pause", op, r.pool.Config().ConnString(), configFile)
			ready := child.Await(t, "PAUSE-READY ")
			require.Len(t, ready, 1)
			original := r.origin
			r.origin = ready[0]
			status, receipt, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), fmt.Sprintf(`{"op":%q}`, op), "pause-live-"+op)
			r.origin = original
			require.NoError(t, err)
			require.Equal(t, 202, status, string(receipt))
			child.Await(t, faultprocess.Marker+op)
			child.Kill(t)
			fmt.Println(faultprocess.Marker + op)
			// The ordinary backend worker reconciles the same external signal once
			// its killed child's lease expires; credentials stay in the host adapter.
			_, err = r.pool.Exec(r.ctx, `ALTER TABLE product_job_dispatches DISABLE TRIGGER pause_fault_claim`)
			require.NoError(t, err)
			require.Eventually(t, func() bool {
				var count int
				err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal' AND state='completed' AND payload->>'runId'=$1`, before.Run.ID).Scan(&count)
				expected := 1
				if op == "resume" {
					expected = 2
				}
				return err == nil && count == expected
			}, 30*time.Second, 100*time.Millisecond)
			status, again, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), fmt.Sprintf(`{"op":%q}`, op), "pause-live-"+op)
			require.NoError(t, err)
			require.Equal(t, 202, status, string(again))
			require.JSONEq(t, string(receipt), string(again))
			if op == "stop" {
				raw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
				require.NoError(t, err)
				var card map[string]any
				require.NoError(t, json.Unmarshal(raw, &card))
				require.Equal(t, "working", card["state"])
				require.Equal(t, "requested", card["stop"])
				require.NotContains(t, card, "pause", "the held planning turn must precede the park")
				require.NoError(t, r.release("pause-live"))
				parked, err := r.waitTodoWithin(number, time.Minute, "paused")
				require.NoError(t, err)
				require.Equal(t, before.Run.ID, parked.Run.ID)
				require.Equal(t, before.Run.Attempt, parked.Run.Attempt)
				require.Equal(t, before.FlowVersion, parked.FlowVersion)
				_, err = r.pool.Exec(r.ctx, `ALTER TABLE product_job_dispatches ENABLE TRIGGER pause_fault_claim`)
				require.NoError(t, err)
			} else {
				resumed, err := r.waitTodoWithin(number, time.Minute, "working", "in_review")
				require.NoError(t, err)
				require.Equal(t, before.Run.ID, resumed.Run.ID)
				require.Equal(t, before.Run.Attempt, resumed.Run.Attempt)
				require.Equal(t, before.FlowVersion, resumed.FlowVersion)
			}
			steps := livePauseModelSteps(t, r)
			require.Equal(t, 1, steps["route"], "Resume must not repeat the completed route")
			require.Equal(t, 1, steps["coding/draft-plan"], "Resume must not repeat planning")
			evidence := filepath.Join(r.evidence, op)
			require.NoError(t, os.MkdirAll(evidence, 0700))
			observation, err := json.MarshalIndent(map[string]any{"point": op, "subject": fmt.Sprintf("todo:%d", number), "run": before.Run, "pin": before.FlowVersion, "receipt": json.RawMessage(receipt), "model_steps": steps, "completed_route_repeats": steps["route"] - 1, "identity": faultprocess.Identity(t), "qualification": "packaged built-in TODO engine and HTTP control; trusted-process, not microVM or supervised install SIGKILL"}, "", "  ")
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(evidence, "observations.json"), observation, 0600))
		})
	}
	_, err = r.pool.Exec(r.ctx, `DROP TRIGGER pause_fault_claim ON product_job_dispatches; DROP FUNCTION pause_fault_claim()`)
	require.NoError(t, err)
}

func livePauseModelSteps(t *testing.T, r *rehearsal) map[string]int {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), "GET", r.coder.url+"/turns", nil)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	var turns struct {
		Steps map[string]int `json:"steps"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&turns))
	return turns.Steps
}
