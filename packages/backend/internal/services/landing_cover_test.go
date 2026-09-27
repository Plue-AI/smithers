package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

func TestLanding_Cov_PgxCreateTxCommitAndRollback(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	manager := &pgxLandingCreateTxManager{pool: pool}
	tag := "landing_cov_" + strings.ReplaceAll(uuid.NewString(), "-", "")

	tx, err := manager.BeginCreateTx(ctx)
	require.NoError(t, err)
	created, err := tx.CreateLandingRequest(ctx, db.CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          tag + "_commit",
		Body:           "created through the pgx landing tx wrapper",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature/cov",
		StackSize:      2,
	})
	require.NoError(t, err)
	for i, changeID := range []string{"change-a", "change-b"} {
		_, err := tx.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{
			LandingRequestID: created.ID,
			ChangeID:         changeID,
			PositionInStack:  int64(i + 1),
		})
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit(ctx))

	var committedChanges int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM landing_request_changes WHERE landing_request_id = $1`,
		created.ID,
	).Scan(&committedChanges))
	assert.Equal(t, 2, committedChanges)

	rollbackTx, err := manager.BeginCreateTx(ctx)
	require.NoError(t, err)
	rolledBack, err := rollbackTx.CreateLandingRequest(ctx, db.CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          tag + "_rollback",
		Body:           "this row should not commit",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature/cov",
		StackSize:      1,
	})
	require.NoError(t, err)
	require.NoError(t, rollbackTx.Rollback(ctx))

	var exists bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM landing_requests WHERE id = $1)`,
		rolledBack.ID,
	).Scan(&exists))
	assert.False(t, exists)
}

func TestLanding_Cov_ConstructorsAndOptions(t *testing.T) {
	q := &mockLandingQuerier{}
	rh := &mockLandingRepoHostClient{}
	mentionSvc := &MentionService{}
	notifSvc := &NotificationService{}
	dispatcher := &mockLandingWorkflowRunService{}

	withoutPool := NewLandingServiceWithPool(q, rh, nil,
		WithLandingMentionService(mentionSvc),
		WithLandingNotificationService(notifSvc),
		WithLandingWorkflowRunService(dispatcher),
	)
	require.Same(t, q, withoutPool.queries)
	require.Same(t, rh, withoutPool.repoHost)
	assert.Nil(t, withoutPool.createTxManager)
	assert.Same(t, mentionSvc, withoutPool.mentionSvc)
	assert.Same(t, notifSvc, withoutPool.notifSvc)
	assert.Same(t, dispatcher, withoutPool.workflowRunSvc)

	pool := getAgentTestPool(t)
	withPool := NewLandingServiceWithPool(q, rh, pool, nil)
	require.NotNil(t, withPool.createTxManager)
	_, ok := withPool.createTxManager.(*pgxLandingCreateTxManager)
	assert.True(t, ok)
}

func TestLanding_Cov_ListRequestsPaginationAndAuthorCache(t *testing.T) {
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 9101
		r.IsPublic = true
	})
	authorLoads := 0
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "alice", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return repo, nil
		},
		countLandingRequestsByRepoFilteredFn: func(ctx context.Context, arg db.CountLandingRequestsByRepoFilteredParams) (int64, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Empty(t, arg.State)
			return 3, nil
		},
		listLandingRequestsByRepoFilteredKeysetFn: func(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error) {
			assert.Equal(t, int64(40), arg.AfterNumber)
			assert.Equal(t, int32(2), arg.PageSize)
			return []db.ListLandingRequestsByRepoFilteredKeysetRow{
				landingDBRequestKeysetRow(1, repo.ID, 39, 44, []string{"k1"}),
				landingDBRequestKeysetRow(2, repo.ID, 38, 44, []string{"k2"}),
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			authorLoads++
			return db.User{ID: id, Username: "cached-author", LowerUsername: "cached-author"}, nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	items, cursor, total, err := svc.ListLandingRequests(context.Background(), nil, " Alice ", " Demo ", 40, 2, "")
	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, encodeIssueNumberCursor(38), cursor)
	assert.Equal(t, int64(3), total)
	assert.Equal(t, "cached-author", items[0].Author.Login)
	assert.Equal(t, 1, authorLoads, "same author should be resolved through the request-local cache")
}

