package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type mockPushHookRepoResolver struct {
	getRepoFn                     func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	getRepoByIDFn                 func(ctx context.Context, id int64) (db.Repository, error)
	getRepoOwnerSlugAndNameByIDFn func(ctx context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
	// collabPermission overrides the pusher's effective collaborator
	// permission used by the config-sync admin gate. Empty defaults to "admin"
	// so the common path (an admin pusher) keeps config-sync enabled.
	collabPermission string
}

func (m *mockPushHookRepoResolver) GetRepoOwnerSlugAndNameByID(ctx context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	if m.getRepoOwnerSlugAndNameByIDFn != nil {
		return m.getRepoOwnerSlugAndNameByIDFn(ctx, id)
	}
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "alice", RepoName: "demo"}, nil
}

func (m *mockPushHookRepoResolver) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, arg)
	}
	return db.GetRepoByOwnerAndNameRow{
		ID:   101,
		Name: "demo",
	}, nil
}

func (m *mockPushHookRepoResolver) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{
		ID:              id,
		Name:            "demo",
		DefaultBookmark: "main",
	}, nil
}

func (m *mockPushHookRepoResolver) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (m *mockPushHookRepoResolver) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (m *mockPushHookRepoResolver) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.collabPermission != "" {
		return m.collabPermission, nil
	}
	return "admin", nil
}

type mockPushHookDispatcher struct {
	dispatchedType    webhooks.EventType
	dispatchedRepoID  int64
	dispatchedPayload any
	dispatchErr       error
}

type mockPushHookChangeRecorder struct {
	repositoryID int64
	owner        string
	repo         string
	err          error
	recordFn     func(context.Context) error
	done         chan struct{}
}

func (m *mockPushHookChangeRecorder) RecordPush(ctx context.Context, repositoryID int64, owner, repo string) error {
	if m.done != nil {
		defer close(m.done)
	}
	m.repositoryID = repositoryID
	m.owner = owner
	m.repo = repo
	if m.recordFn != nil {
		return m.recordFn(ctx)
	}
	return m.err
}

func (m *mockPushHookDispatcher) DispatchEvent(ctx context.Context, repositoryID int64, eventType webhooks.EventType, payload any) error {
	m.dispatchedType = eventType
	m.dispatchedRepoID = repositoryID
	m.dispatchedPayload = payload
	return m.dispatchErr
}

func (m *mockPushHookDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	return nil
}

func TestInternalPushHookHandler_PostPushEvent_DispatchesPushEvent(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{}
	dispatcher := &mockPushHookDispatcher{}
	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		PusherID:     42,
		PusherLogin:  "bob",

		PusherCredential: "person",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, webhooks.EventTypePush, dispatcher.dispatchedType)
	assert.Equal(t, int64(101), dispatcher.dispatchedRepoID)

	eventPayload, ok := dispatcher.dispatchedPayload.(webhooks.PushEventPayload)
	require.True(t, ok, "payload should be PushEventPayload")
	assert.Equal(t, "refs/heads/main", eventPayload.Ref)
	assert.Equal(t, int64(101), eventPayload.Repository.ID)
	assert.Equal(t, "demo", eventPayload.Repository.Name)
	assert.Equal(t, "alice/demo", eventPayload.Repository.FullName)
	assert.Equal(t, int64(42), eventPayload.Sender.ID)
	assert.Equal(t, "bob", eventPayload.Sender.Login)
}

func TestInternalPushHookHandler_PostPushEvent_RecordsChangeRevisions(t *testing.T) {
	t.Parallel()

	recorder := &mockPushHookChangeRecorder{done: make(chan struct{})}
	handler := &InternalPushHookHandler{
		RepoResolver:   &mockPushHookRepoResolver{},
		Dispatcher:     &mockPushHookDispatcher{},
		ChangeRecorder: recorder,
	}
	body, err := json.Marshal(PushHookEventRequest{RepositoryID: 101, Owner: "alice", Repo: "demo"})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	select {
	case <-recorder.done:
	case <-time.After(5 * time.Second):
		t.Fatal("change recording did not finish")
	}
	assert.Equal(t, int64(101), recorder.repositoryID)
	assert.Equal(t, "alice", recorder.owner)
	assert.Equal(t, "demo", recorder.repo)
}

