package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// landingFPrivateRepo returns a private repo owned by ownerID (invalid owner
// when ownerID<=0), no org, so permission resolution funnels through the
// collaborator query.
func landingFPrivateRepo(ownerID int64) db.Repository {
	return landingRepo(func(r *db.Repository) {
		r.ID = 4242
		r.Name = "demo"
		r.LowerName = "demo"
		r.IsPublic = false
		r.OrgID = pgtype.Int8{}
		if ownerID > 0 {
			r.UserID = pgtype.Int8{Int64: ownerID, Valid: true}
		} else {
			r.UserID = pgtype.Int8{}
		}
	})
}

// landingFRepoFn returns a getRepoByOwnerAndLowerNameFn that always yields repo.
func landingFRepoFn(repo db.Repository) func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repo, nil
	}
}

func landingFSvc(q *mockLandingQuerier, opts ...LandingServiceOption) *LandingService {
	return NewLandingService(q, &mockLandingRepoHostClient{}, opts...)
}

// TestLanding_F_ListLandingRequests drives every branch of ListLandingRequests.
func TestLanding_F_ListLandingRequests(t *testing.T) {
	ctx := context.Background()
	pub := landingRepo(func(r *db.Repository) { r.ID = 88; r.IsPublic = true })

	t.Run("resolve repo error propagates", func(t *testing.T) {
		// default mock GetRepoByOwnerAndLowerName -> pgx.ErrNoRows -> NotFound
		_, _, _, err := landingFSvc(&mockLandingQuerier{}).ListLandingRequests(ctx, nil, "o", "r", 0, 10, "")
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("invalid filter state", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub)}
		_, _, _, err := landingFSvc(q).ListLandingRequests(ctx, nil, "o", "r", 0, 10, "bogus")
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("limit clamped low and high plus count error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub),
			countLandingRequestsByRepoFilteredFn: func(ctx context.Context, arg db.CountLandingRequestsByRepoFilteredParams) (int64, error) {
				return 0, errors.New("count boom")
			},
		}
		_, _, _, err := landingFSvc(q).ListLandingRequests(ctx, nil, "o", "r", 0, 0, "")
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
		_, _, _, err = landingFSvc(q).ListLandingRequests(ctx, nil, "o", "r", 0, 100000, "")
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("list keyset error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub),
			listLandingRequestsByRepoFilteredKeysetFn: func(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error) {
				return nil, errors.New("list boom")
			},
		}
		_, _, _, err := landingFSvc(q).ListLandingRequests(ctx, nil, "o", "r", 0, 10, "open")
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("author load error inside loop", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub),
			listLandingRequestsByRepoFilteredKeysetFn: func(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error) {
				return []db.ListLandingRequestsByRepoFilteredKeysetRow{landingDBRequestKeysetRow(1, pub.ID, 5, 3, []string{"k1"})}, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{}, errors.New("author boom")
			},
		}
		_, _, _, err := landingFSvc(q).ListLandingRequests(ctx, nil, "o", "r", 0, 10, "")
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
}

// TestLanding_F_CreateLandingRequest drives create validation, tx and non-tx paths.
func TestLanding_F_CreateLandingRequest(t *testing.T) {
	ctx := context.Background()
	actor := landingTestUser(10, "creator")
	ownRepo := landingFPrivateRepo(actor.ID)

	baseInput := func() CreateLandingRequestInput {
		return CreateLandingRequestInput{Title: "ok", TargetBookmark: "main", Body: "clean body", ChangeIDs: []string{"k1"}}
	}

	t.Run("unsafe body text rejected", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo)}
		in := baseInput()
		in.Body = "bad\x00body"
		_, err := landingFSvc(q).CreateLandingRequest(ctx, actor, "o", "r", in)
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingRequest(ctx, actor, "o", "r", baseInput())
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("non-tx add change failure", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			addLandingRequestChangeFn: func(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
				return db.LandingRequestChange{}, errors.New("add boom")
			},
		}
		_, err := landingFSvc(q).CreateLandingRequest(ctx, actor, "o", "r", baseInput())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("afterCreate build response error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{}, errors.New("author boom")
			},
		}
		_, err := landingFSvc(q).CreateLandingRequest(ctx, actor, "o", "r", baseInput())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("afterCreate dispatch error", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo)}
		disp := &mockLandingDispatcher{dispatchFn: func(ctx context.Context, repoID int64, et webhooks.EventType, p any) error {
			return errors.New("enqueue boom")
		}}
		svc := landingFSvc(q, WithLandingWebhookDispatcher(disp))
		_, err := svc.CreateLandingRequest(ctx, actor, "o", "r", baseInput())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("tx path success with mentions and notifications", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo)}
		svc := landingFSvc(q,
			WithLandingMentionService(NewMentionService(nil, nil)),
			WithLandingNotificationService(NewNotificationService(&mockNotificationQuerier{})),
		)
		svc.createTxManager = &mockLandingCreateTxManager{}
		in := baseInput()
		in.Body = "plain body no mentions"
		_, err := svc.CreateLandingRequest(ctx, actor, "o", "r", in)
		require.NoError(t, err)
	})

	t.Run("tx path create failure rolled back", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo)}
		svc := landingFSvc(q)
		svc.createTxManager = &mockLandingCreateTxManager{beginCreateTxFn: func(ctx context.Context) (landingCreateTx, error) {
			return &mockLandingCreateTx{createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, errors.New("insert boom")
			}}, nil
		}}
		_, err := svc.CreateLandingRequest(ctx, actor, "o", "r", baseInput())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
}

