package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

// Literal Active todo flow digests; the second becomes Active mid-test.
var (
	todoPinOne = strings.Repeat("d1", 32)
	todoPinTwo = strings.Repeat("d2", 32)
)

// newTodoAdmission is the stack orchestration with its account as the
// install owner, and that owner's browser session for filing TODOs.
func newTodoAdmission(t *testing.T) (*mythicalOrchestration, context.Context) {
	t.Helper()
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	_, err := o.pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, o.userID)
	require.NoError(t, err)
	return o, middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: o.userID}, SessionHash: "owner-session"})
}

// fileTodo files an owner's TODO through the public creation path.
func (o *mythicalOrchestration) fileTodo(session context.Context, request string) db.MythicalItem {
	o.t.Helper()
	view, err := o.service.FileTodo(session, o.repoID, o.userID, MythicalTodoInput{Title: "Add a greeting",
		Prompt: "Add a greeting to JOURNEY.md", Acceptance: []string{"JOURNEY.md greets the reader"}, Request: request})
	require.NoError(o.t, err)
	require.Equal(o.t, "queued", view.TodoState)
	return o.byID(view.ID)
}

func (o *mythicalOrchestration) byID(id string) db.MythicalItem {
	o.t.Helper()
	parsed, err := uuid.Parse(id)
	require.NoError(o.t, err)
	item, err := db.New(o.pool).GetMythicalItem(context.Background(), pgtype.UUID{Bytes: parsed, Valid: true})
	require.NoError(o.t, err)
	return item
}

// projectTodo reports the composition's run as the dispatcher does: its run
// ID and the execution digest of the flow the runtime planned.
func (o *mythicalOrchestration) projectTodo(request flowdispatch.LaunchRequest, state jobs.State, runID, digest, output string) {
	o.t.Helper()
	update := flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: runID,
		ExecutionDigest: digest, Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output}}}
	require.NoError(o.t, o.service.ProjectFlowRuntime(context.Background(), update))
}

// runDispatcher composes the real flowdispatch service over resolver as the
// stack's launcher; start runs its fenced worker until the test ends.
func (o *mythicalOrchestration) runDispatcher(t *testing.T, resolver flowruntime.FlowRuntimeResolver) (pool *pgxpool.Pool, start func()) {
	t.Helper()
	pool = o.pool.(*pgxpool.Pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: o.service, ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond,
		Resolver: resolver})
	require.NoError(t, err)
	o.service.SetLauncher(dispatcher)
	return pool, func() {
		workerCtx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "todo-" + uuid.NewString(), Capacity: 2, Lease: 2 * time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
		}()
		t.Cleanup(func() {
			cancel()
			select {
			case err := <-done:
				require.NoError(t, err)
			case <-time.After(5 * time.Second):
				t.Error("worker did not stop")
			}
		})
	}
}

func decodeJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