func TestInternalPushHookHandler_PostPushEvent_RevisionFailureDoesNotStopDispatch(t *testing.T) {
	t.Parallel()

	dispatcher := &mockPushHookDispatcher{}
	handler := &InternalPushHookHandler{
		RepoResolver:   &mockPushHookRepoResolver{},
		Dispatcher:     dispatcher,
		ChangeRecorder: &mockPushHookChangeRecorder{err: pkgerrors.Internal("record failed")},
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewBufferString(`{"repository_id":101,"owner":"alice","repo":"demo"}`))
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, webhooks.EventTypePush, dispatcher.dispatchedType)
}

// Steps of one push event run concurrently: an hour-long history import
// must not hold back workflow dispatch, and the history step gets its own
// deadline.
func TestInternalPushHookHandler_ProcessRepoPushEvent_SlowHistoryDoesNotBlockWorkflow(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	started := make(chan context.Context, 1)
	recorder := &mockPushHookChangeRecorder{
		recordFn: func(ctx context.Context) error {
			started <- ctx
			<-release
			return nil
		},
	}
	runner := &mockPushHookWorkflowRunner{calls: make(chan dispatchCallRecord, 1)}
	handler := &InternalPushHookHandler{
		RepoResolver: &mockPushHookRepoResolver{}, Dispatcher: &mockPushHookDispatcher{},
		ChangeRecorder: recorder, WorkflowRun: runner,
	}
	event := db.RepoPushEvent{ID: 1, RepositoryID: 101, Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSha: "abc", PusherID: 42}
	processed := make(chan error, 1)
	go func() { processed <- handler.ProcessRepoPushEvent(context.Background(), event, nil) }()

	select {
	case recordCtx := <-started:
		require.NoError(t, recordCtx.Err())
		_, bounded := recordCtx.Deadline()
		require.True(t, bounded)
	case <-time.After(5 * time.Second):
		t.Fatal("history recording did not start")
	}
	select {
	case call := <-runner.calls:
		assert.Equal(t, "abc", call.event.CommitSHA)
		assert.Equal(t, int64(42), call.userID)
	case <-time.After(5 * time.Second):
		t.Fatal("workflow dispatch blocked on history recording")
	}
	close(release)
	select {
	case err := <-processed:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("processing did not finish after history completed")
	}
}

func TestInternalPushHookHandler_PostPushEvent_RepoNotFound_Returns404(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{
		getRepoOwnerSlugAndNameByIDFn: func(ctx context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			return db.GetRepoOwnerSlugAndNameByIDRow{}, pgx.ErrNoRows
		},
	}
	dispatcher := &mockPushHookDispatcher{}
	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "missing",
		Ref:          "refs/heads/main",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.Empty(t, dispatcher.dispatchedType, "should not dispatch if repo not found")
}

