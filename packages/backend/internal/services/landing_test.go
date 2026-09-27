package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type landingDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

type mockLandingDispatcher struct {
	dispatchFn func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	calls      []landingDispatchCall
}

type mockLandingAgentTurnDispatcher struct {
	calls []LandingAgentTurnDispatchInput
}

func (m *mockLandingAgentTurnDispatcher) DispatchLandingAuthorTurn(_ context.Context, input LandingAgentTurnDispatchInput) error {
	m.calls = append(m.calls, input)
	return nil
}

func (m *mockLandingDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, landingDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockLandingDispatcher) DispatchOrgEvent(_ context.Context, _ int64, _ webhooks.EventType, _ any) error {
	return nil
}

type mockLandingQuerier struct {
	outsiderLanding                                bool
	landingSourceWorkspaces                        map[int64]string
	getRepoByOwnerAndLowerNameFn                   func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn                        func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUserFn          func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoUserFn         func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	getUserByIDFn                                  func(ctx context.Context, id int64) (db.User, error)
	getChangeByChangeIDFn                          func(ctx context.Context, arg db.GetChangeByChangeIDParams) (db.Change, error)
	getAgentSessionFn                              func(ctx context.Context, id string) (db.AgentSession, error)
	getUserByLowerUsernameFn                       func(ctx context.Context, lowerUsername string) (db.User, error)
	createLandingRequestFn                         func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error)
	addLandingRequestChangeFn                      func(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error)
	deleteLandingRequestChangesFn                  func(ctx context.Context, landingRequestID int64) error
	updateLandingRequestFn                         func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error)
	closeLandingRequestFn                          func(ctx context.Context, id int64) (db.LandingRequest, error)
	mergeLandingRequestFn                          func(ctx context.Context, id int64) (db.LandingRequest, error)
	enqueueLandingRequestFn                        func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error)
	createLandingTaskFn                            func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error)
	getLandingTaskByLandingRequestIDFn             func(ctx context.Context, landingRequestID int64) (db.LandingTask, error)
	getLandingTaskByLandingRequestIDCalled         bool
	getLandingQueuePositionByTaskIDFn              func(ctx context.Context, id int64) (int64, error)
	getLandingRequestWithChangeIDsByNumberFn       func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error)
	listLandingRequestsWithChangeIDsFilteredFn     func(ctx context.Context, arg db.ListLandingRequestsWithChangeIDsByRepoFilteredParams) ([]db.ListLandingRequestsWithChangeIDsByRepoFilteredRow, error)
	listLandingRequestsByRepoFilteredKeysetFn      func(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error)
	countLandingRequestsByRepoFilteredFn           func(ctx context.Context, arg db.CountLandingRequestsByRepoFilteredParams) (int64, error)
	listLandingRequestReviewsFn                    func(ctx context.Context, arg db.ListLandingRequestReviewsParams) ([]db.LandingRequestReview, error)
	countLandingRequestReviewsFn                   func(ctx context.Context, landingRequestID int64) (int64, error)
	createLandingRequestReviewFn                   func(ctx context.Context, arg db.CreateLandingRequestReviewParams) (db.LandingRequestReview, error)
	createLandingReviewRequestFn                   func(ctx context.Context, arg db.CreateLandingReviewRequestParams) (db.LandingReviewRequest, error)
	listLandingReviewRequestsFn                    func(ctx context.Context, landingRequestID int64) ([]db.LandingReviewRequest, error)
	dismissLandingReviewRequestFn                  func(ctx context.Context, arg db.DismissLandingReviewRequestParams) (db.LandingReviewRequest, error)
	fulfillLandingReviewRequestsForUserFn          func(ctx context.Context, arg db.FulfillLandingReviewRequestsForUserParams) error
	fulfillLandingReviewRequestsForAgentFn         func(ctx context.Context, arg db.FulfillLandingReviewRequestsForAgentParams) error
	getLandingRevisionByCommitIDFn                 func(ctx context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error)
	updateLandingRequestReviewStateFn              func(ctx context.Context, arg db.UpdateLandingRequestReviewStateParams) (db.LandingRequestReview, error)
	listLandingRequestCommentsFn                   func(ctx context.Context, arg db.ListLandingRequestCommentsParams) ([]db.LandingRequestComment, error)
	countLandingRequestCommentsFn                  func(ctx context.Context, landingRequestID int64) (int64, error)
	createLandingRequestCommentFn                  func(ctx context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error)
	updateLandingRequestTurnFn                     func(ctx context.Context, arg db.UpdateLandingRequestTurnParams) (db.LandingRequest, error)
	getLandingRequestCommentByIDFn                 func(ctx context.Context, arg db.GetLandingRequestCommentByIDParams) (db.LandingRequestComment, error)
	markLandingRequestThreadDoneFn                 func(ctx context.Context, arg db.MarkLandingRequestThreadDoneParams) (db.LandingRequestComment, error)
	ackLandingRequestThreadFn                      func(ctx context.Context, arg db.AckLandingRequestThreadParams) (db.LandingRequestComment, error)
	reopenLandingRequestThreadFn                   func(ctx context.Context, arg db.ReopenLandingRequestThreadParams) (db.LandingRequestComment, error)
	countUnresolvedLandingRequestThreadsFn         func(ctx context.Context, landingRequestID int64) (int64, error)
	changesRequestedFn                             func(ctx context.Context, landingRequestID int64) ([]string, error)
	listChangeRevisionsFn                          func(ctx context.Context, arg db.ListChangeRevisionsParams) ([]db.ChangeRevision, error)
	listLandingRequestChangesFn                    func(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error)
	countLandingRequestChangesFn                   func(ctx context.Context, landingRequestID int64) (int64, error)
	listAllProtectedBookmarksByRepoFn              func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	countApprovedLandingRequestReviewsFn           func(ctx context.Context, landingRequestID int64) (int64, error)
	countCurrentAgentLandingReviewCommitsFn        func(ctx context.Context, arg db.CountCurrentAgentLandingReviewCommitsParams) (int64, error)
	getLandingRequestReviewByIDFn                  func(ctx context.Context, id int64) (db.LandingRequestReview, error)
	createLandingRequestCalled                     bool
	lastCreateLandingRequestArg                    db.CreateLandingRequestParams
	addLandingRequestChangeCalls                   []db.AddLandingRequestChangeParams
	lastUpdateLandingRequestArg                    db.UpdateLandingRequestParams
	lastListLandingRequestsWithChangeIDsArg        db.ListLandingRequestsWithChangeIDsByRepoFilteredParams
	lastListLandingRequestsByRepoFilteredKeysetArg db.ListLandingRequestsByRepoFilteredKeysetParams
	lastCountLandingRequestsByRepoFilteredArg      db.CountLandingRequestsByRepoFilteredParams
	lastListLandingRequestReviewsArg               db.ListLandingRequestReviewsParams
	lastListLandingRequestCommentsArg              db.ListLandingRequestCommentsParams
	lastListLandingRequestChangesArg               db.ListLandingRequestChangesParams
	lastCreateLandingRequestReviewArg              db.CreateLandingRequestReviewParams
	lastCreateLandingRequestCommentArg             db.CreateLandingRequestCommentParams
	lastUpdateLandingRequestTurnArg                db.UpdateLandingRequestTurnParams
	lastGetRepoByOwnerAndLowerNameArg              db.GetRepoByOwnerAndLowerNameParams
	lastGetHighestTeamPermissionForRepoUserArg     db.GetHighestTeamPermissionForRepoUserParams
	lastIsOrgOwnerForRepoUserArg                   db.IsOrgOwnerForRepoUserParams
	lastGetLandingRequestWithChangeIDsByNumber     db.GetLandingRequestWithChangeIDsByNumberParams
	lastCountLandingRequestReviewsLandingID        int64
	lastCountLandingRequestCommentsLandingID       int64
	lastCountLandingRequestChangesLandingID        int64
	lastListAllProtectedBookmarksRepoID            int64
	lastCountApprovedLandingRequestReviewsID       int64
	enqueueLandingRequestCalled                    bool
	lastEnqueueLandingRequestArg                   db.EnqueueLandingRequestParams
	createLandingTaskCalled                        bool
	lastCreateLandingTaskArg                       db.CreateLandingTaskParams
	revertLandingRequestToOpenFn                   func(ctx context.Context, id int64) (db.LandingRequest, error)
	revertLandingRequestToOpenCalled               bool
	getLatestCommitStatusesFn                      func(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error)
	listLatestCommitStatusesFn                     func(ctx context.Context, arg db.ListLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.ListLatestCommitStatusesByChangeIDsAndContextsRow, error)
	lastGetLatestCommitStatusesArg                 db.GetLatestCommitStatusesByChangeIDsAndContextsParams
	lastListLatestCommitStatusesArg                db.ListLatestCommitStatusesByChangeIDsAndContextsParams
}

func (m *mockLandingQuerier) RevertLandingRequestToOpen(ctx context.Context, id int64) (db.LandingRequest, error) {
	m.revertLandingRequestToOpenCalled = true
	if m.revertLandingRequestToOpenFn != nil {
		return m.revertLandingRequestToOpenFn(ctx, id)
	}
	row := landingDBRequest(id, 77, 11, 10, nil)
	row.State = "open"
	return row, nil
}