// A fresh attempt of an owner's TODO places a lane, retains the stack tip
// into it and launches the todo composition, pinned to the Active digest, in
// the transaction that records the attempt: Starting. The host accepting the
// run is Working. Retry keeps the pin even after another digest is Active.
func TestTodoOwnerAdmissionLaunchesThePinnedComposition(t *testing.T) {
	o, session := newTodoAdmission(t)
	var asked atomic.Int32
	active := todoPinOne
	o.service.SetTodoFlow(func(_ context.Context, repositoryID int64) (string, error) {
		require.Equal(t, o.repoID, repositoryID)
		asked.Add(1)
		return active, nil
	})
	item := o.fileTodo(session, "first")
	require.Zero(t, item.Attempt)

	o.wake()
	// An attempt starts from main's tip (the available prefix), not the
	// stack bookmark.
	tip := o.hostRef("refs/heads/main")
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "running", item.State, item.Reason)
	require.Equal(t, "starting", todoState(item))
	require.EqualValues(t, 1, item.Attempt)
	require.EqualValues(t, 1, item.Generation)
	require.Equal(t, pgtype.Text{String: todoPinOne, Valid: true}, item.FlowDigest)
	require.Equal(t, tip, item.BaseCommit)
	checks := mythicalChecksOf(item)
	require.True(t, checks.RunLaunched)
	require.False(t, checks.RunAttached)
	require.EqualValues(t, 1, checks.Launches)
	require.Contains(t, o.lanes.created, item.WorkspaceID)
	require.Empty(t, o.launcher.byFlow("coding/request"), "no legacy request admission")

	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	launch := launches[0]
	id := uuidString(item.ID)
	require.Equal(t, "mythical:"+id+":1:todo:1", launch.RequestID)
	require.Equal(t, item.WorkspaceID, launch.Target.WorkspaceID)
	require.Equal(t, flowdispatch.ApprovalAuto, launch.ApprovalPolicy)
	payload := decodeJSON(t, launch.Payload)
	require.Equal(t, "Add a greeting\n\nAdd a greeting to JOURNEY.md\n\nAcceptance:\n- JOURNEY.md greets the reader\n", payload["prompt"])
	require.EqualValues(t, 3, payload["maxRounds"])
	ref := repohost.WorkspaceSourceRef(item.WorkspaceID, tip)
	require.Equal(t, map[string]any{"commitId": tip, "ref": ref}, payload["base"])
	require.Equal(t, tip, o.hostRef(ref), "the tip reached the lane before the launch")
	require.Equal(t, map[string]any{"repositoryId": float64(o.repoID), "userId": float64(o.userID), "workspaceId": item.WorkspaceID,
		"itemId": id, "generation": float64(1), "attempt": float64(1), "flowDigest": todoPinOne}, decodeJSON(t, launch.AuthorizationContext))
	require.Equal(t, map[string]any{"kind": mythicalBindingKind, "itemId": id, "generation": float64(1), "attempt": float64(1),
		"phase": "todo", "flowDigest": todoPinOne}, decodeJSON(t, launch.Projection))

	// Duplicate wakes launch nothing more while the run is in flight.
	o.wake()
	o.wake()
	require.Len(t, o.launcher.byFlow("todo"), 1)

	// Stale observations change nothing: another pin, another attempt.
	other := launch
	other.Projection = []byte(strings.Replace(string(launch.Projection), todoPinOne, todoPinTwo, 1))
	o.projectTodo(other, jobs.StateWaiting, "foreign-run", todoPinTwo, "")
	earlier := launch
	earlier.Projection = []byte(strings.Replace(string(launch.Projection), `"attempt":1`, `"attempt":2`, 1))
	o.projectTodo(earlier, jobs.StateWaiting, "future-run", todoPinOne, "")
	require.Equal(t, "starting", todoState(o.byID(id)))

	// The host accepted the run: Working, bound to that run only.
	o.projectTodo(launch, jobs.StateWaiting, "todo-run-1", todoPinOne, "")
	item = o.byID(id)
	require.Equal(t, "working", todoState(item))
	require.Equal(t, "todo-run-1", item.RequestRunID)
	o.projectTodo(launch, jobs.StateWaiting, "replacement-run", todoPinOne, "")
	require.Equal(t, "todo-run-1", o.byID(id).RequestRunID, "the first bound run wins")

	// Success alone is not a proposal: the attempt fails no_proposal and
	// retries; the stack's candidate and propose operations never ran.
	o.projectTodo(launch, jobs.StateCompleted, "todo-run-1", todoPinOne, `{}`)
	o.wake()
	item = o.byID(id)
	require.Equal(t, "retrying", item.State, item.Reason)
	require.Equal(t, &mythicalFault{Class: "factory", Tag: "no_proposal", Kind: mythicalFailPlan}, mythicalChecksOf(item).Fault)
	first := item.WorkspaceID

	// Another digest is Active now; the retry keeps the attempt's pin.
	active = todoPinTwo
	o.wake()
	item = o.byID(id)
	require.Equal(t, "running", item.State, item.Reason)
	require.Equal(t, "starting", todoState(item))
	require.EqualValues(t, 2, item.Attempt)
	require.Equal(t, todoPinOne, item.FlowDigest.String)
	require.EqualValues(t, 1, asked.Load(), "a pinned attempt never asks for the Active digest again")
	require.Contains(t, o.lanes.deleted, first, "the failed attempt's lane is retired before the next opens")
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 2)
	require.Equal(t, "mythical:"+id+":2:todo:2", launches[1].RequestID)
	require.Equal(t, todoPinOne, decodeJSON(t, launches[1].AuthorizationContext)["flowDigest"])
	require.EqualValues(t, 2, decodeJSON(t, launches[1].AuthorizationContext)["attempt"])
}

