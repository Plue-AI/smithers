package compose

import (
	"context"

	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// Real served TODO/merge/check doors and production GitHub polling precede
// production admission, shared machine queue and authenticated host dispatch.
// Guest lifecycle/source observations are injected; extraction executes the
// production Learning flow. This does not qualify reference-host isolation.
func TestLearningMergeDispatchComposedInstall(t *testing.T) {
	testTodoMergeComposedRouteBoundaryPostgres(t, false, false, true, false, false, true)
}

func proveLearningMergedDispatch(t *testing.T, pool *pgxpool.Pool, service *services.MythicalService, item db.MythicalItem, server *httptest.Server) {
	ctx := t.Context()
	defer func() {
		if t.Failed() {
			rows, e := pool.Query(context.Background(), `SELECT r.operation,r.state,coalesce(d.last_error,''),coalesce(d.external_receipt::text,'') FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.operation IN ('learning.admission','flow.runtime.launch')`)
			if e == nil {
				defer rows.Close()
				for rows.Next() {
					var op, state, message, receipt string
					_ = rows.Scan(&op, &state, &message, &receipt)
					t.Log(op, state, message, receipt)
				}
			}
			events, e := pool.Query(context.Background(), `SELECT event_type,data::text FROM product_job_events WHERE event_type LIKE '%failed%'`)
			if e == nil {
				defer events.Close()
				for events.Next() {
					var kind, data string
					_ = events.Scan(&kind, &data)
					t.Log(kind, data)
				}
			}

		}
	}()
	q := db.New(pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission'`).Scan(&count))
	require.Equal(t, 1, count)
	var input, authorization []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload,authorization_context FROM product_job_requests WHERE operation='learning.admission'`).Scan(&input, &authorization))
	require.JSONEq(t, `{"source":"confirmed-github-merge","class":"background"}`, string(authorization))
	var admitted struct {
		Commit string `json:"commit"`
		Todo   int64  `json:"todo"`
	}
	require.NoError(t, json.Unmarshal(input, &admitted))
	require.Equal(t, item.PRMergeCommit, admitted.Commit)
	require.Equal(t, int64(7), admitted.Todo)
	// Publication after admission must retain the first qualified Active pin.
	digest := "1fdfa26813fce28d5d5a9ec036cdc0e169cdb44cbb7459464f699c602c04bdcc"
	replacementDigest := strings.Repeat("d", 64)
	_, err = q.InsertFlowVersion(ctx, item.RepositoryID, "learning", "flows/learning/flow.ts", item.PRMergeCommit, replacementDigest, "loaded", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, item.RepositoryID, "learning", replacementDigest)
	require.NoError(t, err)
	require.EqualValues(t, 41, item.PRNumber.Int64)
	runtime := &learningCompletionExtraction{origin: server.URL, source: item.PRMergeCommit, digest: digest}
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: server.URL, SigningKey: []byte("learning-test-key-with-32-bytes!!")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	wiki := services.NewWikiService(q, nil, services.WithWikiContent(content))
	consumer := services.NewLearningRuntime(service, wiki)
	readServer := httptest.NewUnstartedServer(nil)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://" + readServer.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	hubContext, stopHub := context.WithCancel(ctx)
	defer stopHub()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(hubContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	topics := &liveTopics{queries: q, todos: service, jobs: store}
	handler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubContext, nil), Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	readServer.Config.Handler = buildRouterCompat(
		cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		wiki, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Mythical: &routes.MythicalHandler{Service: service}, Live: handler})
	readServer.Start()
	defer readServer.Close()
	readLive := func(topic string) live.Frame {
		readContext, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(readContext, "ws"+strings.TrimPrefix(readServer.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {readServer.URL}, "Cookie": {"smithers_session=owner-browser-session"}}})
		require.NoError(t, err)
		defer conn.CloseNow()
		request, _ := json.Marshal(map[string]any{"t": "sub", "id": 1, "topic": topic})
		require.NoError(t, conn.Write(readContext, websocket.MessageText, request))
		_, raw, err := conn.Read(readContext)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, "snap", frame.T)
		return frame
	}
	beforeTopics := map[string]live.Frame{}
	for _, topic := range []string{"todo:7", "home", "proposals"} {
		beforeTopics[topic] = readLive(topic)
	}
	// Qualify the missing shared execution boundary through the same merge,
	// poll and admission path before supplying the recorded guest lifecycle.
	// A trusted Active pin is insufficient authority to execute on the host.
	refusalCtx, stopRefusal := context.WithCancel(ctx)
	t.Cleanup(stopRefusal)
	refusalDone := make(chan error, 1)
	go func() {
		refusalDone <- store.RunWorker(refusalCtx, jobs.WorkerConfig{WorkerID: "merged-learning-refusal", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond, Operations: []string{services.LearningAdmissionOperation}}, service.HandleLearningAdmission)
	}()
	var admissionID, principal string
	require.Eventually(t, func() bool {
		var state, reason, pinned string
		var parked bool
		err := pool.QueryRow(ctx, `SELECT d.status='ready' AND d.next_attempt_at > clock_timestamp() + interval '30 seconds',r.id,r.principal_id,r.state,coalesce(d.external_receipt->>'reason',''),coalesce(d.external_receipt->'pin'->>'executionDigest','') FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.operation='learning.admission'`).Scan(&parked, &admissionID, &principal, &state, &reason, &pinned)
		return err == nil && parked && state == "waiting" && reason == "learning_execution_unavailable" && pinned == digest
	}, 5*time.Second, 10*time.Millisecond)
	stopRefusal()
	require.NoError(t, <-refusalDone)
	for _, query := range []string{`SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`, `SELECT count(*) FROM flow_runtime_host_bindings WHERE binding_kind='learning'`, `SELECT count(*) FROM wiki_pages`, `SELECT count(*) FROM memory_notes`, `SELECT count(*) FROM mythical_items WHERE learning_receipt IS NOT NULL`} {
		require.NoError(t, pool.QueryRow(ctx, query).Scan(&count))
		require.Zero(t, count, "missing isolation must refuse before execution or receipt")
	}
	var refusedHome struct {
		Runs []struct {
			Title string `json:"title"`
			State string `json:"state"`
		} `json:"background_runs"`
	}
	require.NoError(t, json.Unmarshal(readLive("home").Data, &refusedHome))
	require.Len(t, refusedHome.Runs, 1)
	require.Equal(t, "Learning · T7", refusedHome.Runs[0].Title)
	require.Equal(t, "waiting", refusedHome.Runs[0].State)
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nif [ \"$1\" = list ]; then echo '[]'; else exit 99; fi\n"), 0700))
	queue, err := microsandbox.New(ctx, microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: binary, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768, MaxRunningVMs: 1, HostProfile: &microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}, SkipQualification: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, queue.Close()) })
	queue.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	// The observed occupied slot is a precondition; the confirmed merge still
	// enters only through the served merge/check doors above.
	_, err = queue.WaitAdmission(ctx, microsandbox.AdmissionProviders{Ready: func(context.Context, microsandbox.AdmissionRequest) error { return nil }, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }}, "person", "occupied", "owner", "terminal")
	require.NoError(t, err)
	composeAdmissionPublication(queue, service)

	source := &learningSourceContract{}
	guest := &learningRuntimeContract{queue: queue, source: source}
	source.runtime = guest
	require.True(t, bindLearningMachines(service, cfg, pool, guest, source))
	codec, err := webhook.NewSecretCodec("learning-admission-host-key")
	require.NoError(t, err)
	bindings, err := flowhost.NewStore(pool, codec)
	require.NoError(t, err)
	transport := &reviewHostTransport{todoControlHostTransport: &todoControlHostTransport{receiver: runtime}}
	guestServer := httptest.NewServer(transport)
	t.Cleanup(guestServer.Close)
	transport.endpoint = guestServer.URL
	runtime.transport = transport.todoControlHostTransport
	resolver, err := flowhost.New(flowhost.Config{Store: bindings, Targets: consumer, Launcher: transport, Catalogs: []flowhost.Catalog{{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/installed/coding-host", ArtifactDigest: strings.Repeat("a", 64), ServiceName: "coding-host", SystemFlows: services.SystemFlows}}})
	require.NoError(t, err)
	var failedReceipt atomic.Bool
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: installFlowResolver{resolver}, Projector: flowdispatch.ProjectorFunc(func(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
		err := consumer.ProjectFlowRuntime(ctx, update)
		if err != nil && strings.Contains(err.Error(), "recorded receipt failure") {
			failedReceipt.Store(true)
		}
		return err
	})})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	require.NoError(t, store.Wake(ctx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", item.RepositoryID), PrincipalID: principal}, admissionID))
	// Fail in the production transaction after wiki/note writes. The durable
	// dispatcher must retry the same completion, without relaunching execution.
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_learning_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lessons IS NOT NULL THEN RAISE EXCEPTION 'recorded receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_learning_commit BEFORE UPDATE ON mythical_items FOR EACH ROW EXECUTE FUNCTION refuse_learning_commit()`)
	require.NoError(t, err)
	workerCtx, cancel := context.WithCancel(ctx)
	admissionDone, dispatchDone := make(chan error, 1), make(chan error, 1)
	go func() {
		admissionDone <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "merged-learning-admission", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond, Operations: []string{services.LearningAdmissionOperation}}, service.HandleLearningAdmission)
	}()
	go func() {
		dispatchDone <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "merged-learning-output", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond, RetryDelay: 10 * time.Millisecond, MaxRetryDelay: 20 * time.Millisecond})
	}()
	defer func() { cancel(); require.NoError(t, <-admissionDone); require.NoError(t, <-dispatchDone) }()
	require.Eventually(t, func() bool {
		for _, row := range queue.AdmissionSnapshot() {
			if row.Class == "background" && row.State == "waiting" && row.Position == 1 {
				return true
			}
		}
		return false
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, learningCounts{}, guest.counts(), "waiting background work never allocates a guest")
	require.Zero(t, transport.starts.Load())
	queue.ConfirmAdmissionStop("occupied", false)
	require.Eventually(t, failedReceipt.Load, 15*time.Second, 20*time.Millisecond)
	require.Equal(t, 1, queue.InUse(), "receipt rollback retains the learning machine's slot")
	require.Equal(t, learningCounts{creates: 1, restores: 1}, guest.counts())

	for _, query := range []string{`SELECT count(*) FROM wiki_pages`, `SELECT count(*) FROM memory_notes`, `SELECT count(*) FROM mythical_items WHERE learning_receipt IS NOT NULL`, `SELECT count(*) FROM product_job_events WHERE event_type IN ('learning.receipt','todo.learning.receipt')`} {
		require.NoError(t, pool.QueryRow(ctx, query).Scan(&count))
		require.Zero(t, count)
	}
	for _, topic := range []string{"todo:7", "home", "proposals"} {
		after := readLive(topic)
		require.Equal(t, beforeTopics[topic].Cursor, after.Cursor)
		if topic == "home" {
			// The admitted run legitimately advances queued -> waiting while
			// its receipt rolls back. Shared TODO facts must not advance.
			var beforeHome, afterHome map[string]any
			require.NoError(t, json.Unmarshal(beforeTopics[topic].Data, &beforeHome))
			require.NoError(t, json.Unmarshal(after.Data, &afterHome))
			delete(beforeHome, "background_runs")
			delete(afterHome, "background_runs")
			require.Equal(t, beforeHome, afterHome)
		} else {
			require.JSONEq(t, string(beforeTopics[topic].Data), string(after.Data))
		}
	}
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_learning_commit ON mythical_items; DROP FUNCTION refuse_learning_commit()`)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		return pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND state='completed'`).Scan(&count) == nil && count == 1
	}, 15*time.Second, 20*time.Millisecond)
	var lessons []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT learning_receipt FROM mythical_items WHERE id=$1`, item.ID).Scan(&lessons))
	require.NotEmpty(t, runtime.run)
	require.Contains(t, string(lessons), runtime.run)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions`).Scan(&count))
	require.Equal(t, 1, count)
	var pageBody string
	require.NoError(t, pool.QueryRow(ctx, `SELECT body FROM wiki_pages`).Scan(&pageBody))
	for _, literal := range []string{"/pull/41", item.PRMergeCommit, "attempt-1", "attempt-2", "because it already backs off"} {
		require.Contains(t, pageBody, literal)
	}
	readJSON := func(path string) json.RawMessage {
		req, err := http.NewRequest("GET", readServer.URL+path, nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
		res, err := readServer.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		require.Equal(t, 200, res.StatusCode)
		var body json.RawMessage
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		return body
	}
	require.Contains(t, string(readJSON("/api/proposals")), "check:lint@review")
	require.Contains(t, string(readJSON("/api/repos/merge-owner/app/wiki")), "T7 decisions")
	for _, topic := range []string{"todo:7", "home", "proposals"} {
		after := readLive(topic)
		require.NotNil(t, after.Cursor)
		require.Greater(t, *after.Cursor, *beforeTopics[topic].Cursor)
	}
	require.Contains(t, string(readLive("todo:7").Data), `"lessons":2`)
	var author []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT learning_author FROM wiki_page_revisions`).Scan(&author))
	require.JSONEq(t, fmt.Sprintf(`{"agent":"coding","run":%q}`, runtime.run), string(author))
	var checkpoint []byte
	var operation string
	require.NoError(t, pool.QueryRow(ctx, `SELECT r.id,d.external_receipt FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id WHERE r.operation='flow.runtime.launch'`).Scan(&operation, &checkpoint))
	var cp flowdispatch.RuntimeCheckpoint
	require.NoError(t, json.Unmarshal(checkpoint, &cp))
	require.Equal(t, item.PRMergeCommit, cp.Identity.SourceRevision)
	require.Equal(t, digest, cp.ExecutionDigest)
	require.NoError(t, consumer.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{OperationID: operation, Scope: jobs.Scope{TenantID: cp.Target.TenantID, PrincipalID: cp.Target.PrincipalID}, State: jobs.StateCompleted, Checkpoint: cp}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions`).Scan(&count))
	require.Equal(t, 1, count)
	req, err := http.NewRequest("GET", server.URL+"/api/todos/7", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
	res, err := server.Client().Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, 200, res.StatusCode)
	var card map[string]any
	require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
	require.Equal(t, "merged", card["state"])
	require.Equal(t, float64(2), card["lessons"])
	require.EqualValues(t, 1, runtime.starts.Load())
	require.EqualValues(t, 1, transport.starts.Load())
	require.Equal(t, learningCounts{creates: 1, restores: 1, deletes: 2}, guest.counts())
	require.Zero(t, queue.InUse())
	require.Equal(t, item.PRMergeCommit, source.restored.SourceCommit)
	require.Equal(t, digest, source.restored.ExecutionDigest)
	var completionFact []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.learning.receipt'`).Scan(&completionFact))
	var completed map[string]any
	require.NoError(t, json.Unmarshal(completionFact, &completed))
	require.Equal(t, "merged", completed["from"])
	require.Equal(t, "merged", completed["to"])
	require.Equal(t, map[string]any{"kind": "run", "id": runtime.run}, completed["actor"])
	require.Contains(t, runtime.output, "1 of the last 20 failed check:lint@review")
	t.Logf("C-J8-01 output: %s", runtime.output)
	t.Logf("C-J8-01 page: %s", pageBody)
	t.Logf("C-J8-01 receipt: %s", lessons)
	t.Logf("C-J8-01 event: %s", completionFact)
	// Finish live observation before mutating source rows for refusal cases.
	// Otherwise its polling projector legitimately appends unrelated card facts.
	stopHub()
	// Independently authored completion sources: only Merged may accept
	// Learning's receipt. A late completion never changes the TODO's state.
	for _, c := range []struct {
		state, engine                              string
		launched, attached, paused, wait, accepted bool
	}{
		{"queued", "queued", false, false, false, false, false},
		{"starting", "running", true, false, false, false, false},
		{"working", "running", true, true, false, false, false},
		{"needs_you", "running", true, true, false, true, false},
		{"paused", "running", true, true, true, false, false},
		{"failed", "blocked", true, true, false, false, false},
		{"in_review", "proposed", true, true, false, false, false},
		{"merged", "landed", true, true, false, false, true},
		{"dropped", "cancelled", true, true, false, false, false},
	} {
		t.Run("Learning completion from "+c.state, func(t *testing.T) {
			checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached}
			if c.wait {
				checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			pr := ""
			if c.accepted {
				pr = "merged"
			}
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_state=$4,paused_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`, item.ID, c.engine, raw, pr, c.paused)
			require.NoError(t, err)
			before, err := db.New(pool).GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			var facts, revisions int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&facts))
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions`).Scan(&revisions))
			err = consumer.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{OperationID: operation, Scope: jobs.Scope{TenantID: cp.Target.TenantID, PrincipalID: cp.Target.PrincipalID}, State: jobs.StateCompleted, Checkpoint: cp})
			if c.accepted {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, services.ErrLearningBinding)
			}
			after, err := db.New(pool).GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&count))
			require.Equal(t, facts, count)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions`).Scan(&count))
			require.Equal(t, revisions, count)
			req, err := http.NewRequest("GET", server.URL+"/api/todos/7", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			res, err := server.Client().Do(req)
			require.NoError(t, err)
			defer res.Body.Close()
			require.Equal(t, http.StatusOK, res.StatusCode)
			var card map[string]any
			require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
			require.Equal(t, c.state, card["state"])
			if c.accepted {
				require.Equal(t, float64(2), card["lessons"])
			} else {
				require.Nil(t, card["lessons"])
			}
		})
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission'`).Scan(&count))
	require.Equal(t, 1, count)
}

