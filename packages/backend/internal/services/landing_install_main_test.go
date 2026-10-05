package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Spec §5.2.1: in install mode no credential moves main through repo-host
// landing. Land, append and auto-land onto main or the default bookmark, in
// any spelling, are refused at admission with the §6.2.3 permission envelope,
// before any repository host call or queue write. Hosted landing and install
// landing onto another bookmark are unchanged.
func TestLandingService_InstallRefusesLandingOntoMain(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
		r.DefaultBookmark = "trunk"
	})
	landing := func(target string) (*autoLandTestQuerier, *mockLandingRepoHostClient, *int) {
		repoHostCalls := 0
		base := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repository, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(88, repository.ID, arg.Number, actor.ID, []string{"k-a"})
				row.TargetBookmark = target
				return row, nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) { return *actor, nil },
		}
		q := &autoLandTestQuerier{mockLandingQuerier: base}
		q.setFn = func(context.Context, db.SetLandingRequestAutoLandParams) (db.LandingRequest, error) {
			t.Fatalf("auto-land onto %s was recorded", target)
			return db.LandingRequest{}, nil
		}
		rh := &mockLandingRepoHostClient{getChangeFn: func(context.Context, string, string, string) (repohost.Change, error) {
			repoHostCalls++
			return repohost.Change{}, nil
		}}
		return q, rh, &repoHostCalls
	}
	for _, target := range []string{"main", "MAIN", "ma‌in", "trunk", "Trunk"} {
		for _, input := range []LandLandingRequestInput{
			{CommitID: "k1"},
			{CommitID: "k1", Append: &repohost.LandAppend{SourceCommitID: "c1", SourceBaseCommitID: "c0"}},
		} {
			q, rh, calls := landing(target)
			svc := NewLandingService(q, rh, WithLandingInstallMainMirror(true))
			_, err := svc.LandLandingRequest(context.Background(), actor, "owner", "demo", 5, input)
			refusal, ok := err.(*pkgerrors.APIError)
			require.True(t, ok, "land onto %s: %v", target, err)
			assert.Equal(t, 403, refusal.Status, target)
			assert.Equal(t, pkgerrors.CodePermission, refusal.Code, target)
			assert.Equal(t, "permission", refusal.Class, target)
			assert.Zero(t, *calls, "land onto %s reached the repository host", target)
			assert.False(t, q.enqueueLandingRequestCalled, target)
			assert.False(t, q.createLandingTaskCalled, target)
		}
		q, rh, _ := landing(target)
		svc := NewLandingService(q, rh, WithLandingInstallMainMirror(true))
		_, err := svc.SetLandingRequestAutoLand(context.Background(), actor, "owner", "demo", 5, SetAutoLandInput{Enabled: true})
		assert.Equal(t, 403, landingAPIStatus(t, err), "auto-land onto %s", target)
	}

	// Install landing onto another bookmark, and hosted landing onto main,
	// pass admission and reach the repository host.
	for _, tc := range []struct {
		target  string
		install bool
	}{{"feature", true}, {"main", false}, {"trunk", false}} {
		q, rh, calls := landing(tc.target)
		svc := NewLandingService(q, rh, WithLandingInstallMainMirror(tc.install))
		_, err := svc.LandLandingRequest(context.Background(), actor, "owner", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		if err != nil {
			apiErr, ok := err.(*pkgerrors.APIError)
			require.True(t, ok, "%+v: %v", tc, err)
			assert.NotEqual(t, pkgerrors.CodePermission, apiErr.Code, "%+v", tc)
		}
		assert.NotZero(t, *calls, "%+v did not reach the repository host", tc)
	}
}

// An auto-land intent recorded before the install refused it never enqueues
// a landing onto main; the worker treats it like a blocked candidate.
func TestLandingService_InstallAutoLandNeverEnqueuesMain(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(10, "owner")
	for _, target := range []string{"main", "trunk"} {
		repository := landingRepo(func(r *db.Repository) {
			r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
			r.DefaultBookmark = "trunk"
		})
		candidate := landingDBRequest(88, repository.ID, 7, actor.ID, func(row *db.LandingRequest) {
			row.TargetBookmark = target
			row.AutoLandEnabled = true
			row.AutoLandSetBy = pgtype.Int8{Int64: actor.ID, Valid: true}
			row.AutoLandSetAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
		})
		q := &autoLandTestQuerier{mockLandingQuerier: &mockLandingQuerier{
			getUserByIDFn: func(context.Context, int64) (db.User, error) { return *actor, nil },
			listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
				return []db.LandingRequestChange{{LandingRequestID: candidate.ID, ChangeID: "change-1", PositionInStack: 1}}, nil
			},
		}}
		q.claimFn = func(context.Context) (db.LandingRequest, error) { return candidate, nil }
		q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
		enqueued := false
		q.enqueueAutoFn = func(_ context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error) {
			enqueued = true
			row := candidate
			row.State = landingStateQueued
			return row, nil
		}
		require.NoError(t, NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingInstallMainMirror(true)).ProcessNextAutoLand(context.Background()))
		assert.False(t, enqueued, "install auto-land onto %s", target)
		assert.False(t, q.createLandingTaskCalled, "install auto-land onto %s", target)
		require.NoError(t, NewLandingService(q, &mockLandingRepoHostClient{}).ProcessNextAutoLand(context.Background()))
		assert.True(t, enqueued, "hosted auto-land onto %s", target)
	}
}