// T-FLW-11 dark admission for owner TODOs: each missing provider refuses
// before placement, lane, capture, launch or GitHub write, and keeps the
// TODO queued with its attempt; the positive control launches.
func TestTodoDarkAdmissionOwnerProviders(t *testing.T) {
	missing := []struct {
		name   string
		reason string
		bind   func(o *mythicalOrchestration)
	}{
		{name: "no provider", reason: "TODO admission unavailable", bind: func(o *mythicalOrchestration) {}},
		{name: "isolated dispatch", reason: "TODO admission unavailable", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })
			o.service.launcher = nil
		}},
		{name: "lane machines", reason: "TODO admission unavailable", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })
			o.service.lanes = nil
		}},
		{name: "invalid digest", reason: "TODO admission unavailable: the pinned todo flow is invalid", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return "flow-one", nil })
		}},
	}
	for _, provider := range []string{"isolated guest dispatch (T-FLW-01)", "retained wake (T-MCH-14)", "candidate authorization (T-STK-12)",
		"outbound recovery (T-GH-09)", "validated root startup (T-SEC-01)", "pinned source loading (T-FLW-03)"} {
		missing = append(missing, struct {
			name   string
			reason string
			bind   func(o *mythicalOrchestration)
		}{name: provider, reason: "TODO admission unavailable: " + provider + " is not integrated", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64) (string, error) {
				return "", errors.New(provider + " is not integrated")
			})
		}})
	}
	for _, test := range missing {
		t.Run(test.name, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			test.bind(o)
			item := o.fileTodo(session, "dark")
			o.wake()
			o.wake()
			refused := o.byID(uuidString(item.ID))
			require.Equal(t, "queued", refused.State)
			require.Equal(t, test.reason, refused.Reason)
			require.Equal(t, "queued", todoState(refused))
			require.Zero(t, refused.Attempt)
			require.Empty(t, refused.WorkspaceID)
			require.False(t, refused.FlowDigest.Valid)
			require.False(t, mythicalChecksOf(refused).RunLaunched)
			require.Empty(t, o.launcher.requests, "no run was admitted")
			require.Empty(t, o.lanes.created, "no lane was placed")
			var lanes int
			require.NoError(t, o.pool.QueryRow(context.Background(), `SELECT count(*) FROM mythical_lanes WHERE repository_id=$1`, o.repoID).Scan(&lanes))
			require.Zero(t, lanes)
			require.Empty(t, o.git(o.hostDir, "for-each-ref", "--format=%(refname)", "refs/smithers/workspaces/"), "nothing was captured")
			o.github.mu.Lock()
			require.Empty(t, o.github.pulls, "no GitHub write")
			o.github.mu.Unlock()
		})
	}
	t.Run("positive control", func(t *testing.T) {
		o, session := newTodoAdmission(t)
		o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })
		item := o.fileTodo(session, "control")
		o.wake()
		require.Equal(t, "starting", todoState(o.byID(uuidString(item.ID))))
		require.Len(t, o.launcher.byFlow("todo"), 1)
	})
	t.Run("a lost launch leaves the attempt unadmitted", func(t *testing.T) {
		o, session := newTodoAdmission(t)
		o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })
		o.launcher.fail = 1
		item := o.fileTodo(session, "lost")
		o.wake()
		refused := o.byID(uuidString(item.ID))
		require.Equal(t, "queued", refused.State)
		require.Zero(t, refused.Attempt)
		require.False(t, mythicalChecksOf(refused).RunLaunched)
		require.Empty(t, o.launcher.requests)
		o.wake()
		require.Len(t, o.launcher.byFlow("todo"), 1, "the next pass admits it once")
		require.Equal(t, "starting", todoState(o.byID(uuidString(item.ID))))
	})
}

