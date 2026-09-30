package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type issueDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

type mockIssueDispatcher struct {
	dispatchFn func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	calls      []issueDispatchCall
}

func (m *mockIssueDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, issueDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockIssueDispatcher) DispatchOrgEvent(_ context.Context, _ int64, _ webhooks.EventType, _ any) error {
	return nil
}

type mockIssueWorkflowRunService struct {
	dispatchForEventFn func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	dispatchCalls      []DispatchForEventInput
}

func (m *mockIssueWorkflowRunService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.dispatchCalls = append(m.dispatchCalls, input)
	if m.dispatchForEventFn != nil {
		return m.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}

func (m *mockIssueWorkflowRunService) CancelRun(ctx context.Context, repositoryID, runID int64) error {
	return nil
}

func (m *mockIssueWorkflowRunService) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	return &WorkflowRunResult{WorkflowRunID: 999, WorkflowDefinitionID: input.RepositoryID}, nil
}

func (m *mockIssueWorkflowRunService) ResumeRun(_ context.Context, _, _ int64) error {
	return nil
}

type mockIssueQuerier struct {
	getRepoByOwnerAndLowerNameFn          func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn               func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUserFn func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoFn    func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	getUserByIDFn                         func(ctx context.Context, id int64) (db.User, error)
	getUserByLowerUsernameFn              func(ctx context.Context, lowerUsername string) (db.User, error)
	getMilestoneByIDFn                    func(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error)

	createIssueFn                    func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
	getIssueByNumberFn               func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)
	getIssueByIDFn                   func(ctx context.Context, id int64) (db.Issue, error)
	listIssuesByRepoFilteredFn       func(ctx context.Context, arg db.ListIssuesByRepoFilteredParams) ([]db.Issue, error)
	listIssuesByRepoFilteredKeysetFn func(ctx context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error)
	countIssuesByRepoFilteredFn      func(ctx context.Context, arg db.CountIssuesByRepoFilteredParams) (int64, error)
	updateIssueFn                    func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error)
	listIssueAssigneesFn             func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error)
	replaceIssueAssigneesFn          func(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error
	listLabelsByNamesFn              func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error)
	replaceIssueLabelsFn             func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error
	countLabelsForIssueFn            func(ctx context.Context, issueID int64) (int64, error)
	listLabelsForIssueFn             func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error)

	createIssueEventFn func(ctx context.Context, arg db.CreateIssueEventParams) (db.IssueEvent, error)

	createIssueCommentFn        func(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error)
	listIssueCommentsFn         func(ctx context.Context, arg db.ListIssueCommentsParams) ([]db.IssueComment, error)
	listIssueLastCommentsFn     func(context.Context, []int64) ([]db.ListIssueLastCommentsRow, error)
	listIssueCommentsKeysetFn   func(ctx context.Context, arg db.ListIssueCommentsByIssueKeysetParams) ([]db.IssueComment, error)
	countIssueCommentsByIssueFn func(ctx context.Context, issueID int64) (int64, error)
	getIssueCommentByIDFn       func(ctx context.Context, id int64) (db.IssueComment, error)
	updateIssueCommentFn        func(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error)
	deleteIssueCommentFn        func(ctx context.Context, id int64) error
	getIssueByCommentIDFn       func(ctx context.Context, commentID int64) (db.Issue, error)
	listLinkedChangesFn         func(ctx context.Context, issueID int64) ([]db.ListLinkedChangesForIssueRow, error)

	lastListIssuesArg       db.ListIssuesByRepoFilteredParams
	lastListIssuesKeysetArg db.ListIssuesByRepoFilteredKeysetParams
	lastCountIssuesArg      db.CountIssuesByRepoFilteredParams
	lastUpdateIssueArg      db.UpdateIssueParams
	lastCreateIssueArg      db.CreateIssueParams
	lastReplaceLabelsArg    *db.ReplaceIssueLabelsParams
	lastReplaceAssigneesArg *db.ReplaceIssueAssigneesParams

	createdIssueEvents []db.CreateIssueEventParams
}

func (m *mockIssueQuerier) ListLinkedChangesForIssue(ctx context.Context, issueID int64) ([]db.ListLinkedChangesForIssueRow, error) {
	if m.listLinkedChangesFn != nil {
		return m.listLinkedChangesFn(ctx, issueID)
	}
	return []db.ListLinkedChangesForIssueRow{}, nil
}

func (m *mockIssueQuerier) CreateIssueEvent(ctx context.Context, arg db.CreateIssueEventParams) (db.IssueEvent, error) {
	m.createdIssueEvents = append(m.createdIssueEvents, arg)
	if m.createIssueEventFn != nil {
		return m.createIssueEventFn(ctx, arg)
	}
	return db.IssueEvent{
		ID:        int64(len(m.createdIssueEvents)),
		IssueID:   arg.IssueID,
		ActorID:   arg.ActorID,
		EventType: arg.EventType,
		Payload:   arg.Payload,
	}, nil
}

func (m *mockIssueQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockIssueQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockIssueQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoUserFn != nil {
		return m.getHighestTeamPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockIssueQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoFn != nil {
		return m.getCollaboratorPermissionForRepoFn(ctx, arg)
	}
	return "", nil
}

func (m *mockIssueQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{ID: id, Username: fmt.Sprintf("u-%d", id), LowerUsername: fmt.Sprintf("u-%d", id)}, nil
}

func (m *mockIssueQuerier) GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error) {
	if m.getUserByLowerUsernameFn != nil {
		return m.getUserByLowerUsernameFn(ctx, lowerUsername)
	}
	return db.User{ID: 99, Username: lowerUsername, LowerUsername: lowerUsername}, nil
}

func (m *mockIssueQuerier) GetMilestoneByID(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error) {
	if m.getMilestoneByIDFn != nil {
		return m.getMilestoneByIDFn(ctx, arg)
	}
	return db.Milestone{}, pgx.ErrNoRows
}

func (m *mockIssueQuerier) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	m.lastCreateIssueArg = arg
	if m.createIssueFn != nil {
		return m.createIssueFn(ctx, arg)
	}
	return issueDBRecord(1, arg.RepositoryID, 1, arg.AuthorID, nil), nil
}

func (m *mockIssueQuerier) GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
	if m.getIssueByNumberFn != nil {
		return m.getIssueByNumberFn(ctx, arg)
	}
	return issueDBRecord(1, arg.RepositoryID, arg.Number, 1, nil), nil
}

func (m *mockIssueQuerier) GetIssueByID(ctx context.Context, id int64) (db.Issue, error) {
	if m.getIssueByIDFn != nil {
		return m.getIssueByIDFn(ctx, id)
	}
	return db.Issue{}, pgx.ErrNoRows
}

func (m *mockIssueQuerier) ListIssuesByRepoFiltered(ctx context.Context, arg db.ListIssuesByRepoFilteredParams) ([]db.Issue, error) {
	m.lastListIssuesArg = arg
	if m.listIssuesByRepoFilteredFn != nil {
		return m.listIssuesByRepoFilteredFn(ctx, arg)
	}
	return []db.Issue{issueDBRecord(2, arg.RepositoryID, 2, 1, nil)}, nil
}

