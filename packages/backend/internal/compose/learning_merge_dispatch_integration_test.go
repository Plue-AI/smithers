package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Real served TODO/merge/check doors and production GitHub polling precede
// production admission and dispatch. Only the unavailable Learning execution
// dependency is recorded; this does not qualify reference-host isolation.
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
	require.Equal(t, int64(1), admitted.Todo)
	// Publication after admission must retain the first qualified Active pin.
	digest := "1fdfa26813fce28d5d5a9ec036cdc0e169cdb44cbb7459464f699c602c04bdcc"
	replacementDigest := strings.Repeat("d", 64)
	_, err = q.InsertFlowVersion(ctx, item.RepositoryID, "learning", "flows/learning/flow.ts", item.PRMergeCommit, replacementDigest, "loaded", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, item.RepositoryID, "learning", replacementDigest)
	require.NoError(t, err)
	output := fmt.Sprintf(`{"repository":"merge-owner/app","todo":1,"run":"learning-recorded","pages":[{"title":"Retry helper","body":"Use the existing retry helper because it already backs off. Change: %s; commit %s; attempt-1; attempt-2"}],"proposals":[{"signature":"check:lint@review","title":"Run lint","prompt":"Run lint before review","evidence":["3 of the last 5 failed lint at review"],"todos":[1,3,5]}]}`, item.PRURL, item.PRMergeCommit)
	runtime := &learningCompletionRecording{source: item.PRMergeCommit, digest: digest, output: output}
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: server.URL, SigningKey: []byte("learning-test-key-with-32-bytes!!")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	consumer := services.NewLearningRuntime(service, services.NewWikiService(q, nil, services.WithWikiContent(content)))
	var failedReceipt atomic.Bool
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil }), Projector: flowdispatch.ProjectorFunc(func(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
		err := consumer.ProjectFlowRuntime(ctx, update)
		if err != nil && strings.Contains(err.Error(), "recorded receipt failure") {
			failedReceipt.Store(true)
		}
		return err
	})})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	service.SetLearningMachines(learningDispatchRecording{})
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
	require.Eventually(t, failedReceipt.Load, 15*time.Second, 20*time.Millisecond)
	for _, query := range []string{`SELECT count(*) FROM wiki_pages`, `SELECT count(*) FROM memory_notes`, `SELECT count(*) FROM mythical_items WHERE learning_receipt IS NOT NULL`, `SELECT count(*) FROM product_job_events WHERE event_type IN ('learning.receipt','todo.learning.receipt')`} {
		require.NoError(t, pool.QueryRow(ctx, query).Scan(&count))
		require.Zero(t, count)
	}
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_learning_commit ON mythical_items; DROP FUNCTION refuse_learning_commit()`)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		return pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND state='completed'`).Scan(&count) == nil && count == 1
	}, 15*time.Second, 20*time.Millisecond)
	var lessons []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT learning_receipt FROM mythical_items WHERE id=$1`, item.ID).Scan(&lessons))
	require.Contains(t, string(lessons), "learning-recorded")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions`).Scan(&count))
	require.Equal(t, 1, count)
	var author []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT learning_author FROM wiki_page_revisions`).Scan(&author))
	require.JSONEq(t, `{"agent":"coding","run":"learning-recorded"}`, string(author))
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
	req, err := http.NewRequest("GET", server.URL+"/api/todos/1", nil)
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
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission'`).Scan(&count))
	require.Equal(t, 1, count)
}

type learningDispatchRecording struct{}

func (learningDispatchRecording) EnsureLearningMachine(_ context.Context, repo, actor int64, item string, _ flowruntime.Pin) (flowruntime.Target, error) {
	return flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", actor), WorkspaceID: "recorded-learning-machine", BindingKind: "learning", BindingID: item}, nil
}
func (learningDispatchRecording) RetireLearningMachine(context.Context, flowruntime.Target) error {
	return nil
}

type learningCompletionRecording struct {
	flowruntime.Runtime
	source, digest, output string
	starts                 atomic.Int64
}

func (r *learningCompletionRecording) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, SourceRevision: r.source, RuntimeArtifactDigest: strings.Repeat("a", 64), OwnerGeneration: 1}, nil
}
func (r *learningCompletionRecording) Launch(_ context.Context, l flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.starts.Add(1)
	return flowruntime.LaunchResult{ApplicationRequestID: l.ApplicationRequestID, OwnerGeneration: l.OwnerGeneration, RuntimeArtifactDigest: l.RuntimeArtifactDigest, SourceRevision: l.SourceRevision, ExecutionDigest: r.digest, PlanID: "learning-plan", Receipt: flowruntime.Receipt{Tag: "Accepted", RunID: "learning-recorded"}}, nil
}
func (r *learningCompletionRecording) Observe(context.Context, string, string, int) (flowruntime.Observation, error) {
	return flowruntime.Observation{Run: flowruntime.Run{RunID: "learning-recorded", FlowID: "learning", Status: "completed", FinalOutput: &r.output}, Terminal: true}, nil
}
