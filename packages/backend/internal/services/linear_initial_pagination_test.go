package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type linearPageRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

func linearPageResponse(w http.ResponseWriter, nodes []map[string]string, hasNext bool, cursor any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"issues": map[string]any{
		"nodes": nodes, "pageInfo": map[string]any{"hasNextPage": hasNext, "endCursor": cursor},
	}}})
}

func linearPageNodes(first, last int) []map[string]string {
	nodes := make([]map[string]string, 0, last-first+1)
	for number := first; number <= last; number++ {
		nodes = append(nodes, map[string]string{
			"id": fmt.Sprintf("linear-page-%d", number), "identifier": fmt.Sprintf("PLT-%d", number),
			"title": fmt.Sprintf("Issue %d", number), "description": "From Linear",
		})
	}
	return nodes
}

// The service still builds its production URL. Rewrite only the transport's
// destination so the request crosses a real HTTP socket without a global URL.
func linearPageServerClient(server *httptest.Server) *http.Client {
	upstream := server.Client().Transport
	endpoint, _ := url.Parse(server.URL)
	return &http.Client{Transport: linearSyncRoundTripper(func(req *http.Request) (*http.Response, error) {
		copy := req.Clone(req.Context())
		copy.URL.Scheme, copy.URL.Host = endpoint.Scheme, endpoint.Host
		copy.Host = endpoint.Host
		return upstream.RoundTrip(copy)
	})}
}

func waitLinearPageRun(t *testing.T, svc *LinearSyncService, integration db.LinearIntegration, runID int64) LinearSyncRunStatus {
	t.Helper()
	var status LinearSyncRunStatus
	require.Eventually(t, func() bool {
		var err error
		status, err = svc.GetInitialSyncRun(t.Context(), integration.UserID, integration.ID, runID)
		return err == nil && (status.State == "completed" || status.State == "failed")
	}, 15*time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool {
		_, running := svc.initialSyncInFlight.Load(integration.ID)
		return !running
	}, time.Second, time.Millisecond)
	return status
}

