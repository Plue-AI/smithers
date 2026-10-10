//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	"github.com/stretchr/testify/require"
)

// Extend the installed TODO rehearsal, not an engine-only replacement. The
// recorded provider is external to the coding host and retains its request log
// across a kill. K5 owns a private cluster; it never signals the fleet database.
func TestTodoHostRecordedKillThroughInstall(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_HOST_KILL") != "1" {
		t.Skip("set SMITHERS_TODO_HOST_KILL=1 for recorded production TODO crossings")
	}
	t.Setenv("TRACE_MESSAGES", "1")
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	for _, point := range []string{"K1", "K2", "K3", "K4", "K5"} {
		t.Run(point, func(t *testing.T) {
			if point == "K5" {
				cluster := newFaultPostgres(t)
				t.Setenv("SMITHERS_TEST_DATABASE_URL", cluster.url)
				runTodoHostRecordedCrossing(t, point, cluster)
			} else {
				runTodoHostRecordedCrossing(t, point, nil)
			}
		})
	}
}

func runTodoHostRecordedCrossing(t *testing.T, point string, cluster *faultPostgres) {
	t.Helper()
	enable := "SMITHERS_TODO_HOST_KILL"
	if os.Getenv("SMITHERS_FAULT_HOST") == "reference" {
		require.NotEmpty(t, os.Getenv("SMITHERS_FAULT_INSTALL_BUNDLE"))
		t.Setenv("SMITHERS_CHECK_BUNDLE", os.Getenv("SMITHERS_FAULT_INSTALL_BUNDLE"))
		t.Setenv(pinnedMicroVMRehearsal, "1")
		enable = pinnedMicroVMRehearsal
	}
	r := newRehearsal(t, enable, "C-DUR-01", "host-"+point+"-", 25)
	services := prepareTodoFaultServices(t, r)
	if point == "K3" {
		seedTodoFaultCheck(t, r, enable == pinnedMicroVMRehearsal)
	}
	require.True(t, r.install("Install through Machine ready"))
	var worker *githubKillProcess
	if enable == pinnedMicroVMRehearsal {
		// Reuse the existing owned production worker controller. The HTTP door
		// and recorded provider stay reachable while the install worker dies.
		r.options.Duties = DutiesHTTP
		r.restartBackend()
		worker = githubKillWorker(t, r, r.fake.URL, r.repositoryRoot, time.Minute)
		defer worker.close()
	}
	t.Run("crossing", func(t *testing.T) {
		runTodoHostRecordedCrossingBody(t, r, point, cluster, services, worker)
	})
}

