package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type changeTestQueries struct {
	upserts                []db.UpsertChangeParams
	records                []db.RecordChangeRevisionParams
	turnUpdates            []db.UpdateLandingRequestsTurnForRevisionParams
	revisions              []db.ChangeRevision
	reviews                []db.ListChangeReviewsRow
	reviewsErr             error
	landed                 *db.GetChangeLandingProvenanceRow
	landingErr             error
	landedChangeset        *db.Changeset
	landedChangesetErr     error
	approvers              []db.ListChangeLandingApproversRow
	approversErr           error
	walkthroughRevision    db.ChangeRevision
	walkthroughRevisionErr error
	walkthroughRevisionGet db.GetChangeRevisionForWalkthroughParams
	walkthrough            db.ChangeWalkthrough
	walkthroughErr         error
	walkthroughGet         db.GetChangeWalkthroughParams
	walkthroughUpserts     []db.UpsertChangeWalkthroughParams
	walkthroughUpsertErr   error
	changeNotifications    []db.NotifyChangeEventParams
	changeNotificationErr  error
	stack                  db.GetChangeStackRow
	stackErr               error
	agentSessions          map[string]db.AgentSession
	snapshots              map[string]db.WorkspaceSnapshot
	upsertErr              error
	recordErr              error
	revisionSeq            int64
	landingID              int64
	approvals              []db.LandingRequestReview
	usersByID              map[int64]db.User
	teams                  []string
	findings               []db.Finding
	findingFeedbackRows    []db.ListFindingFeedbackForChangeRow
	findingFeedbackErr     error
	upsertFindingFeedback  db.UpsertFindingFeedbackParams
	upsertFeedbackErr      error
	activeFindingDispatch  *db.AgentSession
	activeFindingErr       error
	workspaceBookmark      string
	workspaceBookmarkErr   error
	analyzerRuns           []db.AnalyzerRun
	findingsErr            error
	analyzersErr           error
	findingFilter          pgtype.Int8
	findingFeedbackFilter  pgtype.Int8
	findingFeedbackUser    pgtype.Int8
	analyzerFilter         pgtype.Int8
	conflicts              map[string]db.Conflict
	conflictUpserts        []db.UpsertConflictParams
	conflictDeletes        []db.DeleteConflictsByChangeIDParams
	issueLinks             []db.CreateIssueChangeLinkParams
	linkedIssues           []db.ListLinkedIssuesForChangeRow
	userByIDCalls          []int64
	agentSessionCalls      []string
}

func changeConflictKey(repositoryID int64, changeID, filePath string) string {
	return fmt.Sprintf("%d:%s:%s", repositoryID, changeID, filePath)
}

func (q *changeTestQueries) UpsertChange(_ context.Context, arg db.UpsertChangeParams) (db.Change, error) {
	q.upserts = append(q.upserts, arg)
	return db.Change{RepositoryID: arg.RepositoryID, ChangeID: arg.ChangeID, CommitID: arg.CommitID, RevisionSeq: q.revisionSeq}, q.upsertErr
}

func (q *changeTestQueries) GetLatestLandingRequestForChange(context.Context, db.GetLatestLandingRequestForChangeParams) (db.LandingRequest, error) {
	if q.landingID == 0 {
		return db.LandingRequest{}, pgx.ErrNoRows
	}
	return db.LandingRequest{ID: q.landingID}, nil
}

func (q *changeTestQueries) ListSubmittedLandingApprovals(context.Context, int64) ([]db.LandingRequestReview, error) {
	return q.approvals, nil
}

func (q *changeTestQueries) GetUserByID(_ context.Context, id int64) (db.User, error) {
	q.userByIDCalls = append(q.userByIDCalls, id)
	user, ok := q.usersByID[id]
	if !ok {
		return db.User{}, pgx.ErrNoRows
	}
	return user, nil
}

func (q *changeTestQueries) ListTeamNamesForUserByRepository(context.Context, db.ListTeamNamesForUserByRepositoryParams) ([]string, error) {
	return q.teams, nil
}

func (q *changeTestQueries) GetUserByLowerEmail(context.Context, pgtype.Text) (db.User, error) {
	return db.User{}, pgx.ErrNoRows
}

func (q *changeTestQueries) RecordChangeRevision(_ context.Context, arg db.RecordChangeRevisionParams) (db.ChangeRevision, error) {
	q.records = append(q.records, arg)
	return db.ChangeRevision{RepositoryID: arg.RepositoryID, ChangeID: arg.ChangeID, CommitID: arg.CommitID}, q.recordErr
}

func (q *changeTestQueries) DeleteIssueChangeLinksByChange(_ context.Context, arg db.DeleteIssueChangeLinksByChangeParams) error {
	kept := q.issueLinks[:0]
	for _, link := range q.issueLinks {
		if link.RepositoryID != arg.RepositoryID || link.ChangeID != arg.ChangeID {
			kept = append(kept, link)
		}
	}
	q.issueLinks = kept
	return nil
}

func (q *changeTestQueries) CreateIssueChangeLink(_ context.Context, arg db.CreateIssueChangeLinkParams) error {
	q.issueLinks = append(q.issueLinks, arg)
	return nil
}

func (q *changeTestQueries) ListLinkedIssuesForChange(_ context.Context, _ db.ListLinkedIssuesForChangeParams) ([]db.ListLinkedIssuesForChangeRow, error) {
	return q.linkedIssues, nil
}

func (q *changeTestQueries) UpdateLandingRequestsTurnForRevision(_ context.Context, arg db.UpdateLandingRequestsTurnForRevisionParams) error {
	q.turnUpdates = append(q.turnUpdates, arg)
	return nil
}

func (q *changeTestQueries) UpsertConflict(_ context.Context, arg db.UpsertConflictParams) (db.Conflict, error) {
	q.conflictUpserts = append(q.conflictUpserts, arg)
	if q.conflicts == nil {
		q.conflicts = make(map[string]db.Conflict)
	}
	conflict := db.Conflict{
		RepositoryID: arg.RepositoryID,
		ChangeID:     arg.ChangeID,
		FilePath:     arg.FilePath,
		ConflictType: arg.ConflictType,
	}
	q.conflicts[changeConflictKey(arg.RepositoryID, arg.ChangeID, arg.FilePath)] = conflict
	return conflict, nil
}

func (q *changeTestQueries) GetConflictByPath(_ context.Context, arg db.GetConflictByPathParams) (db.Conflict, error) {
	conflict, ok := q.conflicts[changeConflictKey(arg.RepositoryID, arg.ChangeID, arg.FilePath)]
	if !ok {
		return db.Conflict{}, pgx.ErrNoRows
	}
	return conflict, nil
}

func (q *changeTestQueries) DeleteConflictsByChangeID(_ context.Context, arg db.DeleteConflictsByChangeIDParams) (int64, error) {
	q.conflictDeletes = append(q.conflictDeletes, arg)
	var deleted int64
	for key, conflict := range q.conflicts {
		if conflict.RepositoryID == arg.RepositoryID && conflict.ChangeID == arg.ChangeID {
			delete(q.conflicts, key)
			deleted++
		}
	}
	return deleted, nil
}

func (q *changeTestQueries) ListChangeRevisions(_ context.Context, _ db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
	return q.revisions, nil
}

