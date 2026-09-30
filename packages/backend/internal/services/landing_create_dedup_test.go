package services

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// requireStackInFlight asserts the typed refusal that names the landing
// request already carrying the proposed stack.
func requireStackInFlight(t *testing.T, err error, number int64) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeLandingStackInFlight, apiErr.Code)
	require.Equal(t, http.StatusConflict, apiErr.Status)
	require.Equal(t, map[string]int64{"number": number}, apiErr.Details)
	require.Equal(t, fmt.Sprintf("landing request #%d already carries this stack", number), apiErr.Message)
}

// Distinct callers proposing one exact stack onto one target open one landing
// request; every other proposal is refused with that landing request's number.
func TestCreateLandingRequestRefusesStackAlreadyInFlight(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	service := NewLandingServiceWithPool(q, &mockLandingRepoHostClient{}, pool)
	create := func(requestID, target string, changes ...string) (LandingRequestResponse, error) {
		return service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, CreateLandingRequestInput{
			RequestID: requestID, Title: "proposal", TargetBookmark: target, ChangeIDs: changes,
		})
	}
	count := func(query string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, query, repoID).Scan(&n))
		return n
	}

	// Callers race: each uses its own request identity, and half use none.
	const callers = 8
	type result struct {
		response LandingRequestResponse
		err      error
	}
	results := make(chan result, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		requestID := ""
		if i%2 == 0 {
			requestID = uuid.NewString()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := create(requestID, "main", "stack-a", "stack-b")
			results <- result{r, e}
		}()
	}
	wg.Wait()
	close(results)
	var opened []int64
	var refused []error
	for r := range results {
		if r.err == nil {
			opened = append(opened, r.response.Number)
		} else {
			refused = append(refused, r.err)
		}
	}
	require.Len(t, opened, 1)
	number := opened[0]
	require.Len(t, refused, callers-1)
	for _, e := range refused {
		requireStackInFlight(t, e, number)
	}
	require.Equal(t, 1, count(`SELECT count(*) FROM landing_requests WHERE repository_id=$1`))
	require.Equal(t, 2, count(`SELECT count(*) FROM landing_request_changes c JOIN landing_requests r ON r.id=c.landing_request_id WHERE r.repository_id=$1`))

	// Only the exact ordered stack onto the same target matches.
	for _, proposal := range []struct {
		target  string
		changes []string
	}{
		{"main", []string{"stack-b", "stack-a"}},
		{"main", []string{"stack-a"}},
		{"main", []string{"stack-a", "stack-b", "stack-c"}},
		{"release", []string{"stack-a", "stack-b"}},
	} {
		r, err := create(uuid.NewString(), proposal.target, proposal.changes...)
		require.NoError(t, err, proposal)
		require.NotEqual(t, number, r.Number)
	}
	require.Equal(t, 5, count(`SELECT count(*) FROM landing_requests WHERE repository_id=$1`))

	// Draft, queued and landing requests are still in flight.
	for _, state := range []string{"draft", "queued", "landing"} {
		_, err = pool.Exec(ctx, `UPDATE landing_requests SET state=$2 WHERE repository_id=$1 AND number=$3`, repoID, state, number)
		require.NoError(t, err)
		_, err = create(uuid.NewString(), "main", "stack-a", "stack-b")
		requireStackInFlight(t, err, number)
	}

	// A finished landing request no longer holds the stack: the next proposal opens a new one.
	for _, state := range []string{"closed", "merged", "failed"} {
		_, err = pool.Exec(ctx, `UPDATE landing_requests SET state=$2 WHERE repository_id=$1 AND number=$3`, repoID, state, number)
		require.NoError(t, err)
		r, err := create(uuid.NewString(), "main", "stack-a", "stack-b")
		require.NoError(t, err, state)
		require.NotEqual(t, number, r.Number, state)
		number = r.Number
	}
	require.Equal(t, 8, count(`SELECT count(*) FROM landing_requests WHERE repository_id=$1`))
}