// TestLanding_F_GetLandingRequest drives GetLandingRequest branches.
func TestLanding_F_GetLandingRequest(t *testing.T) {
	ctx := context.Background()
	viewer := landingTestUser(30, "viewer")
	priv := landingFPrivateRepo(999) // owned by someone else

	t.Run("resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).GetLandingRequest(ctx, viewer, "o", "r", 1)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("read access denied", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(priv)}
		_, err := landingFSvc(q).GetLandingRequest(ctx, viewer, "o", "r", 1)
		assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	})

	t.Run("landing lookup error", func(t *testing.T) {
		pub := landingRepo(func(r *db.Repository) { r.IsPublic = true })
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).GetLandingRequest(ctx, viewer, "o", "r", 5)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("landing number invalid", func(t *testing.T) {
		pub := landingRepo(func(r *db.Repository) { r.IsPublic = true })
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub)}
		_, err := landingFSvc(q).GetLandingRequest(ctx, viewer, "o", "r", 0)
		assert.Equal(t, http.StatusBadRequest, landingAPIStatus(t, err))
	})

	t.Run("landing not found", func(t *testing.T) {
		pub := landingRepo(func(r *db.Repository) { r.IsPublic = true })
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(pub),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, pgx.ErrNoRows
			},
		}
		_, err := landingFSvc(q).GetLandingRequest(ctx, viewer, "o", "r", 5)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
}

// TestLanding_F_UpdateLandingRequest drives UpdateLandingRequest branches.
func TestLanding_F_UpdateLandingRequest(t *testing.T) {
	ctx := context.Background()
	actor := landingTestUser(11, "editor")
	ownRepo := landingFPrivateRepo(actor.ID)

	landingRowFn := func(state string) func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			row := landingDBRequestWithChangeIDs(50, ownRepo.ID, arg.Number, actor.ID, []string{"k1"})
			row.State = state
			return row, nil
		}
	}

	t.Run("actor nil", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).UpdateLandingRequest(ctx, nil, "o", "r", 1, UpdateLandingRequestInput{})
		assert.Equal(t, http.StatusUnauthorized, landingAPIStatus(t, err))
	})

	t.Run("resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("write access denied", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(landingFPrivateRepo(999))}
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{})
		assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	})

	t.Run("landing lookup error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("frozen source bookmark conflict", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateQueued),
		}
		src := "different-source"
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{SourceBookmark: &src})
		assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
	})

	t.Run("blank title validation", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateOpen),
		}
		blank := "   "
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{Title: &blank})
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("blank target bookmark validation", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateOpen),
		}
		blank := "  "
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{TargetBookmark: &blank})
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("update conflict on no rows", func(t *testing.T) {
		title := "new title"
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateOpen),
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, pgx.ErrNoRows
			},
		}
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{Title: &title})
		assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
	})

	t.Run("update internal error", func(t *testing.T) {
		body := "b"
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateOpen),
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{Body: &body})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("map record error after persist", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateOpen),
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{}, errors.New("author boom")
			},
		}
		// no fields set -> shouldPersist false -> straight to mapLandingRecord
		_, err := landingFSvc(q).UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("reopened action dispatch error", func(t *testing.T) {
		st := landingStateOpen
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingRowFn(landingStateClosed),
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(arg.ID, ownRepo.ID, 1, actor.ID, nil)
				row.State = landingStateOpen
				return row, nil
			},
		}
		disp := &mockLandingDispatcher{dispatchFn: func(ctx context.Context, repoID int64, et webhooks.EventType, p any) error {
			return errors.New("enqueue boom")
		}}
		svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(disp))
		_, err := svc.UpdateLandingRequest(ctx, actor, "o", "r", 1, UpdateLandingRequestInput{State: &st})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
}

