package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// These test-only dependency ports cannot qualify root inputs, pinned module
// imports or microVM isolation. The machine adapter, worker, database, delivery,
// GitHub client and HTTP admission/read doors are production implementations.
func exerciseReviewMachine(t *testing.T, pool *pgxpool.Pool, service *services.MythicalService, chatStore *chat.Store, router http.Handler, repository, user int64) {
	ctx := t.Context()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	runtime := &reviewRuntimeContract{head: strings.Repeat("a", 40), loseLaunch: true, failDelete: true}
	source := &reviewSourceContract{}
	machine := &reviewMachine{pool: pool, jobs: store, workspace: runtime, source: source}
	resolver := &reviewResolverContract{machine: machine, runtime: runtime}
	machine.resolver, machine.existing = resolver, resolver
	background, err := services.NewReviewBackground(pool, service, machine, reviewConversationDelivery{store: chatStore, resolve: conversationBranchResolver(services.NewWorkspaceService(db.New(pool)))})
	require.NoError(t, err)
	service.SetReviewBackground(background)
	call := func(key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(`{"number":50,"conversation":"main"}`))
		req.RemoteAddr = "127.0.0.1:61000"
		req.Header.Set("Origin", "http://localhost:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "review-csrf")
		req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	machine.source = nil
	refused := call("adapter-no-source")
	require.Equal(t, 503, refused.Code, refused.Body.String())
	require.Contains(t, refused.Body.String(), "review_source_unavailable")
	require.Zero(t, runtime.creates)
	machine.source = source
	source.refusal = reviewRefusal("review_root_boundary_unavailable")
	refused = call("adapter-no-root")
	require.Equal(t, 503, refused.Code, refused.Body.String())
	require.Zero(t, runtime.creates)
	source.refusal = nil
	accepted := call("adapter-review")
	require.Equal(t, 202, accepted.Code, accepted.Body.String())
	var admission services.ReviewAdmission
	require.NoError(t, json.Unmarshal(accepted.Body.Bytes(), &admission))
	require.Zero(t, runtime.creates, "the HTTP response must precede execution")
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- background.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-adapter", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	defer func() { cancel(); require.NoError(t, <-done) }()
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", user)}
	require.Eventually(t, func() bool {
		op, e := store.Get(ctx, scope, admission.OperationID)
		return e == nil && op.State == jobs.StateCompleted
	}, 10*time.Second, 10*time.Millisecond)
	runtime.mu.Lock()
	require.Equal(t, 1, runtime.creates)
	require.Equal(t, 2, runtime.launches, "lost launch reply reconnects the same application request")
	require.Equal(t, 2, runtime.deletes, "failed retirement must retry")
	require.Equal(t, admission.OperationID, runtime.launch.ApplicationRequestID)
	require.Equal(t, admission.Pin, *runtime.launch.Pin)
	require.JSONEq(t, `{"repo":".","from":"9999999999999999999999999999999999999999","to":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","verify":true,"narrate":false}`, string(runtime.launch.Payload))
	require.Equal(t, reviewWorkspaceID(admission.OperationID), runtime.id)
	runtime.mu.Unlock()
	require.GreaterOrEqual(t, source.restores, 2)
	require.Equal(t, admission.Head, source.selected.Head)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1`, reviewWorkspaceID(admission.OperationID)).Scan(&count))
	require.Zero(t, count)
	for _, table := range []string{"mythical_items", "mythical_stacks"} {
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count)
	}
	req := httptest.NewRequest("GET", "http://localhost:4000/api/conversations/main", nil)
	req.RemoteAddr = "127.0.0.1:61000"
	req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "Pinned adapter finding")
	require.NotContains(t, response.Body.String(), "private-thinking-canary")
	require.NotContains(t, response.Body.String(), "untrusted-html-canary")
	// The committed job no longer authorizes an engine target.
	_, err = machine.ResolveFlowHostTarget(ctx, reviewTarget(admission.OperationID, admission))
	require.Error(t, err)
}

type reviewSourceContract struct {
	refusal  error
	restores int
	selected services.ReviewAdmission
}

func (s *reviewSourceContract) Prepare(context.Context, services.ReviewAdmission) error {
	return s.refusal
}
func (s *reviewSourceContract) Restore(_ context.Context, _ string, a services.ReviewAdmission) error {
	s.restores++
	s.selected = a
	return nil
}
func (s *reviewSourceContract) Retire(context.Context, string, services.ReviewAdmission) error {
	return nil
}

type reviewResolverContract struct {
	machine *reviewMachine
	runtime *reviewRuntimeContract
}

func (r *reviewResolverContract) ResolveFlowRuntime(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
	_, err := r.machine.ResolveFlowHostTarget(ctx, target)
	return r.runtime, err
}
func (r *reviewResolverContract) ResolveExistingFlowRuntime(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
	return r.ResolveFlowRuntime(ctx, target)
}

type reviewRuntimeContract struct {
	workspace.WorkspaceLifecycle
	flowruntime.Runtime
	mu                             sync.Mutex
	head, id                       string
	exists, loseLaunch, failDelete bool
	creates, launches, deletes     int
	launch                         flowruntime.Launch
}

func (*reviewRuntimeContract) Isolation() workspace.IsolationLevel {
	return workspace.IsolationSandboxed
}
func (r *reviewRuntimeContract) InspectWorkspace(context.Context, string) (workspace.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.exists {
		return workspace.Workspace{}, workspace.ErrWorkspaceNotFound
	}
	return workspace.Workspace{ID: r.id, State: workspace.WorkspaceRunning}, nil
}
func (r *reviewRuntimeContract) CreateWorkspace(_ context.Context, s workspace.WorkspaceSpec) (workspace.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.creates++
	r.id = s.ID
	r.exists = true
	return workspace.Workspace{ID: s.ID, State: workspace.WorkspaceRunning}, nil
}
func (r *reviewRuntimeContract) DeleteWorkspace(context.Context, string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deletes++
	if r.failDelete {
		r.failDelete = false
		return errors.New("lost delete reply")
	}
	r.exists = false
	return nil
}
func (r *reviewRuntimeContract) ResolveWorkspaceSourceRevision(context.Context, string) (string, error) {
	return r.head, nil
}
func (*reviewRuntimeContract) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, SourceRevision: strings.Repeat("b", 40), RuntimeArtifactDigest: strings.Repeat("d", 64), OwnerGeneration: 1}, nil
}
func (r *reviewRuntimeContract) Launch(_ context.Context, l flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.launches++
	r.launch = l
	if r.loseLaunch {
		r.loseLaunch = false
		return flowruntime.LaunchResult{}, errors.New("lost launch reply")
	}
	return flowruntime.LaunchResult{ApplicationRequestID: l.ApplicationRequestID, SourceRevision: l.SourceRevision, RuntimeArtifactDigest: l.RuntimeArtifactDigest, OwnerGeneration: l.OwnerGeneration, ExecutionDigest: l.Pin.ExecutionDigest, Receipt: flowruntime.Receipt{RunID: "review-engine-run"}}, nil
}
func (*reviewRuntimeContract) Observe(context.Context, string, string, int) (flowruntime.Observation, error) {
	output := `{"review":{"status":"success","ok":true,"comments":[{"path":"cache.ts","content":"Pinned adapter finding","startLine":20,"severity":"major","thinking":"private-thinking-canary"}]},"ui":{"html":"untrusted-html-canary"}}`
	return flowruntime.Observation{Terminal: true, Run: flowruntime.Run{RunID: "review-engine-run", FlowID: "review", Status: "completed", FinalOutput: &output}}, nil
}