func (q *changeTestQueries) ListFindingsForChange(_ context.Context, arg db.ListFindingsForChangeParams) ([]db.Finding, error) {
	q.findingFilter = arg.RevisionSeq
	return q.findings, q.findingsErr
}

func (q *changeTestQueries) ListFindingFeedbackForChange(_ context.Context, arg db.ListFindingFeedbackForChangeParams) ([]db.ListFindingFeedbackForChangeRow, error) {
	q.findingFeedbackFilter = arg.RevisionSeq
	q.findingFeedbackUser = arg.UserID
	return q.findingFeedbackRows, q.findingFeedbackErr
}

func (q *changeTestQueries) GetFindingForChange(_ context.Context, arg db.GetFindingForChangeParams) (db.Finding, error) {
	for _, finding := range q.findings {
		if finding.ID == arg.ID && finding.RepositoryID == arg.RepositoryID && finding.ChangeID == arg.ChangeID {
			return finding, nil
		}
	}
	return db.Finding{}, pgx.ErrNoRows
}

func (q *changeTestQueries) UpsertFindingFeedback(_ context.Context, arg db.UpsertFindingFeedbackParams) (db.FindingFeedback, error) {
	q.upsertFindingFeedback = arg
	if q.upsertFeedbackErr != nil {
		return db.FindingFeedback{}, q.upsertFeedbackErr
	}
	return db.FindingFeedback{FindingID: arg.FindingID, UserID: arg.UserID, Useful: arg.Useful, Note: arg.Note}, nil
}

func (q *changeTestQueries) GetActiveFindingDispatch(context.Context, db.GetActiveFindingDispatchParams) (db.AgentSession, error) {
	if q.activeFindingErr != nil {
		return db.AgentSession{}, q.activeFindingErr
	}
	if q.activeFindingDispatch == nil {
		return db.AgentSession{}, pgx.ErrNoRows
	}
	return *q.activeFindingDispatch, nil
}

func (q *changeTestQueries) GetWorkspaceBookmarkForChange(context.Context, db.GetWorkspaceBookmarkForChangeParams) (string, error) {
	if q.workspaceBookmarkErr != nil {
		return "", q.workspaceBookmarkErr
	}
	if q.workspaceBookmark == "" {
		return "", pgx.ErrNoRows
	}
	return q.workspaceBookmark, nil
}

func (q *changeTestQueries) ListAnalyzerRunsForChange(_ context.Context, arg db.ListAnalyzerRunsForChangeParams) ([]db.AnalyzerRun, error) {
	q.analyzerFilter = arg.RevisionSeq
	return q.analyzerRuns, q.analyzersErr
}

func (q *changeTestQueries) ListChangeReviews(_ context.Context, _ db.ListChangeReviewsParams) ([]db.ListChangeReviewsRow, error) {
	return q.reviews, q.reviewsErr
}

func (q *changeTestQueries) GetChangeLandingProvenance(_ context.Context, _ db.GetChangeLandingProvenanceParams) (db.GetChangeLandingProvenanceRow, error) {
	if q.landingErr != nil {
		return db.GetChangeLandingProvenanceRow{}, q.landingErr
	}
	if q.landed == nil {
		return db.GetChangeLandingProvenanceRow{}, pgx.ErrNoRows
	}
	return *q.landed, nil
}

func (q *changeTestQueries) GetLandedChangesetForChange(_ context.Context, _ db.GetLandedChangesetForChangeParams) (db.Changeset, error) {
	if q.landedChangesetErr != nil {
		return db.Changeset{}, q.landedChangesetErr
	}
	if q.landedChangeset == nil {
		return db.Changeset{}, pgx.ErrNoRows
	}
	return *q.landedChangeset, nil
}

func (q *changeTestQueries) ListChangeLandingApprovers(_ context.Context, _ db.ListChangeLandingApproversParams) ([]db.ListChangeLandingApproversRow, error) {
	return q.approvers, q.approversErr
}

func (q *changeTestQueries) GetChangeRevisionForWalkthrough(_ context.Context, arg db.GetChangeRevisionForWalkthroughParams) (db.ChangeRevision, error) {
	q.walkthroughRevisionGet = arg
	return q.walkthroughRevision, q.walkthroughRevisionErr
}

func (q *changeTestQueries) UpsertChangeWalkthrough(_ context.Context, arg db.UpsertChangeWalkthroughParams) (db.ChangeWalkthrough, error) {
	q.walkthroughUpserts = append(q.walkthroughUpserts, arg)
	if q.walkthroughUpsertErr != nil {
		return db.ChangeWalkthrough{}, q.walkthroughUpsertErr
	}
	row := q.walkthrough
	if row.ID == 0 {
		row.ID = 1
	}
	row.ChangeRevisionID = arg.ChangeRevisionID
	row.Sections = arg.Sections
	row.Quiz = arg.Quiz
	return row, nil
}

func (q *changeTestQueries) GetChangeWalkthrough(_ context.Context, arg db.GetChangeWalkthroughParams) (db.ChangeWalkthrough, error) {
	q.walkthroughGet = arg
	return q.walkthrough, q.walkthroughErr
}

func (q *changeTestQueries) NotifyChangeEvent(_ context.Context, arg db.NotifyChangeEventParams) error {
	q.changeNotifications = append(q.changeNotifications, arg)
	return q.changeNotificationErr
}

func (q *changeTestQueries) GetChangeStack(_ context.Context, _ db.GetChangeStackParams) (db.GetChangeStackRow, error) {
	return q.stack, q.stackErr
}

func (q *changeTestQueries) GetAgentSession(_ context.Context, id string) (db.AgentSession, error) {
	q.agentSessionCalls = append(q.agentSessionCalls, id)
	session, ok := q.agentSessions[id]
	if !ok {
		return db.AgentSession{}, pgx.ErrNoRows
	}
	return session, nil
}

func (q *changeTestQueries) GetWorkspaceSnapshotByRepo(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
	snapshot, ok := q.snapshots[arg.ID]
	if !ok || snapshot.RepositoryID != arg.RepositoryID {
		return db.WorkspaceSnapshot{}, pgx.ErrNoRows
	}
	return snapshot, nil
}

type changeTestRepoHost struct {
	pages        map[string][]repohost.Change
	next         map[string]string
	change       repohost.Change
	conflicts    []repohost.Conflict
	listErr      error
	getErr       error
	conflictsErr error
	seenCursors  []string
	files        []repohost.ChangeFile
	filesErr     error
	ownersFile   string
	revisionDiff repohost.ChangeDiff
	diffErr      error
	diffArgs     []string
	splitResult  repohost.SplitChangeResult
	splitErr     error
	splitChange  string
	splitRequest repohost.SplitChangeRequest
}

type changeTestAgent struct {
	createInput   CreateAgentSessionInput
	appendSession string
	appendRole    string
	appendParts   []db.CreateAgentPartParams
	admissionErr  error
	admissions    int
	dispatches    chan DispatchAgentRunInput
	deleted       []string
}

func (a *changeTestAgent) CreateSession(_ context.Context, input CreateAgentSessionInput) (AgentSessionResponse, error) {
	a.createInput = input
	return AgentSessionResponse{ID: "11111111-1111-4111-8111-111111111111", RepositoryID: input.RepositoryID, UserID: input.UserID, Metadata: input.Metadata}, nil
}