// TestLanding_F_LandLandingRequest drives LandLandingRequest branches.
func TestLanding_F_LandLandingRequest(t *testing.T) {
	ctx := context.Background()
	actor := landingTestUser(12, "admin")
	ownRepo := landingFPrivateRepo(actor.ID)

	openLandingFn := func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return landingDBRequestWithChangeIDs(60, ownRepo.ID, arg.Number, actor.ID, []string{"k1"}), nil
	}

	t.Run("actor nil", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).LandLandingRequest(ctx, nil, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusUnauthorized, landingAPIStatus(t, err))
	})

	t.Run("resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("landing lookup error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("existing task lookup internal error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			getLandingTaskByLandingRequestIDFn: func(ctx context.Context, id int64) (db.LandingTask, error) {
				return db.LandingTask{}, errors.New("task boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("required approvals list error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repoID int64) ([]db.ProtectedBookmark, error) {
				return nil, errors.New("rules boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("invalid protected pattern", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repoID int64) ([]db.ProtectedBookmark, error) {
				return []db.ProtectedBookmark{{Pattern: "[", RequireReview: true, RequireHumanApprovals: 1}}, nil
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("count approved reviews error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repoID int64) ([]db.ProtectedBookmark, error) {
				return []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1}}, nil
			},
			countApprovedLandingRequestReviewsFn: func(ctx context.Context, id int64) (int64, error) {
				return 0, errors.New("count boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("insufficient approvals", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repoID int64) ([]db.ProtectedBookmark, error) {
				return []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 2}}, nil
			},
			countApprovedLandingRequestReviewsFn: func(ctx context.Context, id int64) (int64, error) {
				return 1, nil
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("enqueue conflict on no rows", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, pgx.ErrNoRows
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
	})

	t.Run("enqueue internal error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("create task error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			createLandingTaskFn: func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
				return db.LandingTask{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("map record error after enqueue", func(t *testing.T) {
		called := false
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				called = true
				return db.User{}, errors.New("author boom")
			},
		}
		_, err := landingFSvc(q).LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
		assert.True(t, called)
	})

	t.Run("dispatch error after enqueue", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: openLandingFn,
		}
		disp := &mockLandingDispatcher{dispatchFn: func(ctx context.Context, repoID int64, et webhooks.EventType, p any) error {
			return errors.New("enqueue boom")
		}}
		svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(disp))
		_, err := svc.LandLandingRequest(ctx, actor, "o", "r", 1, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
}