func (m *mockLandingQuerier) GetLatestCommitStatusesByChangeIDsAndContexts(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error) {
	m.lastGetLatestCommitStatusesArg = arg
	if m.getLatestCommitStatusesFn != nil {
		return m.getLatestCommitStatusesFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockLandingQuerier) ListLatestCommitStatusesByChangeIDsAndContexts(ctx context.Context, arg db.ListLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.ListLatestCommitStatusesByChangeIDsAndContextsRow, error) {
	m.lastListLatestCommitStatusesArg = arg
	if m.listLatestCommitStatusesFn != nil {
		return m.listLatestCommitStatusesFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockLandingQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	m.lastGetRepoByOwnerAndLowerNameArg = arg
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	m.lastIsOrgOwnerForRepoUserArg = arg
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockLandingQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	m.lastGetHighestTeamPermissionForRepoUserArg = arg
	if m.getHighestTeamPermissionForRepoUserFn != nil {
		return m.getHighestTeamPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockLandingQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoUserFn != nil {
		return m.getCollaboratorPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockLandingQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id, Username: fmt.Sprintf("user-%d", id), LowerUsername: fmt.Sprintf("user-%d", id)}, nil
}

func (m *mockLandingQuerier) GetAgentSession(ctx context.Context, id string) (db.AgentSession, error) {
	if m.getAgentSessionFn != nil {
		return m.getAgentSessionFn(ctx, id)
	}
	return db.AgentSession{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) CreateLandingRequest(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
	m.createLandingRequestCalled = true
	m.lastCreateLandingRequestArg = arg
	if m.createLandingRequestFn != nil {
		return m.createLandingRequestFn(ctx, arg)
	}
	row := landingDBRequest(1, arg.RepositoryID, 1, arg.AuthorID, nil)
	row.StackSize = arg.StackSize
	return row, nil
}

func (m *mockLandingQuerier) AddLandingRequestChange(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
	m.addLandingRequestChangeCalls = append(m.addLandingRequestChangeCalls, arg)
	if m.addLandingRequestChangeFn != nil {
		return m.addLandingRequestChangeFn(ctx, arg)
	}
	return db.LandingRequestChange{
		ID:               int64(len(m.addLandingRequestChangeCalls)),
		LandingRequestID: arg.LandingRequestID,
		ChangeID:         arg.ChangeID,
		PositionInStack:  arg.PositionInStack,
		CreatedAt:        time.Now().UTC(),
	}, nil
}

func (m *mockLandingQuerier) DeleteLandingRequestChanges(ctx context.Context, landingRequestID int64) error {
	if m.deleteLandingRequestChangesFn != nil {
		return m.deleteLandingRequestChangesFn(ctx, landingRequestID)
	}
	return nil
}

func (m *mockLandingQuerier) UpdateLandingRequest(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
	m.lastUpdateLandingRequestArg = arg
	if m.updateLandingRequestFn != nil {
		return m.updateLandingRequestFn(ctx, arg)
	}
	row := landingDBRequest(arg.ID, 77, 11, 10, nil)
	row.Title = arg.Title
	row.Body = arg.Body
	row.State = arg.State
	row.TargetBookmark = arg.TargetBookmark
	row.SourceBookmark = arg.SourceBookmark
	row.ConflictStatus = arg.ConflictStatus
	row.StackSize = arg.StackSize
	row.ClosedAt = arg.ClosedAt
	row.MergedAt = arg.MergedAt
	return row, nil
}

func (m *mockLandingQuerier) CloseLandingRequest(ctx context.Context, id int64) (db.LandingRequest, error) {
	if m.closeLandingRequestFn != nil {
		return m.closeLandingRequestFn(ctx, id)
	}
	row := landingDBRequest(id, 77, 11, 10, nil)
	row.State = "closed"
	row.ClosedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	return row, nil
}

func (m *mockLandingQuerier) MergeLandingRequest(ctx context.Context, id int64) (db.LandingRequest, error) {
	if m.mergeLandingRequestFn != nil {
		return m.mergeLandingRequestFn(ctx, id)
	}
	row := landingDBRequest(id, 77, 11, 10, nil)
	row.State = "merged"
	row.MergedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	return row, nil
}

func (m *mockLandingQuerier) EnqueueLandingRequest(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
	m.enqueueLandingRequestCalled = true
	m.lastEnqueueLandingRequestArg = arg
	if m.enqueueLandingRequestFn != nil {
		return m.enqueueLandingRequestFn(ctx, arg)
	}
	row := landingDBRequest(arg.ID, 77, 11, 10, nil)
	row.State = "queued"
	return row, nil
}

func (m *mockLandingQuerier) CreateLandingTask(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
	m.createLandingTaskCalled = true
	m.lastCreateLandingTaskArg = arg
	if m.createLandingTaskFn != nil {
		return m.createLandingTaskFn(ctx, arg)
	}
	return db.LandingTask{
		ID:               100,
		LandingRequestID: arg.LandingRequestID,
		RepositoryID:     arg.RepositoryID,
		Status:           "pending",
		Priority:         arg.Priority,
		CreatedAt:        time.Now().UTC(),
		UpdatedAt:        time.Now().UTC(),
	}, nil
}

func (m *mockLandingQuerier) GetLandingQueuePositionByTaskID(ctx context.Context, id int64) (int64, error) {
	if m.getLandingQueuePositionByTaskIDFn != nil {
		return m.getLandingQueuePositionByTaskIDFn(ctx, id)
	}
	return 1, nil
}

func (m *mockLandingQuerier) GetLandingTaskByLandingRequestID(ctx context.Context, landingRequestID int64) (db.LandingTask, error) {
	m.getLandingTaskByLandingRequestIDCalled = true
	if m.getLandingTaskByLandingRequestIDFn != nil {
		return m.getLandingTaskByLandingRequestIDFn(ctx, landingRequestID)
	}
	return db.LandingTask{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) GetLandingRequestWithChangeIDsByNumber(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
	m.lastGetLandingRequestWithChangeIDsByNumber = arg
	if m.getLandingRequestWithChangeIDsByNumberFn != nil {
		return m.getLandingRequestWithChangeIDsByNumberFn(ctx, arg)
	}
	return landingDBRequestWithChangeIDs(7, arg.RepositoryID, arg.Number, 1, []string{"k1"}), nil
}

func (m *mockLandingQuerier) ListLandingRequestsWithChangeIDsByRepoFiltered(ctx context.Context, arg db.ListLandingRequestsWithChangeIDsByRepoFilteredParams) ([]db.ListLandingRequestsWithChangeIDsByRepoFilteredRow, error) {
	m.lastListLandingRequestsWithChangeIDsArg = arg
	if m.listLandingRequestsWithChangeIDsFilteredFn != nil {
		return m.listLandingRequestsWithChangeIDsFilteredFn(ctx, arg)
	}
	return []db.ListLandingRequestsWithChangeIDsByRepoFilteredRow{
		landingDBRequestListRow(7, arg.RepositoryID, 1, 1, []string{"k1"}),
	}, nil
}

func (m *mockLandingQuerier) ListLandingRequestsByRepoFilteredKeyset(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error) {
	m.lastListLandingRequestsByRepoFilteredKeysetArg = arg
	if m.listLandingRequestsByRepoFilteredKeysetFn != nil {
		return m.listLandingRequestsByRepoFilteredKeysetFn(ctx, arg)
	}
	return []db.ListLandingRequestsByRepoFilteredKeysetRow{}, nil
}

func (m *mockLandingQuerier) CountLandingRequestsByRepoFiltered(ctx context.Context, arg db.CountLandingRequestsByRepoFilteredParams) (int64, error) {
	m.lastCountLandingRequestsByRepoFilteredArg = arg
	if m.countLandingRequestsByRepoFilteredFn != nil {
		return m.countLandingRequestsByRepoFilteredFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockLandingQuerier) ListLandingRequestReviews(ctx context.Context, arg db.ListLandingRequestReviewsParams) ([]db.LandingRequestReview, error) {
	m.lastListLandingRequestReviewsArg = arg
	if m.listLandingRequestReviewsFn != nil {
		return m.listLandingRequestReviewsFn(ctx, arg)
	}
	return []db.LandingRequestReview{{ID: 1, LandingRequestID: arg.LandingRequestID, ReviewerID: pgtype.Int8{Int64: 2, Valid: true}, Type: "comment", Body: "ok", State: "submitted"}}, nil
}

func (m *mockLandingQuerier) CountLandingRequestReviews(ctx context.Context, landingRequestID int64) (int64, error) {
	m.lastCountLandingRequestReviewsLandingID = landingRequestID
	if m.countLandingRequestReviewsFn != nil {
		return m.countLandingRequestReviewsFn(ctx, landingRequestID)
	}
	return 1, nil
}

func (m *mockLandingQuerier) CreateLandingRequestReview(ctx context.Context, arg db.CreateLandingRequestReviewParams) (db.LandingRequestReview, error) {
	m.lastCreateLandingRequestReviewArg = arg
	if m.createLandingRequestReviewFn != nil {
		return m.createLandingRequestReviewFn(ctx, arg)
	}
	return db.LandingRequestReview{
		ID:               1,
		LandingRequestID: arg.LandingRequestID,
		ReviewerID:       arg.ReviewerID,
		ReviewerKind:     arg.ReviewerKind,
		Type:             arg.Type,
		Verdict:          pgtype.Text{String: arg.Verdict, Valid: arg.Verdict != ""},
		ConfidenceBucket: pgtype.Text{String: arg.ConfidenceBucket, Valid: arg.ConfidenceBucket != ""},
		Summary:          arg.Summary,
		CommitID:         arg.CommitID,
		Body:             arg.Body,
		State:            "submitted",
		ChangeRevisions:  arg.ChangeRevisions,
	}, nil
}

func (m *mockLandingQuerier) CreateLandingReviewRequest(ctx context.Context, arg db.CreateLandingReviewRequestParams) (db.LandingReviewRequest, error) {
	if m.createLandingReviewRequestFn != nil {
		return m.createLandingReviewRequestFn(ctx, arg)
	}
	return db.LandingReviewRequest{
		ID:               1,
		LandingRequestID: arg.LandingRequestID,
		RequestedBy:      arg.RequestedBy,
		ReviewerID:       arg.ReviewerID,
		AgentName:        pgtype.Text{String: arg.AgentName, Valid: arg.AgentName != ""},
		State:            "requested",
		CreatedAt:        time.Now().UTC(),
	}, nil
}

func (m *mockLandingQuerier) ListLandingReviewRequests(ctx context.Context, landingRequestID int64) ([]db.LandingReviewRequest, error) {
	if m.listLandingReviewRequestsFn != nil {
		return m.listLandingReviewRequestsFn(ctx, landingRequestID)
	}
	return nil, nil
}

func (m *mockLandingQuerier) DismissLandingReviewRequest(ctx context.Context, arg db.DismissLandingReviewRequestParams) (db.LandingReviewRequest, error) {
	if m.dismissLandingReviewRequestFn != nil {
		return m.dismissLandingReviewRequestFn(ctx, arg)
	}
	return db.LandingReviewRequest{ID: arg.ID, LandingRequestID: arg.LandingRequestID, State: "dismissed"}, nil
}

func (m *mockLandingQuerier) FulfillLandingReviewRequestsForUser(ctx context.Context, arg db.FulfillLandingReviewRequestsForUserParams) error {
	if m.fulfillLandingReviewRequestsForUserFn != nil {
		return m.fulfillLandingReviewRequestsForUserFn(ctx, arg)
	}
	return nil
}

func (m *mockLandingQuerier) FulfillLandingReviewRequestsForAgent(ctx context.Context, arg db.FulfillLandingReviewRequestsForAgentParams) error {
	if m.fulfillLandingReviewRequestsForAgentFn != nil {
		return m.fulfillLandingReviewRequestsForAgentFn(ctx, arg)
	}
	return nil
}

func (m *mockLandingQuerier) GetLandingRequestChangeRevisionByCommitID(ctx context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
	if m.getLandingRevisionByCommitIDFn != nil {
		return m.getLandingRevisionByCommitIDFn(ctx, arg)
	}
	return db.ChangeRevision{RepositoryID: arg.RepositoryID, ChangeID: "k1", CommitID: arg.CommitID, Seq: 1}, nil
}

func (m *mockLandingQuerier) UpdateLandingRequestReviewState(ctx context.Context, arg db.UpdateLandingRequestReviewStateParams) (db.LandingRequestReview, error) {
	if m.updateLandingRequestReviewStateFn != nil {
		return m.updateLandingRequestReviewStateFn(ctx, arg)
	}
	return db.LandingRequestReview{
		ID:               arg.ID,
		LandingRequestID: 1,
		ReviewerID:       pgtype.Int8{Int64: 1, Valid: true},
		Type:             "comment",
		Body:             "",
		State:            arg.State,
	}, nil
}

func (m *mockLandingQuerier) ListLandingRequestComments(ctx context.Context, arg db.ListLandingRequestCommentsParams) ([]db.LandingRequestComment, error) {
	m.lastListLandingRequestCommentsArg = arg
	if m.listLandingRequestCommentsFn != nil {
		return m.listLandingRequestCommentsFn(ctx, arg)
	}
	return []db.LandingRequestComment{{ID: 1, LandingRequestID: arg.LandingRequestID, UserID: pgtype.Int8{Int64: 2, Valid: true}, Path: "README.md", Line: 10, Side: "right", Body: "nit"}}, nil
}

func (m *mockLandingQuerier) CountLandingRequestComments(ctx context.Context, landingRequestID int64) (int64, error) {
	m.lastCountLandingRequestCommentsLandingID = landingRequestID
	if m.countLandingRequestCommentsFn != nil {
		return m.countLandingRequestCommentsFn(ctx, landingRequestID)
	}
	return 1, nil
}

func (m *mockLandingQuerier) CreateLandingRequestComment(ctx context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error) {
	m.lastCreateLandingRequestCommentArg = arg
	if m.createLandingRequestCommentFn != nil {
		return m.createLandingRequestCommentFn(ctx, arg)
	}
	return db.LandingRequestComment{ID: 1, LandingRequestID: arg.LandingRequestID, UserID: arg.UserID, Path: arg.Path, Line: arg.Line, Side: arg.Side, Body: arg.Body, CommitID: arg.CommitID, AnchorHash: arg.AnchorHash}, nil
}

func (m *mockLandingQuerier) UpdateLandingRequestTurn(ctx context.Context, arg db.UpdateLandingRequestTurnParams) (db.LandingRequest, error) {
	m.lastUpdateLandingRequestTurnArg = arg
	if m.updateLandingRequestTurnFn != nil {
		return m.updateLandingRequestTurnFn(ctx, arg)
	}
	row := landingDBRequest(arg.ID, 77, 11, 10, nil)
	row.TurnParty = arg.TurnParty
	row.TurnActorID = arg.TurnActorID
	row.TurnReason = arg.TurnReason
	row.TurnSince = time.Now().UTC()
	return row, nil
}

func (m *mockLandingQuerier) GetLandingRequestCommentByID(ctx context.Context, arg db.GetLandingRequestCommentByIDParams) (db.LandingRequestComment, error) {
	if m.getLandingRequestCommentByIDFn != nil {
		return m.getLandingRequestCommentByIDFn(ctx, arg)
	}
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) MarkLandingRequestThreadDone(ctx context.Context, arg db.MarkLandingRequestThreadDoneParams) (db.LandingRequestComment, error) {
	if m.markLandingRequestThreadDoneFn != nil {
		return m.markLandingRequestThreadDoneFn(ctx, arg)
	}
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) AckLandingRequestThread(ctx context.Context, arg db.AckLandingRequestThreadParams) (db.LandingRequestComment, error) {
	if m.ackLandingRequestThreadFn != nil {
		return m.ackLandingRequestThreadFn(ctx, arg)
	}
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) ReopenLandingRequestThread(ctx context.Context, arg db.ReopenLandingRequestThreadParams) (db.LandingRequestComment, error) {
	if m.reopenLandingRequestThreadFn != nil {
		return m.reopenLandingRequestThreadFn(ctx, arg)
	}
	return db.LandingRequestComment{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) ListChangesRequestedLandingReviewers(ctx context.Context, landingRequestID int64) ([]string, error) {
	if m.changesRequestedFn != nil {
		return m.changesRequestedFn(ctx, landingRequestID)
	}
	return nil, nil
}

func (m *mockLandingQuerier) CountUnresolvedLandingRequestThreads(ctx context.Context, landingRequestID int64) (int64, error) {
	if m.countUnresolvedLandingRequestThreadsFn != nil {
		return m.countUnresolvedLandingRequestThreadsFn(ctx, landingRequestID)
	}
	return 0, nil
}

func (m *mockLandingQuerier) ListChangeRevisions(ctx context.Context, arg db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
	if m.listChangeRevisionsFn != nil {
		return m.listChangeRevisionsFn(ctx, arg)
	}
	return []db.ChangeRevision{{RepositoryID: arg.RepositoryID, ChangeID: arg.ChangeID, Seq: 1, CommitID: arg.ChangeID, ParentCommitID: "parent-" + arg.ChangeID}}, nil
}

func (m *mockLandingQuerier) GetChangeByChangeID(ctx context.Context, arg db.GetChangeByChangeIDParams) (db.Change, error) {
	if m.getChangeByChangeIDFn != nil {
		return m.getChangeByChangeIDFn(ctx, arg)
	}
	return db.Change{RepositoryID: arg.RepositoryID, ChangeID: arg.ChangeID, CommitID: arg.ChangeID, Description: arg.ChangeID, AuthorName: "author"}, nil
}

func (m *mockLandingQuerier) ListLandingRequestChanges(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
	m.lastListLandingRequestChangesArg = arg
	if m.listLandingRequestChangesFn != nil {
		return m.listLandingRequestChangesFn(ctx, arg)
	}
	return []db.LandingRequestChange{{ID: 1, LandingRequestID: arg.LandingRequestID, ChangeID: "k1", PositionInStack: 1}}, nil
}

func (m *mockLandingQuerier) CountLandingRequestChanges(ctx context.Context, landingRequestID int64) (int64, error) {
	m.lastCountLandingRequestChangesLandingID = landingRequestID
	if m.countLandingRequestChangesFn != nil {
		return m.countLandingRequestChangesFn(ctx, landingRequestID)
	}
	return 1, nil
}

func (m *mockLandingQuerier) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	m.lastListAllProtectedBookmarksRepoID = repositoryID
	if m.listAllProtectedBookmarksByRepoFn != nil {
		return m.listAllProtectedBookmarksByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockLandingQuerier) CountApprovedLandingRequestReviews(ctx context.Context, landingRequestID int64) (int64, error) {
	m.lastCountApprovedLandingRequestReviewsID = landingRequestID
	if m.countApprovedLandingRequestReviewsFn != nil {
		return m.countApprovedLandingRequestReviewsFn(ctx, landingRequestID)
	}
	return 0, nil
}

func (m *mockLandingQuerier) CountCurrentAgentLandingReviewCommits(ctx context.Context, arg db.CountCurrentAgentLandingReviewCommitsParams) (int64, error) {
	if m.countCurrentAgentLandingReviewCommitsFn != nil {
		return m.countCurrentAgentLandingReviewCommitsFn(ctx, arg)
	}
	return 0, nil
}

func (m *mockLandingQuerier) GetLandingRequestReviewByID(ctx context.Context, id int64) (db.LandingRequestReview, error) {
	if m.getLandingRequestReviewByIDFn != nil {
		return m.getLandingRequestReviewByIDFn(ctx, id)
	}
	return db.LandingRequestReview{}, nil
}

func (m *mockLandingQuerier) GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error) {
	if m.getUserByLowerUsernameFn != nil {
		return m.getUserByLowerUsernameFn(ctx, lowerUsername)
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *mockLandingQuerier) CreateMention(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error) {
	return db.Mention{}, nil
}

func (m *mockLandingQuerier) DeleteMentionsForComment(ctx context.Context, arg db.DeleteMentionsForCommentParams) error {
	return nil
}

type mockLandingRepoHostClient struct {
	landChangesFn        func(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error)
	getChangeConflictsFn func(ctx context.Context, owner, repo, changeID string) ([]repohost.Conflict, error)
	getChangeFn          func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	getChangeFilesFn     func(ctx context.Context, owner, repo, changeID string) ([]repohost.ChangeFile, error)
	getChangeDiffFn      func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error)
	getRevisionDiffFn    func(ctx context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error)
	getFileAtChangeFn    func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
	listDirectoryFn      func(ctx context.Context, owner, repo, changeID, prefix, after string, limit int) ([]repohost.TreeEntry, error)
	lastLandOwner        string
	lastLandRepo         string
	lastLandRequest      repohost.LandRequest
	lastLandCtx          context.Context
	conflictCalls        []string
	conflictCallCtxs     []context.Context
}

func (m *mockLandingRepoHostClient) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	m.lastLandOwner = owner
	m.lastLandRepo = repo
	m.lastLandRequest = req
	m.lastLandCtx = ctx
	if m.landChangesFn != nil {
		return m.landChangesFn(ctx, owner, repo, req)
	}
	return repohost.LandResult{
		LandedCount:    len(req.ChangeIDs),
		TargetBookmark: req.TargetBookmark,
		TargetCommitID: "c-main",
	}, nil
}

func (m *mockLandingRepoHostClient) GetChangeConflicts(ctx context.Context, owner, repo, changeID string) ([]repohost.Conflict, error) {
	m.conflictCalls = append(m.conflictCalls, changeID)
	m.conflictCallCtxs = append(m.conflictCallCtxs, ctx)
	if m.getChangeConflictsFn != nil {
		return m.getChangeConflictsFn(ctx, owner, repo, changeID)
	}
	return []repohost.Conflict{{FilePath: "README.md", ConflictType: "both_modified"}}, nil
}

func (m *mockLandingRepoHostClient) GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
	if m.getChangeFn != nil {
		return m.getChangeFn(ctx, owner, repo, changeID)
	}
	return repohost.Change{ChangeID: changeID, CommitID: changeID}, nil
}

func (m *mockLandingRepoHostClient) GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
	if m.getChangeDiffFn != nil {
		return m.getChangeDiffFn(ctx, owner, repo, changeID)
	}
	return repohost.ChangeDiff{ChangeID: changeID}, nil
}

func (m *mockLandingRepoHostClient) GetRevisionDiff(ctx context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error) {
	if m.getRevisionDiffFn != nil {
		return m.getRevisionDiffFn(ctx, owner, repo, changeID, fromCommitID, toCommitID, path)
	}
	return m.GetChangeDiff(ctx, owner, repo, changeID)
}

func (m *mockLandingRepoHostClient) GetChangeFiles(ctx context.Context, owner, repo, changeID string) ([]repohost.ChangeFile, error) {
	if m.getChangeFilesFn != nil {
		return m.getChangeFilesFn(ctx, owner, repo, changeID)
	}
	return nil, nil
}

func (m *mockLandingRepoHostClient) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	if m.getFileAtChangeFn != nil {
		return m.getFileAtChangeFn(ctx, owner, repo, changeID, path)
	}
	return repohost.FileContent{Path: path}, nil
}

func (m *mockLandingRepoHostClient) ListDirectory(ctx context.Context, owner, repo, changeID, prefix, after string, limit int) ([]repohost.TreeEntry, error) {
	if m.listDirectoryFn != nil {
		return m.listDirectoryFn(ctx, owner, repo, changeID, prefix, after, limit)
	}
	return nil, &repohost.StatusError{StatusCode: 404}
}

type mockLandingCreateTxManager struct {
	beginCreateTxFn func(ctx context.Context) (landingCreateTx, error)
}

func (m *mockLandingCreateTxManager) BeginCreateTx(ctx context.Context) (landingCreateTx, error) {
	if m.beginCreateTxFn != nil {
		return m.beginCreateTxFn(ctx)
	}
	return &mockLandingCreateTx{}, nil
}

type mockLandingCreateTx struct {
	createLandingRequestFn func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error)
	addLandingChangeFn     func(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error)
	commitFn               func(ctx context.Context) error
	rollbackFn             func(ctx context.Context) error
	committed              bool
	rolledBack             bool
}

func (m *mockLandingCreateTx) CreateLandingRequest(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
	if m.createLandingRequestFn != nil {
		return m.createLandingRequestFn(ctx, arg)
	}
	return landingDBRequest(11, arg.RepositoryID, 6, arg.AuthorID, nil), nil
}

func (m *mockLandingCreateTx) AddLandingRequestChange(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
	if m.addLandingChangeFn != nil {
		return m.addLandingChangeFn(ctx, arg)
	}
	return db.LandingRequestChange{
		ID:               int64(arg.PositionInStack),
		LandingRequestID: arg.LandingRequestID,
		ChangeID:         arg.ChangeID,
		PositionInStack:  arg.PositionInStack,
		CreatedAt:        time.Now().UTC(),
	}, nil
}

func (m *mockLandingCreateTx) Commit(ctx context.Context) error {
	m.committed = true
	if m.commitFn != nil {
		return m.commitFn(ctx)
	}
	return nil
}

func (m *mockLandingCreateTx) Rollback(ctx context.Context) error {
	m.rolledBack = true
	if m.rollbackFn != nil {
		return m.rollbackFn(ctx)
	}
	return nil
}

func landingTestUser(id int64, username string) *db.User {
	return &db.User{
		ID:            id,
		Username:      username,
		LowerUsername: username,
		IsActive:      true,
	}
}

func landingRepo(overrides func(*db.Repository)) db.Repository {
	r := db.Repository{
		ID:        77,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
		Name:      "demo",
		LowerName: "demo",
		IsPublic:  true,
	}
	if overrides != nil {
		overrides(&r)
	}
	return r
}

func landingDBRequest(id, repositoryID, number, authorID int64, overrides func(*db.LandingRequest)) db.LandingRequest {
	now := time.Now().UTC().Truncate(time.Second)
	lr := db.LandingRequest{
		ID:             id,
		RepositoryID:   repositoryID,
		Number:         number,
		Title:          "seed",
		Body:           "seed body",
		State:          "open",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ConflictStatus: "clean",
		StackSize:      1,
		TurnParty:      "reviewer",
		TurnActorID:    fmt.Sprint(authorID),
		TurnSince:      now,
		TurnReason:     "request",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if overrides != nil {
		overrides(&lr)
	}
	return lr
}

func landingDBRequestWithChangeIDs(id, repositoryID, number, authorID int64, changeIDs []string) db.GetLandingRequestWithChangeIDsByNumberRow {
	now := time.Now().UTC().Truncate(time.Second)
	return db.GetLandingRequestWithChangeIDsByNumberRow{
		ID:             id,
		RepositoryID:   repositoryID,
		Number:         number,
		Title:          "seed",
		Body:           "seed body",
		State:          "open",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ConflictStatus: "clean",
		StackSize:      int64(len(changeIDs)),
		TurnParty:      "reviewer",
		TurnActorID:    fmt.Sprint(authorID),
		TurnSince:      now,
		TurnReason:     "request",
		CreatedAt:      now,
		UpdatedAt:      now,
		ChangeIds:      changeIDs,
	}
}

func landingDBRequestListRow(id, repositoryID, number, authorID int64, changeIDs []string) db.ListLandingRequestsWithChangeIDsByRepoFilteredRow {
	now := time.Now().UTC().Truncate(time.Second)
	return db.ListLandingRequestsWithChangeIDsByRepoFilteredRow{
		ID:             id,
		RepositoryID:   repositoryID,
		Number:         number,
		Title:          "seed",
		Body:           "seed body",
		State:          "open",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ConflictStatus: "clean",
		StackSize:      int64(len(changeIDs)),
		TurnParty:      "reviewer",
		TurnActorID:    fmt.Sprint(authorID),
		TurnSince:      now,
		TurnReason:     "request",
		CreatedAt:      now,
		UpdatedAt:      now,
		ChangeIds:      changeIDs,
	}
}

func landingDBRequestKeysetRow(id, repositoryID, number, authorID int64, changeIDs []string) db.ListLandingRequestsByRepoFilteredKeysetRow {
	now := time.Now().UTC().Truncate(time.Second)
	return db.ListLandingRequestsByRepoFilteredKeysetRow{
		ID:             id,
		RepositoryID:   repositoryID,
		Number:         number,
		Title:          "seed",
		Body:           "seed body",
		State:          "open",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ConflictStatus: "clean",
		StackSize:      int64(len(changeIDs)),
		TurnParty:      "reviewer",
		TurnActorID:    fmt.Sprint(authorID),
		TurnSince:      now,
		TurnReason:     "request",
		CreatedAt:      now,
		UpdatedAt:      now,
		ChangeIds:      changeIDs,
	}
}

func landingAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok, "expected *errors.APIError, got %T", err)
	return apiErr.Status
}