func TestLanding_Cov_CreateLandingInTxSuccessAndCommitFailure(t *testing.T) {
	params := db.CreateLandingRequestParams{
		RepositoryID:   77,
		Title:          "tx title",
		Body:           "tx body",
		AuthorID:       10,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      2,
	}

	t.Run("success commits every change", func(t *testing.T) {
		tx := &mockLandingCreateTx{}
		svc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{})
		svc.createTxManager = &mockLandingCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (landingCreateTx, error) {
				return tx, nil
			},
		}

		created, err := svc.createLandingInTx(context.Background(), params, []string{"k1", "k2"})
		require.NoError(t, err)
		assert.Equal(t, int64(11), created.ID)
		assert.True(t, tx.committed)
		assert.False(t, tx.rolledBack)
	})

	t.Run("commit failure is rolled back and mapped", func(t *testing.T) {
		tx := &mockLandingCreateTx{
			commitFn: func(ctx context.Context) error {
				return fmt.Errorf("disk full")
			},
		}
		svc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{})
		svc.createTxManager = &mockLandingCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (landingCreateTx, error) {
				return tx, nil
			},
		}

		_, err := svc.createLandingInTx(context.Background(), params, []string{"k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
		assert.True(t, tx.committed)
		assert.True(t, tx.rolledBack)
	})
}

func TestLanding_Cov_LandingRequestValidationAndQueueFailures(t *testing.T) {
	actor := landingTestUser(10, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 901
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	t.Run("blank change id is rejected before persistence", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.CreateLandingRequest(context.Background(), actor, "owner", "demo", CreateLandingRequestInput{
			Title:          "blank",
			TargetBookmark: "main",
			ChangeIDs:      []string{"k1", " "},
		})
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
		assert.False(t, q.createLandingRequestCalled)
	})

	t.Run("active task blocks double enqueue", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(90, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
			},
			getLandingTaskByLandingRequestIDFn: func(ctx context.Context, landingRequestID int64) (db.LandingTask, error) {
				return db.LandingTask{ID: 5, LandingRequestID: landingRequestID, Status: "running"}, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.LandLandingRequest(context.Background(), actor, "owner", "demo", 9, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
	})

	t.Run("empty stack is rejected", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(91, repo.ID, arg.Number, actor.ID, nil), nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.LandLandingRequest(context.Background(), actor, "owner", "demo", 9, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("queue position failure returns internal error after task creation", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(92, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
			},
			enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(arg.ID, repo.ID, 9, actor.ID, nil)
				row.State = "queued"
				return row, nil
			},
			getLandingQueuePositionByTaskIDFn: func(ctx context.Context, id int64) (int64, error) {
				return 0, fmt.Errorf("count failed")
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.LandLandingRequest(context.Background(), actor, "owner", "demo", 9, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
		assert.True(t, q.createLandingTaskCalled)
	})
}

func TestLanding_Cov_DismissReviewAndDiffErrorBranches(t *testing.T) {
	actor := landingTestUser(7, "maintainer")
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 707
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	t.Run("dismiss validates review ownership", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(30, repo.ID, arg.Number, 99, []string{"k1"}), nil
			},
			getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{ID: id, LandingRequestID: 999, State: "submitted"}, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.DismissLandingReview(context.Background(), actor, "owner", "demo", 3, 55, DismissLandingReviewInput{Message: "stale"})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("dismiss maps update no rows to not found", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(31, repo.ID, arg.Number, 99, []string{"k1"}), nil
			},
			getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{ID: id, LandingRequestID: 31, State: "submitted"}, nil
			},
			updateLandingRequestReviewStateFn: func(ctx context.Context, arg db.UpdateLandingRequestReviewStateParams) (db.LandingRequestReview, error) {
				return db.LandingRequestReview{}, pgx.ErrNoRows
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.DismissLandingReview(context.Background(), actor, "owner", "demo", 3, 55, DismissLandingReviewInput{Message: "stale"})
		assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
	})

	t.Run("diff maps repo host conflict", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(32, repo.ID, arg.Number, 99, []string{"k1"}), nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "author", LowerUsername: "author"}, nil
			},
		}
		rh := &mockLandingRepoHostClient{
			getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
				return repohost.ChangeDiff{}, fmt.Errorf("repo-host returned status 409 conflict")
			},
		}
		svc := NewLandingService(q, rh)
		_, err := svc.GetLandingDiff(context.Background(), actor, "owner", "demo", 3, LandingDiffOptions{})
		assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
	})
}