// TestLanding_F_ReviewsCommentsChanges drives list/create review+comment+change error paths.
func TestLanding_F_ReviewsCommentsChanges(t *testing.T) {
	ctx := context.Background()
	actor := landingTestUser(13, "owner")
	ownRepo := landingFPrivateRepo(actor.ID)
	viewer := landingTestUser(31, "viewer")
	priv := landingFPrivateRepo(999)

	landingFn := func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return landingDBRequestWithChangeIDs(70, ownRepo.ID, arg.Number, actor.ID, []string{"k1"}), nil
	}

	t.Run("list reviews resolve error", func(t *testing.T) {
		_, _, err := landingFSvc(&mockLandingQuerier{}).ListLandingReviews(ctx, viewer, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("list reviews list error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			listLandingRequestReviewsFn: func(ctx context.Context, arg db.ListLandingRequestReviewsParams) ([]db.LandingRequestReview, error) {
				return nil, errors.New("boom")
			},
		}
		_, _, err := landingFSvc(q).ListLandingReviews(ctx, actor, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("list reviews count error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			countLandingRequestReviewsFn: func(ctx context.Context, id int64) (int64, error) {
				return 0, errors.New("boom")
			},
		}
		_, _, err := landingFSvc(q).ListLandingReviews(ctx, actor, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("create review actor nil", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingReview(ctx, nil, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "x"})
		assert.Equal(t, http.StatusUnauthorized, landingAPIStatus(t, err))
	})
	t.Run("create review unsafe body", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingReview(ctx, actor, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "approve", Body: "bad\x00"})
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})
	t.Run("create review resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingReview(ctx, actor, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "ok"})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("create review write denied", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(priv)}
		_, err := landingFSvc(q).CreateLandingReview(ctx, viewer, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "ok"})
		assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	})
	t.Run("create review landing error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).CreateLandingReview(ctx, actor, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "ok"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("create review insert error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			createLandingRequestReviewFn: func(ctx context.Context, arg db.CreateLandingRequestReviewParams) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).CreateLandingReview(ctx, actor, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "ok"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("create review dispatch review event error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
		}
		disp := &mockLandingDispatcher{dispatchFn: func(ctx context.Context, repoID int64, et webhooks.EventType, p any) error {
			return errors.New("boom")
		}}
		svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(disp))
		_, err := svc.CreateLandingReview(ctx, actor, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "ok"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("dispatch review event author load error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{}, errors.New("author boom")
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(&mockLandingDispatcher{}))
		_, err := svc.CreateLandingReview(ctx, actor, "o", "r", 1, CreateLandingReviewInput{CommitID: "commit-1", Type: "comment", Body: "ok"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("list comments resolve error", func(t *testing.T) {
		_, _, err := landingFSvc(&mockLandingQuerier{}).ListLandingComments(ctx, viewer, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("list comments list error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			listLandingRequestCommentsFn: func(ctx context.Context, arg db.ListLandingRequestCommentsParams) ([]db.LandingRequestComment, error) {
				return nil, errors.New("boom")
			},
		}
		_, _, err := landingFSvc(q).ListLandingComments(ctx, actor, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("list comments count error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			countLandingRequestCommentsFn: func(ctx context.Context, id int64) (int64, error) {
				return 0, errors.New("boom")
			},
		}
		_, _, err := landingFSvc(q).ListLandingComments(ctx, actor, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})

	t.Run("list changes resolve error", func(t *testing.T) {
		_, _, err := landingFSvc(&mockLandingQuerier{}).ListLandingChanges(ctx, viewer, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("list changes list error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			listLandingRequestChangesFn: func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
				return nil, errors.New("boom")
			},
		}
		_, _, err := landingFSvc(q).ListLandingChanges(ctx, actor, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("list changes count error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			countLandingRequestChangesFn: func(ctx context.Context, id int64) (int64, error) {
				return 0, errors.New("boom")
			},
		}
		_, _, err := landingFSvc(q).ListLandingChanges(ctx, actor, "o", "r", 1, 1, 10)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
}

// TestLanding_F_CreateLandingComment drives CreateLandingComment branches.
func TestLanding_F_CreateLandingComment(t *testing.T) {
	ctx := context.Background()
	actor := landingTestUser(14, "commenter")
	ownRepo := landingFPrivateRepo(actor.ID)
	priv := landingFPrivateRepo(999)
	landingFn := func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return landingDBRequestWithChangeIDs(71, ownRepo.ID, arg.Number, actor.ID, []string{"k1"}), nil
	}
	ok := func() CreateLandingCommentInput {
		return CreateLandingCommentInput{Body: "nice", Side: "right", CommitID: "commit-1"}
	}

	t.Run("actor nil", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingComment(ctx, nil, "o", "r", 1, ok())
		assert.Equal(t, http.StatusUnauthorized, landingAPIStatus(t, err))
	})
	t.Run("line without path", func(t *testing.T) {
		in := ok()
		in.Path = "  "
		in.Line = 5
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingComment(ctx, actor, "o", "r", 1, in)
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})
	t.Run("default side then unsafe body", func(t *testing.T) {
		in := ok()
		in.Side = ""
		in.Line = 0
		in.Path = ""
		in.Body = "bad\x00"
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingComment(ctx, actor, "o", "r", 1, in)
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})
	t.Run("unsafe path", func(t *testing.T) {
		in := ok()
		in.Path = "bad\x00path"
		in.Line = 1
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingComment(ctx, actor, "o", "r", 1, in)
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})
	t.Run("resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).CreateLandingComment(ctx, actor, "o", "r", 1, ok())
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("write denied", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(priv)}
		_, err := landingFSvc(q).CreateLandingComment(ctx, landingTestUser(31, "v"), "o", "r", 1, ok())
		assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	})
	t.Run("landing error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).CreateLandingComment(ctx, actor, "o", "r", 1, ok())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("insert error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			createLandingRequestCommentFn: func(ctx context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error) {
				return db.LandingRequestComment{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).CreateLandingComment(ctx, actor, "o", "r", 1, ok())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("dispatch comment event error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
		}
		disp := &mockLandingDispatcher{dispatchFn: func(ctx context.Context, repoID int64, et webhooks.EventType, p any) error {
			return errors.New("boom")
		}}
		svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(disp))
		_, err := svc.CreateLandingComment(ctx, actor, "o", "r", 1, ok())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("dispatch comment event author load error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{}, errors.New("author boom")
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(&mockLandingDispatcher{}))
		_, err := svc.CreateLandingComment(ctx, actor, "o", "r", 1, ok())
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("success with mentions", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: landingFn,
		}
		svc := landingFSvc(q, WithLandingMentionService(NewMentionService(nil, nil)))
		in := ok()
		in.Body = "plain comment no mentions"
		_, err := svc.CreateLandingComment(ctx, actor, "o", "r", 1, in)
		require.NoError(t, err)
	})
}

// TestLanding_F_ConflictsAndDismiss drives GetLandingConflicts, DismissLandingReview, GetLandingDiff.
func TestLanding_F_ConflictsAndDismiss(t *testing.T) {
	ctx := context.Background()
	actor := landingTestUser(15, "owner")
	ownRepo := landingFPrivateRepo(actor.ID)
	viewer := landingTestUser(32, "viewer")

	cleanLandingFn := func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return landingDBRequestWithChangeIDs(80, ownRepo.ID, arg.Number, actor.ID, []string{"k1"}), nil
	}
	conflictedLandingFn := func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		row := landingDBRequestWithChangeIDs(81, ownRepo.ID, arg.Number, actor.ID, []string{"k1"})
		row.ConflictStatus = "conflicted"
		return row, nil
	}

	t.Run("conflicts resolve error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).GetLandingConflicts(ctx, viewer, "o", "r", 1)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("conflicts clean returns early", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: cleanLandingFn,
		}
		resp, err := landingFSvc(q).GetLandingConflicts(ctx, actor, "o", "r", 1)
		require.NoError(t, err)
		assert.False(t, resp.HasConflicts)
	})
	t.Run("conflicts repo host error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: conflictedLandingFn,
		}
		rh := &mockLandingRepoHostClient{getChangeConflictsFn: func(ctx context.Context, owner, repo, changeID string) ([]repohost.Conflict, error) {
			return nil, errors.New("repo-host returned status 404")
		}}
		_, err := NewLandingService(q, rh).GetLandingConflicts(ctx, actor, "o", "r", 1)
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("dismiss resolve repo error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).DismissLandingReview(ctx, actor, "o", "r", 1, 5, DismissLandingReviewInput{})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("dismiss write denied", func(t *testing.T) {
		q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(landingFPrivateRepo(999))}
		_, err := landingFSvc(q).DismissLandingReview(ctx, viewer, "o", "r", 1, 5, DismissLandingReviewInput{})
		assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	})
	t.Run("dismiss landing error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).DismissLandingReview(ctx, actor, "o", "r", 1, 5, DismissLandingReviewInput{})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("dismiss review lookup internal error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: cleanLandingFn,
			getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).DismissLandingReview(ctx, actor, "o", "r", 1, 5, DismissLandingReviewInput{})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("dismiss review not found", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: cleanLandingFn,
			getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{}, pgx.ErrNoRows
			},
		}
		_, err := landingFSvc(q).DismissLandingReview(ctx, actor, "o", "r", 1, 5, DismissLandingReviewInput{})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
	t.Run("dismiss update internal error", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: cleanLandingFn,
			getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{ID: id, LandingRequestID: 80, State: "submitted"}, nil
			},
			updateLandingRequestReviewStateFn: func(ctx context.Context, arg db.UpdateLandingRequestReviewStateParams) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{}, errors.New("boom")
			},
		}
		_, err := landingFSvc(q).DismissLandingReview(ctx, actor, "o", "r", 1, 5, DismissLandingReviewInput{})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
	})
	t.Run("dismiss success", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn:             landingFRepoFn(ownRepo),
			getLandingRequestWithChangeIDsByNumberFn: cleanLandingFn,
			getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{ID: id, LandingRequestID: 80, State: "submitted"}, nil
			},
		}
		updated, err := landingFSvc(q).DismissLandingReview(ctx, actor, "o", "r", 1, 5, DismissLandingReviewInput{Message: "stale"})
		require.NoError(t, err)
		assert.Equal(t, "dismissed", updated.State)
	})

	t.Run("diff resolve error", func(t *testing.T) {
		_, err := landingFSvc(&mockLandingQuerier{}).GetLandingDiff(ctx, viewer, "o", "r", 1, LandingDiffOptions{})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})
}

