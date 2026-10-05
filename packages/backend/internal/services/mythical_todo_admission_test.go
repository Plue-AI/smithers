package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// Literal Active todo flow digests; the second becomes Active mid-test. The
// review flow names its own execution identity.
var (
	todoPinOne   = strings.Repeat("d1", 32)
	todoPinTwo   = strings.Repeat("d2", 32)
	reviewDigest = strings.Repeat("e1", 32)
)

// landedMain is the main commit the stack folded from the mirror: the
// source a fresh attempt pins its todo flow at.
func (o *mythicalOrchestration) landedMain() string {
	o.t.Helper()
	var landed string
	require.NoError(o.t, o.pool.QueryRow(context.Background(), `SELECT landed_main FROM mythical_stacks WHERE repository_id=$1`, o.repoID).Scan(&landed))
	require.Regexp(o.t, `^[0-9a-f]{40}$`, landed)
	return landed
}

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
	update := flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: request.FlowID, Projection: request.Projection, RunID: runID,
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
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: o.service, SteerAuthorizer: o.service, ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond,
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
// into it and launches the todo composition, pinned at admission to
// (todo, main's mirrored commit, its Active digest), in the transaction that
// records the attempt: Starting. The host accepting the run is Working.
// Retry keeps the whole pin even after main moves and another digest is
// Active.
func TestTodoOwnerAdmissionLaunchesThePinnedComposition(t *testing.T) {
	o, session := newTodoAdmission(t)
	var asked atomic.Int32
	active := todoPinOne
	var sources []string
	o.service.SetTodoFlow(func(_ context.Context, repositoryID int64, source string) (string, error) {
		require.Equal(t, o.repoID, repositoryID)
		asked.Add(1)
		sources = append(sources, source)
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
	landed := o.landedMain()
	require.Equal(t, []string{landed}, sources, "the pin is chosen at main's mirrored commit")
	checks := mythicalChecksOf(item)
	require.Equal(t, landed, checks.FlowSource, "the pin's source commit is persisted")
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
	require.Equal(t, &flowruntime.Pin{Flow: "todo", SourceCommit: landed, ExecutionDigest: todoPinOne}, launch.Pin, "the launch carries the whole pin")
	payload := decodeJSON(t, launch.Payload)
	require.Equal(t, "Add a greeting\n\nAdd a greeting to JOURNEY.md\n\nAcceptance:\n- JOURNEY.md greets the reader\n", payload["prompt"])
	require.EqualValues(t, 3, payload["maxRounds"])
	ref := repohost.WorkspaceSourceRef(item.WorkspaceID, tip)
	require.Equal(t, map[string]any{"commitId": tip, "ref": ref}, payload["base"])
	require.Equal(t, tip, o.hostRef(ref), "the tip reached the lane before the launch")
	require.Equal(t, map[string]any{"repositoryId": float64(o.repoID), "userId": float64(o.userID), "workspaceId": item.WorkspaceID,
		"itemId": id, "generation": float64(1), "attempt": float64(1), "flow": "todo", "flowSource": landed, "flowDigest": todoPinOne}, decodeJSON(t, launch.AuthorizationContext))
	require.Equal(t, map[string]any{"kind": mythicalBindingKind, "itemId": id, "generation": float64(1), "attempt": float64(1),
		"phase": "todo", "flowDigest": todoPinOne, "flowSource": landed}, decodeJSON(t, launch.Projection))

	// Duplicate wakes launch nothing more while the run is in flight.
	o.wake()
	o.wake()
	require.Len(t, o.launcher.byFlow("todo"), 1)

	// Stale observations change nothing: another pin (digest or source),
	// no pin, another attempt, or a run naming another digest or none.
	other := launch
	other.Projection = []byte(strings.Replace(string(launch.Projection), todoPinOne, todoPinTwo, 1))
	o.projectTodo(other, jobs.StateWaiting, "foreign-run", todoPinTwo, "")
	moved := launch
	moved.Projection = []byte(strings.Replace(string(launch.Projection), landed, strings.Repeat("f", 40), 1))
	o.projectTodo(moved, jobs.StateWaiting, "moved-run", todoPinOne, "")
	unpinned := launch
	unpinned.Projection = []byte(strings.Replace(strings.Replace(string(launch.Projection), `,"flowDigest":"`+todoPinOne+`"`, "", 1), `,"flowSource":"`+landed+`"`, "", 1))
	o.projectTodo(unpinned, jobs.StateWaiting, "unpinned-run", todoPinOne, "")
	earlier := launch
	earlier.Projection = []byte(strings.Replace(string(launch.Projection), `"attempt":1`, `"attempt":2`, 1))
	o.projectTodo(earlier, jobs.StateWaiting, "future-run", todoPinOne, "")
	o.projectTodo(launch, jobs.StateWaiting, "wrong-digest-run", todoPinTwo, "")
	o.projectTodo(launch, jobs.StateWaiting, "no-digest-run", "", "")
	item = o.byID(id)
	require.Equal(t, "starting", todoState(item))
	require.Empty(t, item.RequestRunID)
	require.Empty(t, item.RequestOutcome, "a running mismatch settles nothing until it ends")

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

	// Another digest is Active and main moved; the retry keeps the
	// attempt's whole pin.
	active = todoPinTwo
	o.commit("✨ feat: three", "c.txt", "c\n")
	o.publish()
	o.wake()
	require.NotEqual(t, landed, o.landedMain(), "the stack folded the new main")
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
	require.Equal(t, landed, decodeJSON(t, launches[1].AuthorizationContext)["flowSource"])
	require.EqualValues(t, 2, decodeJSON(t, launches[1].AuthorizationContext)["attempt"])
	require.Equal(t, &flowruntime.Pin{Flow: "todo", SourceCommit: landed, ExecutionDigest: todoPinOne}, launches[1].Pin)
}

// Fable round 1, F5: an item's pin admits a launch, or binds a run, only
// when it is exactly a 64-hex digest with its 40-hex source commit. A
// malformed or half pin refuses the attempt before any effect and binds no
// run, even one reporting the same malformed digest.
func TestTodoItemPinMustBeExact(t *testing.T) {
	for name, set := range map[string]string{
		"empty digest":      `flow_digest=left($2, 0)`,
		"uppercase digest":  `flow_digest=upper($2)`,
		"short digest":      `flow_digest=left($2, 63)`,
		"no source commit":  `flow_digest=$2`,
		"bad source commit": `flow_digest=$2, checks=jsonb_set(checks, '{flowSource}', '"main"')`,
	} {
		t.Run(name, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			var asked atomic.Int32
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
				asked.Add(1)
				return todoPinOne, nil
			})
			item := o.fileTodo(session, "malformed")
			_, err := o.pool.Exec(context.Background(), `UPDATE mythical_items SET `+set+` WHERE id=$1`, item.ID, todoPinOne)
			require.NoError(t, err)
			o.wake()
			refused := o.byID(uuidString(item.ID))
			require.Equal(t, "queued", refused.State)
			require.Equal(t, "TODO admission unavailable: the pinned todo flow is invalid", refused.Reason)
			require.Zero(t, refused.Attempt)
			require.Empty(t, o.launcher.requests, "no run was admitted")
			require.Empty(t, o.lanes.created, "no lane was placed")
			require.Zero(t, asked.Load(), "a pinned attempt never asks for another pin")

			// A run reporting the item's own malformed values is never bound.
			_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET attempt=1, generation=1, state='running', checks=jsonb_set(checks, '{run_launched}', 'true') WHERE id=$1`, item.ID)
			require.NoError(t, err)
			current := o.byID(uuidString(item.ID))
			projection, _ := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: 1, Attempt: 1, Phase: "todo",
				FlowDigest: current.FlowDigest.String, FlowSource: mythicalChecksOf(current).FlowSource})
			o.projectTodo(flowdispatch.LaunchRequest{FlowID: "todo", Projection: projection}, jobs.StateWaiting, "malformed-run", current.FlowDigest.String, "")
			require.Empty(t, o.byID(uuidString(item.ID)).RequestRunID)
		})
	}
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
		{name: "hosted composition", reason: "TODO admission unavailable", bind: func(o *mythicalOrchestration) { o.service.todoAdmission = false }},
		{name: "isolated dispatch", reason: "TODO admission unavailable", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			o.service.launcher = nil
		}},
		{name: "lane machines", reason: "TODO admission unavailable", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			o.service.lanes = nil
		}},
		{name: "invalid digest", reason: "TODO admission unavailable: the pinned todo flow is invalid", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return "flow-one", nil })
		}},
	}
	for _, provider := range []string{"isolated guest dispatch (T-FLW-01)", "retained wake (T-MCH-14)", "candidate authorization (T-STK-12)",
		"outbound recovery (T-GH-09)", "validated root startup (T-SEC-01)", "pinned source loading (T-FLW-03)"} {
		missing = append(missing, struct {
			name   string
			reason string
			bind   func(o *mythicalOrchestration)
		}{name: provider, reason: "TODO admission unavailable: " + provider + " is not integrated", bind: func(o *mythicalOrchestration) {
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
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
		o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
		item := o.fileTodo(session, "control")
		o.wake()
		require.Equal(t, "starting", todoState(o.byID(uuidString(item.ID))))
		require.Len(t, o.launcher.byFlow("todo"), 1)
	})
	t.Run("a lost launch leaves the attempt unadmitted", func(t *testing.T) {
		o, session := newTodoAdmission(t)
		o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
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
	// cancels and denials are the runs and plans the dispatcher stopped.
	cancels, denials []string
	cancelled        map[string]bool
	// digest and review are the execution digests the host reports for a
	// todo and a review launch: the flows it planned. parked parks a todo
	// plan for approval instead of running it. source is the source commit
	// the host serves.
	digest, review, source string
	parked                 bool
}

func (h *todoRuntimeHost) serve(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		source := h.source
		if source == "" {
			source = strings.Repeat("b", 40)
		}
		identity := flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: source, OwnerGeneration: 1}
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
		h.mu.Lock()
		defer h.mu.Unlock()
		if r.URL.Path == "/runtime/v1/observe" {
			runID, _ := input["runId"].(string)
			flowID := "todo"
			if strings.HasPrefix(runID, "review-") {
				flowID = mythicalReviewFlow
			}
			status := "running"
			if h.cancelled[runID] {
				status = "cancelled"
			}
			value = map[string]any{"run": flowruntime.Run{RunID: runID, FlowID: flowID, Status: status}, "events": []any{}, "nextCursor": "", "hasMore": false, "terminal": status == "cancelled"}
		} else {
			operation, _ := input["operation"].(string)
			runID := "todo-run"
			receipt := flowruntime.Receipt{Tag: "Accepted", RunID: runID}
			switch operation {
			case "launch":
				h.launches = append(h.launches, input)
				if input["flowId"] == mythicalReviewFlow {
					receipt.RunID = "review-run"
				} else if h.parked {
					receipt = flowruntime.Receipt{Tag: "Parked", PlanID: "todo-plan", Status: "waiting-approval"}
				}
			case "cancel":
				run, _ := input["runId"].(string)
				h.cancels = append(h.cancels, run)
				if h.cancelled == nil {
					h.cancelled = map[string]bool{}
				}
				h.cancelled[run] = true
				receipt = flowruntime.Receipt{Tag: "Terminal", RunID: run, Status: "cancelled"}
			case "deny":
				h.denials = append(h.denials, "todo-plan")
				receipt = flowruntime.Receipt{Tag: "Terminal", Status: "cancelled"}
			}
			value = map[string]any{"operation": operation, "applicationRequestId": input["applicationRequestId"], "ownerGeneration": 1,
				"runtimeArtifactDigest": identity.RuntimeArtifactDigest, "sourceRevision": identity.SourceRevision, "receipt": receipt}
			if operation == "launch" {
				digest := h.digest
				if input["flowId"] == mythicalReviewFlow {
					digest = h.review
				}
				if digest != "" {
					value["executionDigest"] = digest
				}
				if receipt.Tag == "Parked" {
					value["planId"], value["approval"] = "todo-plan", map[string]any{"target": map[string]any{"_tag": "Plan", "planId": "todo-plan"}}
				}
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

// pins are the pins the host received, launch by launch.
func (h *todoRuntimeHost) pins() []any {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []any
	for _, launch := range h.launches {
		out = append(out, launch["pin"])
	}
	return out
}

func (h *todoRuntimeHost) stopped() (cancels, denials []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.cancels...), append([]string(nil), h.denials...)
}

// TestTodoPinnedEngineLaunches (C-STK-06) enters production stack admission
// and the real flowdispatch AdmitInTx and Handle: the attempt launches the
// todo composition, the TODO goes Starting then Working only from the host's
// acceptance, and the engine's review launch of that attempt carries and
// enforces the same pin: the host receives it, and a review run that names
// no execution identity is cancelled and never becomes the TODO's review.
// No coding/request or coding/vibe run is admitted.
func TestTodoPinnedEngineLaunches(t *testing.T) {
	for name, review := range map[string]string{"review names its identity": reviewDigest, "review names none": ""} {
		t.Run(name, func(t *testing.T) { todoPinnedEngineLaunches(t, review) })
	}
}

func todoPinnedEngineLaunches(t *testing.T, review string) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	peer := &todoRuntimeHost{digest: todoPinOne, review: review, source: o.landedMain()}
	pool, startWorker := o.runDispatcher(t, peer.resolver(t))
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })

	item := o.fileTodo(session, "pinned")
	id := uuidString(item.ID)
	o.wake()
	tip := o.hostRef("refs/heads/main")
	landed := o.landedMain()
	pin := map[string]any{"flow": "todo", "sourceCommit": landed, "executionDigest": todoPinOne}
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
	require.Equal(t, pin, todo[0]["launch"].(map[string]any)["pin"], "the durable launch holds the whole pin")
	require.Empty(t, admitted("coding/request"))
	require.Empty(t, admitted("coding/vibe"))
	// Before the host accepted the composition no run is the attempt's, so
	// nothing hands a result over for it.
	early := o.laneResult(item.WorkspaceID, tip, map[string]string{"EARLY.md": "x\n"}, "✨ feat: early")
	_, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: tip, Source: early, RequestRunID: "todo-run", Summary: "✨ feat: early"})
	require.ErrorContains(t, err, "not waiting for a validated result")

	startWorker()
	require.Eventually(t, func() bool { return todoState(o.byID(id)) == "working" }, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, "todo-run", o.byID(id).RequestRunID)
	require.Equal(t, []string{"todo"}, peer.flows(), "the host launched the composition once")
	require.Equal(t, []any{pin}, peer.pins(), "the host received the pin with the launch")

	// The composition's delivery child hands the request child's validated
	// result to the stack while the composition runs: the submission names
	// the composition's run, the one the attempt bound.
	item = o.byID(id)
	candidate := o.laneResult(item.WorkspaceID, tip, map[string]string{"JOURNEY.md": "Hello, reader.\n"}, "✨ feat: greet the reader")
	submission := MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: tip, Source: candidate, RequestRunID: "todo-run", Summary: "✨ feat: greet the reader"}
	other := submission
	other.RequestRunID = "another-run"
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, other)
	require.ErrorContains(t, err, "does not come from this lane's current request", "only the attempt's composition run hands its result over")
	receipt, err := o.service.SubmitLane(ctx, o.repoID, o.userID, submission)
	require.NoError(t, err)
	require.Equal(t, "integrating", receipt.State)
	item = o.byID(id)
	require.Equal(t, tip, item.CandidateBase)
	require.Equal(t, candidate, item.CandidateHead)
	require.True(t, item.CandidateVerified, "the request child's checks verified it")
	require.Equal(t, "submitted", item.VibeOutcome)
	require.Equal(t, todoPinOne, item.FlowDigest.String, "the pin stays the attempt's")
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
	reviews := admitted(mythicalReviewFlow)
	require.Len(t, reviews, 1)
	authorization := reviews[0]["authorization"].(map[string]any)
	require.Equal(t, todoPinOne, authorization["flowDigest"], "the engine review carries the attempt's pin")
	require.Equal(t, landed, authorization["flowSource"])
	require.EqualValues(t, 1, authorization["attempt"])
	launch := reviews[0]["launch"].(map[string]any)
	require.Equal(t, pin, launch["pin"])
	projection := launch["projection"].(map[string]any)
	require.Equal(t, "review", projection["phase"])
	require.Equal(t, todoPinOne, projection["flowDigest"])
	require.Equal(t, landed, projection["flowSource"])
	require.Eventually(t, func() bool { return len(peer.flows()) == 2 }, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, []string{"todo", mythicalReviewFlow}, peer.flows())
	require.Equal(t, []any{pin, pin}, peer.pins(), "the review launch carried the same pin to the host")
	if review != "" {
		require.Eventually(t, func() bool {
			current := mythicalChecksOf(o.byID(id)).Review
			return current != nil && current.RunID == "review-run"
		}, 10*time.Second, 10*time.Millisecond)
		cancels, _ := peer.stopped()
		require.Empty(t, cancels)
	} else {
		require.Eventually(t, func() bool {
			cancels, _ := peer.stopped()
			return len(cancels) == 1
		}, 10*time.Second, 10*time.Millisecond)
		cancels, _ := peer.stopped()
		require.Equal(t, []string{"review-run"}, cancels, "a review run without an execution identity is cancelled")
		require.Eventually(t, func() bool {
			current := mythicalChecksOf(o.byID(id)).Review
			return current != nil && current.Verdict != ""
		}, 10*time.Second, 10*time.Millisecond)
		current := mythicalChecksOf(o.byID(id)).Review
		require.Empty(t, current.RunID, "it never becomes the TODO's review")
		require.Equal(t, mythicalOutage+"infra: "+mythicalPinMismatch, current.Verdict, "once it ended, the review settles as an outage and runs again")
	}
	require.Empty(t, admitted("coding/request"))
	require.Empty(t, admitted("coding/vibe"))
}

// A run whose execution digest is not its attempt's pin, or names none, is
// never the attempt's run and does not keep running with its credentials:
// the dispatcher cancels it (or denies a parked plan of it), and only once it
// ended does the attempt settle, as an outage that spends no attempt. The
// TODO never shows Working for it. Production stack admission, the real
// dispatcher and the HTTP bridge run for real.
func TestTodoRunOfAnotherFlowIsNeverTheAttempts(t *testing.T) {
	for _, test := range []struct {
		name, digest string
		parked       bool
	}{
		{name: "another flow", digest: todoPinTwo},
		{name: "no digest", digest: ""},
		{name: "parked plan of another flow", digest: todoPinTwo, parked: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			// The lane's host serves its own working copy, never the main
			// commit the attempt pinned its flow at (spec §11.4.1).
			peer := &todoRuntimeHost{digest: test.digest, parked: test.parked, source: strings.Repeat("b", 40)}
			_, startWorker := o.runDispatcher(t, peer.resolver(t))
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			id := uuidString(o.fileTodo(session, "pinned").ID)
			o.wake()
			require.Equal(t, "starting", todoState(o.byID(id)))
			startWorker()
			require.Eventually(t, func() bool { return o.byID(id).RequestOutcome != "" }, 10*time.Second, 10*time.Millisecond)
			cancels, denials := peer.stopped()
			if test.parked {
				require.Equal(t, []string{"todo-plan"}, denials, "the parked plan was denied, never approved")
				require.Empty(t, cancels)
			} else {
				require.Equal(t, []string{"todo-run"}, cancels, "the run was cancelled before the attempt settled")
				require.Empty(t, denials)
			}
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
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
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
		Projection: []byte(`{"kind":"` + mythicalBindingKind + `","itemId":"` + id + `","generation":1,"attempt":1,"phase":"todo","flowDigest":"` + todoPinOne + `","flowSource":"` + o.landedMain() + `"}`)}}
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

// The install's composition admits an owner's TODO into the existing coding
// path (EnableTodoAdmission): a fresh attempt places a lane, retains main's
// tip into it and launches coding/request with the TODO's own prompt, in the
// transaction that records the attempt: Starting. The host binding the run
// is Working; the first bound run wins.
func TestTodoAdmissionLaunchesTheCodingRequest(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "install")
	id := uuidString(item.ID)

	o.wake()
	tip := o.hostRef("refs/heads/main")
	item = o.byID(id)
	require.Equal(t, "running", item.State, item.Reason)
	require.Equal(t, "starting", todoState(item))
	require.EqualValues(t, 1, item.Attempt)
	require.EqualValues(t, 1, item.Generation)
	require.False(t, item.FlowDigest.Valid, "the coding path pins no todo composition")
	require.Equal(t, tip, item.BaseCommit)
	checks := mythicalChecksOf(item)
	require.True(t, checks.RunLaunched)
	require.False(t, checks.RunAttached)
	require.Contains(t, o.lanes.created, item.WorkspaceID)
	require.Empty(t, o.launcher.byFlow("todo"))
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 1)
	launch := launches[0]
	require.Equal(t, item.WorkspaceID, launch.Target.WorkspaceID)
	require.Equal(t, flowdispatch.ApprovalAuto, launch.ApprovalPolicy)
	payload := decodeJSON(t, launch.Payload)
	require.Equal(t, "Add a greeting\n\nAdd a greeting to JOURNEY.md\n\nAcceptance:\n- JOURNEY.md greets the reader\n", payload["prompt"])
	require.EqualValues(t, 3, payload["maxRounds"])
	ref := repohost.WorkspaceSourceRef(item.WorkspaceID, tip)
	require.Equal(t, map[string]any{"commitId": tip, "ref": ref}, payload["base"])
	require.Equal(t, tip, o.hostRef(ref), "the tip reached the lane before the launch")

	// Duplicate wakes launch nothing more while the run is in flight.
	o.wake()
	o.wake()
	require.Len(t, o.launcher.byFlow("coding/request"), 1)

	// A run that names no ID binds nothing; the host's accepted run is Working.
	o.project(launch, jobs.StateWaiting, "", "")
	require.Equal(t, "starting", todoState(o.byID(id)))
	o.project(launch, jobs.StateWaiting, "request-run-1", "")
	item = o.byID(id)
	require.Equal(t, "working", todoState(item))
	require.Equal(t, "request-run-1", item.RequestRunID)
	require.True(t, mythicalChecksOf(item).RunAttached)
	o.project(launch, jobs.StateWaiting, "replacement-run", "")
	require.Equal(t, "request-run-1", o.byID(id).RequestRunID, "the first bound run wins")
}

// A TODO made from an issue (Make TODO; the label door alike) starts on the
// same coding path as an owner's: its lane is the TODO's, its run receives
// the TODO's own prompt (the member's Draft, never the issue's text), and
// its runs are TODO lifecycle facts. A label-door TODO's revision 1 is the
// issue's title and body, which its prompt states once.
func TestTodoAdmissionStartsAnIssueTodoFromItsDraft(t *testing.T) {
	o, session := newTodoAdmission(t)
	issue := mythicalIssue{Number: 7, Title: "Webhooks fail on 502", Body: "Webhooks fail on 502", URL: "https://github.com/smithersai/smithers/issues/7", State: "open", TextByMaintainer: true}
	o.github.mu.Lock()
	o.github.issues = append(o.github.issues, issue)
	o.github.mu.Unlock()
	seven := int64(7)
	view, err := o.service.FileTodo(session, o.repoID, o.userID, MythicalTodoInput{Title: "Retry webhooks", Prompt: "Retry a 502 at most 5 times.",
		Acceptance: []string{"a 502 is retried 5 times"}, Issue: &seven, IssueDigest: mythicalIssueDigest(issue), Request: "make-todo-7"})
	require.NoError(t, err)
	item := o.byID(view.ID)
	require.Equal(t, "issue", item.Source)
	require.True(t, mythicalTodo(item))
	id := uuidString(item.ID)

	o.wake()
	item = o.byID(id)
	require.Equal(t, "running", item.State, item.Reason)
	require.Equal(t, "starting", todoState(item))
	launches := o.launcher.byFlow("coding/request")
	require.Len(t, launches, 1)
	require.Equal(t, "Retry webhooks\n\nRetry a 502 at most 5 times.\n\nAcceptance:\n- a 502 is retried 5 times\n", decodeJSON(t, launches[0].Payload)["prompt"])
	var lane string
	require.NoError(t, o.pool.QueryRow(context.Background(), `SELECT name FROM mythical_lanes WHERE workspace_id=$1`, item.WorkspaceID).Scan(&lane))
	require.Equal(t, fmt.Sprintf("TODO %d attempt 1 g1", item.Number.Int64), lane)

	o.project(launches[0], jobs.StateWaiting, "request-run-7", "")
	require.Equal(t, "working", todoState(o.byID(id)))
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	events, err := store.Replay(context.Background(), todoOperationScope(item), 0, 100)
	require.NoError(t, err)
	types := []string{}
	for _, event := range events.Events {
		types = append(types, event.Type)
	}
	require.Equal(t, []string{"todo.created", "todo.run_updated"}, types)

	labeled := db.MythicalItem{Source: "issue", IssueTitle: "Say goodbye", Revisions: []byte(`[{"text":"Say goodbye\n\nEnd with a farewell.","acceptance":[]}]`)}
	require.True(t, mythicalTodo(labeled))
	require.Equal(t, "Say goodbye\n\nEnd with a farewell.\n", todoPrompt(labeled))
	require.False(t, mythicalTodo(db.MythicalItem{Source: "issue", Revisions: []byte(`[]`)}), "a legacy issue item runs from the issue's text")
	require.False(t, mythicalTodo(db.MythicalItem{Source: "issue"}))
}
