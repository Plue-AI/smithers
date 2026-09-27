package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockIssueWriteTx struct {
	createIssueFn           func(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
	updateIssueFn           func(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error)
	replaceIssueAssigneesFn func(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error
	replaceIssueLabelsFn    func(ctx context.Context, arg db.ReplaceIssueLabelsParams) error
	commitErr               error
	editors                 []string

	calls      []string
	committed  int
	rolledBack bool
}

func (m *mockIssueWriteTx) SetIssueTextEditor(_ context.Context, editor, _ string) error {
	m.editors = append(m.editors, editor)
	return nil
}

func (m *mockIssueWriteTx) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	m.calls = append(m.calls, "CreateIssue")
	if m.createIssueFn != nil {
		return m.createIssueFn(ctx, arg)
	}
	return issueDBRecord(41, arg.RepositoryID, 1, arg.AuthorID, nil), nil
}

func (m *mockIssueWriteTx) UpdateIssue(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
	m.calls = append(m.calls, "UpdateIssue")
	if m.updateIssueFn != nil {
		return m.updateIssueFn(ctx, arg)
	}
	row := issueDBRecord(arg.ID, 77, 3, 1, nil)
	row.Title = arg.Title
	row.State = arg.State
	return row, nil
}

func (m *mockIssueWriteTx) ReplaceIssueAssignees(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error {
	m.calls = append(m.calls, "ReplaceIssueAssignees")
	if m.replaceIssueAssigneesFn != nil {
		return m.replaceIssueAssigneesFn(ctx, arg)
	}
	return nil
}

func (m *mockIssueWriteTx) ReplaceIssueLabels(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
	m.calls = append(m.calls, "ReplaceIssueLabels")
	if m.replaceIssueLabelsFn != nil {
		return m.replaceIssueLabelsFn(ctx, arg)
	}
	return nil
}

func (m *mockIssueWriteTx) CreateIssueComment(context.Context, db.CreateIssueCommentParams) (db.IssueComment, error) {
	m.calls = append(m.calls, "CreateIssueComment")
	return db.IssueComment{}, nil
}

func (m *mockIssueWriteTx) UpdateIssueComment(context.Context, db.UpdateIssueCommentParams) (db.IssueComment, error) {
	m.calls = append(m.calls, "UpdateIssueComment")
	return db.IssueComment{}, nil
}

func (m *mockIssueWriteTx) Commit(context.Context) error {
	if m.commitErr != nil {
		return m.commitErr
	}
	m.committed++
	return nil
}

func (m *mockIssueWriteTx) Rollback(context.Context) error {
	if m.committed == 0 {
		m.rolledBack = true
	}
	return nil
}

type mockIssueWriteTxManager struct {
	tx       *mockIssueWriteTx
	beginErr error
	begins   int
}

func (m *mockIssueWriteTxManager) BeginIssueWriteTx(context.Context) (issueWriteTx, error) {
	m.begins++
	if m.beginErr != nil {
		return nil, m.beginErr
	}
	return m.tx, nil
}

// orderingOwnershipGuard records whether the fenced write had committed by the
// time write() returned, proving the fence spans the whole transaction.
type orderingOwnershipGuard struct {
	tx                   *mockIssueWriteTx
	committedWhenWritten bool
}

func (g *orderingOwnershipGuard) WithRepoOwnershipShared(_ context.Context, _ db.Repository, write func() error) error {
	err := write()
	g.committedWhenWritten = g.tx.committed == 1
	return err
}

func issueTxTestQuerier(actor *db.User) *mockIssueQuerier {
	repo := issueRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	return &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		listLabelsByNamesFn: func(_ context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error) {
			labels := make([]db.Label, 0, len(arg.Names))
			for i, name := range arg.Names {
				labels = append(labels, db.Label{ID: int64(11 + i), RepositoryID: repo.ID, Name: name})
			}
			return labels, nil
		},
	}
}

func TestIssueService_CreateIssue_AssociationFailureRollsBackIssue(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")
	q := issueTxTestQuerier(actor)
	tx := &mockIssueWriteTx{replaceIssueLabelsFn: func(context.Context, db.ReplaceIssueLabelsParams) error {
		return errors.New("label write failed")
	}}
	dispatcher := &mockIssueDispatcher{}
	svc := NewIssueService(q, WithIssueWriteTxManager(&mockIssueWriteTxManager{tx: tx}), WithIssueWebhookDispatcher(dispatcher))

	_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
		Title:     "t",
		Assignees: []string{"bob"},
		Labels:    []string{"bug"},
	})

	assert.Equal(t, 500, issueAPIStatus(t, err))
	assert.Equal(t, []string{"CreateIssue", "ReplaceIssueAssignees", "ReplaceIssueLabels"}, tx.calls)
	assert.True(t, tx.rolledBack)
	assert.Zero(t, tx.committed)
	assert.Empty(t, q.createdIssueEvents)
	assert.Empty(t, dispatcher.calls)
	assert.Zero(t, q.lastCreateIssueArg, "the issue row must be written through the transaction")
}