// TestLanding_F_PermissionHelpers drives requireRead/Write/Admin error+deny branches.
func TestLanding_F_PermissionHelpers(t *testing.T) {
	ctx := context.Background()
	viewer := landingTestUser(40, "viewer")
	priv := landingFPrivateRepo(999)

	collabErr := &mockLandingQuerier{
		getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", errors.New("perm boom")
		},
	}
	svcErr := landingFSvc(collabErr)

	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, svcErr.requireReadAccess(ctx, priv, viewer)))
	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, svcErr.requireWriteAccess(ctx, priv, viewer)))
	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, svcErr.requireLandAccess(ctx, priv, viewer)))

	svcDeny := landingFSvc(&mockLandingQuerier{})
	assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, svcDeny.requireReadAccess(ctx, priv, viewer)))

	// resolveReadableLanding read-denied path.
	q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: landingFRepoFn(priv)}
	_, _, err := landingFSvc(q).ListLandingReviews(ctx, viewer, "o", "r", 1, 1, 10)
	assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))

	// resolveReadableLanding getLanding-error path (owner passes read access).
	owner := landingTestUser(41, "owner")
	ownRepo := landingFPrivateRepo(owner.ID)
	q2 := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: landingFRepoFn(ownRepo),
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return db.GetLandingRequestWithChangeIDsByNumberRow{}, errors.New("boom")
		},
	}
	_, _, err = landingFSvc(q2).ListLandingReviews(ctx, owner, "o", "r", 1, 1, 10)
	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
}