func TestLanding_Cov_HelperBranches(t *testing.T) {
	assert.Equal(t, http.StatusConflict, landingAPIStatus(t, mapLandingRepoHostError(
		fmt.Errorf("wrapped: %w", &repohost.StatusError{StatusCode: 409, Message: "append base changed"}), "fallback")))

	status, ok := extractRepoHostStatusCode(fmt.Errorf("wrapped: repo-host returned status 404 while loading"))
	assert.True(t, ok)
	assert.Equal(t, 404, status)
	_, ok = extractRepoHostStatusCode(fmt.Errorf("repo-host returned status not-a-number"))
	assert.False(t, ok)

	assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, mapLandingRepoHostError(fmt.Errorf("repo-host returned status 404"), "fallback")))
	assert.Equal(t, http.StatusConflict, landingAPIStatus(t, mapLandingRepoHostError(fmt.Errorf("repo-host returned status 409"), "fallback")))
	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, mapLandingRepoHostError(fmt.Errorf("plain failure"), "fallback")))

	title, err := applyOptionalTitle("old", landingStringPtr("  new title  "))
	require.NoError(t, err)
	assert.Equal(t, "new title", title)
	_, err = applyOptionalTitle("old", landingStringPtr(" "))
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))

	state, err := applyOptionalState(landingStateDraft, landingStringPtr(" OPEN "))
	require.NoError(t, err)
	assert.Equal(t, landingStateOpen, state)
	_, err = applyOptionalState(landingStateOpen, landingStringPtr("merged"))
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	state, err = applyOptionalState(landingStateFailed, landingStringPtr("closed"))
	require.NoError(t, err)
	assert.Equal(t, landingStateClosed, state)
	_, err = applyOptionalState(landingStateOpen, landingStringPtr("failed"))
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))

	bookmark, err := applyOptionalBookmark("main", landingStringPtr(" release/1 "), "target_bookmark")
	require.NoError(t, err)
	assert.Equal(t, "release/1", bookmark)
	_, err = applyOptionalBookmark("main", landingStringPtr(" "), "target_bookmark")
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))

	conflict, err := applyOptionalConflictStatus("clean", landingStringPtr(" UNKNOWN "))
	require.NoError(t, err)
	assert.Equal(t, "unknown", conflict)

	changeIDs, err := normalizeChangeIDs([]string{" k1 ", "k2"})
	require.NoError(t, err)
	assert.Equal(t, []string{"k1", "k2"}, changeIDs)
	_, err = normalizeChangeIDs([]string{"k1", " "})
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))

	assert.Equal(t, "target_bookmark", landingCreateErrorField("landing_requests_target_bookmark_check"))
	assert.Equal(t, "change_ids", landingCreateErrorField("landing_request_changes_position_key"))
	assert.Equal(t, "stack_size", landingCreateErrorField("landing_requests_stack_size_check"))
	assert.Equal(t, "conflict_status", landingCreateErrorField("landing_requests_conflict_status_check"))
	assert.Equal(t, "landing_request", landingCreateErrorField("other"))

	apiErr := pkgerrors.Conflict("already an api error")
	assert.Same(t, apiErr, normalizeLandingCreateError(apiErr, "fallback"))
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t,
		normalizeLandingCreateError(&pgconn.PgError{Code: "23503", ConstraintName: "landing_request_changes_change_id_fkey"}, "fallback"),
	))
}