func landingStringPtr(v string) *string { return &v }

func TestLandingService_ListLandingRequests_ReadAccessMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		repo         db.Repository
		viewer       *db.User
		teamPerm     string
		expectStatus int
		expectOK     bool
	}{
		{
			name:     "public repo allows anonymous",
			repo:     landingRepo(func(r *db.Repository) { r.IsPublic = true }),
			viewer:   nil,
			expectOK: true,
		},
		{
			name:         "private repo denies anonymous",
			repo:         landingRepo(func(r *db.Repository) { r.IsPublic = false }),
			viewer:       nil,
			expectStatus: 403,
		},
		{
			name: "private repo allows team read",
			repo: landingRepo(func(r *db.Repository) {
				r.IsPublic = false
				// Team permission checks are only evaluated for org-owned repositories.
				r.UserID = pgtype.Int8{}
				r.OrgID = pgtype.Int8{Int64: 33, Valid: true}
			}),
			viewer:   landingTestUser(5, "reviewer"),
			teamPerm: "read",
			expectOK: true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			q := &mockLandingQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return tc.repo, nil
				},
				getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				listLandingRequestsByRepoFilteredKeysetFn: func(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error) {
					return []db.ListLandingRequestsByRepoFilteredKeysetRow{
						landingDBRequestKeysetRow(1, tc.repo.ID, 9, 1, []string{"k1", "k2"}),
					}, nil
				},
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
				},
			}

			svc := NewLandingService(q, &mockLandingRepoHostClient{})
			items, _, total, err := svc.ListLandingRequests(context.Background(), tc.viewer, "alice", "demo", 2, 50, "open")
			if tc.expectOK {
				require.NoError(t, err)
				require.Len(t, items, 1)
				assert.Equal(t, int64(9), items[0].Number)
				assert.Equal(t, []string{"k1", "k2"}, items[0].ChangeIDs)
				assert.Equal(t, "reviewer", items[0].Turn.Party)
				assert.Equal(t, "request", items[0].Turn.Reason)
				assert.Equal(t, int64(1), total)
				assert.Equal(t, int32(50), q.lastListLandingRequestsByRepoFilteredKeysetArg.PageSize)
				assert.Equal(t, int64(2), q.lastListLandingRequestsByRepoFilteredKeysetArg.AfterNumber)
				assert.Equal(t, "open", q.lastListLandingRequestsByRepoFilteredKeysetArg.State)
				return
			}
			assert.Equal(t, tc.expectStatus, landingAPIStatus(t, err))
		})
	}
}