func (a *changeTestAgent) AppendMessageAndDispatch(_ context.Context, input DispatchAgentRunInput, parts []db.CreateAgentPartParams) (AgentMessageResponse, error) {
	a.admissions++
	a.appendSession = input.SessionID
	a.appendRole = "user"
	a.appendParts = parts
	if a.admissionErr != nil {
		return AgentMessageResponse{}, a.admissionErr
	}
	a.dispatches <- input
	return AgentMessageResponse{ID: 77, SessionID: input.SessionID, Role: "user"}, nil
}

func (a *changeTestAgent) DeleteSession(_ context.Context, sessionID string, _ int64) error {
	a.deleted = append(a.deleted, sessionID)
	return nil
}

func (r *changeTestRepoHost) ListChanges(_ context.Context, _, _, cursor string, _ int) ([]repohost.Change, string, error) {
	r.seenCursors = append(r.seenCursors, cursor)
	return r.pages[cursor], r.next[cursor], r.listErr
}

func (r *changeTestRepoHost) GetChange(context.Context, string, string, string) (repohost.Change, error) {
	return r.change, r.getErr
}

func (r *changeTestRepoHost) GetChangeDiff(context.Context, string, string, string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{ChangeID: r.change.ChangeID}, r.diffErr
}

func (r *changeTestRepoHost) GetChangeConflicts(context.Context, string, string, string) ([]repohost.Conflict, error) {
	return r.conflicts, r.conflictsErr
}

func (r *changeTestRepoHost) GetChangeFiles(context.Context, string, string, string) ([]repohost.ChangeFile, error) {
	return r.files, r.filesErr
}

func (r *changeTestRepoHost) GetFileAtChange(_ context.Context, _, _, _, filePath string) (repohost.FileContent, error) {
	if filePath == "OWNERS" && r.ownersFile != "" {
		return repohost.FileContent{Content: r.ownersFile}, nil
	}
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
}

func (r *changeTestRepoHost) GetRevisionDiff(_ context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error) {
	r.diffArgs = []string{owner, repo, changeID, fromCommitID, toCommitID, path}
	return r.revisionDiff, r.diffErr
}

func (r *changeTestRepoHost) SplitChange(_ context.Context, _, _, changeID string, req repohost.SplitChangeRequest) (repohost.SplitChangeResult, error) {
	r.splitChange = changeID
	r.splitRequest = req
	return r.splitResult, r.splitErr
}

func TestChangeService_RecordPushRecordsEveryRevisionAndProvenance(t *testing.T) {
	t.Parallel()

	agentID := "11111111-1111-4111-8111-111111111111"
	snapshotID := "22222222-2222-4222-8222-222222222222"
	queries := &changeTestQueries{
		agentSessions: map[string]db.AgentSession{
			agentID: {ID: agentID, RepositoryID: 42},
		},
		snapshots: map[string]db.WorkspaceSnapshot{
			snapshotID: {ID: snapshotID, RepositoryID: 42},
		},
	}
	repoHost := &changeTestRepoHost{
		pages: map[string][]repohost.Change{
			"": {{
				ChangeID:        "change-agent",
				CommitID:        "commit-2",
				ParentCommitID:  "parent-at-2",
				Description:     "Agent rewrite\n\nAgent-Session: " + agentID + "\nWorkspace-Snapshot: " + snapshotID,
				ParentChangeIDs: []string{"change-parent"},
			}},
			"next": {{ChangeID: "change-human", CommitID: "commit-1", ParentCommitID: "parent-at-1"}},
		},
		next: map[string]string{"": "next", "next": ""},
	}

	err := NewChangeService(queries, repoHost, nil).RecordPush(context.Background(), 42, "alice", "demo")

	require.NoError(t, err)
	assert.Equal(t, []string{"", "next"}, repoHost.seenCursors)
	require.Len(t, queries.upserts, 2)
	require.Len(t, queries.records, 2)
	assert.Equal(t, "parent-at-2", queries.records[0].ParentCommitID)
	assert.Equal(t, "agent", queries.records[0].Source)
	assert.Equal(t, agentID, queries.records[0].AgentSessionID)
	assert.Equal(t, snapshotID, queries.records[0].WorkspaceSnapshotID)
	assert.Empty(t, queries.records[0].OperationIds, "pushes do not have the agent workspace operation log")
	assert.Equal(t, "push", queries.records[1].Source)
	require.Len(t, queries.turnUpdates, 2)
	assert.Equal(t, db.UpdateLandingRequestsTurnForRevisionParams{RepositoryID: 42, ChangeID: "change-agent", CommitID: "commit-2"}, queries.turnUpdates[0])
}

func TestChangeService_RecordPushParsesAndReplacesIssueTrailers(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{issueLinks: []db.CreateIssueChangeLinkParams{{RepositoryID: 42, ChangeID: "change-1", IssueNumber: 99, LinkType: "issue"}}}
	repoHost := &changeTestRepoHost{pages: map[string][]repohost.Change{
		"": {{
			ChangeID: "change-1", CommitID: "commit-2",
			Description: "Fix both bugs\n\nIssue: #7, #8\nCloses #8\nCloses: #9\nnot Closes #10",
		}},
	}}

	require.NoError(t, NewChangeService(queries, repoHost, nil).RecordPush(context.Background(), 42, "alice", "demo"))
	require.Equal(t, []db.CreateIssueChangeLinkParams{
		{RepositoryID: 42, ChangeID: "change-1", IssueNumber: 7, LinkType: "issue"},
		{RepositoryID: 42, ChangeID: "change-1", IssueNumber: 8, LinkType: "closes"},
		{RepositoryID: 42, ChangeID: "change-1", IssueNumber: 9, LinkType: "closes"},
	}, queries.issueLinks)
}

func TestChangeService_RecordPushIgnoresForgedProvenance(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{}
	repoHost := &changeTestRepoHost{pages: map[string][]repohost.Change{
		"": {{
			ChangeID:    "change-1",
			CommitID:    "commit-1",
			Description: "Agent-Session: 33333333-3333-4333-8333-333333333333\nWorkspace-Snapshot: not-a-uuid",
		}},
	}}

	err := NewChangeService(queries, repoHost, nil).RecordPush(context.Background(), 42, "alice", "demo")

	require.NoError(t, err)
	require.Len(t, queries.records, 1)
	assert.Equal(t, "push", queries.records[0].Source)
	assert.Empty(t, queries.records[0].AgentSessionID)
	assert.Empty(t, queries.records[0].WorkspaceSnapshotID)
}

func TestChangeService_RecordPushRefreshesConflictCache(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{conflicts: map[string]db.Conflict{
		changeConflictKey(42, "change-1", "old.go"): {
			RepositoryID: 42, ChangeID: "change-1", FilePath: "old.go", ConflictType: "content",
		},
	}}
	repoHost := &changeTestRepoHost{
		pages:     map[string][]repohost.Change{"": {{ChangeID: "change-1", CommitID: "commit-2", HasConflict: true}}},
		conflicts: []repohost.Conflict{{FilePath: "new.go", ConflictType: "rename", ResolutionStatus: "unresolved"}},
	}

	err := NewChangeService(queries, repoHost, nil).RecordPush(context.Background(), 42, "alice", "demo")

	require.NoError(t, err)
	assert.Len(t, queries.conflictDeletes, 1)
	assert.Len(t, queries.conflictUpserts, 1)
	_, oldExists := queries.conflicts[changeConflictKey(42, "change-1", "old.go")]
	assert.False(t, oldExists)
	stored, newExists := queries.conflicts[changeConflictKey(42, "change-1", "new.go")]
	require.True(t, newExists)
	assert.Equal(t, "rename", stored.ConflictType)
}