func (m *mockIssueQuerier) CountIssuesByRepoFiltered(ctx context.Context, arg db.CountIssuesByRepoFilteredParams) (int64, error) {
	m.lastCountIssuesArg = arg
	if m.countIssuesByRepoFilteredFn != nil {
		return m.countIssuesByRepoFilteredFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockIssueQuerier) UpdateIssue(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
	m.lastUpdateIssueArg = arg
	if m.updateIssueFn != nil {
		return m.updateIssueFn(ctx, arg)
	}
	row := issueDBRecord(arg.ID, 77, 3, 1, nil)
	row.Title = arg.Title
	row.Body = arg.Body
	row.State = arg.State
	row.MilestoneID = arg.MilestoneID
	row.ClosedAt = arg.ClosedAt
	row.FixedByID = arg.FixedByID
	row.FixedByAgentSessionID = pgtype.UUID{}
	if arg.FixedByAgentSessionID != "" {
		row.FixedByAgentSessionID = pgtype.UUID{Bytes: uuid.MustParse(arg.FixedByAgentSessionID), Valid: true}
	}
	row.FixedAt = arg.FixedAt
	row.VerifiedByID = arg.VerifiedByID
	row.VerifiedByAgentSessionID = pgtype.UUID{}
	if arg.VerifiedByAgentSessionID != "" {
		row.VerifiedByAgentSessionID = pgtype.UUID{Bytes: uuid.MustParse(arg.VerifiedByAgentSessionID), Valid: true}
	}
	row.VerifiedAt = arg.VerifiedAt
	return row, nil
}

func (m *mockIssueQuerier) ListIssueAssignees(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
	if m.listIssueAssigneesFn != nil {
		return m.listIssueAssigneesFn(ctx, issueID)
	}
	return []db.ListIssueAssigneesRow{}, nil
}

func (m *mockIssueQuerier) ReplaceIssueAssignees(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error {
	m.lastReplaceAssigneesArg = &arg
	if m.replaceIssueAssigneesFn != nil {
		return m.replaceIssueAssigneesFn(ctx, arg)
	}
	return nil
}

func (m *mockIssueQuerier) ListLabelsByNames(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
	if m.listLabelsByNamesFn != nil {
		return m.listLabelsByNamesFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockIssueQuerier) ReplaceIssueLabels(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
	m.lastReplaceLabelsArg = &arg
	if m.replaceIssueLabelsFn != nil {
		return m.replaceIssueLabelsFn(ctx, arg)
	}
	return nil
}

func (m *mockIssueQuerier) CountLabelsForIssue(ctx context.Context, issueID int64) (int64, error) {
	if m.countLabelsForIssueFn != nil {
		return m.countLabelsForIssueFn(ctx, issueID)
	}
	return 0, nil
}

func (m *mockIssueQuerier) ListLabelsForIssue(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
	if m.listLabelsForIssueFn != nil {
		return m.listLabelsForIssueFn(ctx, arg)
	}
	return []db.Label{}, nil
}

func (m *mockIssueQuerier) CreateIssueComment(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error) {
	if m.createIssueCommentFn != nil {
		return m.createIssueCommentFn(ctx, arg)
	}
	return db.IssueComment{ID: 1, IssueID: arg.IssueID, UserID: arg.UserID, Commenter: arg.Commenter, Body: arg.Body, Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
}

func (m *mockIssueQuerier) ListIssueComments(ctx context.Context, arg db.ListIssueCommentsParams) ([]db.IssueComment, error) {
	if m.listIssueCommentsFn != nil {
		return m.listIssueCommentsFn(ctx, arg)
	}
	return []db.IssueComment{{ID: 1, IssueID: arg.IssueID, UserID: pgtype.Int8{Int64: 1, Valid: true}, Commenter: "alice", Body: "hi", Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}}, nil
}

func (m *mockIssueQuerier) ListIssuesByRepoFilteredKeyset(ctx context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
	m.lastListIssuesKeysetArg = arg
	if m.listIssuesByRepoFilteredKeysetFn != nil {
		return m.listIssuesByRepoFilteredKeysetFn(ctx, arg)
	}
	return []db.Issue{issueDBRecord(2, arg.RepositoryID, 2, 1, nil)}, nil
}

func (m *mockIssueQuerier) ListIssueCommentsByIssueKeyset(ctx context.Context, arg db.ListIssueCommentsByIssueKeysetParams) ([]db.IssueComment, error) {
	if m.listIssueCommentsKeysetFn != nil {
		return m.listIssueCommentsKeysetFn(ctx, arg)
	}
	return []db.IssueComment{{ID: 1, IssueID: arg.IssueID, UserID: pgtype.Int8{Int64: 1, Valid: true}, Commenter: "alice", Body: "hi", Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}}, nil
}

func (m *mockIssueQuerier) ListIssueLastComments(ctx context.Context, issueIDs []int64) ([]db.ListIssueLastCommentsRow, error) {
	if m.listIssueLastCommentsFn != nil {
		return m.listIssueLastCommentsFn(ctx, issueIDs)
	}
	return nil, nil
}

func (m *mockIssueQuerier) CountIssueCommentsByIssue(ctx context.Context, issueID int64) (int64, error) {
	if m.countIssueCommentsByIssueFn != nil {
		return m.countIssueCommentsByIssueFn(ctx, issueID)
	}
	return 1, nil
}

func (m *mockIssueQuerier) GetIssueCommentByID(ctx context.Context, id int64) (db.IssueComment, error) {
	if m.getIssueCommentByIDFn != nil {
		return m.getIssueCommentByIDFn(ctx, id)
	}
	return db.IssueComment{ID: id, IssueID: 1, UserID: pgtype.Int8{Int64: 1, Valid: true}, Commenter: "alice", Body: "old", Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
}

func (m *mockIssueQuerier) UpdateIssueComment(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error) {
	if m.updateIssueCommentFn != nil {
		return m.updateIssueCommentFn(ctx, arg)
	}
	return db.IssueComment{ID: arg.ID, IssueID: 1, UserID: pgtype.Int8{Int64: 1, Valid: true}, Commenter: "alice", Body: arg.Body, Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
}

func (m *mockIssueQuerier) DeleteIssueComment(ctx context.Context, id int64) error {
	if m.deleteIssueCommentFn != nil {
		return m.deleteIssueCommentFn(ctx, id)
	}
	return nil
}

func (m *mockIssueQuerier) GetIssueByCommentID(ctx context.Context, commentID int64) (db.Issue, error) {
	if m.getIssueByCommentIDFn != nil {
		return m.getIssueByCommentIDFn(ctx, commentID)
	}
	return issueDBRecord(1, 77, 2, 1, nil), nil
}

func (m *mockIssueQuerier) CreateMention(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error) {
	return db.Mention{}, nil
}

func (m *mockIssueQuerier) DeleteMentionsForComment(ctx context.Context, arg db.DeleteMentionsForCommentParams) error {
	return nil
}

func issueTestUser(id int64, username string) *db.User {
	return &db.User{ID: id, Username: username, LowerUsername: username, IsActive: true}
}

func issueRepo(overrides func(*db.Repository)) db.Repository {
	r := db.Repository{
		ID:        77,
		Name:      "demo",
		LowerName: "demo",
		IsPublic:  true,
		UserID:    pgtype.Int8{Int64: 1, Valid: true},
	}
	if overrides != nil {
		overrides(&r)
	}
	return r
}

func issueDBRecord(id, repositoryID, number, authorID int64, overrides func(*db.Issue)) db.Issue {
	now := time.Now().UTC().Truncate(time.Second)
	issue := db.Issue{
		ID:           id,
		RepositoryID: repositoryID,
		Number:       number,
		Title:        "title",
		Body:         "body",
		State:        "open",
		AuthorID:     authorID,
		CommentCount: 0,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if overrides != nil {
		overrides(&issue)
	}
	return issue
}

func issueAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *errors.APIError, got %T", err)
	return apiErr.Status
}

func milestonePatchSet(id int64) *IssuePatch[int64] {
	return &IssuePatch[int64]{Value: &id}
}

func milestonePatchClear() *IssuePatch[int64] {
	return &IssuePatch[int64]{}
}

func TestIssueService_ListIssues_ReadAccessAndFilters(t *testing.T) {
	t.Parallel()

	privateRepo := issueRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.OrgID = pgtype.Int8{Int64: 9, Valid: true}
		r.UserID = pgtype.Int8{}
	})

	tests := []struct {
		name         string
		repo         db.Repository
		viewer       *db.User
		teamPerm     string
		state        string
		expectStatus int
	}{
		{name: "public anonymous", repo: issueRepo(nil), viewer: nil, state: "open"},
		{name: "private denied", repo: privateRepo, viewer: nil, state: "open", expectStatus: 403},
		{name: "private with read", repo: privateRepo, viewer: issueTestUser(8, "viewer"), teamPerm: "read", state: "open"},
		{name: "invalid state", repo: issueRepo(nil), viewer: nil, state: "bad", expectStatus: 422},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			q := &mockIssueQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return tc.repo, nil
				},
				getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				listIssuesByRepoFilteredKeysetFn: func(ctx context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
					return []db.Issue{issueDBRecord(10, tc.repo.ID, 9, 2, nil)}, nil
				},
				countIssuesByRepoFilteredFn: func(ctx context.Context, arg db.CountIssuesByRepoFilteredParams) (int64, error) {
					return 1, nil
				},
				listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
					return []db.ListIssueAssigneesRow{}, nil
				},
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
				},
			}
			svc := NewIssueService(q)

			items, _, total, err := svc.ListIssues(context.Background(), tc.viewer, "alice", "demo", 2, 50, tc.state)
			if tc.expectStatus != 0 {
				assert.Equal(t, tc.expectStatus, issueAPIStatus(t, err))
				return
			}

			require.NoError(t, err)
			require.Len(t, items, 1)
			assert.Equal(t, int64(1), total)
			assert.Equal(t, int32(50), q.lastListIssuesKeysetArg.PageSize)
			assert.Equal(t, int64(2), q.lastListIssuesKeysetArg.AfterNumber)
		})
	}
}