func TestLinearInitialSyncImportsEveryProviderPageAndTracksTotals(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	var firstCalls, secondCalls atomic.Int32
	secondArrived := make(chan struct{})
	releaseSecond := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var input linearPageRequest
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if req.Header.Get("Authorization") != "Bearer linear-access-token" || !strings.Contains(input.Query, "pageInfo") {
			t.Errorf("missing provider token or pageInfo in query")
		}
		switch input.Variables["after"] {
		case nil:
			firstCalls.Add(1)
			linearPageResponse(w, linearPageNodes(1, 100), true, "cursor-100")
		case "cursor-100":
			if secondCalls.Add(1) == 1 {
				close(secondArrived)
				select {
				case <-releaseSecond:
				case <-req.Context().Done():
					return
				}
			}
			linearPageResponse(w, linearPageNodes(101, 101), false, "cursor-101")
		default:
			t.Errorf("unexpected continuation cursor: %v", input.Variables["after"])
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer func() {
		select {
		case <-releaseSecond:
		default:
			close(releaseSecond)
		}
		server.Close()
	}()
	svc := NewLinearSyncServiceWithPool(queries, NewLinearIntegrationService(queries, nil, "linear-sync-test-secret"), pool)
	svc.httpClient = linearPageServerClient(server)

	for attempt := 1; attempt <= 2; attempt++ {
		runID, err := svc.StartInitialSyncRun(t.Context(), integration.UserID, integration.ID)
		require.NoError(t, err)
		if attempt == 1 {
			select {
			case <-secondArrived:
			case <-time.After(10 * time.Second):
				t.Fatal("initial sync did not request the second page")
			}
			pending, err := svc.GetInitialSyncRun(t.Context(), integration.UserID, integration.ID, runID)
			require.NoError(t, err)
			require.Equal(t, "running", pending.State, "the run must wait for the final page")
			require.Equal(t, LinearSyncCount{Done: 100, Total: 100}, pending.Counts.Issues)
			stored, err := queries.GetLinearIntegration(t.Context(), integration.ID)
			require.NoError(t, err)
			require.False(t, stored.LastSyncAt.Valid)
			close(releaseSecond)
		}
		status := waitLinearPageRun(t, svc, integration, runID)
		require.Equal(t, "completed", status.State)
		require.Equal(t, LinearSyncCount{Done: 101, Total: 101}, status.Counts.Issues)
	}
	maps, err := queries.ListLinearIssueMaps(t.Context(), integration.ID)
	require.NoError(t, err)
	require.Len(t, maps, 101)
	_, err = queries.GetLinearIssueMapByLinearIssue(t.Context(), db.GetLinearIssueMapByLinearIssueParams{
		IntegrationID: integration.ID, LinearIssueID: "linear-page-101",
	})
	require.NoError(t, err)
	require.EqualValues(t, 2, firstCalls.Load())
	require.EqualValues(t, 2, secondCalls.Load())
}

func TestLinearInitialSyncContinuationFailureCanRetryWithoutDuplicates(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	var secondCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var input linearPageRequest
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch input.Variables["after"] {
		case nil:
			linearPageResponse(w, linearPageNodes(1, 100), true, "cursor-100")
		case "cursor-100":
			if secondCalls.Add(1) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			linearPageResponse(w, linearPageNodes(101, 101), false, "cursor-101")
		default:
			t.Errorf("unexpected cursor: %v", input.Variables["after"])
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	svc := NewLinearSyncServiceWithPool(queries, NewLinearIntegrationService(queries, nil, "linear-sync-test-secret"), pool)
	svc.httpClient = linearPageServerClient(server)

	runID, err := svc.StartInitialSyncRun(t.Context(), integration.UserID, integration.ID)
	require.NoError(t, err)
	first := waitLinearPageRun(t, svc, integration, runID)
	require.Equal(t, "failed", first.State)
	require.Equal(t, LinearSyncCount{Done: 100, Total: 100}, first.Counts.Issues)
	stored, err := queries.GetLinearIntegration(t.Context(), integration.ID)
	require.NoError(t, err)
	require.False(t, stored.LastSyncAt.Valid)
	maps, err := queries.ListLinearIssueMaps(t.Context(), integration.ID)
	require.NoError(t, err)
	require.Len(t, maps, 100)

	runID, err = svc.StartInitialSyncRun(t.Context(), integration.UserID, integration.ID)
	require.NoError(t, err)
	second := waitLinearPageRun(t, svc, integration, runID)
	require.Equal(t, "completed", second.State)
	require.Equal(t, LinearSyncCount{Done: 101, Total: 101}, second.Counts.Issues)
	maps, err = queries.ListLinearIssueMaps(t.Context(), integration.ID)
	require.NoError(t, err)
	require.Len(t, maps, 101)
	require.EqualValues(t, 2, secondCalls.Load())
}

func TestLinearInitialSyncRejectsNonProgressingContinuation(t *testing.T) {
	for _, tc := range []struct {
		name             string
		cursor           any
		cursorSequence   []any
		pageInfoOverride bool
		pageInfo         any
		wantCalls        int32
	}{
		{name: "missing cursor", cursor: nil, wantCalls: 1},
		{name: "empty cursor", cursor: "", wantCalls: 1},
		{name: "whitespace cursor", cursor: " \t ", wantCalls: 1},
		{name: "non-string cursor", cursor: 42, wantCalls: 1},
		{name: "repeated cursor", cursor: "cursor-1", wantCalls: 2},
		{name: "non-adjacent cursor cycle", cursorSequence: []any{"A", "B", "A"}, wantCalls: 3},
		{name: "missing pageInfo", pageInfoOverride: true, pageInfo: nil, wantCalls: 1},
		{name: "invalid hasNextPage", pageInfoOverride: true, pageInfo: map[string]any{"hasNextPage": "yes"}, wantCalls: 1},
		{name: "missing hasNextPage", pageInfoOverride: true, pageInfo: map[string]any{"endCursor": "cursor-1"}, wantCalls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			integration, integrationSvc := linearSyncCovIntegration(t)
			queries := &linearSyncCovQuerier{integration: integration}
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				call := calls.Add(1)
				if tc.pageInfoOverride {
					w.Header().Set("Content-Type", "application/json")
					issues := map[string]any{"nodes": []map[string]string{}}
					if tc.pageInfo != nil {
						issues["pageInfo"] = tc.pageInfo
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"issues": issues}})
					return
				}
				cursor := tc.cursor
				if len(tc.cursorSequence) > 0 {
					if int(call) > len(tc.cursorSequence) {
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					cursor = tc.cursorSequence[call-1]
				}
				linearPageResponse(w, []map[string]string{}, true, cursor)
			}))
			defer server.Close()
			svc := NewLinearSyncService(queries, integrationSvc)
			svc.httpClient = linearPageServerClient(server)
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			err := svc.runInitialSync(ctx, integration, 0)
			require.Error(t, err)
			require.Equal(t, tc.wantCalls, calls.Load(), "continuation must stop when pagination cannot progress")
			require.Empty(t, queries.lastSyncIDs, "invalid pagination cannot mark the integration synced")
		})
	}
}

func TestLinearInitialSyncCancellationDuringContinuation(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	secondArrived := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var input linearPageRequest
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if input.Variables["after"] == nil {
			linearPageResponse(w, linearPageNodes(1, 1), true, "cursor-1")
			return
		}
		close(secondArrived)
		<-req.Context().Done()
	}))
	defer server.Close()
	svc := NewLinearSyncServiceWithPool(queries, NewLinearIntegrationService(queries, nil, "linear-sync-test-secret"), pool)
	svc.httpClient = linearPageServerClient(server)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- svc.runInitialSync(ctx, integration, 0) }()
	select {
	case <-secondArrived:
	case <-time.After(10 * time.Second):
		t.Fatal("continuation was not requested")
	}
	cancel()
	select {
	case err := <-result:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(10 * time.Second):
		t.Fatal("canceled sync did not stop")
	}
	maps, err := queries.ListLinearIssueMaps(t.Context(), integration.ID)
	require.NoError(t, err)
	require.Len(t, maps, 1)
	stored, err := queries.GetLinearIntegration(t.Context(), integration.ID)
	require.NoError(t, err)
	require.False(t, stored.LastSyncAt.Valid, "a canceled pagination sequence is incomplete")
}