func TestChangeService_RecordGeneratedRevertDoesNotTrustCopiedTrailers(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{}
	change := repohost.Change{
		ChangeID: "revert-change", CommitID: "revert-commit", ParentCommitID: "main-commit",
		Description: "Revert original\n\nAgent-Session: 11111111-1111-4111-8111-111111111111",
	}
	err := NewChangeService(queries, &changeTestRepoHost{}, nil).RecordGeneratedChange(context.Background(), 42, change, "revert")
	require.NoError(t, err)
	require.Len(t, queries.records, 1)
	assert.Equal(t, "revert", queries.records[0].Source)
	assert.Empty(t, queries.records[0].AgentSessionID)
	assert.Equal(t, "main-commit", queries.records[0].ParentCommitID)
}

func TestChangeService_SplitChangeRecordsBothSplitRevisions(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{}
	original := repohost.Change{
		ChangeID: "change-1", CommitID: "commit-original-2", ParentCommitID: "commit-split-1",
		Description: "original", ParentChangeIDs: []string{"change-2"},
	}
	split := repohost.Change{
		ChangeID: "change-2", CommitID: "commit-split-1", ParentCommitID: "parent-1",
		Description: "focused files", ParentChangeIDs: []string{"parent-change"},
	}
	repoHost := &changeTestRepoHost{
		change:      repohost.Change{ChangeID: "change-1", CommitID: "commit-original-1"},
		splitResult: repohost.SplitChangeResult{Original: original, Split: split},
	}

	got, err := NewChangeService(queries, repoHost, nil).SplitChange(
		context.Background(), 42, "alice", "demo", "change-1",
		SplitChangeInput{Paths: []string{"src/a.go", "src/b.go"}, Description: "focused files"},
	)
	require.NoError(t, err)
	assert.Equal(t, SplitChangeResponse{Original: original, Split: split}, got)
	assert.Equal(t, "change-1", repoHost.splitChange)
	assert.Equal(t, repohost.SplitChangeRequest{Paths: []string{"src/a.go", "src/b.go"}, Description: "focused files"}, repoHost.splitRequest)
	require.Len(t, queries.upserts, 2)
	require.Len(t, queries.records, 2)
	assert.Equal(t, []string{"change-1", "change-2"}, []string{queries.records[0].ChangeID, queries.records[1].ChangeID})
	assert.Equal(t, "split", queries.records[0].Source)
	assert.Equal(t, "split", queries.records[1].Source)
}

func TestChangeService_SplitChangeRejectsLandedOrConflictedChange(t *testing.T) {
	t.Parallel()

	t.Run("landed", func(t *testing.T) {
		queries := &changeTestQueries{landed: &db.GetChangeLandingProvenanceRow{LandingRequestID: 9}}
		repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1"}}
		_, err := NewChangeService(queries, repoHost, nil).SplitChange(context.Background(), 42, "alice", "demo", "change-1", SplitChangeInput{Paths: []string{"a.go"}})
		requireAPIErrorStatus(t, err, http.StatusConflict)
		assert.Empty(t, repoHost.splitChange)
	})

	t.Run("conflicted", func(t *testing.T) {
		queries := &changeTestQueries{}
		repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", HasConflict: true}}
		_, err := NewChangeService(queries, repoHost, nil).SplitChange(context.Background(), 42, "alice", "demo", "change-1", SplitChangeInput{Paths: []string{"a.go"}})
		requireAPIErrorStatus(t, err, http.StatusConflict)
		assert.Empty(t, repoHost.splitChange)
	})

	t.Run("landed changeset member", func(t *testing.T) {
		queries := &changeTestQueries{landedChangeset: &db.Changeset{ID: 10, State: "landed"}}
		repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1"}}
		_, err := NewChangeService(queries, repoHost, nil).SplitChange(context.Background(), 42, "alice", "demo", "change-1", SplitChangeInput{Paths: []string{"a.go"}})
		requireAPIErrorStatus(t, err, http.StatusConflict)
		assert.Empty(t, repoHost.splitChange)
	})
}

func TestChangeService_SplitChangePreservesUnprocessableStatus(t *testing.T) {
	t.Parallel()

	repoHost := &changeTestRepoHost{
		change:   repohost.Change{ChangeID: "change-1"},
		splitErr: &repohost.StatusError{StatusCode: http.StatusUnprocessableEntity, Message: "no listed path is in the change"},
	}
	_, err := NewChangeService(&changeTestQueries{}, repoHost, nil).SplitChange(context.Background(), 42, "alice", "demo", "change-1", SplitChangeInput{Paths: []string{"missing.go"}})
	requireAPIErrorStatus(t, err, http.StatusUnprocessableEntity)
}