// todoRuntimeHost is a controlled runtime protocol peer: provider execution
// is not under test. PostgreSQL admission, the HTTP bridge, the fenced
// worker and product projection all run for real.
type todoRuntimeHost struct {
	mu       sync.Mutex
	launches []map[string]any
	// digest is the execution digest the host reports for a todo launch:
	// the flow it planned.
	digest string
}

func (h *todoRuntimeHost) serve(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		identity := flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"runtimeBridge": identity})
			return
		}
		var input map[string]any
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var value map[string]any
		if r.URL.Path == "/runtime/v1/observe" {
			runID, _ := input["runId"].(string)
			flowID := "todo"
			if strings.HasPrefix(runID, "review-") {
				flowID = mythicalReviewFlow
			}
			value = map[string]any{"run": flowruntime.Run{RunID: runID, FlowID: flowID, Status: "running"}, "events": []any{}, "nextCursor": "", "hasMore": false, "terminal": false}
		} else {
			operation, _ := input["operation"].(string)
			runID := "todo-run"
			if operation == "launch" {
				h.mu.Lock()
				h.launches = append(h.launches, input)
				h.mu.Unlock()
				if input["flowId"] == mythicalReviewFlow {
					runID = "review-run"
				}
			}
			value = map[string]any{"operation": operation, "applicationRequestId": input["applicationRequestId"], "ownerGeneration": 1,
				"runtimeArtifactDigest": identity.RuntimeArtifactDigest, "sourceRevision": identity.SourceRevision,
				"receipt": flowruntime.Receipt{Tag: "Accepted", RunID: runID}}
			if operation == "launch" && input["flowId"] == "todo" && h.digest != "" {
				value["executionDigest"] = h.digest
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"protocol": flowruntime.Protocol, "ok": true, "value": value})
	}))
	t.Cleanup(server.Close)
	return server
}

// resolver reaches the host through the real HTTP runtime bridge.
func (h *todoRuntimeHost) resolver(t *testing.T) flowruntime.FlowRuntimeResolver {
	t.Helper()
	bridge, err := runtimebridge.New(runtimebridge.Config{Endpoint: h.serve(t).URL, Credential: "fixture-token"})
	require.NoError(t, err)
	return flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return bridge, nil })
}

func (h *todoRuntimeHost) flows() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, launch := range h.launches {
		flowID, _ := launch["flowId"].(string)
		out = append(out, flowID)
	}
	return out
}