func TestLanding_Cov_ResolveAndPermissionBranches(t *testing.T) {
	actor := landingTestUser(50, "member")
	orgRepo := landingRepo(func(r *db.Repository) {
		r.ID = 505
		r.IsPublic = false
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 9, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return orgRepo, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "admin", nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	_, err := svc.resolveRepoByOwnerAndName(context.Background(), " ", "demo")
	assert.Equal(t, http.StatusBadRequest, landingAPIStatus(t, err))
	_, err = svc.resolveRepoByOwnerAndName(context.Background(), "owner", " ")
	assert.Equal(t, http.StatusBadRequest, landingAPIStatus(t, err))

	perm, owner, err := repoPermissionForUser(context.Background(), svc.queries, orgRepo, actor.ID)
	require.NoError(t, err)
	assert.Equal(t, "admin", perm)
	assert.False(t, owner)
	assert.NoError(t, svc.requireReadAccess(context.Background(), orgRepo, actor))
	assert.NoError(t, svc.requireWriteAccess(context.Background(), orgRepo, actor))
	assert.NoError(t, svc.requireLandAccess(context.Background(), orgRepo, actor))
	// The coding flow lands with its run credential; that credential is
	// never its user's administrator anywhere else.
	runCtx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: actor, IsTokenAuth: true, TokenSystemIssued: true})
	assert.NoError(t, svc.requireLandAccess(runCtx, orgRepo, actor))
	admin, err := canAdminRepo(runCtx, svc.queries, orgRepo, actor.ID)
	require.NoError(t, err)
	assert.False(t, admin)

	noAccessSvc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{})
	assert.Equal(t, http.StatusUnauthorized, landingAPIStatus(t, noAccessSvc.requireWriteAccess(context.Background(), orgRepo, nil)))
	assert.Equal(t, http.StatusUnauthorized, landingAPIStatus(t, noAccessSvc.requireLandAccess(context.Background(), orgRepo, nil)))
}

func TestLanding_Cov_DispatchPayloadsAndFailures(t *testing.T) {
	actor := landingTestUser(1, "sender")
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 321
		r.Name = "demo"
	})
	row := LandingRequestResponse{
		Number:         8,
		Title:          "LR",
		Body:           "body",
		State:          "open",
		Author:         LandingRequestAuthor{ID: 2, Login: "author"},
		ChangeIDs:      []string{"k1"},
		TargetBookmark: "main",
		ConflictStatus: "clean",
		StackSize:      1,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}

	dispatcher := &mockLandingDispatcher{}
	workflowRuns := &mockLandingWorkflowRunService{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			assert.Equal(t, repo.ID, input.RepositoryID)
			assert.Equal(t, actor.ID, input.UserID)
			assert.Equal(t, "landing_request", input.Event.Type)
			assert.Equal(t, "opened", input.Event.Action)
			assert.Equal(t, "k1", input.Event.ChangeID)
			return nil, fmt.Errorf("non fatal")
		},
	}
	svc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{},
		WithLandingWebhookDispatcher(dispatcher),
		WithLandingWorkflowRunService(workflowRuns),
	)
	require.NoError(t, svc.dispatchLandingRequestEvent(context.Background(), repo, actor, "opened", row))
	require.Len(t, dispatcher.calls, 1)
	payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
	require.True(t, ok)
	assert.Equal(t, "opened", payload.Action)
	assert.Equal(t, "sender", payload.Sender.Login)
	assert.Len(t, workflowRuns.dispatchCalls, 1)

	failingDispatcher := &mockLandingDispatcher{
		dispatchFn: func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
			return fmt.Errorf("enqueue failed")
		},
	}
	failingSvc := NewLandingService(&mockLandingQuerier{}, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(failingDispatcher))
	assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t,
		failingSvc.dispatchLandingRequestEvent(context.Background(), repo, actor, "opened", row),
	))
}