func TestLandingService_CreateLandingRequest_ValidationAndPermission(t *testing.T) {
	t.Parallel()

	privateRepo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		// Team permission checks are only evaluated for org-owned repositories.
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 88, Valid: true}
	})
	actor := landingTestUser(10, "actor")

	tests := []struct {
		name         string
		actor        *db.User
		input        CreateLandingRequestInput
		teamPerm     string
		expectStatus int
	}{
		{
			name:         "requires auth",
			actor:        nil,
			input:        CreateLandingRequestInput{Title: "x", TargetBookmark: "main", ChangeIDs: []string{"k1"}},
			expectStatus: 401,
		},
		{
			name:         "missing title",
			actor:        actor,
			input:        CreateLandingRequestInput{Title: "  ", TargetBookmark: "main", ChangeIDs: []string{"k1"}},
			expectStatus: 422,
		},
		{
			name:         "missing target bookmark",
			actor:        actor,
			input:        CreateLandingRequestInput{Title: "x", TargetBookmark: " ", ChangeIDs: []string{"k1"}},
			expectStatus: 422,
		},
		{
			name:         "missing change ids",
			actor:        actor,
			input:        CreateLandingRequestInput{Title: "x", TargetBookmark: "main", ChangeIDs: nil},
			expectStatus: 422,
		},
		{
			name:         "insufficient permissions",
			actor:        actor,
			input:        CreateLandingRequestInput{Title: "x", TargetBookmark: "main", ChangeIDs: []string{"k1"}},
			expectStatus: 403,
		},
		{
			name:         "team write permission allows create",
			actor:        actor,
			input:        CreateLandingRequestInput{Title: "new landing", Body: "desc", TargetBookmark: "main", SourceBookmark: "feature/new", ChangeIDs: []string{"k1", "k2"}},
			teamPerm:     "write",
			expectStatus: 0,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			q := &mockLandingQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return privateRepo, nil
				},
				getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
					return landingDBRequest(91, privateRepo.ID, 7, arg.AuthorID, nil), nil
				},
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{ID: id, Username: "actor", LowerUsername: "actor"}, nil
				},
			}
			svc := NewLandingService(q, &mockLandingRepoHostClient{})

			resp, err := svc.CreateLandingRequest(context.Background(), tc.actor, "alice", "demo", tc.input)
			if tc.expectStatus != 0 {
				assert.Equal(t, tc.expectStatus, landingAPIStatus(t, err))
				return
			}

			require.NoError(t, err)
			assert.Equal(t, int64(7), resp.Number)
			assert.Equal(t, "actor", resp.Author.Login)
			assert.Equal(t, int64(2), q.lastCreateLandingRequestArg.StackSize)
			assert.Equal(t, "feature/new", q.lastCreateLandingRequestArg.SourceBookmark)
			require.Len(t, q.addLandingRequestChangeCalls, 2)
			assert.Equal(t, "k1", q.addLandingRequestChangeCalls[0].ChangeID)
			assert.Equal(t, int64(1), q.addLandingRequestChangeCalls[0].PositionInStack)
			assert.Equal(t, "k2", q.addLandingRequestChangeCalls[1].ChangeID)
			assert.Equal(t, int64(2), q.addLandingRequestChangeCalls[1].PositionInStack)
		})
	}
}

func TestLandingService_CreateLandingRequest_CollaboratorWriteAllowed(t *testing.T) {
	t.Parallel()

	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
	actor := landingTestUser(77, "collab")

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, pgtype.Int8{Int64: actor.ID, Valid: true}, arg.UserID)
			return "write", nil
		},
		createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
			return landingDBRequest(300, repo.ID, 41, arg.AuthorID, nil), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "collab", LowerUsername: "collab"}, nil
		},
	}
	m := newObserveV2Metrics()
	svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingMetrics(m))

	resp, err := svc.CreateLandingRequest(context.Background(), actor, "owner", "demo", CreateLandingRequestInput{
		Title:          "collaborator landing",
		Body:           "body",
		TargetBookmark: "main",
		SourceBookmark: "feature/collab",
		ChangeIDs:      []string{"k1", "k2"},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(41), resp.Number)
	assert.Equal(t, "feature/collab", q.lastCreateLandingRequestArg.SourceBookmark)
	require.Len(t, q.addLandingRequestChangeCalls, 2)
	require.Equal(t, 1.0, testutil.ToFloat64(m.landing.WithLabelValues("create")))
}

func TestLandingService_CreateLandingRequest_RecordsAgentAuthorSessionAndInitialTurn(t *testing.T) {
	t.Parallel()
	sessionID := "11111111-1111-4111-8111-111111111111"
	actor := landingTestUser(10, "alice")
	repo := landingRepo(func(repo *db.Repository) {
		repo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
		repo.IsPublic = false
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createLandingRequestFn: func(_ context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
			assert.True(t, arg.AgentAuthored)
			assert.Equal(t, sessionID, arg.AuthorAgentSessionID)
			row := landingDBRequest(9, repo.ID, 3, actor.ID, nil)
			row.AgentAuthored = true
			row.AuthorAgentSessionID = pgtype.UUID{Bytes: uuid.MustParse(sessionID), Valid: true}
			row.TurnActorID = sessionID
			return row, nil
		},
		getAgentSessionFn: func(_ context.Context, id string) (db.AgentSession, error) {
			return db.AgentSession{ID: id, Title: "Implement landing facets"}, nil
		},
	}
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{
		User:        actor,
		IsTokenAuth: true,
		RawScopes:   "write:repository,repo:77," + middleware.AgentSessionRestrictionScope(sessionID),
	})

	got, err := NewLandingService(q, &mockLandingRepoHostClient{}).CreateLandingRequest(ctx, actor, "alice", "demo", CreateLandingRequestInput{
		Title: "agent change", TargetBookmark: "main", ChangeIDs: []string{"change-1"},
	})

	require.NoError(t, err)
	assert.True(t, got.AgentAuthored)
	assert.Equal(t, LandingRequestTurn{Party: "reviewer", ActorID: sessionID, ActorLogin: "Implement landing facets", Since: got.Turn.Since, Reason: "request"}, got.Turn)
}

func TestLandingService_ReviewerFeedbackHandsTurnToAgentAndDispatches(t *testing.T) {
	t.Parallel()
	sessionID := "22222222-2222-4222-8222-222222222222"
	actor := landingTestUser(10, "alice")
	repo := landingRepo(func(repo *db.Repository) {
		repo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
		repo.IsPublic = false
	})
	landingRow := landingDBRequestWithChangeIDs(9, repo.ID, 3, actor.ID, []string{"change-1"})
	landingRow.AgentAuthored = true
	landingRow.AuthorAgentSessionID = pgtype.UUID{Bytes: uuid.MustParse(sessionID), Valid: true}
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingRow, nil
		},
		updateLandingRequestTurnFn: func(_ context.Context, arg db.UpdateLandingRequestTurnParams) (db.LandingRequest, error) {
			row := landingDBRequest(landingRow.ID, repo.ID, landingRow.Number, actor.ID, nil)
			row.AgentAuthored = true
			row.AuthorAgentSessionID = landingRow.AuthorAgentSessionID
			row.TurnParty, row.TurnActorID, row.TurnReason = arg.TurnParty, arg.TurnActorID, arg.TurnReason
			return row, nil
		},
		getLandingRevisionByCommitIDFn: func(_ context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
			return db.ChangeRevision{RepositoryID: repo.ID, ChangeID: "change-1", CommitID: arg.CommitID, Seq: 1}, nil
		},
	}
	dispatcher := &mockLandingAgentTurnDispatcher{}
	repoHost := &mockLandingRepoHostClient{getChangeFn: func(_ context.Context, _, _, changeID string) (repohost.Change, error) {
		return repohost.Change{ChangeID: changeID, CommitID: "reviewed-head"}, nil
	}}
	svc := NewLandingService(q, repoHost, WithLandingAgentTurnDispatcher(dispatcher))

	_, err := svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 3, CreateLandingCommentInput{Body: "please fix the bounds", CommitID: "reviewed-head"})
	require.NoError(t, err)
	assert.Equal(t, db.UpdateLandingRequestTurnParams{TurnParty: "author", TurnActorID: "10", TurnReason: "comment", ID: 9}, q.lastUpdateLandingRequestTurnArg)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, LandingAgentTurnDispatchInput{
		SessionID: sessionID, RepositoryID: repo.ID, UserID: actor.ID, RepoOwner: "alice", RepoName: repo.Name, Number: 3, Feedback: "please fix the bounds",
	}, dispatcher.calls[0])

	_, err = svc.CreateLandingReview(context.Background(), actor, "alice", "demo", 3, CreateLandingReviewInput{Type: "request_changes", Body: "add a regression test", CommitID: "reviewed-head"})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 2)
	assert.Equal(t, "add a regression test", dispatcher.calls[1].Feedback)
}

func TestLandingService_CreateLandingRequest_PersistenceErrorsMapToAPIError(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(31, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	input := CreateLandingRequestInput{
		Title:          "new",
		Body:           "seed",
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ChangeIDs:      []string{"k1"},
	}

	t.Run("transaction begin keeps wrapped api status", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		svc.createTxManager = &mockLandingCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (landingCreateTx, error) {
				return nil, fmt.Errorf("wrapped begin: %w", errors.ValidationFailed(errors.FieldError{
					Resource: "LandingRequest",
					Field:    "target_bookmark",
					Code:     "invalid",
				}))
			},
		}

		_, err := svc.CreateLandingRequest(context.Background(), actor, "alice", "demo", input)
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})

	t.Run("transactional change insert unique violation returns conflict", func(t *testing.T) {
		tx := &mockLandingCreateTx{
			createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
				return landingDBRequest(88, repo.ID, 12, actor.ID, nil), nil
			},
			addLandingChangeFn: func(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
				return db.LandingRequestChange{}, &pgconn.PgError{Code: "23505", ConstraintName: "landing_request_changes_landing_request_id_position_in_stack_key"}
			},
		}

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		svc.createTxManager = &mockLandingCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (landingCreateTx, error) {
				return tx, nil
			},
		}

		_, err := svc.CreateLandingRequest(context.Background(), actor, "alice", "demo", input)
		assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
		assert.True(t, tx.rolledBack)
	})

	t.Run("non transactional create constraint violation returns validation", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
				return db.LandingRequest{}, &pgconn.PgError{Code: "23514", ConstraintName: "landing_requests_conflict_status_check"}
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})

		_, err := svc.CreateLandingRequest(context.Background(), actor, "alice", "demo", input)
		assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	})
}

func TestLandingService_ListLandingRequests_InvalidStateFilter(t *testing.T) {
	t.Parallel()

	countCalled := false
	listCalled := false
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return landingRepo(func(r *db.Repository) { r.IsPublic = true }), nil
		},
		countLandingRequestsByRepoFilteredFn: func(ctx context.Context, arg db.CountLandingRequestsByRepoFilteredParams) (int64, error) {
			countCalled = true
			return 0, nil
		},
		listLandingRequestsWithChangeIDsFilteredFn: func(ctx context.Context, arg db.ListLandingRequestsWithChangeIDsByRepoFilteredParams) ([]db.ListLandingRequestsWithChangeIDsByRepoFilteredRow, error) {
			listCalled = true
			return nil, nil
		},
	}

	svc := NewLandingService(q, &mockLandingRepoHostClient{})
	_, _, _, err := svc.ListLandingRequests(context.Background(), nil, "alice", "demo", 1, 30, "garbage")
	assert.Equal(t, http.StatusUnprocessableEntity, landingAPIStatus(t, err))
	assert.False(t, countCalled)
	assert.False(t, listCalled)
}

func TestLandingService_GetLandingRequest_ReturnsMappedResponse(t *testing.T) {
	t.Parallel()

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return landingRepo(nil), nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(21, arg.RepositoryID, arg.Number, 9, []string{"k-one", "k-two"}), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	got, err := svc.GetLandingRequest(context.Background(), nil, "alice", "demo", 42)
	require.NoError(t, err)
	assert.Equal(t, int64(42), got.Number)
	assert.Equal(t, []string{"k-one", "k-two"}, got.ChangeIDs)
	assert.Equal(t, "main", got.TargetBookmark)
	assert.Equal(t, "clean", got.ConflictStatus)
	assert.Equal(t, "alice", got.Author.Login)
	assert.Equal(t, "alice", got.Turn.ActorLogin)
	assert.Equal(t, int64(2), got.LandablePrefix)
	require.Len(t, got.BlockedBy, 2)
	assert.Empty(t, got.BlockedBy["k-one"])
}

func TestLandingService_GetLandingRequest_ComputesPerChangeReadiness(t *testing.T) {
	t.Parallel()

	repo := landingRepo(func(r *db.Repository) {
		r.LandingQueueRequiredChecks = []string{"ci/typecheck"}
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(21, arg.RepositoryID, arg.Number, 9, []string{"base", "middle", "top"}), nil
		},
		listLatestCommitStatusesFn: func(_ context.Context, arg db.ListLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.ListLatestCommitStatusesByChangeIDsAndContextsRow, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, []string{"base", "middle", "top"}, arg.ChangeIds)
			assert.Equal(t, []string{"ci/typecheck"}, arg.Contexts)
			return []db.ListLatestCommitStatusesByChangeIDsAndContextsRow{
				{ChangeID: "base", Context: "ci/typecheck", Status: "success"},
				{ChangeID: "middle", Context: "ci/typecheck", Status: "failure"},
				{ChangeID: "top", Context: "ci/typecheck", Status: "success"},
			}, nil
		},
	}

	got, err := NewLandingService(q, &mockLandingRepoHostClient{}).GetLandingRequest(context.Background(), nil, "alice", "demo", 42)
	require.NoError(t, err)
	assert.Equal(t, int64(1), got.LandablePrefix)
	require.Len(t, got.BlockedBy, 3)
	assert.Empty(t, got.BlockedBy["base"])
	assert.Equal(t, []LandingBlock{{Kind: "check", Name: "ci/typecheck", Repo: "demo"}}, got.BlockedBy["middle"])
	assert.Empty(t, got.BlockedBy["top"])
}

func TestLandingService_GetLandingRequest_ReportsMissingCurrentAgentLGTM(t *testing.T) {
	t.Parallel()

	repo := landingRepo(nil)
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(21, arg.RepositoryID, arg.Number, 9, []string{"base", "middle", "top"}), nil
		},
		listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
			return []db.ProtectedBookmark{{Pattern: "main", RequireAgentLgtm: true}}, nil
		},
		countCurrentAgentLandingReviewCommitsFn: func(_ context.Context, arg db.CountCurrentAgentLandingReviewCommitsParams) (int64, error) {
			assert.Equal(t, int64(21), arg.LandingRequestID)
			require.Len(t, arg.CommitIds, 1)
			if arg.CommitIds[0] == "commit-middle-current" {
				return 0, nil
			}
			return 1, nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeFn: func(_ context.Context, owner, repoName, changeID string) (repohost.Change, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repoName)
			return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID + "-current"}, nil
		},
	}

	got, err := NewLandingService(q, rh).GetLandingRequest(context.Background(), nil, "alice", "demo", 42)
	require.NoError(t, err)
	assert.Equal(t, int64(1), got.LandablePrefix)
	assert.Empty(t, got.BlockedBy["base"])
	assert.Equal(t, []LandingBlock{{Kind: "review", Missing: "agent_lgtm"}}, got.BlockedBy["middle"])
	assert.Empty(t, got.BlockedBy["top"])
}