func TestChangeService_GetChangeBuildsRevisionAwareDetail(t *testing.T) {
	t.Parallel()

	agentID := uuid.MustParse("11111111-1111-4111-8111-111111111111")
	snapshotID := uuid.MustParse("22222222-2222-4222-8222-222222222222")
	reviewerAgentID := uuid.MustParse("33333333-3333-4333-8333-333333333333").String()
	createdAt := time.Date(2026, 9, 2, 14, 50, 0, 0, time.UTC)
	queries := &changeTestQueries{
		revisions: []db.ChangeRevision{
			{Seq: 1, CommitID: "commit-1", ParentCommitID: "parent-1", Source: "push", OperationIds: []string{}, CreatedAt: createdAt},
			{Seq: 2, CommitID: "commit-2", ParentCommitID: "parent-2", Source: "agent", AgentSessionID: pgtype.UUID{Bytes: agentID, Valid: true}, WorkspaceSnapshotID: pgtype.UUID{Bytes: snapshotID, Valid: true}, OperationIds: []string{"op-1"}, CreatedAt: createdAt.Add(time.Minute)},
		},
		reviews: []db.ListChangeReviewsRow{
			{Reviewer: reviewerAgentID, ReviewerKey: reviewerAgentID, ReviewerKind: "agent", Type: "approve", Verdict: "lgtm", ConfidenceBucket: pgtype.Text{String: "high", Valid: true}, Summary: "Safe to land", CommitID: "commit-2", Seq: 2, LastReviewedSeq: 2},
			{Reviewer: "carol", ReviewerKey: "7", ReviewerKind: "human", Type: "approve", Verdict: "approve", Summary: "LGTM", CommitID: "commit-1", Seq: 1, LastReviewedSeq: 1},
		},
		stack:         db.GetChangeStackRow{LandingRequestID: 9, LandingRequestNumber: 14, Position: 2, Size: 3, TurnParty: "author", TurnActorID: "7", TurnSince: createdAt, TurnReason: "comment"},
		usersByID:     map[int64]db.User{7: {ID: 7, Username: "carol"}},
		agentSessions: map[string]db.AgentSession{reviewerAgentID: {ID: reviewerAgentID, Title: "Review agent"}},
		linkedIssues:  []db.ListLinkedIssuesForChangeRow{{ID: 81, Number: 7, Title: "bug", State: "fixed", LinkType: "closes"}},
	}
	repoHost := &changeTestRepoHost{
		change: repohost.Change{
			ChangeID: "change-1", CommitID: "commit-2", Description: "detail",
			ParentChangeIDs: []string{"parent-change"}, HasConflict: true,
		},
		conflicts: []repohost.Conflict{{FilePath: "main.go", ResolutionStatus: "unresolved"}},
	}

	got, err := NewChangeService(queries, repoHost, nil).GetChange(context.Background(), 42, "alice", "demo", "change-1")

	require.NoError(t, err)
	assert.Equal(t, int64(2), got.CurrentSeq)
	assert.Equal(t, "parent-change", got.ParentChangeID)
	require.Len(t, got.Revisions, 2)
	assert.Equal(t, "parent-2", got.Revisions[1].ParentCommitID)
	assert.Equal(t, agentID.String(), got.Revisions[1].AgentSessionID)
	assert.Equal(t, snapshotID.String(), got.Revisions[1].WorkspaceSnapshotID)
	assert.Equal(t, []string{"op-1"}, got.Revisions[1].OperationIDs)
	require.Len(t, got.Reviews, 2)
	assert.Equal(t, reviewerAgentID, got.Reviews[0].Reviewer)
	assert.Equal(t, "Review agent", got.Reviews[0].ReviewerLogin)
	assert.Equal(t, "agent", got.Reviews[0].ReviewerKind)
	assert.Equal(t, "approve", got.Reviews[0].Type)
	assert.Equal(t, "lgtm", got.Reviews[0].Verdict)
	require.NotNil(t, got.Reviews[0].ConfidenceBucket)
	assert.Equal(t, "high", *got.Reviews[0].ConfidenceBucket)
	assert.Equal(t, int64(2), got.Reviews[0].LastReviewedSeq)
	assert.Nil(t, got.Reviews[1].ConfidenceBucket)
	assert.Equal(t, "carol", got.Reviews[1].Reviewer)
	assert.Equal(t, "carol", got.Reviews[1].ReviewerLogin)
	assert.Equal(t, []ChangeConflictSummary{{Path: "main.go", State: "unresolved"}}, got.Conflicts)
	require.NotNil(t, got.Stack)
	assert.Equal(t, int64(9), got.Stack.LandingRequestID)
	assert.Equal(t, int64(14), got.Stack.LandingRequestNumber)
	assert.Equal(t, LandingRequestTurn{Party: "author", ActorID: "7", ActorLogin: "carol", Since: createdAt, Reason: "comment"}, got.Stack.Turn)
	assert.Equal(t, []int64{7}, queries.userByIDCalls, "the human reviewer and turn actor should share one identity lookup")
	assert.Equal(t, []string{reviewerAgentID}, queries.agentSessionCalls)
	require.NotNil(t, got.Turn)
	assert.Equal(t, got.Stack.Turn, *got.Turn)
	assert.Nil(t, got.Landed)
	require.Equal(t, []ChangeLinkedIssue{{ID: 81, Number: 7, Title: "bug", State: "fixed", LinkType: "closes"}}, got.LinkedIssues)
}

func TestChangeService_GetChangeIncludesLandedProvenance(t *testing.T) {
	t.Parallel()

	landedAt := time.Date(2026, 9, 2, 16, 30, 0, 0, time.UTC)
	queries := &changeTestQueries{
		landed: &db.GetChangeLandingProvenanceRow{
			LandingRequestID:     71,
			LandingRequestNumber: 23,
			LandedAt:             landedAt,
			LandedBy:             "maintainer",
		},
		approvers: []db.ListChangeLandingApproversRow{
			{Login: "alice", Seq: 2},
			{Login: "review-bot", Seq: 3},
		},
	}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-3"}}

	got, err := NewChangeService(queries, repoHost, nil).GetChange(context.Background(), 42, "acme", "demo", "change-1")

	require.NoError(t, err)
	require.NotNil(t, got.Landed)
	assert.Equal(t, int64(71), got.Landed.LandingRequestID)
	assert.Equal(t, int64(23), got.Landed.LandingRequestNumber)
	assert.Equal(t, landedAt, got.Landed.At)
	assert.Equal(t, "maintainer", got.Landed.By)
	assert.Equal(t, []ChangeLandingApprover{
		{Login: "alice", Seq: 2},
		{Login: "review-bot", Seq: 3},
	}, got.Landed.ApprovedBy)
}

func TestChangeService_GetChangeReturnsInternalOnLandingProvenanceFailure(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{landingErr: errors.New("database unavailable")}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1"}}

	_, err := NewChangeService(queries, repoHost, nil).GetChange(context.Background(), 42, "alice", "demo", "change-1")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to load change landing provenance")
}

func TestChangeService_GetChangeReturnsInternalOnRevisionFailure(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueriesWithRevisionError{changeTestQueries: changeTestQueries{}}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1"}}

	_, err := NewChangeService(queries, repoHost, nil).GetChange(context.Background(), 42, "alice", "demo", "change-1")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to list change revisions")
}

func TestChangeService_GetFindingsKeepsStaleRowsAndReportsAnalyzerState(t *testing.T) {
	t.Parallel()

	started := time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC)
	finished := started.Add(30 * time.Second)
	queries := &changeTestQueries{
		revisions: []db.ChangeRevision{
			{Seq: 1, CommitID: "commit-1"},
			{Seq: 2, CommitID: "commit-2"},
		},
		findings: []db.Finding{
			{ID: 1, RevisionSeq: 1, Analyzer: "lint", Source: "analyzer", Path: "old.go", Line: 4, Side: "right", Severity: "warning", Text: "old finding", CreatedAt: started},
			{ID: 2, RevisionSeq: 2, Analyzer: "agent review", Source: "reviewer", Path: "main.go", Line: 8, Side: "right", Severity: "major", Text: "current finding", Suggestion: pgtype.Text{String: "fix()", Valid: true}, CreatedAt: finished},
		},
		findingFeedbackRows: []db.ListFindingFeedbackForChangeRow{
			{FindingID: 1, UsefulCount: 1, NotUsefulCount: 2},
			{FindingID: 2, CallerUseful: pgtype.Bool{Bool: true, Valid: true}, CallerNote: pgtype.Text{String: "helpful", Valid: true}, CallerUserID: pgtype.Int8{Int64: 7, Valid: true}, UsefulCount: 3, NotUsefulCount: 1},
		},
		analyzerRuns: []db.AnalyzerRun{
			{Name: "security", State: "paused", RevisionSeq: 2, PausedBy: pgtype.Text{String: "kill-switch", Valid: true}, PausedReason: pgtype.Text{String: "not-useful threshold exceeded", Valid: true}},
			{Name: "typecheck", State: "failed", RevisionSeq: 2, StartedAt: pgtype.Timestamptz{Time: started, Valid: true}, FinishedAt: pgtype.Timestamptz{Time: finished, Valid: true}, FailureReason: pgtype.Text{String: "worker exited", Valid: true}},
		},
	}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-2"}}

	got, err := NewChangeService(queries, repoHost, nil).GetFindings(context.Background(), 42, "alice", "demo", "change-1", "", 7)

	require.NoError(t, err)
	assert.Equal(t, int64(2), got.CurrentSeq)
	require.Len(t, got.Findings, 2)
	assert.Equal(t, "stale", got.Findings[0].State)
	assert.Equal(t, "commit-1", got.Findings[0].CommitID)
	assert.Equal(t, "current", got.Findings[1].State)
	assert.Equal(t, "fix()", *got.Findings[1].Suggestion)
	require.NotNil(t, got.Findings[1].Feedback)
	assert.True(t, got.Findings[1].Feedback.Useful)
	assert.Equal(t, "helpful", *got.Findings[1].Feedback.Note)
	assert.Equal(t, int64(7), got.Findings[1].Feedback.ByUserID)
	assert.Equal(t, FindingFeedbackCounts{Useful: 3, NotUseful: 1}, got.Findings[1].FeedbackCounts)
	require.Len(t, got.Analyzers, 2)
	assert.Equal(t, "kill-switch", *got.Analyzers[0].PausedBy)
	assert.Equal(t, "not-useful threshold exceeded", *got.Analyzers[0].PausedReason)
	assert.Equal(t, "worker exited", *got.Analyzers[1].FailureReason)
	assert.Equal(t, started, *got.Analyzers[1].StartedAt)
	assert.Equal(t, finished, *got.Analyzers[1].FinishedAt)
	assert.False(t, queries.findingFilter.Valid, "omitting rev must retain findings from every revision")
	assert.Equal(t, pgtype.Int8{Int64: 7, Valid: true}, queries.findingFeedbackUser)
	assert.False(t, queries.analyzerFilter.Valid)
}