func TestIssueService_CreateIssue_ValidationAndCounters(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(3, "alice")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })

	t.Run("requires auth", func(t *testing.T) {
		svc := NewIssueService(&mockIssueQuerier{})
		_, err := svc.CreateIssue(context.Background(), nil, "alice", "demo", CreateIssueInput{Title: "x"})
		assert.Equal(t, 401, issueAPIStatus(t, err))
	})

	t.Run("validates title", func(t *testing.T) {
		q := &mockIssueQuerier{getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		}}
		svc := NewIssueService(q)
		_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: " "})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})

	// Regression: an oversized title must be rejected with a 422 before the DB
	// insert, not surface as a driver 500 from the VARCHAR(255) column overflow.
	t.Run("rejects oversized title with 422 before insert", func(t *testing.T) {
		createCalled := false
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				createCalled = true
				return issueDBRecord(1, repo.ID, 1, actor.ID, nil), nil
			},
		}
		svc := NewIssueService(q)
		_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: strings.Repeat("a", maxIssueTitleLen+1)})
		assert.Equal(t, 422, issueAPIStatus(t, err))
		assert.False(t, createCalled, "insert must not be reached for an oversized title")
	})

	t.Run("accepts a title at the max length", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				return issueDBRecord(88, repo.ID, 5, actor.ID, nil), nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return []db.ListIssueAssigneesRow{}, nil
			},
		}
		svc := NewIssueService(q)
		_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: strings.Repeat("a", maxIssueTitleLen)})
		require.NoError(t, err)
	})

	t.Run("creates the issue", func(t *testing.T) {
		// repositories.num_issues is trigger-maintained; no counter write here.
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				return issueDBRecord(88, repo.ID, 5, actor.ID, nil), nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return []db.ListIssueAssigneesRow{}, nil
			},
		}
		svc := NewIssueService(q)

		resp, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "new issue", Body: "desc"})
		require.NoError(t, err)
		assert.Equal(t, int64(5), resp.Number)
		assert.Equal(t, "alice", resp.Author.Login)
	})
}

func TestIssueService_CreateIssue_CollaboratorWriteAllowed(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(50, "collab")
	repo := issueRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.OrgID = pgtype.Int8{}
	})

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getCollaboratorPermissionForRepoFn: func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, actor.ID, arg.UserID.Int64)
			return "write", nil
		},
		createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
			return issueDBRecord(99, repo.ID, 12, actor.ID, nil), nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "collab", LowerUsername: "collab"}, nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return []db.ListIssueAssigneesRow{}, nil
		},
	}
	svc := NewIssueService(q)

	created, err := svc.CreateIssue(context.Background(), actor, "owner", "demo", CreateIssueInput{Title: "via collaborator"})
	require.NoError(t, err)
	assert.Equal(t, int64(12), created.Number)
}