func TestInternalPushHookHandler_PostPushEvent_WebhookEnqueueFailureStillRunsPushWork(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{}
	dispatcher := &mockPushHookDispatcher{
		dispatchErr: errors.New("queue error"),
	}
	recorder := &mockPushHookChangeRecorder{done: make(chan struct{})}
	handler := &InternalPushHookHandler{
		RepoResolver:   resolver,
		Dispatcher:     dispatcher,
		ChangeRecorder: recorder,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	select {
	case <-recorder.done:
	case <-time.After(5 * time.Second):
		t.Fatal("change sync never ran after a webhook enqueue failure")
	}
	assert.Equal(t, int64(101), recorder.repositoryID)
}

func TestInternalPushHookHandler_PostPushEvent_InvalidBody_Returns400(t *testing.T) {
	t.Parallel()

	handler := &InternalPushHookHandler{}

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewBufferString("{invalid json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// --- Workflow integration tests ---

type syncCallRecord struct {
	repoID    int64
	commitSHA string
}

type mockPushHookWorkflowSyncer struct {
	loadFn       func(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error)
	persistFn    func(ctx context.Context, repoID int64, result services.WorkflowLoadResult) error
	loadCalls    chan syncCallRecord
	persistCalls chan services.WorkflowLoadResult
}

func (m *mockPushHookWorkflowSyncer) LoadDefinitionsFromCommit(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error) {
	if m.loadCalls != nil {
		m.loadCalls <- syncCallRecord{repoID: repoID, commitSHA: commitSHA}
	}
	if m.loadFn != nil {
		return m.loadFn(ctx, repoID, commitSHA)
	}
	return services.WorkflowLoadResult{}, nil
}

func (m *mockPushHookWorkflowSyncer) PersistDefinitions(ctx context.Context, repoID int64, result services.WorkflowLoadResult) error {
	if m.persistCalls != nil {
		m.persistCalls <- result
	}
	if m.persistFn != nil {
		return m.persistFn(ctx, repoID, result)
	}
	return nil
}

type dispatchCallRecord struct {
	repoID            int64
	event             services.TriggerEvent
	userID            int64
	useLoadedSnapshot bool
	loadedDefinitions int
}

type mockPushHookWorkflowRunner struct {
	dispatchFn func(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
	calls      chan dispatchCallRecord
}

func (m *mockPushHookWorkflowRunner) DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	if m.calls != nil {
		m.calls <- dispatchCallRecord{
			repoID:            input.RepositoryID,
			event:             input.Event,
			userID:            input.UserID,
			useLoadedSnapshot: input.UseLoadedDefinitions,
			loadedDefinitions: len(input.LoadedDefinitions),
		}
	}
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, input)
	}
	return nil, nil
}

type configSyncCallRecord struct {
	repositoryID int64
	commitSHA    string
	trigger      string
	actorID      *int64
	actorName    string
}

type mockPushHookConfigSyncer struct {
	syncFn func(ctx context.Context, input configsync.SyncInput) (configsync.SyncResult, error)
	calls  chan configSyncCallRecord
}

func (m *mockPushHookConfigSyncer) SyncFromCommit(ctx context.Context, input configsync.SyncInput) (configsync.SyncResult, error) {
	if m.calls != nil {
		m.calls <- configSyncCallRecord{
			repositoryID: input.RepositoryID,
			commitSHA:    input.CommitSHA,
			trigger:      input.Trigger,
			actorID:      input.ActorID,
			actorName:    input.ActorName,
		}
	}
	if m.syncFn != nil {
		return m.syncFn(ctx, input)
	}
	return configsync.SyncResult{}, nil
}

type mockPushHookSearchIndexer struct {
	calls chan services.SearchIndexPushInput
	err   error
}

func (m *mockPushHookSearchIndexer) IndexPush(_ context.Context, input services.SearchIndexPushInput) error {
	if m.calls != nil {
		m.calls <- input
	}
	return m.err
}

func TestInternalPushHookHandler_PostPushEvent_StartsCodeSearchIndexing(t *testing.T) {
	t.Parallel()

	indexer := &mockPushHookSearchIndexer{calls: make(chan services.SearchIndexPushInput, 1)}
	handler := &InternalPushHookHandler{
		RepoResolver: &mockPushHookRepoResolver{},
		Dispatcher:   &mockPushHookDispatcher{},
		SearchIndex:  indexer,
	}
	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		CommitSHA:    "abc123",
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)

	select {
	case input := <-indexer.calls:
		assert.Equal(t, int64(101), input.RepositoryID)
		assert.Equal(t, "alice", input.Owner)
		assert.Equal(t, "demo", input.RepositoryName)
		assert.Equal(t, "refs/heads/main", input.Ref)
		assert.Equal(t, "abc123", input.CommitSHA)
	case <-time.After(2 * time.Second):
		t.Fatal("code search indexing was not started")
	}
}

func TestInternalPushHookHandler_PostPushEvent_LoadsPersistsAndDispatchesDefaultBookmarkSnapshot(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{}
	dispatcher := &mockPushHookDispatcher{}

	syncer := &mockPushHookWorkflowSyncer{
		loadCalls:    make(chan syncCallRecord, 1),
		persistCalls: make(chan services.WorkflowLoadResult, 1),
		loadFn: func(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error) {
			return services.WorkflowLoadResult{
				Definitions: []services.LoadedWorkflowDefinition{
					{Name: "build", Path: ".smithers/workflows/build.tsx"},
				},
			}, nil
		},
	}
	runner := &mockPushHookWorkflowRunner{calls: make(chan dispatchCallRecord, 1)}
	configSyncer := &mockPushHookConfigSyncer{calls: make(chan configSyncCallRecord, 1)}

	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
		WorkflowSync: syncer,
		WorkflowRun:  runner,
		ConfigSync:   configSyncer,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		CommitSHA:    "abc123",
		PusherID:     42,
		PusherLogin:  "bob",

		PusherCredential: "person",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)

	select {
	case call := <-syncer.loadCalls:
		assert.Equal(t, int64(101), call.repoID)
		assert.Equal(t, "abc123", call.commitSHA)
	case <-time.After(2 * time.Second):
		t.Fatal("workflow load was not called")
	}

	select {
	case result := <-syncer.persistCalls:
		require.Len(t, result.Definitions, 1)
		assert.Equal(t, "build", result.Definitions[0].Name)
	case <-time.After(2 * time.Second):
		t.Fatal("workflow persistence was not called")
	}

	select {
	case call := <-configSyncer.calls:
		assert.Equal(t, int64(101), call.repositoryID)
		assert.Equal(t, "abc123", call.commitSHA)
		assert.Equal(t, "push", call.trigger)
		if assert.NotNil(t, call.actorID) {
			assert.Equal(t, int64(42), *call.actorID)
		}
		assert.Equal(t, "bob", call.actorName)
	case <-time.After(2 * time.Second):
		t.Fatal("config sync was not called")
	}

	select {
	case call := <-runner.calls:
		assert.Equal(t, int64(101), call.repoID)
		assert.Equal(t, "push", call.event.Type)
		assert.Equal(t, "refs/heads/main", call.event.Ref)
		assert.Equal(t, "abc123", call.event.CommitSHA)
		assert.Equal(t, int64(42), call.userID)
		assert.False(t, call.useLoadedSnapshot)
		assert.Zero(t, call.loadedDefinitions)
	case <-time.After(2 * time.Second):
		t.Fatal("workflow dispatch was not called")
	}
}