// TestTodoPinnedEngineLaunches (C-STK-06) enters production stack admission
// and the real flowdispatch AdmitInTx and Handle: the attempt launches the
// todo composition, the TODO goes Starting then Working only from the host's
// acceptance, and the engine's review launch of that attempt carries the
// same pin. No coding/request or coding/vibe run is admitted.
func TestTodoPinnedEngineLaunches(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	peer := &todoRuntimeHost{digest: todoPinOne}
	pool, startWorker := o.runDispatcher(t, peer.resolver(t))
	o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })

	item := o.fileTodo(session, "pinned")
	id := uuidString(item.ID)
	o.wake()
	tip := o.hostRef("refs/heads/main")
	item = o.byID(id)
	require.Equal(t, "starting", todoState(item), item.Reason)
	admitted := func(flowID string) []map[string]any {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT payload, authorization_context FROM product_job_requests WHERE operation=$1 AND tenant_id=$2 ORDER BY created_at`,
			flowdispatch.OperationLaunch, "repository:"+strconv.FormatInt(o.repoID, 10))
		require.NoError(t, err)
		defer rows.Close()
		var out []map[string]any
		for rows.Next() {
			var payload, authorization []byte
			require.NoError(t, rows.Scan(&payload, &authorization))
			launch := decodeJSON(t, payload)
			if launch["flowId"] == flowID {
				out = append(out, map[string]any{"launch": launch, "authorization": decodeJSON(t, authorization)})
			}
		}
		require.NoError(t, rows.Err())
		return out
	}
	todo := admitted("todo")
	require.Len(t, todo, 1, "one durable admission, committed with the attempt")
	require.Equal(t, todoPinOne, todo[0]["authorization"].(map[string]any)["flowDigest"])
	require.Empty(t, admitted("coding/request"))
	require.Empty(t, admitted("coding/vibe"))

	startWorker()
	require.Eventually(t, func() bool { return todoState(o.byID(id)) == "working" }, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, "todo-run", o.byID(id).RequestRunID)
	require.Equal(t, []string{"todo"}, peer.flows(), "the host launched the composition once")

	// Stands in for T-STK-12's stack.candidate, which records exactly these
	// candidate fields: the engine pins the candidate on the prefix.
	item = o.byID(id)
	candidate := o.laneResult(item.WorkspaceID, tip, map[string]string{"JOURNEY.md": "Hello, reader.\n"}, "✨ feat: greet the reader")
	_, err := pool.Exec(ctx, `UPDATE mythical_items SET state='integrating', candidate_base=$2, candidate_head=$3, candidate_verified=true, summary='✨ feat: greet the reader' WHERE id=$1`,
		item.ID, tip, candidate)
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "proposing", o.byID(id).State)
	require.Equal(t, candidate, o.hostRef(repohost.MythicalReservedRefNS+"keep/"+candidate))
	o.wake()
	require.Equal(t, mythicalPublicationUnavailable, o.byID(id).Reason, "publication stays the PR lane's gate")
	// Stands in for that lane's publication: the pull request is open at the
	// candidate. The engine follows it and launches its review.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed', pr_number=41, pr_head=$2, pr_state='open', reason='' WHERE id=$1`, item.ID, candidate)
	require.NoError(t, err)
	o.github.mu.Lock()
	if o.github.pulls == nil {
		o.github.pulls = map[int64]*mythicalPull{}
	}
	o.github.pulls[41] = &mythicalPull{Number: 41, State: "open", HeadSHA: candidate, HeadRef: "smithers/todo-1", MergeableState: "clean"}
	o.github.mu.Unlock()
	o.wake()
	item = o.byID(id)
	require.Equal(t, "proposed", item.State, item.Reason)
	review := admitted(mythicalReviewFlow)
	require.Len(t, review, 1)
	require.Equal(t, todoPinOne, review[0]["authorization"].(map[string]any)["flowDigest"], "the engine review carries the attempt's pin")
	require.EqualValues(t, 1, review[0]["authorization"].(map[string]any)["attempt"])
	projection := review[0]["launch"].(map[string]any)["projection"].(map[string]any)
	require.Equal(t, "review", projection["phase"])
	require.Equal(t, todoPinOne, projection["flowDigest"])
	require.Eventually(t, func() bool { return len(peer.flows()) == 2 }, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, []string{"todo", mythicalReviewFlow}, peer.flows())
	require.Empty(t, admitted("coding/request"))
	require.Empty(t, admitted("coding/vibe"))
}