func TestLandingService_GetLandingRequest_ReportsReviewAndConflictBlockers(t *testing.T) {
	t.Parallel()

	repo := landingRepo(nil)
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			row := landingDBRequestWithChangeIDs(31, arg.RepositoryID, arg.Number, 9, []string{"base", "top"})
			row.ConflictStatus = "conflicted"
			return row, nil
		},
		listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
			return []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 2}}, nil
		},
		countApprovedLandingRequestReviewsFn: func(context.Context, int64) (int64, error) {
			return 1, nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeConflictsFn: func(_ context.Context, owner, repoName, changeID string) ([]repohost.Conflict, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repoName)
			if changeID == "top" {
				return []repohost.Conflict{{FilePath: "src/main.go", ConflictType: "both_modified"}}, nil
			}
			return nil, nil
		},
	}

	got, err := NewLandingService(q, rh).GetLandingRequest(context.Background(), nil, "alice", "demo", 42)
	require.NoError(t, err)
	assert.Zero(t, got.LandablePrefix)
	assert.Equal(t, []LandingBlock{{Kind: "review", Name: "approval", Repo: "demo"}}, got.BlockedBy["base"])
	assert.Equal(t, []LandingBlock{
		{Kind: "review", Name: "approval", Repo: "demo"},
		{Kind: "conflict", Name: "src/main.go", Repo: "demo"},
	}, got.BlockedBy["top"])
}

func TestLandingService_UpdateLandingRequest_TransitionValidation(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "owner")
	repo := landingRepo(nil)
	repo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}

	t.Run("rejects invalid transition from merged to open", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(3, repo.ID, arg.Number, actor.ID, []string{"k1"})
				row.State = "merged"
				return row, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 7, UpdateLandingRequestInput{State: landingStringPtr("open")})
		assert.Equal(t, 422, landingAPIStatus(t, err))
	})

	t.Run("close transition uses single update query", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(4, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
			},
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(arg.ID, repo.ID, 7, actor.ID, nil)
				row.State = arg.State
				row.ClosedAt = arg.ClosedAt
				return row, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		resp, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 7, UpdateLandingRequestInput{State: landingStringPtr("closed")})
		require.NoError(t, err)
		assert.Equal(t, "closed", q.lastUpdateLandingRequestArg.State)
		assert.Equal(t, "main", q.lastUpdateLandingRequestArg.TargetBookmark)
		assert.Equal(t, "feature", q.lastUpdateLandingRequestArg.SourceBookmark)
		assert.Equal(t, "clean", q.lastUpdateLandingRequestArg.ConflictStatus)
		assert.True(t, q.lastUpdateLandingRequestArg.ClosedAt.Valid)
		assert.Equal(t, "closed", resp.State)
	})

	t.Run("updates target/source bookmark and conflict status", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(5, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
			},
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(arg.ID, repo.ID, 7, actor.ID, nil)
				row.TargetBookmark = arg.TargetBookmark
				row.SourceBookmark = arg.SourceBookmark
				row.ConflictStatus = arg.ConflictStatus
				return row, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		resp, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 7, UpdateLandingRequestInput{
			TargetBookmark: landingStringPtr("release"),
			SourceBookmark: landingStringPtr("feature-v2"),
			ConflictStatus: landingStringPtr("conflicted"),
		})
		require.NoError(t, err)
		assert.Equal(t, "release", q.lastUpdateLandingRequestArg.TargetBookmark)
		assert.Equal(t, "feature-v2", q.lastUpdateLandingRequestArg.SourceBookmark)
		assert.Equal(t, "conflicted", q.lastUpdateLandingRequestArg.ConflictStatus)
		assert.Equal(t, "release", resp.TargetBookmark)
		assert.Equal(t, "conflicted", resp.ConflictStatus)
	})

	t.Run("rejects invalid conflict status", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(6, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 7, UpdateLandingRequestInput{
			ConflictStatus: landingStringPtr("broken"),
		})
		assert.Equal(t, 422, landingAPIStatus(t, err))
	})
}

func TestLandingService_LandLandingRequest_RequiresAdminOrOwnerAndEnqueues(t *testing.T) {
	t.Parallel()

	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 999, Valid: true}
	})
	actor := landingTestUser(10, "writer")

	t.Run("team write is forbidden", func(t *testing.T) {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "write", nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, 403, landingAPIStatus(t, err))
	})

	t.Run("owner enqueues and does not call repo host", func(t *testing.T) {
		ownerRepo := repo
		ownerRepo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return ownerRepo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(88, ownerRepo.ID, arg.Number, actor.ID, []string{"k-a", "k-b"}), nil
			},
			enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(arg.ID, ownerRepo.ID, 5, actor.ID, nil)
				row.State = "queued"
				row.TargetBookmark = "main"
				return row, nil
			},
			createLandingTaskFn: func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
				return db.LandingTask{
					ID:               100,
					LandingRequestID: arg.LandingRequestID,
					RepositoryID:     arg.RepositoryID,
					Status:           "pending",
					Priority:         arg.Priority,
					CreatedAt:        time.Now().UTC(),
					UpdatedAt:        time.Now().UTC(),
				}, nil
			},
			getLandingQueuePositionByTaskIDFn: func(ctx context.Context, id int64) (int64, error) {
				return 1, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "writer", LowerUsername: "writer"}, nil
			},
		}
		rh := &mockLandingRepoHostClient{}
		m := newObserveV2Metrics()
		svc := NewLandingService(q, rh, WithLandingMetrics(m))
		resp, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		require.NoError(t, err)
		assert.Equal(t, "queued", resp.State)
		assert.Equal(t, int64(1), resp.QueuePosition)
		assert.Equal(t, int64(100), resp.TaskID)
		assert.True(t, q.enqueueLandingRequestCalled)
		assert.True(t, q.createLandingTaskCalled)
		assert.Equal(t, "", rh.lastLandOwner)
		require.Equal(t, 1.0, testutil.ToFloat64(m.landing.WithLabelValues("queue")))
	})

	t.Run("rejects already queued landing request", func(t *testing.T) {
		ownerRepo := repo
		ownerRepo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return ownerRepo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(88, ownerRepo.ID, arg.Number, actor.ID, []string{"k-a"})
				row.State = "queued"
				return row, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, 409, landingAPIStatus(t, err))
	})

	t.Run("rejects merged landing request", func(t *testing.T) {
		ownerRepo := repo
		ownerRepo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return ownerRepo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(88, ownerRepo.ID, arg.Number, actor.ID, []string{"k-a"})
				row.State = "merged"
				return row, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, 409, landingAPIStatus(t, err))
	})
}

func TestLandingService_LandLandingRequest_ProtectedBookmarks(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	tests := []struct {
		name                  string
		targetBookmark        string
		protectedBookmarks    []db.ProtectedBookmark
		approvedReviews       int64
		expectStatus          int
		expectCountQueryCalls bool
	}{
		{
			name:                  "landing allowed when no protected bookmark matches",
			targetBookmark:        "main",
			protectedBookmarks:    []db.ProtectedBookmark{{Pattern: "release/*", RequireReview: true, RequireHumanApprovals: 1}},
			expectStatus:          0,
			expectCountQueryCalls: false,
		},
		{
			name:                  "landing blocked when protected bookmark requires review with zero approvals",
			targetBookmark:        "main",
			protectedBookmarks:    []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1}},
			approvedReviews:       0,
			expectStatus:          422,
			expectCountQueryCalls: true,
		},
		{
			name:                  "landing blocked when approvals less than required approvals",
			targetBookmark:        "release/2026",
			protectedBookmarks:    []db.ProtectedBookmark{{Pattern: "release/*", RequireReview: true, RequireHumanApprovals: 2}},
			approvedReviews:       1,
			expectStatus:          422,
			expectCountQueryCalls: true,
		},
		{
			name:                  "landing allowed when approvals meet required approvals",
			targetBookmark:        "release/2026",
			protectedBookmarks:    []db.ProtectedBookmark{{Pattern: "release/*", RequireReview: true, RequireHumanApprovals: 2}},
			approvedReviews:       2,
			expectStatus:          0,
			expectCountQueryCalls: true,
		},
		{
			name:                  "landing allowed when protected bookmark does not require review",
			targetBookmark:        "main",
			protectedBookmarks:    []db.ProtectedBookmark{{Pattern: "main", RequireReview: false, RequireHumanApprovals: 2}},
			expectStatus:          0,
			expectCountQueryCalls: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			countQueryCalls := 0
			landingID := int64(88)

			q := &mockLandingQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repo, nil
				},
				getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
					row := landingDBRequestWithChangeIDs(landingID, repo.ID, arg.Number, actor.ID, []string{"k-a", "k-b"})
					row.TargetBookmark = tc.targetBookmark
					return row, nil
				},
				listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
					return tc.protectedBookmarks, nil
				},
				countApprovedLandingRequestReviewsFn: func(ctx context.Context, landingRequestID int64) (int64, error) {
					countQueryCalls++
					return tc.approvedReviews, nil
				},
				enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
					row := landingDBRequest(arg.ID, repo.ID, 5, actor.ID, nil)
					row.State = "queued"
					row.TargetBookmark = tc.targetBookmark
					return row, nil
				},
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
				},
			}
			rh := &mockLandingRepoHostClient{}

			svc := NewLandingService(q, rh)
			resp, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
			if tc.expectStatus != 0 {
				assert.Equal(t, tc.expectStatus, landingAPIStatus(t, err))
				assert.False(t, q.enqueueLandingRequestCalled)
			} else {
				require.NoError(t, err)
				assert.Equal(t, "queued", resp.State)
				assert.True(t, q.enqueueLandingRequestCalled)
				assert.Equal(t, "", rh.lastLandOwner)
			}

			assert.Equal(t, repo.ID, q.lastListAllProtectedBookmarksRepoID)
			if tc.expectCountQueryCalls {
				expectedCalls := 1
				if tc.expectStatus == 0 {
					expectedCalls = 2 // gate evaluation plus response readiness mapping
				}
				assert.Equal(t, expectedCalls, countQueryCalls)
				assert.Equal(t, landingID, q.lastCountApprovedLandingRequestReviewsID)
			} else {
				assert.Equal(t, 0, countQueryCalls)
			}
		})
	}
}

func TestLandingService_ReviewCommentAndChangesMethods(t *testing.T) {
	t.Parallel()

	// actor is the reviewer; the landing request is authored by a different user.
	actor := landingTestUser(1, "alice")
	author := landingTestUser(99, "lrauthor")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	fulfilled := false
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			// LR is authored by a different user so that actor can approve.
			return landingDBRequestWithChangeIDs(9, repo.ID, arg.Number, author.ID, []string{"k1"}), nil
		},
		fulfillLandingReviewRequestsForUserFn: func(_ context.Context, arg db.FulfillLandingReviewRequestsForUserParams) error {
			fulfilled = true
			assert.Equal(t, int64(9), arg.LandingRequestID)
			assert.Equal(t, actor.ID, arg.ReviewerID.Int64)
			return nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	reviews, totalReviews, err := svc.ListLandingReviews(context.Background(), actor, "alice", "demo", 9, 1, 30)
	require.NoError(t, err)
	require.Len(t, reviews, 1)
	assert.Equal(t, int64(1), totalReviews)
	assert.Equal(t, int32(30), q.lastListLandingRequestReviewsArg.PageSize)
	assert.Equal(t, int32(0), q.lastListLandingRequestReviewsArg.PageOffset)

	createdReview, err := svc.CreateLandingReview(context.Background(), actor, "alice", "demo", 9, CreateLandingReviewInput{
		CommitID: "commit-1",
		Type:     "approve",
		Body:     "looks good",
	})
	require.NoError(t, err)
	assert.Equal(t, "approve", createdReview.Type)
	assert.Equal(t, "approve", q.lastCreateLandingRequestReviewArg.Type)
	assert.Equal(t, "human", q.lastCreateLandingRequestReviewArg.ReviewerKind)
	assert.JSONEq(t, `{"k1":{"commit_id":"commit-1","seq":1}}`, string(q.lastCreateLandingRequestReviewArg.ChangeRevisions))
	assert.True(t, fulfilled)

	comments, totalComments, err := svc.ListLandingComments(context.Background(), actor, "alice", "demo", 9, 2, 10)
	require.NoError(t, err)
	require.Len(t, comments, 1)
	assert.Equal(t, int64(1), totalComments)
	assert.Equal(t, int32(10), q.lastListLandingRequestCommentsArg.PageSize)
	assert.Equal(t, int32(10), q.lastListLandingRequestCommentsArg.PageOffset)
	assert.Equal(t, "user-2", comments[0].UserLogin)

	createdComment, err := svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 9, CreateLandingCommentInput{
		CommitID: "commit-1",
		Side:     "left",
		Body:     "nit",
	})
	require.NoError(t, err)
	assert.Equal(t, "left", createdComment.Side)
	assert.Equal(t, "alice", createdComment.UserLogin)
	assert.Equal(t, "left", q.lastCreateLandingRequestCommentArg.Side)

	changes, totalChanges, err := svc.ListLandingChanges(context.Background(), actor, "alice", "demo", 9, 1, 20)
	require.NoError(t, err)
	require.Len(t, changes, 1)
	assert.Equal(t, int64(1), totalChanges)
	assert.Equal(t, int32(20), q.lastListLandingRequestChangesArg.PageSize)
	assert.Equal(t, int32(0), q.lastListLandingRequestChangesArg.PageOffset)
}