func runTodoHostRecordedCrossingBody(t *testing.T, r *rehearsal, crossing string, cluster *faultPostgres, services *todoFaultServices, worker *githubKillProcess) {
	point := crossing
	machine := crossing == "M1" || crossing == "M2"
	if crossing == "M1" {
		point = "K2"
	}
	if crossing == "M2" {
		point = "K3"
	}
	if point == "K1" {
		_, err := r.pool.Exec(r.ctx, `CREATE FUNCTION host_fault_hold_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.checks ? 'planReceipt' AND NOT (OLD.checks ? 'planReceipt') THEN
    PERFORM set_config('application_name','fr16-flw09-plan-projection',false); PERFORM pg_sleep(300);
   END IF; RETURN NEW; END $$;
   CREATE TRIGGER host_fault_hold_plan BEFORE UPDATE ON mythical_items FOR EACH ROW EXECUTE FUNCTION host_fault_hold_plan()`)
		require.NoError(t, err)
	}

	prompt := "[HOLD host-fault] [FILE JOURNEY.md] Append a greeting to JOURNEY.md."
	if point == "K3" {
		prompt = "[FILE JOURNEY.md] Append a greeting to JOURNEY.md."
	}
	if point == "K4" {
		prompt = "[ASK] " + prompt
	}
	number, err := r.file("Recover interrupted TODO", prompt)
	require.NoError(t, err)
	if point == "K3" && r.processRuntime != nil {
		defer watchTodoFaultCheck(t, r, number, services)()
	}
	var projectionPID int
	if point == "K1" {
		require.Eventually(t, func() bool {
			err := r.pool.QueryRow(r.ctx, `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='fr16-flw09-plan-projection' AND wait_event='PgSleep' LIMIT 1`).Scan(&projectionPID)
			return err == nil && projectionPID > 0
		}, 3*time.Minute, 100*time.Millisecond, "completed plan never reached its uncommitted projection")
	} else if point == "K3" {
		select {
		case <-services.checkReached:
		case <-time.After(4 * time.Minute):
			t.Fatal("test never reached its recorded immutable-source crossing")
		}
		require.EqualValues(t, 1, services.checkCalls.Load())
	} else if point == "K4" {
		_, err = r.waitTodoWithin(number, 3*time.Minute, "needs_you")
	} else {
		err = r.waitHeld("host-fault", 3*time.Minute)
	}
	require.NoError(t, err)
	before, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, before.Run)
	require.NotNil(t, before.FlowVersion)
	beforeSteps := livePauseModelSteps(t, r)
	require.Equal(t, 1, beforeSteps["route"])
	if point == "K2" || point == "K5" {
		require.Equal(t, 1, beforeSteps["coding/edit-atom"])
	}
	workspace, service, err := r.todoHostBinding(number)
	require.NoError(t, err)
	save := func(name string, value any) {
		raw, err := json.MarshalIndent(value, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, name+".json"), raw, 0600))
	}
	beforeRaw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	require.NoError(t, err)
	save("before-card", json.RawMessage(beforeRaw))
	save("before-provider", beforeSteps)
	beforeMonitor, err := r.inspect(workspace, before.Run.ID)
	require.NoError(t, err)
	require.Len(t, beforeMonitor.Attempts, 1)
	save("before-run", beforeMonitor)
	primaryCheckKey := ""
	if point == "K3" {
		// The monitor includes the check wrapper, its child, and later checks.
		// Bind the oracle to the first running primary check before the kill.
		for _, step := range beforeMonitor.Attempts[0].Steps {
			if step.Label == "Ran checks" && step.State == "running" {
				primaryCheckKey = strings.TrimSuffix(step.Key, "#1")
				require.NotEqual(t, step.Key, primaryCheckKey)
				require.Empty(t, step.Output)
				break
			}
		}
		require.NotEmpty(t, primaryCheckKey)
	}
	var heldMessages []byte
	if point == "K2" || point == "K5" {
		turns, err := r.modelTurns()
		require.NoError(t, err)
		for _, turn := range turns {
			if turn["step"] == "coding/edit-atom" {
				require.NotNil(t, turn["all"], "provider must record request identity")
				heldMessages, err = json.Marshal(turn["all"])
				require.NoError(t, err)
			}
		}
		require.NotEmpty(t, heldMessages)
	}
	if machine {
		_, d2 := activateWatchdogOverride(t, r, `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("todo", { description: "D2 must never run", capabilities: [], modelInvocable: false,
 effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
 payload: {}, success: Schema.String, body: () => Node.succeed("D2") })`)
		require.NotEqual(t, before.FlowVersion.Digest, d2)
	}
	killedAt := time.Now()
	if point == "K5" {
		cluster.kill(t)
		t.Logf("CRASH-POINT %s subject todo", crossing)
		cluster.start(t)
	} else if worker != nil {
		worker.kill(t)
		t.Logf("CRASH-POINT %s subject todo", crossing)
	} else if machine {
		faultprocess.KillMachine(t, r.workspaceStateRoot, workspace, os.Getenv("SMITHERS_CHECK_BUNDLE"))
		t.Logf("CRASH-POINT %s subject todo", crossing)
	} else {
		host, err := r.processRuntime.InspectService(r.ctx, workspace, service)
		require.NoError(t, err)
		require.Positive(t, host.PID)
		require.NoError(t, syscall.Kill(-host.PID, syscall.SIGKILL))
		t.Logf("CRASH-POINT %s subject todo", crossing)
	}
	if point == "K1" {
		var terminated bool
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pg_terminate_backend($1)`, projectionPID).Scan(&terminated))
		require.True(t, terminated)
		_, err := r.pool.Exec(r.ctx, `DROP TRIGGER host_fault_hold_plan ON mythical_items; DROP FUNCTION host_fault_hold_plan()`)
		require.NoError(t, err)
	}
	// Release the owned provider response after the fault so HTTP drain does
	// not confuse a deliberately unresolved SSE call with restart failure.
	require.NoError(t, r.release("host-fault"))
	if point != "K5" {
		if worker != nil {
			recovered := githubKillWorker(t, r, r.fake.URL, r.repositoryRoot, time.Minute)
			defer recovered.close()
		} else if point != "K3" {
			r.restartBackend()
		}
		// K3 kills the coding host during a check. Its dispatcher restarts
		// that service on the retained machine; the backend and native daemon
		// stay up. Their own kill points qualify their separate recovery.
	}
	if point == "K4" {
		recovered, err := r.waitTodoWithin(number, time.Minute, "needs_you")
		require.NoError(t, err)
		require.Equal(t, before.Run.ID, recovered.Run.ID)
		require.Len(t, before.Waits, 1)
		require.Len(t, recovered.Waits, 1)
		require.Equal(t, before.Waits[0].ID, recovered.Waits[0].ID)
		var beforeWait, afterWait struct {
			Waits []struct {
				Since string `json:"since"`
			} `json:"waits"`
		}
		require.NoError(t, json.Unmarshal(beforeRaw, &beforeWait))
		recoveredRaw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(recoveredRaw, &afterWait))
		require.Len(t, beforeWait.Waits, 1)
		require.Len(t, afterWait.Waits, 1)
		require.NotEmpty(t, beforeWait.Waits[0].Since)
		require.Equal(t, beforeWait.Waits[0].Since, afterWait.Waits[0].Since)
		body, err := json.Marshal(map[string]string{"wait": recovered.Waits[0].ID, "answer": "Use the greeting in JOURNEY.md."})
		require.NoError(t, err)
		_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d/answer", number), string(body), 202)
		require.NoError(t, err)
	}
	require.NoError(t, r.release("host-fault"))
	recoveryBudget := 4 * time.Minute
	if machine {
		recoveryBudget = time.Until(killedAt.Add(time.Minute))
		require.Positive(t, recoveryBudget)
	}
	after, err := r.waitTodoWithin(number, recoveryBudget, "in_review", "failed")
	require.NoError(t, err)
	require.Equal(t, before.Run.ID, after.Run.ID)
	require.Equal(t, before.Run.Attempt, after.Run.Attempt)
	require.Equal(t, before.FlowVersion.Digest, after.FlowVersion.Digest)
	if machine {
		require.Equal(t, "in_review", after.State, "model and sealed-check recovery must resume")
		retainedWorkspace, _, err := r.todoHostBinding(number)
		require.NoError(t, err)
		require.Equal(t, workspace, retainedWorkspace, "recovery must retain the machine disk")
	}
	steps := livePauseModelSteps(t, r)
	modelRequestCalls := 0
	require.Equal(t, 1, steps["route"], "the completed route must not be redispatched")
	if point != "K4" {
		require.Equal(t, 1, steps["coding/draft-plan"], "the completed plan must not be redispatched")
		if point == "K3" {
			// The interrupted check runs twice; final-history and the separately
			// launched verifier each run their own check (E-19).
			require.EqualValues(t, 4, services.checkCalls.Load(), "replay plus final-history and verification checks")
			require.Equal(t, "in_review", after.State, "the rerun must produce one passing check result")
		}
		if len(heldMessages) > 0 {
			turns, err := r.modelTurns()
			require.NoError(t, err)
			calls := 0
			for _, turn := range turns {
				messages, err := json.Marshal(turn["all"])
				require.NoError(t, err)
				if turn["step"] == "coding/edit-atom" && string(messages) == string(heldMessages) {
					calls++
				}
			}
			require.LessOrEqual(t, calls, 2, "the same in-flight request may be reissued at most once")
			require.Positive(t, calls)
			modelRequestCalls = calls
			save("model-request-calls", calls)
		}
	}
	card, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	require.NoError(t, err)
	if after.State == "failed" {
		var projection map[string]any
		require.NoError(t, json.Unmarshal(card, &projection))
		failure, ok := projection["failure"].(map[string]any)
		require.True(t, ok, string(card))
		require.Equal(t, "interrupted", failure["class"], string(card))
		require.Equal(t, true, failure["retryable"], string(card))
	}
	var facts json.RawMessage
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.sequence), '[]'::jsonb) FROM product_job_events e WHERE e.principal_id=(SELECT 'todo:'||id::text FROM mythical_items WHERE number=$1 AND repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository'))`, number).Scan(&facts))
	save("after-card", json.RawMessage(card))
	save("after-provider", steps)
	save("product-events", facts)
	require.NotEqual(t, "[]", string(facts), "the served terminal state needs durable facts")
	var terminalFact string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT state FROM product_job_events WHERE principal_id=(SELECT 'todo:'||id::text FROM mythical_items WHERE number=$1 AND repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')) AND event_type LIKE 'todo.%' ORDER BY sequence DESC LIMIT 1`, number).Scan(&terminalFact))
	require.Equal(t, after.State, terminalFact, "served state must already have its committed TODO fact")
	afterMonitor, err := r.inspect(workspace, before.Run.ID)
	require.NoError(t, err, "the served run projection must preserve the recovered attempt")
	require.Len(t, afterMonitor.Attempts, 1)
	save("after-run", afterMonitor)
	completed := 0
	for _, prior := range beforeMonitor.Attempts[0].Steps {
		if prior.State != "completed" {
			continue
		}
		completed++
		matched := 0
		for _, step := range afterMonitor.Attempts[0].Steps {
			if step.Key != prior.Key {
				continue
			}
			matched++
			require.Equal(t, "completed", step.State)
			require.Equal(t, prior.EndedAt, step.EndedAt, "finished step cannot acquire a new completion")
			if len(prior.Output) == 0 {
				require.Empty(t, step.Output)
			} else {
				require.JSONEq(t, string(prior.Output), string(step.Output))
			}
		}
		require.Equal(t, 1, matched, "finished step must retain exactly one observation")
	}
	require.Positive(t, completed, "the fault must follow a completed step")
	if point == "K3" {
		results := 0
		for _, step := range afterMonitor.Attempts[0].Steps {
			var preview string
			if !strings.HasPrefix(step.Key, primaryCheckKey+"#") || json.Unmarshal(step.Output, &preview) != nil {
				continue
			}
			receipt := j11Receipt.FindStringSubmatch(preview)
			if len(receipt) == 3 && receipt[1] == "test" {
				require.Equal(t, "passed", receipt[2])
				require.Equal(t, primaryCheckKey+"#2", step.Key, "the interrupted primary check must replay exactly once")
				require.Equal(t, "completed", step.State)
				results++
			}
		}
		require.Equal(t, 1, results, "exactly one test receipt must be accepted")
	}
	observation := map[string]any{"point": crossing, "subject": "todo", "completedRouteCalls": 1, "newAttempts": 0, "terminal": after.State}
	if point == "K3" {
		observation["checkCalls"] = services.checkCalls.Load()
		observation["acceptedCheckResults"] = 1
	}
	if modelRequestCalls > 0 {
		observation["modelRequestCalls"] = modelRequestCalls
	}
	if point == "K4" {
		observation["waitPreserved"] = true
	}
	raw, err := json.Marshal(observation)
	require.NoError(t, err)
	t.Log("CRASH-OBSERVATION " + string(raw))
}