// TestLanding_F_ResolveRepoInternalError drives resolveRepoByOwnerAndName generic error.
func TestLanding_F_ResolveRepoInternalError(t *testing.T) {
	ctx := context.Background()
	q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return db.Repository{}, errors.New("db down")
	}}
	_, err := landingFSvc(q).resolveRepoByOwnerAndName(ctx, "o", "r")
	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
}

// TestLanding_F_PureHelpers drives standalone helper branches.
func TestLanding_F_PureHelpers(t *testing.T) {
	// webhookSender nil actor.
	assert.Equal(t, webhooks.UserPayload{}, webhookSender(nil))

	// extractRepoHostStatusCode nil and empty-tail.
	_, ok := extractRepoHostStatusCode(nil)
	assert.False(t, ok)
	_, ok = extractRepoHostStatusCode(errors.New("repo-host returned status "))
	assert.False(t, ok)

	// mapLandingRepoHostError default (non-404/409 status) -> Internal.
	assert.Equal(t, http.StatusInternalServerError,
		landingAPIStatus(t, mapLandingRepoHostError(errors.New("repo-host returned status 500"), "fallback")))

	// applyOptionalTitle too_long and unsafe.
	long := strings.Repeat("a", 256)
	_, err := applyOptionalTitle("old", &long)
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	unsafe := "a\x00b"
	_, err = applyOptionalTitle("old", &unsafe)
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))

	// applyOptionalState blank and disallowed.
	blank := "  "
	_, err = applyOptionalState(landingStateOpen, &blank)
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	bogus := "bogus"
	_, err = applyOptionalState(landingStateOpen, &bogus)
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))

	// normalizeLandingCreateError string-truncation SQLSTATE.
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t,
		normalizeLandingCreateError(&pgconn.PgError{Code: "22001", ConstraintName: "landing_requests_title"}, "fallback")))
}

// TestLanding_F_BeginCreateTxError drives the pgx tx-manager Begin failure path.
func TestLanding_F_BeginCreateTxError(t *testing.T) {
	cfg, err := pgxpool.ParseConfig(servicesSuite.URL(t))
	require.NoError(t, err)
	closed, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	closed.Close() // Begin on a closed pool fails deterministically.
	manager := &pgxLandingCreateTxManager{pool: closed}
	_, err = manager.BeginCreateTx(context.Background())
	require.Error(t, err)
}

// TestLanding_F_NewWithPoolNonNilOption covers NewLandingServiceWithPool option loop with a real option.
func TestLanding_F_NewWithPoolNonNilOption(t *testing.T) {
	pool := getAgentTestPool(t)
	disp := &mockLandingDispatcher{}
	svc := NewLandingServiceWithPool(&mockLandingQuerier{}, &mockLandingRepoHostClient{}, pool, WithLandingWebhookDispatcher(disp))
	require.NotNil(t, svc.createTxManager)
	assert.Same(t, disp, svc.dispatcher)
	_ = fmt.Sprint(svc)
}