func TestLandingService_ReviewThreadLifecycle(t *testing.T) {
	author := landingTestUser(1, "author")
	reviewer := landingTestUser(2, "reviewer")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: author.ID, Valid: true}
	})
	landingRow := landingDBRequestWithChangeIDs(41, repo.ID, 9, author.ID, []string{"base-change", "tip-change"})
	thread := db.LandingRequestComment{
		ID:                 7,
		LandingRequestID:   landingRow.ID,
		UserID:             pgtype.Int8{Int64: reviewer.ID, Valid: true},
		Path:               "internal/service.go",
		Line:               12,
		Side:               "right",
		Body:               "please fix",
		State:              "open",
		ResolvedInRevision: json.RawMessage(`null`),
	}
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepoUserFn: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			if arg.UserID.Int64 == reviewer.ID {
				return "write", nil
			}
			return "", nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingRow, nil
		},
		getLandingRequestCommentByIDFn: func(_ context.Context, arg db.GetLandingRequestCommentByIDParams) (db.LandingRequestComment, error) {
			assert.Equal(t, thread.ID, arg.ID)
			assert.Equal(t, landingRow.ID, arg.LandingRequestID)
			return thread, nil
		},
		markLandingRequestThreadDoneFn: func(_ context.Context, arg db.MarkLandingRequestThreadDoneParams) (db.LandingRequestComment, error) {
			assert.Equal(t, author.ID, arg.DoneBy.Int64)
			require.JSONEq(t, `{"commit_id":"tip-commit","seq":5}`, string(arg.ResolvedInRevision))
			thread.State = "done"
			thread.DoneBy = arg.DoneBy
			thread.ResolvedInRevision = arg.ResolvedInRevision
			return thread, nil
		},
		ackLandingRequestThreadFn: func(_ context.Context, arg db.AckLandingRequestThreadParams) (db.LandingRequestComment, error) {
			assert.Equal(t, reviewer.ID, arg.ResolvedBy.Int64)
			thread.State = "resolved"
			thread.ResolvedBy = arg.ResolvedBy
			return thread, nil
		},
		reopenLandingRequestThreadFn: func(_ context.Context, arg db.ReopenLandingRequestThreadParams) (db.LandingRequestComment, error) {
			thread.State = "open"
			thread.DoneBy = pgtype.Int8{}
			thread.ResolvedBy = pgtype.Int8{}
			thread.ResolvedInRevision = json.RawMessage(`null`)
			return thread, nil
		},
		listChangeRevisionsFn: func(_ context.Context, arg db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, "tip-change", arg.ChangeID)
			return []db.ChangeRevision{{RepositoryID: repo.ID, ChangeID: arg.ChangeID, Seq: 5, CommitID: "tip-commit"}}, nil
		},
	}
	rh := &mockLandingRepoHostClient{}
	svc := NewLandingService(q, rh)

	done, err := svc.MarkLandingThreadDone(context.Background(), author, "author", "demo", 9, thread.ID)
	require.NoError(t, err)
	assert.Equal(t, "done", done.State)
	require.JSONEq(t, `{"commit_id":"tip-commit","seq":5}`, string(done.ResolvedInRevision))

	resolved, err := svc.AckLandingThread(context.Background(), reviewer, "author", "demo", 9, thread.ID)
	require.NoError(t, err)
	assert.Equal(t, "resolved", resolved.State)

	reopened, err := svc.ReopenLandingThread(context.Background(), author, "author", "demo", 9, thread.ID)
	require.NoError(t, err)
	assert.Equal(t, "open", reopened.State)
	assert.JSONEq(t, `null`, string(reopened.ResolvedInRevision))
}

func TestLandingService_ReviewThreadAuthorizationAndTransitions(t *testing.T) {
	author := landingTestUser(1, "author")
	reviewer := landingTestUser(2, "reviewer")
	other := landingTestUser(3, "other")
	repo := landingRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: author.ID, Valid: true} })
	landingRow := landingDBRequestWithChangeIDs(41, repo.ID, 9, author.ID, []string{"tip"})
	thread := db.LandingRequestComment{ID: 7, LandingRequestID: landingRow.ID, UserID: pgtype.Int8{Int64: reviewer.ID, Valid: true}, State: "open"}
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getCollaboratorPermissionForRepoUserFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "write", nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingRow, nil
		},
		getLandingRequestCommentByIDFn: func(context.Context, db.GetLandingRequestCommentByIDParams) (db.LandingRequestComment, error) {
			return thread, nil
		},
		markLandingRequestThreadDoneFn: func(context.Context, db.MarkLandingRequestThreadDoneParams) (db.LandingRequestComment, error) {
			return db.LandingRequestComment{}, pgx.ErrNoRows
		},
		listChangeRevisionsFn: func(context.Context, db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
			return []db.ChangeRevision{{RepositoryID: repo.ID, ChangeID: "tip", Seq: 1, CommitID: "commit"}}, nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	_, err := svc.MarkLandingThreadDone(context.Background(), reviewer, "author", "demo", 9, thread.ID)
	assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	_, err = svc.AckLandingThread(context.Background(), other, "author", "demo", 9, thread.ID)
	assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	_, err = svc.ReopenLandingThread(context.Background(), other, "author", "demo", 9, thread.ID)
	assert.Equal(t, http.StatusForbidden, landingAPIStatus(t, err))
	_, err = svc.MarkLandingThreadDone(context.Background(), author, "author", "demo", 9, thread.ID)
	assert.Equal(t, http.StatusConflict, landingAPIStatus(t, err))
}

func TestLandingService_LandBlockedByUnresolvedThreads(t *testing.T) {
	actor := landingTestUser(1, "author")
	repo := landingRepo(nil)
	landingRow := landingDBRequestWithChangeIDs(41, repo.ID, 9, actor.ID, []string{"tip"})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingRow, nil
		},
		countUnresolvedLandingRequestThreadsFn: func(_ context.Context, landingRequestID int64) (int64, error) {
			assert.Equal(t, landingRow.ID, landingRequestID)
			return 2, nil
		},
	}

	_, err := NewLandingService(q, &mockLandingRepoHostClient{}).LandLandingRequest(context.Background(), actor, "author", "demo", 9, LandLandingRequestInput{CommitID: "tip"})
	var apiErr *errors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
	assert.Equal(t, errors.CodeLandingBlocked, apiErr.Code)
	details, ok := apiErr.Details.(LandingBlockedDetails)
	require.True(t, ok)
	require.Equal(t, []LandingOwnerBlock{{Kind: "thread", Count: 2}}, details.BlockedBy)
	assert.False(t, q.enqueueLandingRequestCalled)
}

func TestLandingService_CreateAgentReviewRecordsCurrentCommit(t *testing.T) {
	t.Parallel()

	agent := landingTestUser(10, "codex-reviewer")
	agent.UserType = "bot"
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: agent.ID, Valid: true}
	})
	fulfilled := 0
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(44, repo.ID, 9, 99, []string{"change-1"}), nil
		},
		fulfillLandingReviewRequestsForAgentFn: func(_ context.Context, arg db.FulfillLandingReviewRequestsForAgentParams) error {
			fulfilled++
			assert.Equal(t, int64(44), arg.LandingRequestID)
			assert.Equal(t, "codex-reviewer", arg.AgentName)
			return nil
		},
	}
	rh := &mockLandingRepoHostClient{getChangeFn: func(context.Context, string, string, string) (repohost.Change, error) {
		return repohost.Change{ChangeID: "change-1", CommitID: "commit-current"}, nil
	}}

	review, err := NewLandingService(q, rh).CreateLandingReview(context.Background(), agent, "alice", "demo", 9, CreateLandingReviewInput{
		Verdict:          "lgtm",
		ConfidenceBucket: "medium",
		Summary:          "The current revision is safe to land.",
		CommitID:         "commit-current",
	})
	require.NoError(t, err)
	assert.Equal(t, "agent", review.ReviewerKind)
	assert.Equal(t, "approve", review.Type)
	assert.Equal(t, "lgtm", review.Verdict.String)
	assert.Equal(t, "medium", review.ConfidenceBucket.String)
	assert.Equal(t, "The current revision is safe to land.", review.Summary)
	assert.Equal(t, "commit-current", review.CommitID)
	assert.JSONEq(t, `{"change-1":{"commit_id":"commit-current","seq":1}}`, string(review.ChangeRevisions))
	assert.Equal(t, 1, fulfilled)

	_, err = NewLandingService(q, rh).CreateLandingReview(context.Background(), agent, "alice", "demo", 9, CreateLandingReviewInput{
		Verdict:          "lgtm",
		ConfidenceBucket: "high",
		Summary:          "Reviewed an old revision.",
		CommitID:         "commit-stale",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))

	q.getLandingRequestWithChangeIDsByNumberFn = func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return landingDBRequestWithChangeIDs(44, repo.ID, 9, agent.ID, []string{"change-1"}), nil
	}
	_, err = NewLandingService(q, rh).CreateLandingReview(context.Background(), agent, "alice", "demo", 9, CreateLandingReviewInput{
		Verdict:          "lgtm",
		ConfidenceBucket: "high",
		Summary:          "Reviewing my own landing.",
		CommitID:         "commit-current",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))
}

func TestLandingService_LandLandingRequest_ReportsIndependentReviewBlocks(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, repo.ID, 5, 99, []string{"change-1", "change-2"}), nil
		},
		listAllProtectedBookmarksByRepoFn: func(context.Context, int64) ([]db.ProtectedBookmark, error) {
			return []db.ProtectedBookmark{{Pattern: "main", RequireReview: true, RequireHumanApprovals: 1, RequireAgentLgtm: true}}, nil
		},
		countApprovedLandingRequestReviewsFn: func(context.Context, int64) (int64, error) { return 0, nil },
		countCurrentAgentLandingReviewCommitsFn: func(context.Context, db.CountCurrentAgentLandingReviewCommitsParams) (int64, error) {
			return 0, nil
		},
		getLandingRevisionByCommitIDFn: func(_ context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error) {
			return db.ChangeRevision{RepositoryID: arg.RepositoryID, ChangeID: "change-1", CommitID: arg.CommitID, Seq: 1}, nil
		},
	}
	rh := &mockLandingRepoHostClient{getChangeFn: func(_ context.Context, _, _, changeID string) (repohost.Change, error) {
		return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID}, nil
	}}

	_, err := NewLandingService(q, rh).LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "commit-change-1"})
	var apiErr *errors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, errors.CodeLandingBlocked, apiErr.Code)
	details, ok := apiErr.Details.(LandingBlockedDetails)
	require.True(t, ok)
	assert.Equal(t, []LandingOwnerBlock{
		{Kind: "review", Missing: "human_approval", Count: 1},
		{Kind: "review", Missing: "agent_lgtm"},
	}, details.BlockedBy)
}

func TestLandingService_ValidationFailuresForReviewAndCommentInputs(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(9, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	_, err := svc.CreateLandingReview(context.Background(), actor, "alice", "demo", 9, CreateLandingReviewInput{
		CommitID: "commit-1",
		Type:     "not-real",
		Body:     "x",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))

	_, err = svc.CreateLandingReview(context.Background(), actor, "alice", "demo", 9, CreateLandingReviewInput{
		CommitID: "commit-1",
		Type:     "comment",
		Body:     " ",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))

	_, err = svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 9, CreateLandingCommentInput{
		CommitID: "commit-1",
		Path:     "README.md",
		Line:     -1,
		Side:     "right",
		Body:     "x",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))

	_, err = svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 9, CreateLandingCommentInput{
		CommitID: "commit-1",
		Path:     "README.md",
		Line:     1,
		Side:     "center",
		Body:     "x",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))

	_, err = svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 9, CreateLandingCommentInput{
		CommitID: "commit-1",
		Path:     "",
		Line:     0,
		Side:     "right",
		Body:     " ",
	})
	assert.Equal(t, 422, landingAPIStatus(t, err))
}

func TestLandingService_GetLandingConflicts_ReturnsConsistentPayload(t *testing.T) {
	t.Parallel()

	type ctxKey string

	viewer := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: viewer.ID, Valid: true}
	})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			row := landingDBRequestWithChangeIDs(31, repo.ID, arg.Number, viewer.ID, []string{"k-a", "k-b"})
			row.ConflictStatus = "conflicted"
			return row, nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeConflictsFn: func(ctx context.Context, owner, repo, changeID string) ([]repohost.Conflict, error) {
			if changeID == "k-a" {
				return []repohost.Conflict{{FilePath: "README.md", ConflictType: "both_modified"}}, nil
			}
			return []repohost.Conflict{}, nil
		},
	}
	svc := NewLandingService(q, rh)

	ctx := context.WithValue(context.Background(), ctxKey("trace_id"), "trace-conflicts")
	resp, err := svc.GetLandingConflicts(ctx, viewer, "alice", "demo", 31)
	require.NoError(t, err)
	assert.Equal(t, "conflicted", resp.ConflictStatus)
	assert.True(t, resp.HasConflicts)
	assert.Contains(t, resp.ConflictsByChange, "k-a")
	assert.Len(t, rh.conflictCalls, 2)
	for _, callCtx := range rh.conflictCallCtxs {
		assert.Equal(t, "trace-conflicts", callCtx.Value(ctxKey("trace_id")))
	}
}

func TestLandingService_DispatchesLandingRequestWebhookOnCreate(t *testing.T) {
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 77
		r.Name = "demo"
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	dispatcher := &mockLandingDispatcher{}

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
			row := landingDBRequest(7, repo.ID, 9, actor.ID, nil)
			row.State = "open"
			row.StackSize = arg.StackSize
			return row, nil
		},
		addLandingRequestChangeFn: func(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
			return db.LandingRequestChange{ID: arg.PositionInStack, LandingRequestID: arg.LandingRequestID, ChangeID: arg.ChangeID}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}

	svc := NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(dispatcher))
	_, err := svc.CreateLandingRequest(context.Background(), actor, "alice", "demo", CreateLandingRequestInput{
		Title:          "Landing",
		Body:           "details",
		TargetBookmark: "main",
		SourceBookmark: "feature",
		ChangeIDs:      []string{"k1", "k2"},
	})
	require.NoError(t, err)

	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, repo.ID, dispatcher.calls[0].repoID)
	assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)
	payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
	require.True(t, ok)
	assert.Equal(t, "opened", payload.Action)
	assert.Equal(t, []string{"k1", "k2"}, payload.LandingRequest.ChangeIDs)
	assert.Equal(t, "main", payload.LandingRequest.TargetBookmark)
}