func TestIssueService_UpdateIssue_StateTransitionsAndAssignees(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "owner")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })

	// num_closed_issues maintenance moved into the database
	// (trg_issues_repo_counts_upd fires only on actual state transitions).

	t.Run("close transition", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueDBRecord(7, repo.ID, arg.Number, actor.ID, nil), nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				row := issueDBRecord(arg.ID, repo.ID, 3, actor.ID, nil)
				row.State = arg.State
				row.ClosedAt = arg.ClosedAt
				return row, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return []db.ListIssueAssigneesRow{}, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)
		resp, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{State: stringPtr("closed")})
		require.NoError(t, err)
		assert.Equal(t, "closed", resp.State)
	})

	t.Run("reopen transition", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueDBRecord(7, repo.ID, arg.Number, actor.ID, func(i *db.Issue) {
					i.State = "closed"
					i.ClosedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
				}), nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				row := issueDBRecord(arg.ID, repo.ID, 3, actor.ID, nil)
				row.State = arg.State
				row.ClosedAt = arg.ClosedAt
				return row, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return []db.ListIssueAssigneesRow{}, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)
		resp, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{State: stringPtr("open")})
		require.NoError(t, err)
		assert.Equal(t, "open", resp.State)
		assert.False(t, resp.ClosedAt.Valid)
	})

	t.Run("verification requires a distinct human", func(t *testing.T) {
		fixedAt := time.Now().UTC().Add(-time.Hour)
		current := issueDBRecord(7, repo.ID, 3, actor.ID, func(i *db.Issue) {
			i.State = "fixed"
			i.ClosedAt = pgtype.Timestamptz{Time: fixedAt, Valid: true}
			i.FixedByID = pgtype.Int8{Int64: actor.ID, Valid: true}
			i.FixedAt = pgtype.Timestamptz{Time: fixedAt, Valid: true}
		})
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
			getIssueByNumberFn:           func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return current, nil },
			getCollaboratorPermissionForRepoFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return "write", nil
			},
		}

		_, err := NewIssueService(q).UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{State: stringPtr("verified")})
		require.Error(t, err)
		assert.Equal(t, 422, issueAPIStatus(t, err))
		assert.Empty(t, q.lastUpdateIssueArg.State, "a rejected self-verification must not write")

		verifier := issueTestUser(2, "reviewer")
		resp, err := NewIssueService(q).UpdateIssue(context.Background(), verifier, "alice", "demo", 3, UpdateIssueInput{State: stringPtr("verified")})
		require.NoError(t, err)
		assert.Equal(t, "verified", resp.State)
		require.NotNil(t, resp.VerifiedBy)
		assert.Equal(t, verifier.ID, resp.VerifiedBy.ID)
		assert.True(t, resp.VerifiedAt.Valid)
	})

	t.Run("a second agent session may verify the fix", func(t *testing.T) {
		fixerSession := uuid.MustParse("11111111-1111-4111-8111-111111111111")
		verifierSession := "22222222-2222-4222-8222-222222222222"
		fixedAt := time.Now().UTC().Add(-time.Hour)
		current := issueDBRecord(8, repo.ID, 4, actor.ID, func(i *db.Issue) {
			i.State = "fixed"
			i.ClosedAt = pgtype.Timestamptz{Time: fixedAt, Valid: true}
			i.FixedByID = pgtype.Int8{Int64: actor.ID, Valid: true}
			i.FixedByAgentSessionID = pgtype.UUID{Bytes: fixerSession, Valid: true}
			i.FixedAt = pgtype.Timestamptz{Time: fixedAt, Valid: true}
		})
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
			getIssueByNumberFn:           func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) { return current, nil },
		}
		sameAgentCtx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{
			User: actor, IsTokenAuth: true, RawScopes: middleware.AgentSessionRestrictionScope(fixerSession.String()),
		})
		_, err := NewIssueService(q).UpdateIssue(sameAgentCtx, actor, "alice", "demo", 4, UpdateIssueInput{State: stringPtr("verified")})
		require.Error(t, err)
		assert.Equal(t, 422, issueAPIStatus(t, err))

		ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{
			User: actor, IsTokenAuth: true, RawScopes: middleware.AgentSessionRestrictionScope(verifierSession),
		})

		resp, err := NewIssueService(q).UpdateIssue(ctx, actor, "alice", "demo", 4, UpdateIssueInput{State: stringPtr("verified")})
		require.NoError(t, err)
		require.NotNil(t, resp.VerifiedBy)
		assert.Equal(t, verifierSession, resp.VerifiedBy.AgentSessionID)
		assert.Equal(t, verifierSession, q.lastUpdateIssueArg.VerifiedByAgentSessionID)
	})

	t.Run("assignee replacement validates users", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueDBRecord(7, repo.ID, arg.Number, actor.ID, nil), nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				return issueDBRecord(arg.ID, repo.ID, 3, actor.ID, nil), nil
			},
			getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
				if lowerUsername == "missing" {
					return db.User{}, pgx.ErrNoRows
				}
				return db.User{ID: 22, Username: "bob", LowerUsername: "bob"}, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return []db.ListIssueAssigneesRow{{ID: 22, Username: "bob"}}, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)

		_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{Assignees: &[]string{"missing"}})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})
}

func TestIssueService_GetIssueIncludesLinkedChanges(t *testing.T) {
	t.Parallel()
	actor := issueTestUser(1, "owner")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	linkedAt := time.Now().UTC()
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, 3, actor.ID, nil), nil
		},
		listLinkedChangesFn: func(_ context.Context, issueID int64) ([]db.ListLinkedChangesForIssueRow, error) {
			assert.Equal(t, int64(7), issueID)
			return []db.ListLinkedChangesForIssueRow{{ChangeID: "change-1", CommitID: "commit-1", Description: "fix", LinkType: "closes", CreatedAt: linkedAt}}, nil
		},
	}

	resp, err := NewIssueService(q).GetIssue(context.Background(), actor, "alice", "demo", 3)
	require.NoError(t, err)
	require.Equal(t, []IssueLinkedChange{{ChangeID: "change-1", CommitID: "commit-1", Description: "fix", LinkType: "closes", LinkedAt: linkedAt}}, resp.LinkedChanges)
}

func TestIssueService_CommentsLifecycle(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "owner")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, arg.Number, actor.ID, nil), nil
		},
		createIssueCommentFn: func(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error) {
			return db.IssueComment{ID: 9, IssueID: arg.IssueID, UserID: arg.UserID, Commenter: arg.Commenter, Body: arg.Body, Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
		},
		listIssueCommentsFn: func(ctx context.Context, arg db.ListIssueCommentsParams) ([]db.IssueComment, error) {
			return []db.IssueComment{{ID: 9, IssueID: arg.IssueID, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Commenter: "owner", Body: "first", Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}}, nil
		},
		countIssueCommentsByIssueFn: func(ctx context.Context, issueID int64) (int64, error) { return 1, nil },
		getIssueCommentByIDFn: func(ctx context.Context, id int64) (db.IssueComment, error) {
			return db.IssueComment{ID: id, IssueID: 7, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Commenter: "owner", Body: "old", Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, 3, actor.ID, nil), nil
		},
		updateIssueCommentFn: func(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error) {
			return db.IssueComment{ID: arg.ID, IssueID: 7, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Commenter: "owner", Body: arg.Body, Type: "comment", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
		},
		deleteIssueCommentFn: func(ctx context.Context, id int64) error { return nil },
	}
	svc := NewIssueService(q)

	created, err := svc.CreateIssueComment(context.Background(), actor, "alice", "demo", 3, CreateIssueCommentInput{Body: "first"})
	require.NoError(t, err)
	assert.Equal(t, int64(9), created.ID)

	comments, _, total, err := svc.ListIssueComments(context.Background(), actor, "alice", "demo", 3, 1, 20)
	require.NoError(t, err)
	require.Len(t, comments, 1)
	assert.Equal(t, int64(1), total)

	updated, err := svc.UpdateIssueComment(context.Background(), actor, "alice", "demo", 9, UpdateIssueCommentInput{Body: "edited"})
	require.NoError(t, err)
	assert.Equal(t, "edited", updated.Body)

	err = svc.DeleteIssueComment(context.Background(), actor, "alice", "demo", 9)
	require.NoError(t, err)
}

func TestIssueService_GetIssueComment(t *testing.T) {
	t.Parallel()

	repo := issueRepo(func(r *db.Repository) {
		r.IsPublic = false
		r.UserID = pgtype.Int8{}
		r.OrgID = pgtype.Int8{Int64: 41, Valid: true}
	})
	viewer := issueTestUser(12, "reader")

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			assert.Equal(t, repo.ID, arg.RepositoryID)
			assert.Equal(t, viewer.ID, arg.UserID)
			return "read", nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			assert.Equal(t, int64(52), commentID)
			return issueDBRecord(7, repo.ID, 3, 1, nil), nil
		},
		getIssueCommentByIDFn: func(ctx context.Context, id int64) (db.IssueComment, error) {
			assert.Equal(t, int64(52), id)
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        id,
				IssueID:   7,
				UserID:    pgtype.Int8{Int64: 1, Valid: true},
				Commenter: "owner",
				Body:      "details",
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}
	svc := NewIssueService(q)

	comment, err := svc.GetIssueComment(context.Background(), viewer, "alice", "demo", 52)
	require.NoError(t, err)
	assert.Equal(t, int64(52), comment.ID)
	assert.Equal(t, "details", comment.Body)

	_, err = svc.GetIssueComment(context.Background(), viewer, "alice", "demo", 0)
	assert.Equal(t, 400, issueAPIStatus(t, err))

	// A comment whose parent issue lives in another repository must 404,
	// not leak across tenants (IDOR).
	crossQ := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(7, repo.ID+1, 3, 1, nil), nil // different repository
		},
	}
	crossSvc := NewIssueService(crossQ)
	_, err = crossSvc.GetIssueComment(context.Background(), viewer, "alice", "demo", 52)
	assert.Equal(t, 404, issueAPIStatus(t, err))
}