type learningCompletionExtraction struct {
	transport  *todoControlHostTransport
	credential string
	flowruntime.Runtime
	origin, source, digest, output, host, run string
	starts                                    atomic.Int64
}

func (r *learningCompletionExtraction) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, SourceRevision: r.source, RuntimeArtifactDigest: strings.Repeat("a", 64), OwnerGeneration: 1}, nil
}
func (r *learningCompletionExtraction) Launch(ctx context.Context, l flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.starts.Add(1)
	r.run = l.RunID
	r.transport.mu.Lock()
	r.host = r.transport.launch.Binding.ID
	r.credential = r.transport.launch.Credential
	r.transport.mu.Unlock()
	return flowruntime.LaunchResult{ApplicationRequestID: l.ApplicationRequestID, OwnerGeneration: l.OwnerGeneration, RuntimeArtifactDigest: l.RuntimeArtifactDigest, SourceRevision: l.SourceRevision, ExecutionDigest: r.digest, PlanID: "learning-plan", Receipt: flowruntime.Receipt{Tag: "Accepted", RunID: r.run}}, nil
}
func (r *learningCompletionExtraction) Observe(ctx context.Context, _, _ string, _ int) (flowruntime.Observation, error) {
	if r.output == "" {
		script, err := filepath.Abs("../../../../flows/test/fixtures/learning-extraction.ts")
		if err != nil {
			return flowruntime.Observation{}, err
		}
		command := exec.CommandContext(ctx, "node", "--experimental-strip-types", script, r.origin, r.host, r.run)
		command.Env = append(os.Environ(), "SMITHERS_LEARNING_TEST_CREDENTIAL="+r.credential)
		var stderr strings.Builder
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			return flowruntime.Observation{}, fmt.Errorf("production Learning extraction: %w: %s", err, stderr.String())
		}
		r.output = string(output)
	}
	return flowruntime.Observation{Run: flowruntime.Run{RunID: r.run, FlowID: "learning", Status: "completed", FinalOutput: &r.output}, Terminal: true}, nil
}
