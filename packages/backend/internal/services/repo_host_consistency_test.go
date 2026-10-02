package services

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type controlledDeadlineContext struct {
	context.Context
	done     chan struct{}
	deadline time.Time
	expired  atomic.Bool
}

func newControlledDeadlineContext(parent context.Context) *controlledDeadlineContext {
	return &controlledDeadlineContext{
		Context:  parent,
		done:     make(chan struct{}),
		deadline: time.Now().Add(time.Hour),
	}
}

func (c *controlledDeadlineContext) Deadline() (time.Time, bool) { return c.deadline, true }
func (c *controlledDeadlineContext) Done() <-chan struct{}       { return c.done }
func (c *controlledDeadlineContext) Err() error {
	if c.expired.Load() {
		return context.DeadlineExceeded
	}
	return nil
}

func (c *controlledDeadlineContext) expire() {
	if c.expired.CompareAndSwap(false, true) {
		close(c.done)
	}
}

func TestBeginRepoHostMutationConsistency_ExpiredBeforeBoundaryDoesNotStart(t *testing.T) {
	t.Parallel()

	parent := newControlledDeadlineContext(context.Background())
	parent.expire()

	ctx, cancel, err := beginRepoHostMutationConsistency(parent, time.Minute)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Nil(t, ctx)
	assert.Nil(t, cancel)

	called := false
	err = runRepoHostMutation(parent, func(context.Context) error {
		called = true
		return nil
	})
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.False(t, called, "repo-host must not be called after cancellation won the pre-mutation race")
}

func TestBeginRepoHostMutationConsistency_DeadlineAfterBoundaryCannotCancelCoordination(t *testing.T) {
	t.Parallel()

	type valueKey struct{}
	parent := newControlledDeadlineContext(context.WithValue(context.Background(), valueKey{}, "request-value"))
	started := time.Now()
	ctx, cancel, err := beginRepoHostMutationConsistency(parent, 5*time.Minute)
	require.NoError(t, err)
	defer cancel()

	deadline, ok := ctx.Deadline()
	require.True(t, ok, "the detached consistency phase must remain bounded")
	assert.WithinDuration(t, started.Add(5*time.Minute), deadline, time.Second)
	assert.Equal(t, "request-value", ctx.Value(valueKey{}), "request tracing values must survive detachment")

	parent.expire()
	require.ErrorIs(t, parent.Err(), context.DeadlineExceeded)
	assert.NoError(t, ctx.Err(), "the request deadline fired after the coordinated mutation began")
	select {
	case <-ctx.Done():
		t.Fatal("consistency context was canceled by the parent deadline")
	default:
	}
}

func TestCreateRepo_CancellationAfterStorageStartsDoesNotRollbackSuccessfulMutation(t *testing.T) {
	t.Parallel()

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	q := &mockRepoQuerier{}
	rh := &mockRepoHostClient{
		initRepoFn: func(mutationCtx context.Context, _, _, _ string, _ bool) error {
			require.NoError(t, mutationCtx.Err())
			cancelRequest()
			require.ErrorIs(t, requestCtx.Err(), context.Canceled)
			require.NoError(t, mutationCtx.Err(), "cancellation arrived after repo-host mutation started")
			_, bounded := mutationCtx.Deadline()
			assert.True(t, bounded)
			return nil
		},
	}

	repo, err := NewRepoService(q, rh, "s1").CreateRepo(requestCtx, testUser(), "demo", "", true, "main", false)
	require.NoError(t, err)
	assert.Equal(t, "demo", repo.Name)
	assert.False(t, q.deleteCalled, "a truthful repo-host success must keep the coordinated DB row")
}

type cancelingImportRepoHost struct {
	GitHubImportRepoHost
	t          *testing.T
	requestCtx context.Context
	cancel     context.CancelFunc
}

func (h cancelingImportRepoHost) InitRepo(ctx context.Context, _, _, _ string, _ bool) error {
	h.cancel()
	require.ErrorIs(h.t, h.requestCtx.Err(), context.Canceled)
	require.NoError(h.t, ctx.Err(), "GitHub import init already crossed the consistency boundary")
	return nil
}

func TestGitHubImportInit_CancellationAfterStorageStartsKeepsCreatedRow(t *testing.T) {
	t.Parallel()

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	deleted := &[]int64{}
	svc := &GitHubImportService{
		repoDB: testGitHubImportRepoDB{deleted: deleted},
		repoHost: cancelingImportRepoHost{
			t:          t,
			requestCtx: requestCtx,
			cancel:     cancelRequest,
		},
	}

	repo, reused, err := svc.ensureLocalRepo(requestCtx, 7, "alice", "octo", "demo", "main")
	require.NoError(t, err)
	assert.False(t, reused)
	assert.Equal(t, int64(42), repo.ID)
	assert.Empty(t, *deleted)
}

type orderedCleanupRepoHost struct {
	GitHubImportRepoHost
	calls *[]string
}

func (h orderedCleanupRepoHost) DeleteRepo(ctx context.Context, _, _ string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	*h.calls = append(*h.calls, "storage")
	return nil
}

type orderedCleanupRepoDB struct {
	GitHubImportRepoDB
	calls *[]string
}

func (d orderedCleanupRepoDB) DeleteRepo(ctx context.Context, _ int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	*d.calls = append(*d.calls, "db")
	return nil
}

func TestGitHubImportRollback_StorageCompletesBeforeDBWithCanceledRequest(t *testing.T) {
	t.Parallel()

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()

	var calls []string
	svc := &GitHubImportService{
		repoHost: orderedCleanupRepoHost{calls: &calls},
		repoDB:   orderedCleanupRepoDB{calls: &calls},
	}
	svc.rollbackFreshImportRepo(requestCtx, 42, "alice", "demo")
	assert.Equal(t, []string{"storage", "db"}, calls)
}