func TestIssueService_MapIssue_IncludesLabels(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		listIssuesByRepoFilteredKeysetFn: func(ctx context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error) {
			return []db.Issue{issueDBRecord(10, repo.ID, 7, 1, nil)}, nil
		},
		countIssuesByRepoFilteredFn: func(ctx context.Context, arg db.CountIssuesByRepoFilteredParams) (int64, error) {
			return 1, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return nil, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 2, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{
				{ID: 1, Name: "bug", Color: "#d73a4a", Description: "bug"},
				{ID: 2, Name: "docs", Color: "#0e8a16", Description: "docs"},
			}, nil
		},
	}
	svc := NewIssueService(q)

	issues, _, total, err := svc.ListIssues(context.Background(), nil, "alice", "demo", 1, 10, "open")
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Len(t, issues, 1)
	require.Len(t, issues[0].Labels, 2)
	assert.Equal(t, "bug", issues[0].Labels[0].Name)
	assert.Equal(t, "#0e8a16", issues[0].Labels[1].Color)
}

func TestIssueService_CreateIssue_LabelsAndMilestone(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(3, "alice")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	milestoneID := int64(44)

	t.Run("create resolves labels and milestone", func(t *testing.T) {
		var createdIssueID int64
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getMilestoneByIDFn: func(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error) {
				assert.Equal(t, repo.ID, arg.RepositoryID)
				assert.Equal(t, milestoneID, arg.ID)
				return db.Milestone{ID: milestoneID, RepositoryID: repo.ID, Title: "v1"}, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				createdIssueID = 99
				assert.True(t, arg.MilestoneID.Valid)
				assert.Equal(t, milestoneID, arg.MilestoneID.Int64)
				return issueDBRecord(createdIssueID, repo.ID, 5, actor.ID, func(i *db.Issue) {
					i.MilestoneID = arg.MilestoneID
				}), nil
			},
			listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
				assert.Equal(t, []string{"bug", "docs"}, arg.Names)
				return []db.Label{
					{ID: 11, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a", Description: "bug"},
					{ID: 12, RepositoryID: repo.ID, Name: "docs", Color: "#0e8a16", Description: "docs"},
				}, nil
			},
			replaceIssueLabelsFn: func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
				assert.Equal(t, createdIssueID, arg.IssueID)
				assert.Equal(t, []int64{11, 12}, arg.LabelIds)
				return nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 2, nil
			},
			listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
				return []db.Label{
					{ID: 11, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a", Description: "bug"},
					{ID: 12, RepositoryID: repo.ID, Name: "docs", Color: "#0e8a16", Description: "docs"},
				}, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
		}
		svc := NewIssueService(q)

		resp, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
			Title:     "new issue",
			Body:      "desc",
			Labels:    []string{"bug", "docs"},
			Milestone: &milestoneID,
		})
		require.NoError(t, err)
		assert.Equal(t, milestoneID, resp.MilestoneID)
		require.Len(t, resp.Labels, 2)
		assert.Equal(t, "docs", resp.Labels[1].Name)
	})

	t.Run("invalid label returns 422", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getMilestoneByIDFn: func(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error) {
				return db.Milestone{ID: milestoneID, RepositoryID: repo.ID}, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				return issueDBRecord(1, repo.ID, 1, actor.ID, nil), nil
			},
			listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
				return []db.Label{{ID: 11, RepositoryID: repo.ID, Name: "bug"}}, nil
			},
		}
		svc := NewIssueService(q)

		_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
			Title:     "new issue",
			Labels:    []string{"bug", "missing"},
			Milestone: &milestoneID,
		})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})

	t.Run("invalid milestone returns 422", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getMilestoneByIDFn: func(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error) {
				return db.Milestone{}, pgx.ErrNoRows
			},
		}
		svc := NewIssueService(q)

		_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
			Title:     "new issue",
			Milestone: &milestoneID,
		})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})
}

func TestIssueService_UpdateIssue_LabelsAndMilestoneSemantics(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "owner")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	issueWithMilestone := issueDBRecord(7, repo.ID, 3, actor.ID, func(i *db.Issue) {
		i.MilestoneID = pgtype.Int8{Int64: 9, Valid: true}
	})
	setMilestoneID := int64(55)

	t.Run("set milestone and replace labels", func(t *testing.T) {
		replaced := false
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			getMilestoneByIDFn: func(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error) {
				assert.Equal(t, setMilestoneID, arg.ID)
				return db.Milestone{ID: setMilestoneID, RepositoryID: repo.ID}, nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				assert.True(t, arg.MilestoneID.Valid)
				assert.Equal(t, setMilestoneID, arg.MilestoneID.Int64)
				return issueDBRecord(7, repo.ID, 3, actor.ID, func(i *db.Issue) {
					i.MilestoneID = arg.MilestoneID
				}), nil
			},
			listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
				return []db.Label{
					{ID: 11, RepositoryID: repo.ID, Name: "bug"},
					{ID: 12, RepositoryID: repo.ID, Name: "docs"},
				}, nil
			},
			replaceIssueLabelsFn: func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
				replaced = true
				assert.Equal(t, int64(7), arg.IssueID)
				assert.Equal(t, []int64{11, 12}, arg.LabelIds)
				return nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 2, nil
			},
			listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
				return []db.Label{{ID: 11, Name: "bug"}, {ID: 12, Name: "docs"}}, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)

		resp, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{
			Labels:    &[]string{"bug", "docs"},
			Milestone: milestonePatchSet(setMilestoneID),
		})
		require.NoError(t, err)
		assert.True(t, replaced)
		assert.Equal(t, setMilestoneID, resp.MilestoneID)
		require.Len(t, resp.Labels, 2)
	})

	t.Run("empty labels clears", func(t *testing.T) {
		var replacedWith []int64
		replaced := false
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			replaceIssueLabelsFn: func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
				replaced = true
				replacedWith = arg.LabelIds
				return nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 0, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)

		_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{
			Labels: &[]string{},
		})
		require.NoError(t, err)
		assert.True(t, replaced, "an empty label list must replace the set with nothing")
		assert.Empty(t, replacedWith)
	})

	t.Run("nil labels unchanged", func(t *testing.T) {
		deleted := false
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			replaceIssueLabelsFn: func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
				deleted = true
				return nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 0, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)

		_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{})
		require.NoError(t, err)
		assert.False(t, deleted)
	})

	t.Run("null milestone clears", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				assert.False(t, arg.MilestoneID.Valid)
				return issueDBRecord(7, repo.ID, 3, actor.ID, func(i *db.Issue) {
					i.MilestoneID = pgtype.Int8{}
				}), nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 0, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)

		resp, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{
			Milestone: milestonePatchClear(),
		})
		require.NoError(t, err)
		assert.Nil(t, resp.MilestoneID)
	})

	t.Run("absent milestone preserves", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				assert.True(t, arg.MilestoneID.Valid)
				assert.Equal(t, int64(9), arg.MilestoneID.Int64)
				return issueWithMilestone, nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 0, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "owner", LowerUsername: "owner"}, nil
			},
		}
		svc := NewIssueService(q)

		resp, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{})
		require.NoError(t, err)
		assert.Equal(t, int64(9), resp.MilestoneID)
	})

	t.Run("invalid milestone returns 422", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueWithMilestone, nil
			},
			getMilestoneByIDFn: func(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error) {
				return db.Milestone{}, pgx.ErrNoRows
			},
		}
		svc := NewIssueService(q)

		_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{
			Milestone: milestonePatchSet(123),
		})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})
}