func TestChangeService_GetFindingsFiltersAndValidatesRevision(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{revisions: []db.ChangeRevision{{Seq: 1, CommitID: "commit-1"}, {Seq: 2, CommitID: "commit-2"}}}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-2"}}
	service := NewChangeService(queries, repoHost, nil)

	_, err := service.GetFindings(context.Background(), 42, "alice", "demo", "change-1", "1", 0)
	require.NoError(t, err)
	assert.Equal(t, pgtype.Int8{Int64: 1, Valid: true}, queries.findingFilter)
	assert.Equal(t, pgtype.Int8{Int64: 1, Valid: true}, queries.findingFeedbackFilter)
	assert.Equal(t, pgtype.Int8{Int64: 1, Valid: true}, queries.analyzerFilter)

	_, err = service.GetFindings(context.Background(), 42, "alice", "demo", "change-1", "zero", 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "rev must be a positive integer")

	_, err = service.GetFindings(context.Background(), 42, "alice", "demo", "change-1", "3", 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "change revision not found")
}

// recordingRevisionQueries lists the revisions it has recorded, like the
// product table, so a read that records a missing revision sees it.
type recordingRevisionQueries struct {
	changeTestQueries
}

func (q *recordingRevisionQueries) RecordChangeRevision(ctx context.Context, arg db.RecordChangeRevisionParams) (db.ChangeRevision, error) {
	revision, err := q.changeTestQueries.RecordChangeRevision(ctx, arg)
	if err == nil {
		revision.Seq = int64(len(q.revisions) + 1)
		q.revisions = append(q.revisions, revision)
	}
	return revision, err
}

func TestChangeService_GetFindingsRecordsUnrecordedInitialRevision(t *testing.T) {
	t.Parallel()

	queries := &recordingRevisionQueries{}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-1", ParentCommitID: "root"}}
	service := NewChangeService(queries, repoHost, nil)

	got, err := service.GetFindings(context.Background(), 42, "alice", "demo", "change-1", "", 7)

	require.NoError(t, err)
	assert.Equal(t, ChangeFindingsResponse{ChangeID: "change-1", CurrentSeq: 1, Findings: []ChangeFindingResponse{}, Analyzers: []AnalyzerRunResponse{}}, got)
	require.Len(t, queries.records, 1)
	assert.Equal(t, db.RecordChangeRevisionParams{RepositoryID: 42, ChangeID: "change-1", CommitID: "commit-1", ParentCommitID: "root", Source: "push", OperationIds: []string{}}, queries.records[0])

	// The recorded revision is reused, and it is selectable by sequence.
	got, err = service.GetFindings(context.Background(), 42, "alice", "demo", "change-1", "1", 7)
	require.NoError(t, err)
	assert.Equal(t, int64(1), got.CurrentSeq)
	assert.Len(t, queries.records, 1)
	_, err = service.GetFindings(context.Background(), 42, "alice", "demo", "change-1", "2", 7)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "change revision not found")
}

func TestChangeService_GetFindingsRecordsNewHeadOfRecordedChange(t *testing.T) {
	t.Parallel()

	queries := &recordingRevisionQueries{changeTestQueries{revisions: []db.ChangeRevision{{Seq: 1, CommitID: "commit-1"}}}}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-2", HasConflict: true}, conflicts: []repohost.Conflict{{FilePath: "a.go"}}}

	got, err := NewChangeService(queries, repoHost, nil).GetFindings(context.Background(), 42, "alice", "demo", "change-1", "", 0)

	require.NoError(t, err)
	assert.Equal(t, int64(2), got.CurrentSeq)
	require.Len(t, queries.records, 1)
	assert.Equal(t, "commit-2", queries.records[0].CommitID)
}

func TestChangeService_GetFindingsKeepsRefusalsWhenRevisionUnrecorded(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		queries  ChangeRevisionQuerier
		repoHost *changeTestRepoHost
		want     string
		status   int
	}{
		"missing change": {
			queries:  &recordingRevisionQueries{},
			repoHost: &changeTestRepoHost{getErr: &repohost.StatusError{StatusCode: http.StatusNotFound, Message: "change not found"}},
			want:     "change not found", status: http.StatusNotFound,
		},
		"change without commit": {
			queries:  &recordingRevisionQueries{},
			repoHost: &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1"}},
			want:     "repo-host returned a change without an identity", status: http.StatusInternalServerError,
		},
		"revision storage failure": {
			queries:  &recordingRevisionQueries{changeTestQueries{recordErr: errors.New("database unavailable")}},
			repoHost: &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-1"}},
			want:     "failed to store change revision", status: http.StatusInternalServerError,
		},
		"revision list failure": {
			queries:  &changeTestQueriesWithRevisionError{},
			repoHost: &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-1"}},
			want:     "failed to list change revisions", status: http.StatusInternalServerError,
		},
		"conflict read failure": {
			queries:  &recordingRevisionQueries{},
			repoHost: &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-1", HasConflict: true}, conflictsErr: errors.New("repo-host down")},
			want:     "failed to load pushed change conflicts", status: http.StatusInternalServerError,
		},
		"record not visible": {
			queries:  &changeTestQueries{},
			repoHost: &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-1"}},
			want:     "current change revision not recorded", status: http.StatusInternalServerError,
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewChangeService(tc.queries, tc.repoHost, nil).GetFindings(context.Background(), 42, "alice", "demo", "change-1", "", 0)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, tc.status, apiErr.Status)
		})
	}
}

func TestChangeService_SubmitFindingFeedbackUpsertsForCaller(t *testing.T) {
	t.Parallel()

	note := "This explains the failure clearly."
	queries := &changeTestQueries{findings: []db.Finding{{ID: 12, RepositoryID: 42, ChangeID: "change-1"}}}
	response, err := NewChangeService(queries, &changeTestRepoHost{}, nil).SubmitFindingFeedback(context.Background(), SubmitFindingFeedbackInput{
		RepositoryID: 42,
		ChangeID:     "change-1",
		FindingID:    12,
		UserID:       7,
		Useful:       false,
		Note:         &note,
	})

	require.NoError(t, err)
	assert.Equal(t, db.UpsertFindingFeedbackParams{
		FindingID: 12,
		UserID:    7,
		Useful:    false,
		Note:      pgtype.Text{String: note, Valid: true},
	}, queries.upsertFindingFeedback)
	assert.False(t, response.Useful)
	assert.Equal(t, note, *response.Note)
	assert.Equal(t, int64(7), response.ByUserID)
}