func TestLandingService_DispatchesLandingRequestWebhookOnCloseAndLand(t *testing.T) {
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 88
		r.Name = "demo"
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	landingID := int64(30)

	buildQuerier := func() *mockLandingQuerier {
		return &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(landingID, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
			},
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(landingID, repo.ID, 11, actor.ID, nil)
				row.State = arg.State
				return row, nil
			},
			enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(landingID, repo.ID, 11, actor.ID, nil)
				row.State = "queued"
				return row, nil
			},
			createLandingTaskFn: func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
				return db.LandingTask{ID: 100, LandingRequestID: arg.LandingRequestID, RepositoryID: arg.RepositoryID}, nil
			},
			getLandingQueuePositionByTaskIDFn: func(ctx context.Context, id int64) (int64, error) {
				return 1, nil
			},
			listAllProtectedBookmarksByRepoFn: func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
				return nil, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
		}
	}

	t.Run("closed action", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{}
		svc := NewLandingService(buildQuerier(), &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(dispatcher))

		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 11, UpdateLandingRequestInput{
			State: landingStringPtr("closed"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 1)
		assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)

		payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
		require.True(t, ok)
		assert.Equal(t, "closed", payload.Action)
	})

	t.Run("queued action", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{}
		svc := NewLandingService(buildQuerier(), &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(dispatcher))

		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 11, LandLandingRequestInput{CommitID: "k1"})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 1)
		assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)

		payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
		require.True(t, ok)
		// "queued" is dispatched when enqueued; "landed" is dispatched only after merge.
		assert.Equal(t, "queued", payload.Action)
	})
}

func TestLandingService_UpdateLandingRequest_DispatchesConflictEvent(t *testing.T) {
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 90
		r.Name = "demo"
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	landingID := int64(31)
	buildService := func(currentConflictStatus string, dispatcher *mockLandingDispatcher) *LandingService {
		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(landingID, repo.ID, arg.Number, actor.ID, []string{"k1"})
				row.ConflictStatus = currentConflictStatus
				return row, nil
			},
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(landingID, repo.ID, 12, actor.ID, nil)
				row.Title = arg.Title
				row.ConflictStatus = arg.ConflictStatus
				return row, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
		}
		return NewLandingService(q, &mockLandingRepoHostClient{}, WithLandingWebhookDispatcher(dispatcher))
	}

	t.Run("clean to conflicted dispatches conflict event", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{}
		svc := buildService("clean", dispatcher)

		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 12, UpdateLandingRequestInput{
			ConflictStatus: landingStringPtr("conflicted"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 2)
		assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)
		assert.Equal(t, webhooks.EventTypeLandingConflict, dispatcher.calls[1].eventType)

		payload, ok := dispatcher.calls[1].payload.(webhooks.LandingConflictEventPayload)
		require.True(t, ok)
		assert.Equal(t, "conflicted", payload.Action)
		assert.Equal(t, "clean", payload.PreviousStatus)
		assert.Equal(t, "conflicted", payload.LandingRequest.ConflictStatus)
		assert.Equal(t, repo.ID, payload.Repository.ID)
		assert.Equal(t, actor.ID, payload.Sender.ID)
	})

	t.Run("conflicted to clean dispatches resolved action", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{}
		svc := buildService("conflicted", dispatcher)

		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 12, UpdateLandingRequestInput{
			ConflictStatus: landingStringPtr("clean"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 2)
		assert.Equal(t, webhooks.EventTypeLandingConflict, dispatcher.calls[1].eventType)

		payload, ok := dispatcher.calls[1].payload.(webhooks.LandingConflictEventPayload)
		require.True(t, ok)
		assert.Equal(t, "resolved", payload.Action)
		assert.Equal(t, "conflicted", payload.PreviousStatus)
		assert.Equal(t, "clean", payload.LandingRequest.ConflictStatus)
	})

	t.Run("same conflict status does not dispatch conflict event", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{}
		svc := buildService("clean", dispatcher)

		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 12, UpdateLandingRequestInput{
			ConflictStatus: landingStringPtr("clean"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 1)
		assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)
	})

	t.Run("other edit without conflict status does not dispatch conflict event", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{}
		svc := buildService("conflicted", dispatcher)

		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 12, UpdateLandingRequestInput{
			Title: landingStringPtr("updated title"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 1)
		assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)
	})

	t.Run("conflict dispatch failure returns internal error", func(t *testing.T) {
		dispatcher := &mockLandingDispatcher{
			dispatchFn: func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
				if eventType == webhooks.EventTypeLandingConflict {
					return assert.AnError
				}
				return nil
			},
		}
		svc := buildService("clean", dispatcher)

		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 12, UpdateLandingRequestInput{
			ConflictStatus: landingStringPtr("conflicted"),
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, landingAPIStatus(t, err))
		require.Len(t, dispatcher.calls, 2)
		assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)
		assert.Equal(t, webhooks.EventTypeLandingConflict, dispatcher.calls[1].eventType)
	})
}

func TestLandingService_DispatchesReviewAndCommentWebhookEvents(t *testing.T) {
	actor := landingTestUser(1, "alice")
	lrAuthor := landingTestUser(77, "bob") // different from actor so approve is allowed
	repo := landingRepo(func(r *db.Repository) {
		r.ID = 99
		r.Name = "demo"
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	landingRow := landingDBRequestWithChangeIDs(41, repo.ID, 12, lrAuthor.ID, []string{"k1", "k2"})
	dispatcher := &mockLandingDispatcher{}

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingRow, nil
		},
		createLandingRequestReviewFn: func(ctx context.Context, arg db.CreateLandingRequestReviewParams) (db.LandingRequestReview, error) {
			return db.LandingRequestReview{
				ID:               5,
				LandingRequestID: arg.LandingRequestID,
				ReviewerID:       arg.ReviewerID,
				Type:             arg.Type,
				Body:             arg.Body,
				State:            "submitted",
				CommitID:         arg.CommitID,
			}, nil
		},
		createLandingRequestCommentFn: func(ctx context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error) {
			return db.LandingRequestComment{
				ID:               7,
				LandingRequestID: arg.LandingRequestID,
				UserID:           arg.UserID,
				Path:             arg.Path,
				Line:             arg.Line,
				Side:             arg.Side,
				Body:             arg.Body,
				CommitID:         arg.CommitID,
				AnchorHash:       arg.AnchorHash,
			}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}

	repoHost := &mockLandingRepoHostClient{
		getChangeFn: func(_ context.Context, _, _, ref string) (repohost.Change, error) {
			return repohost.Change{ChangeID: "k1", CommitID: "commit-1"}, nil
		},
		getChangeDiffFn: func(_ context.Context, _, _, ref string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{ChangeID: "k1", FileDiffs: []repohost.FileDiff{{Path: "README.md", ChangeType: "added"}}}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, filePath string) (repohost.FileContent, error) {
			return repohost.FileContent{Path: filePath, Content: "first\nsecond\n"}, nil
		},
	}
	svc := NewLandingService(q, repoHost, WithLandingWebhookDispatcher(dispatcher))

	_, err := svc.CreateLandingReview(context.Background(), actor, "alice", "demo", 12, CreateLandingReviewInput{
		CommitID: "commit-1",
		Type:     "approve",
		Body:     "looks good",
	})
	require.NoError(t, err)

	_, err = svc.CreateLandingComment(context.Background(), actor, "alice", "demo", 12, CreateLandingCommentInput{
		CommitID: "commit-1",
		Path:     "README.md",
		Line:     2,
		Side:     "right",
		Body:     "nit",
	})
	require.NoError(t, err)

	require.Len(t, dispatcher.calls, 2)
	assert.Equal(t, webhooks.EventTypeLandingRequestReview, dispatcher.calls[0].eventType)
	assert.Equal(t, webhooks.EventTypeLandingRequestComment, dispatcher.calls[1].eventType)

	reviewPayload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestReviewEventPayload)
	require.True(t, ok)
	assert.Equal(t, "submitted", reviewPayload.Action)
	assert.Equal(t, "approve", reviewPayload.Review.Type)
	assert.Equal(t, "commit-1", reviewPayload.Review.CommitID)

	commentPayload, ok := dispatcher.calls[1].payload.(webhooks.LandingRequestCommentEventPayload)
	require.True(t, ok)
	assert.Equal(t, "created", commentPayload.Action)
	assert.Equal(t, "README.md", commentPayload.Comment.Path)
	assert.Equal(t, "commit-1", commentPayload.Comment.CommitID)
	assert.Len(t, commentPayload.Comment.AnchorHash, 64)
}

func TestLandingService_DismissLandingReview_UpdatesStateAndRequiresAuth(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	landingID := int64(41)
	reviewID := int64(7)

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(landingID, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
		},
		getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
			return db.LandingRequestReview{
				ID:               id,
				LandingRequestID: landingID,
				ReviewerID:       pgtype.Int8{Int64: actor.ID, Valid: true},
				Type:             "approve",
				Body:             "looks good",
				State:            "submitted",
			}, nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	// Unauthenticated actor should return 401.
	_, err := svc.DismissLandingReview(context.Background(), nil, "alice", "demo", 12, reviewID, DismissLandingReviewInput{})
	assert.Equal(t, 401, landingAPIStatus(t, err))

	// Successful dismiss.
	updated, err := svc.DismissLandingReview(context.Background(), actor, "alice", "demo", 12, reviewID, DismissLandingReviewInput{})
	require.NoError(t, err)
	assert.Equal(t, "dismissed", updated.State)
}

func TestLandingService_DismissLandingReview_ReviewNotFound(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	landingID := int64(41)

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(landingID, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
		},
		getLandingRequestReviewByIDFn: func(ctx context.Context, id int64) (db.LandingRequestReview, error) {
			// Simulate: review belongs to a different landing request.
			return db.LandingRequestReview{
				ID:               id,
				LandingRequestID: 999, // different landing request
				ReviewerID:       pgtype.Int8{Int64: actor.ID, Valid: true},
				Type:             "approve",
				State:            "submitted",
			}, nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	_, err := svc.DismissLandingReview(context.Background(), actor, "alice", "demo", 12, 7, DismissLandingReviewInput{})
	assert.Equal(t, 404, landingAPIStatus(t, err))
}

func TestLandingService_GetLandingDiff_AggregatesPerChangeDiffs(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	changeIDs := []string{"k1", "k2"}

	diffCalls := []string{}
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(41, repo.ID, arg.Number, actor.ID, changeIDs), nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			diffCalls = append(diffCalls, changeID)
			return repohost.ChangeDiff{ChangeID: changeID, FileDiffs: []repohost.FileDiff{{Path: "README.md", ChangeType: "modified", OldContent: "before line\n", NewContent: "after line\n"}}}, nil
		},
		getChangeFn: func(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
			return repohost.Change{ChangeID: changeID, ParentChangeIDs: []string{"parent-" + changeID}}, nil
		},
		getFileAtChangeFn: func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			content := "before line\n"
			if changeID == "k1" {
				content = "after line\n"
			}
			if changeID == "k2" {
				content = "second change\n"
			}
			if strings.HasPrefix(changeID, "parent-") {
				content = "before line\n"
			}
			return repohost.FileContent{Path: path, Content: content}, nil
		},
	}
	svc := NewLandingService(q, rh)

	resp, err := svc.GetLandingDiff(context.Background(), actor, "alice", "demo", 12, LandingDiffOptions{})
	require.NoError(t, err)

	// Should call GetChangeDiff for each change ID in the landing request.
	assert.Len(t, resp.Changes, 2)
	assert.Equal(t, "k1", resp.Changes[0].ChangeID)
	assert.Equal(t, "k2", resp.Changes[1].ChangeID)
	assert.Len(t, resp.Changes[0].FileDiffs, 1)
	assert.Equal(t, "README.md", resp.Changes[0].FileDiffs[0].Path)
	assert.NotEmpty(t, resp.Changes[0].FileDiffs[0].Patch)
	assert.Equal(t, "markdown", resp.Changes[0].FileDiffs[0].Language)
	// Verify diff calls were made for each change in stack order.
	assert.Equal(t, []string{"k1", "k2"}, diffCalls)
}

func TestLandingService_OpenLandingReadsCurrentHeadWithoutRecordedRevision(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) { r.IsPublic = true })
	landing := landingDBRequestWithChangeIDs(41, repo.ID, 9, actor.ID, []string{"live-change"})
	landing.State = landingStateOpen
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landing, nil
		},
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{ChangeID: "live-change"}}, nil
		},
		listChangeRevisionsFn: func(context.Context, db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
			t.Fatal("an open request must not require retained landing history")
			return nil, nil
		},
	}
	head := "first-commit"
	rh := &mockLandingRepoHostClient{
		getChangeFn: func(_ context.Context, _, _, id string) (repohost.Change, error) {
			assert.Equal(t, "live-change", id)
			return repohost.Change{ChangeID: id, CommitID: head, Description: head, AuthorName: "alice", Timestamp: "2026-09-21T10:00:00Z"}, nil
		},
		getChangeDiffFn: func(_ context.Context, _, _, id string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{ChangeID: id}, nil
		},
		getRevisionDiffFn: func(context.Context, string, string, string, string, string, string) (repohost.ChangeDiff, error) {
			t.Fatal("an open diff must still follow the current head")
			return repohost.ChangeDiff{}, nil
		},
	}
	svc := NewLandingService(q, rh)
	for _, commit := range []string{"first-commit", "amended-commit"} {
		head = commit
		changes, _, err := svc.ListLandingChanges(context.Background(), actor, "alice", "demo", 9, 1, 20)
		require.NoError(t, err)
		require.Len(t, changes, 1)
		assert.Equal(t, commit, changes[0].CommitID)
		assert.Equal(t, commit, changes[0].Description)
		_, err = svc.GetLandingDiff(context.Background(), actor, "alice", "demo", 9, LandingDiffOptions{})
		require.NoError(t, err)
	}
}