func TestIssueService_ResolveLabelIDs_ValidatesWithoutTouchingExistingLabels(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		input     []string
		listNames func(t *testing.T, arg db.ListLabelsByNamesParams) []db.Label
	}{
		{
			name:  "unknown label",
			input: []string{"missing"},
			listNames: func(t *testing.T, arg db.ListLabelsByNamesParams) []db.Label {
				assert.Equal(t, int64(77), arg.RepositoryID)
				assert.Equal(t, []string{"missing"}, arg.Names)
				return nil
			},
		},
		{
			name:  "blank label",
			input: []string{"bug", " "},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			deleted := false
			added := false
			q := &mockIssueQuerier{
				listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
					if tc.listNames == nil {
						t.Fatalf("ListLabelsByNames must not be called before local validation succeeds")
					}
					return tc.listNames(t, arg), nil
				},
				replaceIssueLabelsFn: func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
					deleted = true
					added = true
					return nil
				},
			}

			ids, err := NewIssueService(q).resolveLabelIDs(context.Background(), 77, tc.input)

			assert.Equal(t, 422, issueAPIStatus(t, err))
			assert.Nil(t, ids)
			assert.False(t, deleted)
			assert.False(t, added)
		})
	}
}

func TestIssueService_CreateIssue_InvalidAssigneeCreatesNothing(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	created := false
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getUserByLowerUsernameFn: func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
		createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
			created = true
			return issueDBRecord(1, repo.ID, 1, actor.ID, nil), nil
		},
	}

	_, err := NewIssueService(q).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
		Title:     "valid title",
		Assignees: []string{"ghost"},
	})

	assert.Equal(t, 422, issueAPIStatus(t, err))
	assert.False(t, created, "issue row must not be created when an assignee fails validation")
	assert.Empty(t, q.createdIssueEvents)
}

func TestIssueService_UpdateIssue_InvalidLabelLeavesIssueUntouched(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	updated := false
	deletedLabels := false
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(3, repo.ID, 3, actor.ID, nil), nil
		},
		listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
			return nil, nil
		},
		updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
			updated = true
			return issueDBRecord(3, repo.ID, 3, actor.ID, nil), nil
		},
		replaceIssueLabelsFn: func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
			deletedLabels = true
			return nil
		},
	}

	state := "closed"
	labels := []string{"missing"}
	_, err := NewIssueService(q).UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{
		State:  &state,
		Labels: &labels,
	})

	assert.Equal(t, 422, issueAPIStatus(t, err))
	assert.False(t, updated, "issue row must not be written when a label fails validation")
	assert.False(t, deletedLabels, "existing labels must not be deleted when a label fails validation")
	assert.Empty(t, q.createdIssueEvents)
}

func TestIssueService_RecordsTimelineEvents(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")

	t.Run("create records opened", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				return issueDBRecord(9, repo.ID, 4, actor.ID, nil), nil
			},
		}

		_, err := NewIssueService(q).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "new issue"})
		require.NoError(t, err)

		require.Len(t, q.createdIssueEvents, 1)
		event := q.createdIssueEvents[0]
		assert.Equal(t, int64(9), event.IssueID)
		assert.Equal(t, "opened", event.EventType)
		assert.Equal(t, int64(1), event.ActorID.Int64)
		assert.True(t, event.ActorID.Valid)

		var payload map[string]any
		require.NoError(t, json.Unmarshal(event.Payload, &payload))
		assert.Equal(t, "opened", payload["type"])
	})

	t.Run("close records state transition", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return issueDBRecord(9, repo.ID, 4, actor.ID, nil), nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				return issueDBRecord(9, repo.ID, 4, actor.ID, func(i *db.Issue) {
					i.State = arg.State
					i.ClosedAt = arg.ClosedAt
				}), nil
			},
		}

		state := "closed"
		_, err := NewIssueService(q).UpdateIssue(context.Background(), actor, "alice", "demo", 4, UpdateIssueInput{State: &state})
		require.NoError(t, err)

		require.Len(t, q.createdIssueEvents, 1)
		event := q.createdIssueEvents[0]
		assert.Equal(t, "closed", event.EventType)

		var payload map[string]any
		require.NoError(t, json.Unmarshal(event.Payload, &payload))
		before, ok := payload["before"].(map[string]any)
		require.True(t, ok)
		after, ok := payload["after"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "open", before["state"])
		assert.Equal(t, "closed", after["state"])
	})

	t.Run("timeline write failure does not fail the mutation", func(t *testing.T) {
		q := &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
				return issueDBRecord(9, repo.ID, 4, actor.ID, nil), nil
			},
			createIssueEventFn: func(ctx context.Context, arg db.CreateIssueEventParams) (db.IssueEvent, error) {
				return db.IssueEvent{}, fmt.Errorf("events table unavailable")
			},
		}

		_, err := NewIssueService(q).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "new issue"})
		require.NoError(t, err)
	})
}

func TestIssueService_ResolveIssueMilestone_NonPositive(t *testing.T) {
	t.Parallel()

	svc := NewIssueService(&mockIssueQuerier{})
	value := int64(0)
	_, err := svc.resolveIssueMilestone(context.Background(), 1, &value)
	assert.Equal(t, 422, issueAPIStatus(t, err))
}

func TestIssueService_DispatchesIssuesWebhookOnCreate(t *testing.T) {
	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	dispatcher := &mockIssueDispatcher{}
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
			return issueDBRecord(100, repo.ID, 3, actor.ID, nil), nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return nil, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 0, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWebhookDispatcher(dispatcher))
	_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "new issue", Body: "desc"})
	require.NoError(t, err)

	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.Equal(t, repo.ID, call.repoID)
	assert.Equal(t, webhooks.EventTypeIssues, call.eventType)

	payload, ok := call.payload.(webhooks.IssueEventPayload)
	require.True(t, ok)
	assert.Equal(t, "opened", payload.Action)
	assert.Equal(t, int64(3), payload.Issue.Number)
	assert.Equal(t, "demo", payload.Repository.Name)
	assert.Equal(t, "alice", payload.Sender.Login)
}