// TestInternalPushHookHandler_PostPushEvent_NonAdminPusherSkipsConfigSync is the
// regression guard for the config-sync privilege-escalation fix (M5): config-sync
// applies admin-only repo settings (visibility, protected bookmarks, webhooks,
// mirror, landing queue) authored in repo files, so a non-admin pusher must never
// trigger it — otherwise a write-only collaborator could push a .smithers/config.yml
// to flip the repo public or disable branch protection.
func TestInternalPushHookHandler_PostPushEvent_NonAdminPusherSkipsConfigSync(t *testing.T) {
	t.Parallel()

	// Pusher has only write access, not admin.
	resolver := &mockPushHookRepoResolver{collabPermission: "write"}
	dispatcher := &mockPushHookDispatcher{}

	syncer := &mockPushHookWorkflowSyncer{
		loadCalls:    make(chan syncCallRecord, 1),
		persistCalls: make(chan services.WorkflowLoadResult, 1),
		loadFn: func(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error) {
			return services.WorkflowLoadResult{
				Definitions: []services.LoadedWorkflowDefinition{
					{Name: "build", Path: ".smithers/workflows/build.tsx"},
				},
			}, nil
		},
	}
	runner := &mockPushHookWorkflowRunner{calls: make(chan dispatchCallRecord, 1)}
	configSyncer := &mockPushHookConfigSyncer{calls: make(chan configSyncCallRecord, 1)}

	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
		WorkflowSync: syncer,
		WorkflowRun:  runner,
		ConfigSync:   configSyncer,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		CommitSHA:    "abc123",
		PusherID:     42,
		PusherLogin:  "bob",

		PusherCredential: "person",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)

	// Workflow load still runs (not privileged) so the dispatch below can proceed.
	select {
	case <-syncer.loadCalls:
	case <-time.After(2 * time.Second):
		t.Fatal("workflow load was not called")
	}

	// Workflow dispatch (not an admin-only operation) still runs.
	select {
	case <-runner.calls:
	case <-time.After(2 * time.Second):
		t.Fatal("workflow dispatch was not called")
	}

	// Config-sync must be skipped for a non-admin pusher. Dispatch happens after
	// the config-sync gate, so this is a deterministic post-condition.
	select {
	case <-configSyncer.calls:
		t.Fatal("config sync must not run for a non-admin pusher")
	default:
	}
}