func TestChangeService_DispatchFindingUsesTaskMetadataAndChangeWorkspace(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{
		findings:          []db.Finding{{ID: 12, RepositoryID: 42, ChangeID: "change-1", Text: "Handle the nil result before dereferencing it."}},
		workspaceBookmark: "feature/finding-fix",
	}
	agent := &changeTestAgent{dispatches: make(chan DispatchAgentRunInput, 1)}
	service := NewChangeService(queries, &changeTestRepoHost{}, nil, WithChangeConflictAgent(agent))

	response, err := service.DispatchFinding(context.Background(), DispatchFindingInput{
		RepositoryID: 42, UserID: 7, Owner: "alice", Repo: "demo", ChangeID: "change-1", FindingID: 12,
	})

	require.NoError(t, err)
	assert.Equal(t, "11111111-1111-4111-8111-111111111111", response.ID)
	assert.JSONEq(t, `{"finding_id":12}`, string(response.Metadata))
	assert.Equal(t, "Fix finding #12", agent.createInput.Title)
	assert.JSONEq(t, `{"finding_id":12}`, string(agent.createInput.Metadata))
	require.Len(t, agent.appendParts, 1)
	var content map[string]string
	require.NoError(t, json.Unmarshal(agent.appendParts[0].Content, &content))
	assert.Equal(t, "Handle the nil result before dereferencing it.", content["value"])

	select {
	case dispatch := <-agent.dispatches:
		assert.Equal(t, response.ID, dispatch.SessionID)
		assert.Equal(t, "feature/finding-fix", dispatch.SourceBookmark)
		assert.Zero(t, dispatch.TriggerMessageID, "atomic admission assigns the message identity")
		assert.Equal(t, "alice", dispatch.RepoOwner)
		assert.Equal(t, "demo", dispatch.RepoName)
		assert.Empty(t, dispatch.AllowedPaths)
	case <-time.After(time.Second):
		t.Fatal("finding agent dispatch did not start")
	}
}

func TestChangeService_DispatchFindingRejectsActiveDispatch(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{
		findings:              []db.Finding{{ID: 12, RepositoryID: 42, ChangeID: "change-1", Text: "finding"}},
		activeFindingDispatch: &db.AgentSession{ID: "active-session", Status: "active"},
	}
	agent := &changeTestAgent{dispatches: make(chan DispatchAgentRunInput, 1)}
	_, err := NewChangeService(queries, &changeTestRepoHost{}, nil, WithChangeConflictAgent(agent)).DispatchFinding(context.Background(), DispatchFindingInput{
		RepositoryID: 42, UserID: 7, ChangeID: "change-1", FindingID: 12,
	})

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.Empty(t, agent.createInput)
}

func TestChangeService_GetChangeReturnsInternalOnReviewFailure(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{reviewsErr: errors.New("database unavailable")}
	repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-1", CommitID: "commit-1"}}

	_, err := NewChangeService(queries, repoHost, nil).GetChange(context.Background(), 42, "alice", "demo", "change-1")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to list change reviews")
}

type changeTestQueriesWithRevisionError struct {
	changeTestQueries
}

func (q *changeTestQueriesWithRevisionError) ListChangeRevisions(context.Context, db.ListChangeRevisionsParams) ([]db.ChangeRevision, error) {
	return nil, errors.New("database unavailable")
}

// The change detail also answers path ownership: who owns every touched path,
// which agent policy applies, and which approvals are still missing.
func TestChangeService_GetChangeIncludesOwnership(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{revisionSeq: 2}
	repoHost := &changeTestRepoHost{
		change:     repohost.Change{ChangeID: "c1", CommitID: "k2", AuthorName: "alice", ParentChangeIDs: []string{"p1"}},
		files:      []repohost.ChangeFile{{Path: "src/main.go"}},
		ownersFile: "team:platform\nagents: human-approve\n",
	}

	got, err := NewChangeService(queries, repoHost, nil).GetChange(context.Background(), 9, "acme", "demo", "c1")

	require.NoError(t, err)
	assert.Equal(t, int64(2), got.RevisionSeq)
	assert.NotNil(t, got.Reviews)
	assert.Empty(t, got.Reviews)
	require.Len(t, got.Owners.TouchedPaths, 1)
	assert.Equal(t, "src/main.go", got.Owners.TouchedPaths[0].Path)
	assert.Equal(t, "human-approve", got.Owners.TouchedPaths[0].AgentPolicy)
	assert.Equal(t, []string{"team:platform"}, got.Owners.RequiredApprovers)
	assert.Equal(t, []MissingOwnershipApproval{{Path: "src/main.go", Candidates: []string{"team:platform"}}}, got.Owners.MissingApprovals)
}

func TestChangeService_GetChangeDiffResolvesRevisionSequences(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{revisions: []db.ChangeRevision{
		{Seq: 1, CommitID: "commit-one", ParentCommitID: "parent-one"},
		{Seq: 2, CommitID: "commit-two", ParentCommitID: "parent-two"},
	}}
	repoHost := &changeTestRepoHost{
		change: repohost.Change{ChangeID: "canonical-change"},
		revisionDiff: repohost.ChangeDiff{ChangeID: "canonical-change", FileDiffs: []repohost.FileDiff{{
			Path: "src/main.go", ChangeType: "modified", OldContent: "old\n", NewContent: "new\n",
		}}},
	}

	got, err := NewChangeService(queries, repoHost, nil).GetChangeDiff(
		context.Background(), 42, "alice", "demo", "change-prefix",
		ChangeDiffRequest{From: "1", To: "2", Path: "src/main.go"},
	)

	require.NoError(t, err)
	assert.Equal(t, []string{"alice", "demo", "canonical-change", "commit-one", "commit-two", "src/main.go"}, repoHost.diffArgs)
	require.Len(t, got.FileDiffs, 1)
	assert.Equal(t, 1, got.FileDiffs[0].Additions)
	assert.Equal(t, 1, got.FileDiffs[0].Deletions)
	assert.Contains(t, got.FileDiffs[0].Patch, "-old")
	assert.Contains(t, got.FileDiffs[0].Patch, "+new")
}

func TestChangeService_GetChangeDiffParentUsesDestinationParent(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{revisions: []db.ChangeRevision{{Seq: 3, CommitID: "commit-three", ParentCommitID: "parent-three"}}}
	repoHost := &changeTestRepoHost{
		change:       repohost.Change{ChangeID: "change-one"},
		revisionDiff: repohost.ChangeDiff{ChangeID: "change-one", FileDiffs: []repohost.FileDiff{}},
	}

	_, err := NewChangeService(queries, repoHost, nil).GetChangeDiff(
		context.Background(), 9, "acme", "demo", "change-one",
		ChangeDiffRequest{From: "parent", To: "3"},
	)

	require.NoError(t, err)
	assert.Equal(t, []string{"acme", "demo", "change-one", "", "commit-three", ""}, repoHost.diffArgs)
}