// External fault dependencies share the rehearsal listener's guest-forwarded
// port; all ordinary requests still enter the unmodified production router.
// Mount before setup launches any host, and retain the fixture over restart.
type todoFaultServices struct {
	checkCalls   atomic.Int32
	checkReached chan struct{}
	writeReached chan struct{}
	release      chan struct{}
	mu           sync.Mutex
	writeLog     []string
	written      bool
}

func prepareTodoFaultServices(t *testing.T, r *rehearsal) *todoFaultServices {
	t.Helper()
	fixture := &todoFaultServices{checkReached: make(chan struct{}), writeReached: make(chan struct{}), release: make(chan struct{})}
	original := r.server.Config.Handler
	r.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/fault/check":
			if fixture.checkCalls.Add(1) == 1 {
				close(fixture.checkReached)
				select {
				case <-fixture.release:
				case <-req.Context().Done():
					return
				}
			}
			_, _ = w.Write([]byte("passed"))
		case "/fault/write":
			fixture.mu.Lock()
			fixture.writeLog = append(fixture.writeLog, req.Method)
			written := fixture.written
			if req.Method == "POST" && !written {
				fixture.written = true
				close(fixture.writeReached)
			}
			fixture.mu.Unlock()
			if req.Method == "POST" && !written {
				select {
				case <-fixture.release:
				case <-req.Context().Done():
					return
				}
			}
			if written || req.Method == "POST" {
				_, _ = w.Write([]byte("found"))
			} else {
				_, _ = w.Write([]byte("absent"))
			}
		default:
			original.ServeHTTP(w, req)
		}
	})
	t.Cleanup(func() { close(fixture.release) })
	return fixture
}