// A replayed request identity still returns its own landing request, even
// while another in-flight landing request carries the same stack, and still
// refuses changed input.
func TestCreateLandingRequestReplayPrecedesStackRefusal(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	service := NewLandingServiceWithPool(q, &mockLandingRepoHostClient{}, pool)
	first := CreateLandingRequestInput{RequestID: uuid.NewString(), Title: "first", TargetBookmark: "main", ChangeIDs: []string{"replay-a"}}
	original, err := service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, first)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE landing_requests SET state='closed' WHERE repository_id=$1 AND number=$2`, repoID, original.Number)
	require.NoError(t, err)
	reopened, err := service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, CreateLandingRequestInput{Title: "second", TargetBookmark: "main", ChangeIDs: []string{"replay-a"}})
	require.NoError(t, err)
	require.NotEqual(t, original.Number, reopened.Number)

	replay, err := service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, first)
	require.NoError(t, err)
	require.Equal(t, original.Number, replay.Number)
	require.Equal(t, first.RequestID, replay.RequestID)

	changed := first
	changed.Title = "changed"
	_, err = service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, changed)
	require.ErrorContains(t, err, "different input")

	// A refused identity is not bound: after the stack's landing finishes, the same identity opens one.
	refusedID := uuid.NewString()
	_, err = service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, CreateLandingRequestInput{RequestID: refusedID, Title: "third", TargetBookmark: "main", ChangeIDs: []string{"replay-a"}})
	requireStackInFlight(t, err, reopened.Number)
	_, err = pool.Exec(ctx, `UPDATE landing_requests SET state='merged' WHERE repository_id=$1 AND number=$2`, repoID, reopened.Number)
	require.NoError(t, err)
	third, err := service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, CreateLandingRequestInput{RequestID: refusedID, Title: "third", TargetBookmark: "main", ChangeIDs: []string{"replay-a"}})
	require.NoError(t, err)
	require.Equal(t, refusedID, third.RequestID)
}

func TestCreateLandingInTxStackBoundaries(t *testing.T) {
	params := db.CreateLandingRequestParams{RepositoryID: 7, Title: "t", AuthorID: 3, TargetBookmark: "main", StackSize: 2}
	run := func(tx *mockLandingCreateTx) error {
		svc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{})
		svc.createTxManager = &mockLandingCreateTxManager{beginCreateTxFn: func(context.Context) (landingCreateTx, error) { return tx, nil }}
		_, err := svc.createLandingInTx(context.Background(), params, []string{"k1", "k2"})
		return err
	}
	noInsert := func(context.Context, db.CreateLandingRequestParams) (db.LandingRequest, error) {
		t.Fatal("a refused proposal must not insert")
		return db.LandingRequest{}, nil
	}

	t.Run("lock then exact-stack lookup, refusal names the landing request", func(t *testing.T) {
		var calls []any
		tx := &mockLandingCreateTx{
			lockProposalFn: func(_ context.Context, arg db.LockLandingProposalParams) error {
				calls = append(calls, arg)
				return nil
			},
			findInFlightFn: func(_ context.Context, arg db.FindInFlightLandingRequestByStackParams) (db.LandingRequest, error) {
				calls = append(calls, arg)
				return db.LandingRequest{ID: 41, Number: 9}, nil
			},
			createLandingRequestFn: noInsert,
		}
		requireStackInFlight(t, run(tx), 9)
		require.Equal(t, []any{
			db.LockLandingProposalParams{RepositoryID: 7, TargetBookmark: "main"},
			db.FindInFlightLandingRequestByStackParams{RepositoryID: 7, TargetBookmark: "main", ChangeIds: []string{"k1", "k2"}},
		}, calls)
		require.True(t, tx.rolledBack)
		require.False(t, tx.committed)
	})

	t.Run("lock failure refuses before lookup", func(t *testing.T) {
		tx := &mockLandingCreateTx{
			lockProposalFn: func(context.Context, db.LockLandingProposalParams) error { return fmt.Errorf("lock timeout") },
			findInFlightFn: func(context.Context, db.FindInFlightLandingRequestByStackParams) (db.LandingRequest, error) {
				t.Fatal("a failed lock must not look up the stack")
				return db.LandingRequest{}, nil
			},
			createLandingRequestFn: noInsert,
		}
		require.ErrorContains(t, run(tx), "failed to serialize landing request proposal")
		require.True(t, tx.rolledBack)
	})

	t.Run("lookup failure refuses without inserting", func(t *testing.T) {
		tx := &mockLandingCreateTx{
			findInFlightFn: func(context.Context, db.FindInFlightLandingRequestByStackParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, fmt.Errorf("connection reset")
			},
			createLandingRequestFn: noInsert,
		}
		require.ErrorContains(t, run(tx), "failed to find the landing request for this stack")
		require.True(t, tx.rolledBack)
	})
}

type mockLandingIdentityTx struct {
	mockLandingCreateTx
	lookupFn func(context.Context, db.GetLandingRequestByCreateIdentityParams) (db.LandingRequest, error)
}

func (m *mockLandingIdentityTx) CreateLandingRequestIdempotent(context.Context, db.CreateLandingRequestIdempotentParams) (db.LandingRequest, error) {
	return db.LandingRequest{}, fmt.Errorf("unexpected insert")
}

func (m *mockLandingIdentityTx) GetLandingRequestByCreateIdentity(ctx context.Context, arg db.GetLandingRequestByCreateIdentityParams) (db.LandingRequest, error) {
	return m.lookupFn(ctx, arg)
}

func TestCreateLandingIdempotentStackFailuresRefuse(t *testing.T) {
	params := db.CreateLandingRequestParams{RepositoryID: 7, Title: "t", AuthorID: 3, TargetBookmark: "main", StackSize: 1}
	run := func(tx *mockLandingIdentityTx) error {
		svc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{})
		svc.createTxManager = &mockLandingCreateTxManager{beginCreateTxFn: func(context.Context) (landingCreateTx, error) { return tx, nil }}
		_, err := svc.createLandingIdempotent(context.Background(), db.Repository{ID: 7, Name: "demo"}, "alice", &db.User{ID: 3}, params, []string{"k1"}, uuid.NewString())
		return err
	}

	lockFailed := &mockLandingIdentityTx{lookupFn: func(context.Context, db.GetLandingRequestByCreateIdentityParams) (db.LandingRequest, error) {
		t.Fatal("a failed lock must not read request identity")
		return db.LandingRequest{}, nil
	}}
	lockFailed.lockProposalFn = func(context.Context, db.LockLandingProposalParams) error { return fmt.Errorf("lock timeout") }
	require.ErrorContains(t, run(lockFailed), "failed to serialize landing request proposal")
	require.True(t, lockFailed.rolledBack)

	lookupFailed := &mockLandingIdentityTx{lookupFn: func(context.Context, db.GetLandingRequestByCreateIdentityParams) (db.LandingRequest, error) {
		return db.LandingRequest{}, fmt.Errorf("connection reset")
	}}
	require.ErrorContains(t, run(lookupFailed), "failed to recover landing request")
	require.True(t, lookupFailed.rolledBack)
	require.False(t, lookupFailed.committed)
}