func TestInternalPushHookHandler_PostPushEvent_NonDefaultBookmarkSkipsPersistenceAndDispatchesPushForVerification(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{
		getRepoByIDFn: func(ctx context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", DefaultBookmark: "main"}, nil
		},
	}
	dispatcher := &mockPushHookDispatcher{}

	syncer := &mockPushHookWorkflowSyncer{
		loadCalls:    make(chan syncCallRecord, 1),
		persistCalls: make(chan services.WorkflowLoadResult, 1),
		loadFn: func(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error) {
			return services.WorkflowLoadResult{
				Definitions: []services.LoadedWorkflowDefinition{
					{Name: "feature-ci", Path: ".smithers/workflows/feature-ci.tsx"},
				},
			}, nil
		},
	}
	runner := &mockPushHookWorkflowRunner{calls: make(chan dispatchCallRecord, 1)}
	configSyncer := &mockPushHookConfigSyncer{calls: make(chan configSyncCallRecord, 1)}

	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
		WorkflowSync: syncer,
		WorkflowRun:  runner,
		ConfigSync:   configSyncer,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/feature/test",
		CommitSHA:    "branch123",
		PusherID:     42,
		PusherLogin:  "bob",

		PusherCredential: "person",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)

	select {
	case <-syncer.loadCalls:
	case <-time.After(2 * time.Second):
		t.Fatal("workflow load was not called")
	}

	select {
	case <-syncer.persistCalls:
		t.Fatal("workflow persistence should not run for non-default bookmark pushes")
	case <-time.After(200 * time.Millisecond):
	}

	select {
	case <-configSyncer.calls:
		t.Fatal("config sync should not run for non-default bookmark pushes")
	case <-time.After(200 * time.Millisecond):
	}

	select {
	case call := <-runner.calls:
		assert.False(t, call.useLoadedSnapshot)
		assert.Zero(t, call.loadedDefinitions)
		assert.Equal(t, "refs/heads/feature/test", call.event.Ref)
	case <-time.After(2 * time.Second):
		t.Fatal("workflow dispatch was not called")
	}
}

func TestInternalPushHookHandler_PostPushEvent_LoadFailureFallsBackToPersistedDefinitions(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{}
	dispatcher := &mockPushHookDispatcher{}

	syncDone := make(chan struct{}, 1)
	syncer := &mockPushHookWorkflowSyncer{
		loadFn: func(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error) {
			defer func() { syncDone <- struct{}{} }()
			return services.WorkflowLoadResult{}, errors.New("sync error")
		},
		loadCalls: make(chan syncCallRecord, 1),
	}
	runner := &mockPushHookWorkflowRunner{calls: make(chan dispatchCallRecord, 1)}

	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
		WorkflowSync: syncer,
		WorkflowRun:  runner,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		CommitSHA:    "def456",
		PusherID:     42,
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	// Handler returns 204 regardless of workflow errors.
	require.Equal(t, http.StatusNoContent, rec.Code)

	select {
	case <-syncDone:
	case <-time.After(2 * time.Second):
		t.Fatal("load goroutine did not complete")
	}
	select {
	case call := <-runner.calls:
		assert.False(t, call.useLoadedSnapshot)
		assert.Equal(t, 0, call.loadedDefinitions)
		assert.Equal(t, "push", call.event.Type)
		assert.Equal(t, "def456", call.event.CommitSHA)
	case <-time.After(2 * time.Second):
		t.Fatal("workflow dispatch should fall back to persisted definitions")
	}
}

func TestInternalPushHookHandler_PostPushEvent_NilWorkflowServices_NoError(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{}
	dispatcher := &mockPushHookDispatcher{}

	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
		// WorkflowSync and WorkflowRun are nil
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		CommitSHA:    "abc123",
		PusherID:     42,
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
}

// TestInternalPushHookHandler_PostPushEvent_WorkflowSyncContextHasDeadline is the
// regression guard for the unbounded post-push goroutine hardening (#231): the
// context passed to workflow sync must carry a deadline so a stuck repo-host
// call cannot park the worker goroutine forever.
func TestInternalPushHookHandler_PostPushEvent_WorkflowSyncContextHasDeadline(t *testing.T) {
	t.Parallel()

	resolver := &mockPushHookRepoResolver{}
	dispatcher := &mockPushHookDispatcher{}

	ctxCh := make(chan context.Context, 1)
	syncer := &mockPushHookWorkflowSyncer{
		loadFn: func(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error) {
			ctxCh <- ctx
			return services.WorkflowLoadResult{}, nil
		},
	}

	handler := &InternalPushHookHandler{
		RepoResolver: resolver,
		Dispatcher:   dispatcher,
		WorkflowSync: syncer,
	}

	payload := PushHookEventRequest{
		RepositoryID: 101,
		Owner:        "alice",
		Repo:         "demo",
		Ref:          "refs/heads/main",
		CommitSHA:    "abc123",
		PusherID:     42,
		PusherLogin:  "bob",

		PusherCredential: "person",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	postAndProcess(t, handler, rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)

	select {
	case ctx := <-ctxCh:
		_, ok := ctx.Deadline()
		require.True(t, ok, "workflow sync context should have a deadline")
	case <-time.After(2 * time.Second):
		t.Fatal("workflow load was not called")
	}
}