// The native check sandbox closes all sockets. Control its real subprocess
// through new files in its disposable immutable export, never by opening the
// network or modifying tracked source. The microVM keeps the HTTP fixture.
func watchTodoFaultCheck(t *testing.T, r *rehearsal, number int64, fixture *todoFaultServices) func() {
	t.Helper()
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		seen := map[string]bool{}
		var checkRoot string
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if checkRoot == "" {
					workspace, _, err := r.todoHostBinding(number)
					if err != nil {
						continue
					}
					observed, err := r.processRuntime.InspectWorkspace(t.Context(), workspace)
					if err != nil {
						continue
					}
					checkRoot = filepath.Join(observed.Root, ".jj", "smithers-checks")
				}
				_ = filepath.WalkDir(checkRoot, func(path string, entry fs.DirEntry, err error) error {
					if err != nil || entry.IsDir() || entry.Name() != ".fault-check-started" || seen[path] {
						return nil
					}
					seen[path] = true
					if fixture.checkCalls.Add(1) == 1 {
						close(fixture.checkReached)
					} else if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".fault-check-release"), []byte("passed"), 0600); err != nil {
						t.Errorf("release recorded check: %v", err)
					}
					return nil
				})
			}
		}
	}()
	return func() { close(stop); <-done }
}

func seedTodoFaultCheck(t *testing.T, r *rehearsal, machine bool) {
	t.Helper()
	endpoint := r.origin + "/fault/check"
	if machine {
		endpoint = strings.Replace(endpoint, "127.0.0.1", "host.microsandbox.internal", 1)
	}
	seed := filepath.Join(r.gitRoot, "seed")
	if machine {
		require.NoError(t, os.Remove(filepath.Join(seed, "Makefile")))
		require.NoError(t, os.WriteFile(filepath.Join(seed, "package.json"), []byte(`{"packageManager":"pnpm@9.15.4","scripts":{"test":"node fault-check.mjs","lint":"node -e \"process.exit(0)\""}}`), 0600))
		require.NoError(t, os.WriteFile(filepath.Join(seed, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\nimporters:\n  .: {}\n"), 0600))
		script := fmt.Sprintf("const response = await fetch(%q);\nif (!response.ok || await response.text() !== 'passed') throw new Error('check failed');\n", endpoint)
		require.NoError(t, os.WriteFile(filepath.Join(seed, "fault-check.mjs"), []byte(script), 0600))
	} else {
		// The host rehearsal cannot build a toolchain image. Exercise the same
		// immutable check crossing with the base image's Makefile detector.
		require.NoError(t, os.WriteFile(filepath.Join(seed, "Makefile"), []byte("test:\n\t/usr/bin/python3 fault-check.py\n"), 0600))
		script := "from pathlib import Path\nfrom time import sleep\nPath('.fault-check-started').write_text('started')\nwhile not Path('.fault-check-release').exists():\n    sleep(0.05)\nassert Path('.fault-check-release').read_text() == 'passed'\n"
		require.NoError(t, os.WriteFile(filepath.Join(seed, "fault-check.py"), []byte(script), 0600))
	}
	git := func(args ...string) string {
		command := exec.Command("/usr/bin/git", append([]string{"-C", seed}, args...)...)
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	git("add", "-A")
	git("-c", "user.name=Rehearsal", "-c", "user.email=owner@example.test", "commit", "-m", "Recorded immutable test crossing")
	git("push", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), "HEAD:refs/heads/main")
	r.mainCommit = git("rev-parse", "HEAD")
}