func TestIssueService_CreateIssue_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	wfRunSvc := &mockIssueWorkflowRunService{}
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
			return issueDBRecord(100, repo.ID, 3, actor.ID, nil), nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return []db.ListIssueAssigneesRow{{ID: 22, Username: "bob"}}, nil
		},
		listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: arg.RepositoryID, Name: "bug", Color: "#d73a4a"}}, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 1, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a"}}, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			switch id {
			case actor.ID:
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			case 22:
				return db.User{ID: id, Username: "bob", LowerUsername: "bob"}, nil
			default:
				return db.User{ID: id, Username: fmt.Sprintf("u-%d", id), LowerUsername: fmt.Sprintf("u-%d", id)}, nil
			}
		},
	}

	svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
	_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
		Title:  "new issue",
		Body:   "desc",
		Labels: []string{"bug"},
	})
	require.NoError(t, err)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	call := wfRunSvc.dispatchCalls[0]
	assert.Equal(t, repo.ID, call.RepositoryID)
	assert.Equal(t, actor.ID, call.UserID)
	assert.Equal(t, "issues", call.Event.Type)
	assert.Equal(t, "opened", call.Event.Action)
	assert.Equal(t, int64(3), call.Event.Inputs["issueNumber"])
	assert.Equal(t, "alice", call.Event.Inputs["issueAuthor"])
	assert.Equal(t, "alice", call.Event.Inputs["repoOwner"])
	assert.Equal(t, "demo", call.Event.Inputs["repoName"])
	assert.Equal(t, "alice/demo", call.Event.Inputs["repoFullName"])
	assert.Equal(t, []string{"bug"}, call.Event.Inputs["issueLabels"])

	issueInput, ok := call.Event.Inputs["issue"].(webhooks.IssuePayload)
	require.True(t, ok)
	assert.Equal(t, int64(3), issueInput.Number)
	require.Len(t, issueInput.Labels, 1)
	assert.Equal(t, "bug", issueInput.Labels[0].Name)
}

func TestIssueService_CreateIssue_WorkflowDispatchErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	wfRunSvc := &mockIssueWorkflowRunService{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, fmt.Errorf("workflow dispatch failed")
		},
	}
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		createIssueFn: func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
			return issueDBRecord(100, repo.ID, 3, actor.ID, nil), nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return nil, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 0, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
	resp, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "new issue"})
	require.NoError(t, err)
	assert.Equal(t, int64(3), resp.Number)
}

func TestIssueService_UpdateIssue_DispatchesWorkflowRunWithCorrectAction(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })

	tests := []struct {
		name       string
		req        UpdateIssueInput
		current    func(*db.Issue)
		labels     []db.Label
		assignees  []db.ListIssueAssigneesRow
		wantAction string
	}{
		{
			name:       "edited",
			req:        UpdateIssueInput{Title: stringPtr("renamed")},
			wantAction: "edited",
		},
		{
			name:       "closed",
			req:        UpdateIssueInput{State: stringPtr("closed")},
			wantAction: "closed",
		},
		{
			name: "reopened",
			req:  UpdateIssueInput{State: stringPtr("open")},
			current: func(issue *db.Issue) {
				issue.State = "closed"
				issue.ClosedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
			},
			wantAction: "reopened",
		},
		{
			name:       "assigned",
			req:        UpdateIssueInput{Assignees: &[]string{"bob"}},
			assignees:  []db.ListIssueAssigneesRow{{ID: 22, Username: "bob"}},
			wantAction: "assigned",
		},
		{
			name:       "labeled",
			req:        UpdateIssueInput{Labels: &[]string{"bug"}},
			labels:     []db.Label{{ID: 7, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a"}},
			wantAction: "labeled",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			current := issueDBRecord(200, repo.ID, 5, actor.ID, tc.current)
			wfRunSvc := &mockIssueWorkflowRunService{}
			q := &mockIssueQuerier{
				getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repo, nil
				},
				getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
					return current, nil
				},
				updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
					row := current
					row.Title = arg.Title
					row.Body = arg.Body
					row.State = arg.State
					row.MilestoneID = arg.MilestoneID
					row.ClosedAt = arg.ClosedAt
					return row, nil
				},
				listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
					return tc.assignees, nil
				},
				listLabelsByNamesFn: func(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
					return tc.labels, nil
				},
				countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
					return int64(len(tc.labels)), nil
				},
				listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
					return tc.labels, nil
				},
				getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
					switch id {
					case actor.ID:
						return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
					case 22:
						return db.User{ID: id, Username: "bob", LowerUsername: "bob"}, nil
					default:
						return db.User{ID: id, Username: fmt.Sprintf("u-%d", id), LowerUsername: fmt.Sprintf("u-%d", id)}, nil
					}
				},
			}

			svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
			_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 5, tc.req)
			require.NoError(t, err)
			require.Len(t, wfRunSvc.dispatchCalls, 1)
			assert.Equal(t, tc.wantAction, wfRunSvc.dispatchCalls[0].Event.Action)
		})
	}
}
func TestIssueService_DispatchesIssuesWebhookOnEditAndClose(t *testing.T) {
	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")

	baseQuerier := func(current db.Issue, updated db.Issue) *mockIssueQuerier {
		return &mockIssueQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
				return current, nil
			},
			updateIssueFn: func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
				row := updated
				row.Title = arg.Title
				row.Body = arg.Body
				row.State = arg.State
				row.MilestoneID = arg.MilestoneID
				row.ClosedAt = arg.ClosedAt
				return row, nil
			},
			listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
				return nil, nil
			},
			countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
				return 0, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
		}
	}

	t.Run("edited action", func(t *testing.T) {
		current := issueDBRecord(200, repo.ID, 5, actor.ID, nil)
		current.State = "open"
		updated := current
		dispatcher := &mockIssueDispatcher{}
		svc := NewIssueService(baseQuerier(current, updated), WithIssueWebhookDispatcher(dispatcher))

		_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 5, UpdateIssueInput{
			Title: stringPtr("renamed"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 1)

		payload, ok := dispatcher.calls[0].payload.(webhooks.IssueEventPayload)
		require.True(t, ok)
		assert.Equal(t, webhooks.EventTypeIssues, dispatcher.calls[0].eventType)
		assert.Equal(t, "edited", payload.Action)
		assert.Equal(t, int64(5), payload.Issue.Number)
	})

	t.Run("closed action", func(t *testing.T) {
		current := issueDBRecord(201, repo.ID, 6, actor.ID, nil)
		current.State = "open"
		updated := current
		updated.State = "closed"
		dispatcher := &mockIssueDispatcher{}
		svc := NewIssueService(baseQuerier(current, updated), WithIssueWebhookDispatcher(dispatcher))

		_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 6, UpdateIssueInput{
			State: stringPtr("closed"),
		})
		require.NoError(t, err)
		require.Len(t, dispatcher.calls, 1)

		payload, ok := dispatcher.calls[0].payload.(webhooks.IssueEventPayload)
		require.True(t, ok)
		assert.Equal(t, webhooks.EventTypeIssues, dispatcher.calls[0].eventType)
		assert.Equal(t, "closed", payload.Action)
		assert.Equal(t, "closed", payload.Issue.State)
	})
}

func TestIssueService_DispatchesIssueCommentWebhookOnCreate(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	dispatcher := &mockIssueDispatcher{}

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, arg.Number, actor.ID, nil), nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return []db.ListIssueAssigneesRow{{ID: 9, Username: "bob"}}, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 1, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a"}}, nil
		},
		createIssueCommentFn: func(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        88,
				IssueID:   arg.IssueID,
				UserID:    arg.UserID,
				Commenter: arg.Commenter,
				Body:      arg.Body,
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWebhookDispatcher(dispatcher))
	comment, err := svc.CreateIssueComment(context.Background(), actor, "alice", "demo", 3, CreateIssueCommentInput{Body: "webhook test comment"})
	require.NoError(t, err)
	assert.Equal(t, int64(88), comment.ID)

	// Dispatcher should have been called once with issue_comment event.
	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.Equal(t, repo.ID, call.repoID)
	assert.Equal(t, webhooks.EventTypeIssueComment, call.eventType)

	payload, ok := call.payload.(webhooks.IssueCommentEventPayload)
	require.True(t, ok, "payload should be IssueCommentEventPayload")
	assert.Equal(t, "created", payload.Action)
	assert.Equal(t, int64(88), payload.Comment.ID)
	assert.Equal(t, "webhook test comment", payload.Comment.Body)
	assert.Equal(t, "alice", payload.Comment.Commenter)
	assert.Equal(t, repo.ID, payload.Repository.ID)
	assert.Equal(t, "alice", payload.Sender.Login)
}