func TestChangeService_GetChangeDiffRejectsInvalidOrMissingSequences(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		request    ChangeDiffRequest
		revisions  []db.ChangeRevision
		wantStatus int
	}{
		{name: "missing to", request: ChangeDiffRequest{From: "1"}, wantStatus: http.StatusBadRequest},
		{name: "parent destination", request: ChangeDiffRequest{From: "1", To: "parent"}, wantStatus: http.StatusBadRequest},
		{name: "zero source", request: ChangeDiffRequest{From: "0", To: "2"}, wantStatus: http.StatusBadRequest},
		{name: "missing source revision", request: ChangeDiffRequest{From: "1", To: "2"}, revisions: []db.ChangeRevision{{Seq: 2, CommitID: "two"}}, wantStatus: http.StatusNotFound},
		{name: "missing destination revision", request: ChangeDiffRequest{From: "parent", To: "2"}, revisions: []db.ChangeRevision{{Seq: 1, CommitID: "one"}}, wantStatus: http.StatusNotFound},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			queries := &changeTestQueries{revisions: test.revisions}
			repoHost := &changeTestRepoHost{change: repohost.Change{ChangeID: "change-one"}}
			_, err := NewChangeService(queries, repoHost, nil).GetChangeDiff(
				context.Background(), 1, "acme", "demo", "change-one", test.request,
			)
			require.Error(t, err)
			var apiErr *pkgerrors.APIError
			require.True(t, errors.As(err, &apiErr))
			assert.Equal(t, test.wantStatus, apiErr.Status)
		})
	}
}

func TestChangeService_ResolveConflictDispatchesPathScopedAgent(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{conflicts: map[string]db.Conflict{
		changeConflictKey(42, "change-1", "src/conflicted.go"): {
			RepositoryID: 42,
			ChangeID:     "change-1",
			FilePath:     "src/conflicted.go",
			ConflictType: "content",
		},
	}}
	agent := &changeTestAgent{dispatches: make(chan DispatchAgentRunInput, 1)}
	service := NewChangeService(queries, &changeTestRepoHost{}, nil, WithChangeConflictAgent(agent))

	response, err := service.ResolveConflict(context.Background(), ResolveChangeConflictInput{
		RepositoryID: 42,
		UserID:       7,
		Owner:        "alice",
		Repo:         "demo",
		ChangeID:     "change-1",
		Path:         "src/conflicted.go",
	})

	require.NoError(t, err)
	assert.Equal(t, "11111111-1111-4111-8111-111111111111", response.AgentSessionID)
	assert.Equal(t, CreateAgentSessionInput{RepositoryID: 42, UserID: 7, Title: "Resolve change conflict"}, agent.createInput)
	assert.Equal(t, response.AgentSessionID, agent.appendSession)
	assert.Equal(t, "user", agent.appendRole)
	require.Len(t, agent.appendParts, 1)
	var content map[string]string
	require.NoError(t, json.Unmarshal(agent.appendParts[0].Content, &content))
	assert.Contains(t, content["value"], `path "src/conflicted.go"`)
	assert.Contains(t, content["value"], "Agent-Session: "+response.AgentSessionID)

	select {
	case dispatch := <-agent.dispatches:
		assert.Equal(t, response.AgentSessionID, dispatch.SessionID)
		assert.Zero(t, dispatch.TriggerMessageID, "atomic admission assigns the message identity")
		assert.Equal(t, "alice", dispatch.RepoOwner)
		assert.Equal(t, "demo", dispatch.RepoName)
		assert.Equal(t, []string{"src/conflicted.go"}, dispatch.AllowedPaths)
		assert.Equal(t, "smithers", dispatch.AgentProvider)
		assert.Equal(t, "workflow", dispatch.AgentTransport)
	case <-time.After(time.Second):
		t.Fatal("agent dispatch did not start")
	}
}

func TestChangeService_ResolveConflictRejectsMissingAndResolvedPaths(t *testing.T) {
	t.Parallel()

	queries := &changeTestQueries{conflicts: map[string]db.Conflict{
		changeConflictKey(42, "change-1", "resolved.go"): {
			RepositoryID: 42,
			ChangeID:     "change-1",
			FilePath:     "resolved.go",
			ConflictType: "content",
			Resolved:     true,
		},
	}}
	agent := &changeTestAgent{dispatches: make(chan DispatchAgentRunInput, 1)}
	service := NewChangeService(queries, &changeTestRepoHost{}, nil, WithChangeConflictAgent(agent))

	_, missingErr := service.ResolveConflict(context.Background(), ResolveChangeConflictInput{
		RepositoryID: 42, UserID: 7, ChangeID: "change-1", Path: "missing.go",
	})
	_, resolvedErr := service.ResolveConflict(context.Background(), ResolveChangeConflictInput{
		RepositoryID: 42, UserID: 7, ChangeID: "change-1", Path: "resolved.go",
	})
	_, unsafeErr := service.ResolveConflict(context.Background(), ResolveChangeConflictInput{
		RepositoryID: 42, UserID: 7, ChangeID: "change-1", Path: "src/*.go",
	})

	var missingAPIError *pkgerrors.APIError
	require.ErrorAs(t, missingErr, &missingAPIError)
	assert.Equal(t, http.StatusNotFound, missingAPIError.Status)
	var resolvedAPIError *pkgerrors.APIError
	require.ErrorAs(t, resolvedErr, &resolvedAPIError)
	assert.Equal(t, http.StatusConflict, resolvedAPIError.Status)
	var unsafeAPIError *pkgerrors.APIError
	require.ErrorAs(t, unsafeErr, &unsafeAPIError)
	assert.Equal(t, http.StatusBadRequest, unsafeAPIError.Status)
	assert.Empty(t, agent.createInput)
}

func TestChangeService_DispatchAdmissionFailureDoesNotAcknowledge(t *testing.T) {
	for _, finding := range []bool{true, false} {
		t.Run(fmt.Sprint("finding=", finding), func(t *testing.T) {
			queries := &changeTestQueries{findings: []db.Finding{{ID: 12, RepositoryID: 42, ChangeID: "change-1", Text: "repair"}}, conflicts: map[string]db.Conflict{changeConflictKey(42, "change-1", "src/conflicted.go"): {RepositoryID: 42, ChangeID: "change-1", FilePath: "src/conflicted.go"}}}
			admissionErr := errors.New("durable admission unavailable")
			agent := &changeTestAgent{admissionErr: admissionErr, dispatches: make(chan DispatchAgentRunInput, 1)}
			service := NewChangeService(queries, &changeTestRepoHost{}, nil, WithChangeConflictAgent(agent))
			var err error
			if finding {
				_, err = service.DispatchFinding(t.Context(), DispatchFindingInput{RepositoryID: 42, UserID: 7, Owner: "alice", Repo: "demo", ChangeID: "change-1", FindingID: 12})
			} else {
				_, err = service.ResolveConflict(t.Context(), ResolveChangeConflictInput{RepositoryID: 42, UserID: 7, Owner: "alice", Repo: "demo", ChangeID: "change-1", Path: "src/conflicted.go"})
			}
			require.ErrorIs(t, err, admissionErr)
			require.Equal(t, 1, agent.admissions)
			require.Equal(t, []string{"11111111-1111-4111-8111-111111111111"}, agent.deleted)
			require.Empty(t, agent.dispatches)
		})
	}
}