func TestIssueService_UpdateIssue_AssociationFailureRollsBackUpdate(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")
	q := issueTxTestQuerier(actor)
	tx := &mockIssueWriteTx{replaceIssueAssigneesFn: func(context.Context, db.ReplaceIssueAssigneesParams) error {
		return errors.New("assignee write failed")
	}}
	dispatcher := &mockIssueDispatcher{}
	svc := NewIssueService(q, WithIssueWriteTxManager(&mockIssueWriteTxManager{tx: tx}), WithIssueWebhookDispatcher(dispatcher))

	state := "closed"
	assignees := []string{"bob"}
	_, err := svc.UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{
		State:     &state,
		Assignees: &assignees,
	})

	assert.Equal(t, 500, issueAPIStatus(t, err))
	assert.Equal(t, []string{"UpdateIssue", "ReplaceIssueAssignees"}, tx.calls)
	assert.True(t, tx.rolledBack)
	assert.Zero(t, tx.committed)
	assert.Empty(t, q.createdIssueEvents)
	assert.Empty(t, dispatcher.calls)
	assert.Zero(t, q.lastUpdateIssueArg, "the issue row must be written through the transaction")
}

func TestIssueService_CreateIssue_CommitsOnceInsideOwnershipFence(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")
	q := issueTxTestQuerier(actor)
	var gotLabels db.ReplaceIssueLabelsParams
	var gotAssignees db.ReplaceIssueAssigneesParams
	tx := &mockIssueWriteTx{
		replaceIssueLabelsFn: func(_ context.Context, arg db.ReplaceIssueLabelsParams) error {
			gotLabels = arg
			return nil
		},
		replaceIssueAssigneesFn: func(_ context.Context, arg db.ReplaceIssueAssigneesParams) error {
			gotAssignees = arg
			return nil
		},
	}
	guard := &orderingOwnershipGuard{tx: tx}
	svc := NewIssueService(q, WithIssueWriteTxManager(&mockIssueWriteTxManager{tx: tx}), WithIssueOwnershipGuard(guard))

	resp, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{
		Title:     "t",
		Assignees: []string{"bob"},
		Labels:    []string{"bug", "docs"},
	})

	require.NoError(t, err)
	assert.Equal(t, int64(41), resp.ID)
	assert.Equal(t, 1, tx.committed)
	assert.False(t, tx.rolledBack)
	assert.True(t, guard.committedWhenWritten, "the ownership fence must span the commit")
	assert.Equal(t, db.ReplaceIssueAssigneesParams{IssueID: 41, UserIds: []int64{99}}, gotAssignees)
	assert.Equal(t, db.ReplaceIssueLabelsParams{IssueID: 41, AddedBy: pgtype.Int8{Int64: 1, Valid: true}, LabelIds: []int64{11, 12}}, gotLabels, "the label records who applied it")
	assert.Nil(t, q.lastReplaceAssigneesArg, "associations must not bypass the transaction")
	assert.Nil(t, q.lastReplaceLabelsArg, "associations must not bypass the transaction")
	require.Len(t, q.createdIssueEvents, 1, "timeline event is recorded after commit")
}

func TestIssueService_CreateIssue_WithoutAssociationsSkipsReplace(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")
	tx := &mockIssueWriteTx{}
	svc := NewIssueService(issueTxTestQuerier(actor), WithIssueWriteTxManager(&mockIssueWriteTxManager{tx: tx}))

	_, err := svc.CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "t"})

	require.NoError(t, err)
	assert.Equal(t, []string{"CreateIssue"}, tx.calls)
	assert.Equal(t, 1, tx.committed)
}

func TestIssueService_IssueWriteTxBeginAndCommitFailures(t *testing.T) {
	t.Parallel()

	actor := issueTestUser(1, "alice")

	t.Run("begin failure writes nothing", func(t *testing.T) {
		tx := &mockIssueWriteTx{}
		mgr := &mockIssueWriteTxManager{tx: tx, beginErr: errors.New("pool exhausted")}
		q := issueTxTestQuerier(actor)
		_, err := NewIssueService(q, WithIssueWriteTxManager(mgr)).CreateIssue(context.Background(), actor, "alice", "demo", CreateIssueInput{Title: "t"})
		assert.Equal(t, 500, issueAPIStatus(t, err))
		assert.Empty(t, tx.calls)
		assert.Empty(t, q.createdIssueEvents)
	})

	t.Run("commit failure returns 500 and records no event", func(t *testing.T) {
		tx := &mockIssueWriteTx{commitErr: errors.New("serialization failure")}
		q := issueTxTestQuerier(actor)
		title := "renamed"
		_, err := NewIssueService(q, WithIssueWriteTxManager(&mockIssueWriteTxManager{tx: tx})).UpdateIssue(context.Background(), actor, "alice", "demo", 3, UpdateIssueInput{Title: &title})
		assert.Equal(t, 500, issueAPIStatus(t, err))
		assert.True(t, tx.rolledBack)
		assert.Empty(t, q.createdIssueEvents)
	})
}

func TestNewIssueService_SelectsTxManagerFromQuerier(t *testing.T) {
	t.Parallel()

	_, ok := NewIssueService(db.New(nil)).txManager.(*pgxIssueWriteTxManager)
	assert.True(t, ok, "*db.Queries must get a real transaction manager")
	_, ok = NewIssueService(&mockIssueQuerier{}).txManager.(nonTxIssueWriteTxManager)
	assert.True(t, ok)
}