func TestIssueService_CreateIssueComment_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	wfRunSvc := &mockIssueWorkflowRunService{}
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, arg.Number, actor.ID, nil), nil
		},
		listIssueAssigneesFn: func(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error) {
			return []db.ListIssueAssigneesRow{{ID: 9, Username: "bob"}}, nil
		},
		countLabelsForIssueFn: func(ctx context.Context, issueID int64) (int64, error) {
			return 1, nil
		},
		listLabelsForIssueFn: func(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error) {
			return []db.Label{{ID: 7, RepositoryID: repo.ID, Name: "bug", Color: "#d73a4a"}}, nil
		},
		createIssueCommentFn: func(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        88,
				IssueID:   arg.IssueID,
				UserID:    arg.UserID,
				Commenter: arg.Commenter,
				Body:      arg.Body,
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
	_, err := svc.CreateIssueComment(context.Background(), actor, "alice", "demo", 3, CreateIssueCommentInput{Body: "webhook test comment"})
	require.NoError(t, err)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	call := wfRunSvc.dispatchCalls[0]
	assert.Equal(t, repo.ID, call.RepositoryID)
	assert.Equal(t, "issue_comment", call.Event.Type)
	assert.Equal(t, "created", call.Event.Action)

	commentInput, ok := call.Event.Inputs["comment"].(webhooks.IssueCommentPayload)
	require.True(t, ok)
	assert.Equal(t, int64(88), commentInput.ID)

	issueInput, ok := call.Event.Inputs["issue"].(webhooks.IssuePayload)
	require.True(t, ok)
	assert.Equal(t, "alice", issueInput.Author.Login)
	require.Len(t, issueInput.Assignees, 1)
	assert.Equal(t, "bob", issueInput.Assignees[0].Login)
	require.Len(t, issueInput.Labels, 1)
	assert.Equal(t, "bug", issueInput.Labels[0].Name)
}

func TestIssueService_CreateIssueComment_WorkflowDispatchErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	wfRunSvc := &mockIssueWorkflowRunService{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, fmt.Errorf("workflow dispatch failed")
		},
	}
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByNumberFn: func(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, arg.Number, actor.ID, nil), nil
		},
		createIssueCommentFn: func(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        88,
				IssueID:   arg.IssueID,
				UserID:    arg.UserID,
				Commenter: arg.Commenter,
				Body:      arg.Body,
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
	comment, err := svc.CreateIssueComment(context.Background(), actor, "alice", "demo", 3, CreateIssueCommentInput{Body: "webhook test comment"})
	require.NoError(t, err)
	assert.Equal(t, int64(88), comment.ID)
}

func TestIssueService_DispatchesIssueCommentWebhookOnUpdate(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	dispatcher := &mockIssueDispatcher{}

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, 3, actor.ID, nil), nil
		},
		updateIssueCommentFn: func(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        arg.ID,
				IssueID:   7,
				UserID:    pgtype.Int8{Int64: actor.ID, Valid: true},
				Commenter: actor.Username,
				Body:      arg.Body,
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWebhookDispatcher(dispatcher))
	comment, err := svc.UpdateIssueComment(context.Background(), actor, "alice", "demo", 42, UpdateIssueCommentInput{Body: "edited comment body"})
	require.NoError(t, err)
	assert.Equal(t, "edited comment body", comment.Body)

	// Dispatcher should have been called once with issue_comment / "edited" action.
	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.Equal(t, repo.ID, call.repoID)
	assert.Equal(t, webhooks.EventTypeIssueComment, call.eventType)

	payload, ok := call.payload.(webhooks.IssueCommentEventPayload)
	require.True(t, ok, "payload should be IssueCommentEventPayload")
	assert.Equal(t, "edited", payload.Action)
	assert.Equal(t, "edited comment body", payload.Comment.Body)
	assert.Equal(t, repo.ID, payload.Repository.ID)
	assert.Equal(t, "alice", payload.Sender.Login)
}

func TestIssueService_UpdateIssueComment_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	wfRunSvc := &mockIssueWorkflowRunService{}

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, 3, actor.ID, nil), nil
		},
		updateIssueCommentFn: func(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        arg.ID,
				IssueID:   7,
				UserID:    pgtype.Int8{Int64: actor.ID, Valid: true},
				Commenter: actor.Username,
				Body:      arg.Body,
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
	_, err := svc.UpdateIssueComment(context.Background(), actor, "alice", "demo", 42, UpdateIssueCommentInput{Body: "edited comment body"})
	require.NoError(t, err)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	assert.Equal(t, "issue_comment", wfRunSvc.dispatchCalls[0].Event.Type)
	assert.Equal(t, "edited", wfRunSvc.dispatchCalls[0].Event.Action)
}

func TestIssueService_DispatchesIssueCommentWebhookOnDelete(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	dispatcher := &mockIssueDispatcher{}

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, 3, actor.ID, nil), nil
		},
		getIssueCommentByIDFn: func(ctx context.Context, id int64) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        id,
				IssueID:   7,
				UserID:    pgtype.Int8{Int64: actor.ID, Valid: true},
				Commenter: actor.Username,
				Body:      "to be deleted",
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWebhookDispatcher(dispatcher))
	err := svc.DeleteIssueComment(context.Background(), actor, "alice", "demo", 42)
	require.NoError(t, err)

	// Dispatcher should have been called once with issue_comment / "deleted" action.
	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.Equal(t, repo.ID, call.repoID)
	assert.Equal(t, webhooks.EventTypeIssueComment, call.eventType)

	payload, ok := call.payload.(webhooks.IssueCommentEventPayload)
	require.True(t, ok, "payload should be IssueCommentEventPayload")
	assert.Equal(t, "deleted", payload.Action)
	assert.Equal(t, "to be deleted", payload.Comment.Body)
	assert.Equal(t, repo.ID, payload.Repository.ID)
	assert.Equal(t, "alice", payload.Sender.Login)
}

func TestIssueService_DeleteIssueComment_DispatchesWorkflowRun(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	actor := issueTestUser(1, "alice")
	wfRunSvc := &mockIssueWorkflowRunService{}

	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getIssueByCommentIDFn: func(ctx context.Context, commentID int64) (db.Issue, error) {
			return issueDBRecord(7, repo.ID, 3, actor.ID, nil), nil
		},
		getIssueCommentByIDFn: func(ctx context.Context, id int64) (db.IssueComment, error) {
			now := time.Now().UTC()
			return db.IssueComment{
				ID:        id,
				IssueID:   7,
				UserID:    pgtype.Int8{Int64: actor.ID, Valid: true},
				Commenter: actor.Username,
				Body:      "to be deleted",
				Type:      "comment",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	svc := NewIssueService(q, WithIssueWorkflowRunService(wfRunSvc))
	err := svc.DeleteIssueComment(context.Background(), actor, "alice", "demo", 42)
	require.NoError(t, err)

	require.Len(t, wfRunSvc.dispatchCalls, 1)
	assert.Equal(t, "issue_comment", wfRunSvc.dispatchCalls[0].Event.Type)
	assert.Equal(t, "deleted", wfRunSvc.dispatchCalls[0].Event.Action)
}
