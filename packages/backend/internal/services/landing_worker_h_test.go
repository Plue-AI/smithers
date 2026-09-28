package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type landingWorkerHDispatcher struct {
	err   error
	calls int
}

func (d *landingWorkerHDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	d.calls++
	return d.err
}

func (d *landingWorkerHDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

func TestLandingWorker_H_StartAndExecuteIntermediateFailures(t *testing.T) {
	ctx := context.Background()

	polled := make(chan struct{}, 1)
	startCtx, cancel := context.WithCancel(ctx)
	q := &mockLandingWorkerQuerier{
		claimPendingLandingTaskFn: func(context.Context) (db.LandingTask, error) {
			polled <- struct{}{}
			return db.LandingTask{}, errors.New("temporary")
		},
	}
	worker := NewLandingWorker(q, &mockWorkerRepoHostClient{})
	worker.interval = time.Millisecond
	go worker.Start(startCtx)
	select {
	case <-polled:
	case <-time.After(time.Second):
		t.Fatal("worker did not poll")
	}
	cancel()

	task := workerTask(1, 2, 3)
	for _, tc := range []struct {
		name string
		q    *mockLandingWorkerQuerier
		want string
	}{
		{
			name: "landing request",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return db.LandingRequest{}, errors.New("request failed")
				},
			},
			want: "get landing request",
		},
		{
			name: "changes",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return workerLandingRequest(2, 3), nil
				},
				listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
					return nil, errors.New("changes failed")
				},
			},
			want: "list landing changes",
		},
		{
			name: "repo",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return workerLandingRequest(2, 3), nil
				},
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{}, errors.New("repo failed")
				},
			},
			want: "get repository",
		},
		{
			name: "owner",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return workerLandingRequest(2, 3), nil
				},
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 3}, nil
				},
			},
			want: "resolve repo owner",
		},
		{
			name: "started",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return workerLandingRequest(2, 3), nil
				},
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return workerRepo(3), nil
				},
				markLandingStartedFn: func(context.Context, int64) (db.LandingRequest, error) {
					return db.LandingRequest{}, errors.New("start failed")
				},
			},
			want: "mark landing started",
		},
		{
			name: "done",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return workerLandingRequest(2, 3), nil
				},
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return workerRepo(3), nil
				},
				markLandingTaskDoneFn: func(context.Context, int64) (db.LandingTask, error) {
					return db.LandingTask{}, errors.New("done failed")
				},
			},
			want: "mark task done",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			worker := NewLandingWorker(tc.q, &mockWorkerRepoHostClient{})
			worker.finalizeRetryDelay = 0 // Exercise every retry without production backoff.
			err := worker.executeTask(ctx, task)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}

func TestLandingWorker_H_WebhookAndOwnerErrorBranches(t *testing.T) {
	ctx := context.Background()
	task := workerTask(1, 2, 3)
	lr := workerLandingRequest(2, 3)
	repo := workerRepo(3)

	dispatcher := &landingWorkerHDispatcher{err: errors.New("dispatch failed")}
	w := NewLandingWorker(&mockLandingWorkerQuerier{
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("author failed")
		},
	}, &mockWorkerRepoHostClient{}, WithLandingWorkerWebhookDispatcher(dispatcher))
	w.dispatchLandedEvent(ctx, repo, lr, []string{"c1"})
	assert.Equal(t, 0, dispatcher.calls)

	w = NewLandingWorker(&mockLandingWorkerQuerier{}, &mockWorkerRepoHostClient{}, WithLandingWorkerWebhookDispatcher(dispatcher))
	w.dispatchLandedEvent(ctx, repo, lr, []string{"c1"})
	assert.Equal(t, 1, dispatcher.calls)

	for _, tc := range []struct {
		name string
		q    *mockLandingWorkerQuerier
	}{
		{
			name: "load failed request",
			q: &mockLandingWorkerQuerier{
				getLandingRequestByIDFn: func(context.Context, int64) (db.LandingRequest, error) {
					return db.LandingRequest{}, errors.New("request failed")
				},
			},
		},
		{
			name: "repo",
			q: &mockLandingWorkerQuerier{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{}, errors.New("repo failed")
				},
			},
		},
		{
			name: "owner",
			q: &mockLandingWorkerQuerier{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: task.RepositoryID, Name: "demo"}, nil
				},
			},
		},
		{
			name: "author",
			q: &mockLandingWorkerQuerier{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: task.RepositoryID, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) {
					return db.User{}, errors.New("author failed")
				},
			},
		},
		{
			name: "changes",
			q: &mockLandingWorkerQuerier{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: task.RepositoryID, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
				},
				listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
					return nil, errors.New("changes failed")
				},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &landingWorkerHDispatcher{}
			w := NewLandingWorker(tc.q, &mockWorkerRepoHostClient{}, WithLandingWorkerWebhookDispatcher(d))
			if tc.name == "load failed request" {
				w.dispatchFailedEvent(ctx, task, db.LandingRequest{})
			} else {
				w.dispatchFailedEvent(ctx, task, lr)
			}
			assert.Equal(t, 0, d.calls)
		})
	}

	d := &landingWorkerHDispatcher{err: errors.New("dispatch failed")}
	w = NewLandingWorker(&mockLandingWorkerQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: task.RepositoryID, Name: "demo", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
		},
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ChangeID: "c1"}}, nil
		},
	}, &mockWorkerRepoHostClient{}, WithLandingWorkerWebhookDispatcher(d))
	w.dispatchFailedEvent(ctx, task, lr)
	assert.Equal(t, 1, d.calls)

	w = NewLandingWorker(&mockLandingWorkerQuerier{
		getOrgByIDFn: func(context.Context, int64) (db.Organization, error) {
			return db.Organization{}, errors.New("org failed")
		},
	}, &mockWorkerRepoHostClient{})
	_, err := w.resolveRepoOwner(ctx, db.Repository{ID: 9, OrgID: pgtype.Int8{Int64: 4, Valid: true}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "org failed")

	_, err = w.resolveRepoOwner(ctx, db.Repository{ID: 9})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "neither user nor org")
}