type linearPageCancelOnLookup struct {
	*linearSyncCovQuerier
	cancel  context.CancelFunc
	lookups int
}

func (q *linearPageCancelOnLookup) GetLinearIssueMapByLinearIssue(_ context.Context, _ db.GetLinearIssueMapByLinearIssueParams) (db.LinearIssueMap, error) {
	q.lookups++
	q.cancel()
	return db.LinearIssueMap{ID: 1}, nil
}

func TestLinearInitialSyncCancellationDuringFinalPageNode(t *testing.T) {
	for _, nodeCount := range []int{1, 2} {
		t.Run(fmt.Sprintf("%d nodes", nodeCount), func(t *testing.T) {
			integration, integrationSvc := linearSyncCovIntegration(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			queries := &linearPageCancelOnLookup{
				linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration},
				cancel:               cancel,
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				linearPageResponse(w, linearPageNodes(1, nodeCount), false, "cursor-1")
			}))
			defer server.Close()
			svc := NewLinearSyncService(queries, integrationSvc)
			svc.httpClient = linearPageServerClient(server)

			err := svc.runInitialSync(ctx, integration, 0)
			require.ErrorIs(t, err, context.Canceled)
			require.Equal(t, 1, queries.lookups, "no further nodes may process after cancellation")
			require.Empty(t, queries.lastSyncIDs, "canceling the final page cannot mark the integration synced")
		})
	}
}

type linearPageTerminalStore struct {
	*linearSyncOperationsTestStore
	cancel           context.CancelFunc
	cancelAt         string
	lastSyncWrites   int
	terminalErr      error
	terminalDeadline bool
	terminalAttempts int
}

func (s *linearPageTerminalStore) GetLinearIssueMapByLinearIssue(_ context.Context, _ db.GetLinearIssueMapByLinearIssueParams) (db.LinearIssueMap, error) {
	if s.cancelAt == "lookup" {
		s.cancel()
	}
	return db.LinearIssueMap{ID: 1}, nil
}

func (s *linearPageTerminalStore) UpdateLinearIntegrationLastSync(ctx context.Context, id int64) error {
	s.lastSyncWrites++
	if s.cancelAt == "last sync write" {
		s.cancel()
		return ctx.Err()
	}
	return s.linearSyncOperationsTestStore.linearSyncCovQuerier.UpdateLinearIntegrationLastSync(ctx, id)
}

func (s *linearPageTerminalStore) FailLinearSyncRun(ctx context.Context, id int64) (db.LinearSyncRun, error) {
	s.terminalAttempts++
	s.terminalErr = ctx.Err()
	_, s.terminalDeadline = ctx.Deadline()
	if s.terminalErr != nil {
		return db.LinearSyncRun{}, s.terminalErr
	}
	return s.linearSyncOperationsTestStore.FailLinearSyncRun(ctx, id)
}

func TestLinearTrackedInitialSyncCancellationRecordsFailedWithLiveContext(t *testing.T) {
	for _, tc := range []struct {
		cancelAt           string
		wantLastSyncWrites int
	}{
		{cancelAt: "lookup", wantLastSyncWrites: 0},
		{cancelAt: "last sync write", wantLastSyncWrites: 1},
	} {
		t.Run(tc.cancelAt, func(t *testing.T) {
			integration, integrationSvc := linearSyncCovIntegration(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			store := &linearPageTerminalStore{
				linearSyncOperationsTestStore: &linearSyncOperationsTestStore{
					linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration},
				},
				cancel:   cancel,
				cancelAt: tc.cancelAt,
			}
			run, err := store.CreateLinearSyncRun(ctx, integration.ID)
			require.NoError(t, err)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				linearPageResponse(w, linearPageNodes(1, 1), false, "cursor-1")
			}))
			defer server.Close()
			svc := NewLinearSyncService(store, integrationSvc)
			svc.httpClient = linearPageServerClient(server)

			svc.runTrackedInitialSync(ctx, integration, run.ID)
			require.ErrorIs(t, ctx.Err(), context.Canceled)
			require.Equal(t, tc.wantLastSyncWrites, store.lastSyncWrites)
			require.Equal(t, 1, store.terminalAttempts)
			require.NoError(t, store.terminalErr, "the failure receipt needs a live terminal context")
			require.True(t, store.terminalDeadline, "terminal receipt writes need a time bound")
			require.Equal(t, "failed", store.run.State)
			require.True(t, store.run.FinishedAt.Valid)
			require.Empty(t, store.lastSyncIDs)
		})
	}
}