// A run whose execution digest is not its attempt's pin, or names none, is
// never the attempt's run: the TODO never shows Working for it, and the
// attempt settles as an outage that spends no attempt. Production stack
// admission, the real dispatcher and the HTTP bridge run for real.
func TestTodoRunOfAnotherFlowIsNeverTheAttempts(t *testing.T) {
	for name, digest := range map[string]string{"another flow": todoPinTwo, "no digest": ""} {
		t.Run(name, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			peer := &todoRuntimeHost{digest: digest}
			_, startWorker := o.runDispatcher(t, peer.resolver(t))
			o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })
			id := uuidString(o.fileTodo(session, "pinned").ID)
			o.wake()
			require.Equal(t, "starting", todoState(o.byID(id)))
			startWorker()
			require.Eventually(t, func() bool { return o.byID(id).RequestOutcome != "" }, 10*time.Second, 10*time.Millisecond)
			item := o.byID(id)
			require.Equal(t, mythicalOutage+"infra: "+mythicalPinMismatch, item.RequestOutcome)
			require.Empty(t, item.RequestRunID, "the run was never bound")
			require.False(t, mythicalChecksOf(item).RunAttached)
			require.Equal(t, "starting", todoState(item), "never Working")
			require.Equal(t, []string{"todo"}, peer.flows())

			o.wake()
			item = o.byID(id)
			require.Equal(t, "retrying", item.State, item.Reason)
			require.Zero(t, item.Attempt, "an outage spends no attempt")
			require.Equal(t, todoPinOne, item.FlowDigest.String, "the retry keeps the pin")
			require.Equal(t, &mythicalFault{Class: "infra", Tag: mythicalPinMismatch, Kind: mythicalFailRuntime}, mythicalChecksOf(item).Fault)
		})
	}
}

// A launch the dispatcher refuses before any run exists (its fail() path)
// settles the attempt instead of leaving it Starting with nothing to wait
// for: each refusal is an outage that relaunches without spending the
// attempt or binding a run, a duplicate report changes nothing, and past the
// outage bound the TODO is Failed.
func TestTodoLaunchRefusedBeforeItsRunLeavesStarting(t *testing.T) {
	o, session := newTodoAdmission(t)
	var resolved atomic.Int32
	_, startWorker := o.runDispatcher(t, flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		resolved.Add(1)
		return nil, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}))
	o.service.SetTodoFlow(func(context.Context, int64) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "refused").ID)
	o.wake()
	require.Equal(t, "starting", todoState(o.byID(id)))
	startWorker()
	refusal := mythicalOutage + "infra: runtime_target_forbidden"
	require.Eventually(t, func() bool { return o.byID(id).RequestOutcome != "" }, 10*time.Second, 10*time.Millisecond)
	item := o.byID(id)
	require.Equal(t, refusal, item.RequestOutcome)
	require.Empty(t, item.RequestRunID)
	// A second report of the same launch changes nothing.
	again := flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{FailureCode: "runtime_conflict",
		Projection: []byte(`{"kind":"` + mythicalBindingKind + `","itemId":"` + id + `","generation":1,"attempt":1,"phase":"todo","flowDigest":"` + todoPinOne + `"}`)}}
	require.NoError(t, o.service.ProjectFlowRuntime(context.Background(), again))
	require.Equal(t, refusal, o.byID(id).RequestOutcome, "the first report settles the launch")

	// Each pass settles the refused launch and relaunches the same attempt;
	// a refusal lands within the pass, so only invariants are observed.
	for pass := 0; pass < 4*mythicalOutageBound && o.byID(id).State != "blocked"; pass++ {
		o.wake()
		require.Eventually(t, func() bool {
			item := o.byID(id)
			return item.State != "running" || item.RequestOutcome != ""
		}, 10*time.Second, 10*time.Millisecond)
		item := o.byID(id)
		require.Contains(t, []string{"running", "retrying", "blocked"}, item.State, item.Reason)
		require.Empty(t, item.RequestRunID, "no run was ever bound")
		require.NotEqual(t, "working", todoState(item))
		require.LessOrEqual(t, item.Attempt, int32(1), "an outage spends no attempt")
		if item.State == "retrying" {
			require.Equal(t, &mythicalFault{Class: "infra", Tag: "runtime_target_forbidden", Kind: mythicalFailRuntime}, mythicalChecksOf(item).Fault)
		}
	}
	item = o.byID(id)
	require.Equal(t, "blocked", item.State, item.Reason)
	require.Equal(t, "failed", todoState(item))
	checks := mythicalChecksOf(item)
	require.Equal(t, &mythicalFault{Class: "policy", Tag: "outages", Kind: mythicalFailRuntime}, checks.Fault)
	require.EqualValues(t, mythicalOutageBound+1, checks.Launches)
	require.EqualValues(t, mythicalOutageBound+1, resolved.Load(), "one refused launch per relaunch")
}