func TestLandingService_GetLandingDiff_MergedLandingUsesRetainedLandedRevision(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) { r.IsPublic = true; r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	landing := landingDBRequestWithChangeIDs(41, repo.ID, 9, actor.ID, []string{"dead-change"})
	landing.State = landingStateMerged
	landing.LandedRevisions = json.RawMessage(`{"dead-change":{"commit_id":"retained-commit","seq":2}}`)
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landing, nil
		},
		listChangeRevisionsFn: func(context.Context, db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
			return []db.ChangeRevision{{RepositoryID: repo.ID, ChangeID: "dead-change", Seq: 1, CommitID: "old", ParentCommitID: "base"}, {RepositoryID: repo.ID, ChangeID: "dead-change", Seq: 2, CommitID: "retained-commit", ParentCommitID: "retained-parent"}, {RepositoryID: repo.ID, ChangeID: "dead-change", Seq: 3, CommitID: "newer-unrelated", ParentCommitID: "newer-parent"}}, nil
		},
	}
	var gotFrom, gotTo string
	rh := &mockLandingRepoHostClient{getRevisionDiffFn: func(_ context.Context, _, _, changeID, fromCommitID, toCommitID, _ string) (repohost.ChangeDiff, error) {
		gotFrom, gotTo = fromCommitID, toCommitID
		return repohost.ChangeDiff{ChangeID: changeID}, nil
	}}
	resp, err := NewLandingService(q, rh).GetLandingDiff(context.Background(), actor, "alice", "demo", 9, LandingDiffOptions{})
	require.NoError(t, err)
	require.Len(t, resp.Changes, 1)
	assert.Equal(t, "retained-parent", gotFrom)
	assert.Equal(t, "retained-commit", gotTo)
}

func TestLandingService_GetLandingDiff_MergedLandingWithoutRetainedPinRefusesLatestRevision(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) { r.IsPublic = true })
	landing := landingDBRequestWithChangeIDs(41, repo.ID, 9, actor.ID, []string{"dead-change"})
	landing.State = landingStateMerged
	q := &mockLandingQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil }, getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
		return landing, nil
	}}
	_, err := NewLandingService(q, &mockLandingRepoHostClient{}).GetLandingDiff(context.Background(), actor, "alice", "demo", 9, LandingDiffOptions{})
	assert.Equal(t, http.StatusNotFound, landingAPIStatus(t, err))
}

func TestLandingService_GetLandingDiff_RepoHostError(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(41, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{}, fmt.Errorf("repo-host: connection refused")
		},
	}
	svc := NewLandingService(q, rh)

	_, err := svc.GetLandingDiff(context.Background(), actor, "alice", "demo", 12, LandingDiffOptions{})
	require.Error(t, err)
	// Internal error when repo-host is unavailable.
	assert.Equal(t, 500, landingAPIStatus(t, err))
}

func TestLandingService_GetLandingDiff_RepoHostReturns404(t *testing.T) {
	t.Parallel()

	// When repo-host returns a 404 status for a change (e.g., change not found),
	// the service should map it to a 404 NotFound error.
	actor := landingTestUser(1, "alice")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(41, repo.ID, arg.Number, actor.ID, []string{"k1"}), nil
		},
	}
	rh := &mockLandingRepoHostClient{
		getChangeDiffFn: func(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
			// Simulate repo-host returning a 404 for the change ID.
			// The error message format must match extractRepoHostStatusCode's marker.
			return repohost.ChangeDiff{}, fmt.Errorf("repo-host returned status 404 change not found")
		},
	}
	svc := NewLandingService(q, rh)

	_, err := svc.GetLandingDiff(context.Background(), actor, "alice", "demo", 12, LandingDiffOptions{})
	require.Error(t, err)
	// Should surface as 404 NotFound (change doesn't exist in repo-host).
	assert.Equal(t, 404, landingAPIStatus(t, err))
}

// --- Workflow integration tests ---

type mockLandingWorkflowRunService struct {
	dispatchForEventFn func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	dispatchCalls      []DispatchForEventInput
}

func (m *mockLandingWorkflowRunService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.dispatchCalls = append(m.dispatchCalls, input)
	if m.dispatchForEventFn != nil {
		return m.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}

func (m *mockLandingWorkflowRunService) CancelRun(ctx context.Context, repositoryID, runID int64) error {
	return nil
}

func (m *mockLandingWorkflowRunService) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	return &WorkflowRunResult{WorkflowRunID: 999, WorkflowDefinitionID: input.RepositoryID}, nil
}

func (m *mockLandingWorkflowRunService) ResumeRun(_ context.Context, _, _ int64) error {
	return nil
}

func TestLandingService_CreateLandingRequest_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "actor")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
			return landingDBRequest(91, repo.ID, 7, arg.AuthorID, nil), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "actor", LowerUsername: "actor"}, nil
		},
	}

	wfRunSvc := &mockLandingWorkflowRunService{}
	svc := NewLandingService(q, &mockLandingRepoHostClient{},
		WithLandingWorkflowRunService(wfRunSvc),
	)

	_, err := svc.CreateLandingRequest(context.Background(), actor, "alice", "demo", CreateLandingRequestInput{
		Title:          "test landing",
		TargetBookmark: "main",
		ChangeIDs:      []string{"k1"},
	})
	require.NoError(t, err)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	assert.Equal(t, repo.ID, wfRunSvc.dispatchCalls[0].RepositoryID)
	assert.Equal(t, "landing_request", wfRunSvc.dispatchCalls[0].Event.Type)
	assert.Equal(t, "opened", wfRunSvc.dispatchCalls[0].Event.Action)
	assert.Equal(t, "main", wfRunSvc.dispatchCalls[0].Event.Ref)
	assert.Equal(t, "k1", wfRunSvc.dispatchCalls[0].Event.ChangeID)
	assert.Equal(t, actor.ID, wfRunSvc.dispatchCalls[0].UserID)
}

func TestLandingService_CreateLandingRequest_WorkflowDispatchErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "actor")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createLandingRequestFn: func(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
			return landingDBRequest(91, repo.ID, 7, arg.AuthorID, nil), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "actor", LowerUsername: "actor"}, nil
		},
	}

	wfRunSvc := &mockLandingWorkflowRunService{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, fmt.Errorf("workflow dispatch failed")
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{},
		WithLandingWorkflowRunService(wfRunSvc),
	)

	resp, err := svc.CreateLandingRequest(context.Background(), actor, "alice", "demo", CreateLandingRequestInput{
		Title:          "test landing",
		TargetBookmark: "main",
		ChangeIDs:      []string{"k1"},
	})
	// Landing request creation succeeds even though workflow dispatch failed.
	require.NoError(t, err)
	assert.Equal(t, int64(7), resp.Number)
}

// TestLandingService_CreateLandingReview_SelfReviewRejected verifies that an
// author cannot approve their own landing request.
func TestLandingService_CreateLandingReview_SelfReviewRejected(t *testing.T) {
	t.Parallel()

	author := landingTestUser(42, "selfreviewer")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: author.ID, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			// Author of the landing request matches the actor.
			return landingDBRequestWithChangeIDs(7, repo.ID, arg.Number, author.ID, []string{"k1"}), nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	t.Run("approve by author returns 422", func(t *testing.T) {
		_, err := svc.CreateLandingReview(context.Background(), author, "alice", "demo", 1, CreateLandingReviewInput{
			CommitID: "commit-1",
			Type:     "approve",
			Body:     "looks good to me",
		})
		assert.Equal(t, 422, landingAPIStatus(t, err))
		apiErr := err.(*errors.APIError)
		assert.Contains(t, apiErr.Message, "author cannot approve their own landing request")
	})

	t.Run("comment by author is allowed", func(t *testing.T) {
		_, err := svc.CreateLandingReview(context.Background(), author, "alice", "demo", 1, CreateLandingReviewInput{
			CommitID: "commit-1",
			Type:     "comment",
			Body:     "adding a note",
		})
		require.NoError(t, err)
		assert.JSONEq(t, `{"k1":{"commit_id":"commit-1","seq":1}}`, string(q.lastCreateLandingRequestReviewArg.ChangeRevisions))
	})

	t.Run("request_changes by author is allowed", func(t *testing.T) {
		_, err := svc.CreateLandingReview(context.Background(), author, "alice", "demo", 1, CreateLandingReviewInput{
			CommitID: "commit-1",
			Type:     "request_changes",
			Body:     "needs work",
		})
		require.NoError(t, err)
	})

	t.Run("approve by different user with write access is allowed", func(t *testing.T) {
		reviewer := landingTestUser(99, "reviewer")
		// Give the reviewer write permission via collaborator mock.
		qWithReviewer := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				return landingDBRequestWithChangeIDs(7, repo.ID, arg.Number, author.ID, []string{"k1"}), nil
			},
			getCollaboratorPermissionForRepoUserFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				if arg.UserID.Int64 == reviewer.ID {
					return "write", nil
				}
				return "", nil
			},
		}
		svcWithReviewer := NewLandingService(qWithReviewer, &mockLandingRepoHostClient{})
		_, err := svcWithReviewer.CreateLandingReview(context.Background(), reviewer, "alice", "demo", 1, CreateLandingReviewInput{
			CommitID: "commit-1",
			Type:     "approve",
			Body:     "LGTM",
		})
		require.NoError(t, err)
	})
}

// TestLandingService_LandLandingRequest_RetryAfterFailure verifies that a
// landing request in "failed" state can be re-queued (retry semantics).
func TestLandingService_LandLandingRequest_RetryAfterFailure(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	t.Run("failed landing request can be re-queued", func(t *testing.T) {
		t.Parallel()

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(88, repo.ID, arg.Number, 99, []string{"k-a"})
				row.State = "failed"
				return row, nil
			},
			enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(88, repo.ID, 5, 99, nil)
				row.State = "queued"
				return row, nil
			},
			createLandingTaskFn: func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
				return db.LandingTask{
					ID:               200,
					LandingRequestID: arg.LandingRequestID,
					RepositoryID:     arg.RepositoryID,
					Status:           "pending",
					Priority:         arg.Priority,
					CreatedAt:        time.Now().UTC(),
					UpdatedAt:        time.Now().UTC(),
				}, nil
			},
			getLandingQueuePositionByTaskIDFn: func(ctx context.Context, id int64) (int64, error) {
				return 1, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})

		resp, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		require.NoError(t, err)
		assert.Equal(t, "queued", resp.State)
		assert.True(t, q.enqueueLandingRequestCalled)
		assert.True(t, q.createLandingTaskCalled)
	})

	t.Run("failed landing with active task is rejected to prevent double-queue", func(t *testing.T) {
		t.Parallel()

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(88, repo.ID, arg.Number, 99, []string{"k-a"})
				row.State = "failed"
				return row, nil
			},
			getLandingTaskByLandingRequestIDFn: func(ctx context.Context, landingRequestID int64) (db.LandingTask, error) {
				// Simulate an active "running" task still in flight.
				return db.LandingTask{
					ID:               50,
					LandingRequestID: landingRequestID,
					Status:           "running",
				}, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})

		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, 409, landingAPIStatus(t, err))
		assert.False(t, q.enqueueLandingRequestCalled)
	})

	t.Run("closed landing request cannot be retried", func(t *testing.T) {
		t.Parallel()

		q := &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(88, repo.ID, arg.Number, 99, []string{"k-a"})
				row.State = "closed"
				return row, nil
			},
		}
		svc := NewLandingService(q, &mockLandingRepoHostClient{})

		_, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
		assert.Equal(t, 409, landingAPIStatus(t, err))
	})
}

// TestLandingService_LandLandingRequest_DispatchesQueuedEvent verifies that
// the event emitted when a landing request is enqueued has action "queued",
// not "landed" (which is reserved for the worker's post-merge event).
func TestLandingService_LandLandingRequest_DispatchesQueuedEvent(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(10, "owner")
	repo := landingRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, repo.ID, arg.Number, 99, []string{"k-a", "k-b"}), nil
		},
		enqueueLandingRequestFn: func(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
			row := landingDBRequest(88, repo.ID, 5, 99, nil)
			row.State = "queued"
			row.TargetBookmark = "main"
			return row, nil
		},
		createLandingTaskFn: func(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
			return db.LandingTask{
				ID:               300,
				LandingRequestID: arg.LandingRequestID,
				RepositoryID:     arg.RepositoryID,
				Status:           "pending",
				Priority:         arg.Priority,
				CreatedAt:        time.Now().UTC(),
				UpdatedAt:        time.Now().UTC(),
			}, nil
		},
		getLandingQueuePositionByTaskIDFn: func(ctx context.Context, id int64) (int64, error) {
			return 2, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
		},
	}

	dispatcher := &mockLandingDispatcher{}
	svc := NewLandingService(q, &mockLandingRepoHostClient{},
		WithLandingWebhookDispatcher(dispatcher),
	)

	resp, err := svc.LandLandingRequest(context.Background(), actor, "alice", "demo", 5, LandLandingRequestInput{CommitID: "k1"})
	require.NoError(t, err)
	assert.Equal(t, "queued", resp.State)

	// The webhook event action must be "queued", not "landed".
	require.Len(t, dispatcher.calls, 1)
	payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
	require.True(t, ok)
	assert.Equal(t, "queued", payload.Action, "event action should be 'queued' when enqueuing, not 'landed'")
	assert.Equal(t, "queued", payload.LandingRequest.State)
}

func (m *mockLandingQuerier) RecordLandingSourceWorkspace(_ context.Context, landingRequestID int64, workspaceID string) error {
	if m.landingSourceWorkspaces == nil {
		m.landingSourceWorkspaces = map[int64]string{}
	}
	m.landingSourceWorkspaces[landingRequestID] = workspaceID
	return nil
}

func (m *mockLandingQuerier) IsOutsiderLanding(context.Context, int64) (bool, error) {
	return m.outsiderLanding, nil
}
