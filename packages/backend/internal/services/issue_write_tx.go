package services

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// issueWriteTx is the transaction an issue mutation runs in: the issue row
// write and the assignee/label replacement commit together or not at all, so
// a failed association write never leaves a committed issue behind a 500.
type issueWriteTx interface {
	CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
	UpdateIssue(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error)
	ReplaceIssueAssignees(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error
	ReplaceIssueLabels(ctx context.Context, arg db.ReplaceIssueLabelsParams) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type issueWriteTxManager interface {
	BeginIssueWriteTx(ctx context.Context) (issueWriteTx, error)
}

// WithIssueWriteTxManager overrides how IssueService begins issue write
// transactions. NewIssueService derives one from a *db.Queries, so production
// wiring never needs this; tests use it to inject failures.
func WithIssueWriteTxManager(m issueWriteTxManager) IssueServiceOption {
	return func(s *IssueService) {
		s.txManager = m
	}
}

// issueTxQuerier is satisfied by *db.Queries.
type issueTxQuerier interface {
	IssueQuerier
	BeginTx(ctx context.Context) (pgx.Tx, error)
	WithTx(tx pgx.Tx) *db.Queries
}

type pgxIssueWriteTxManager struct {
	q issueTxQuerier
}

func (m *pgxIssueWriteTxManager) BeginIssueWriteTx(ctx context.Context) (issueWriteTx, error) {
	tx, err := m.q.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxIssueWriteTx{tx: tx, q: m.q.WithTx(tx)}, nil
}

type pgxIssueWriteTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxIssueWriteTx) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	return t.q.CreateIssue(ctx, arg)
}

func (t *pgxIssueWriteTx) UpdateIssue(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
	return t.q.UpdateIssue(ctx, arg)
}

func (t *pgxIssueWriteTx) ReplaceIssueAssignees(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error {
	return t.q.ReplaceIssueAssignees(ctx, arg)
}

func (t *pgxIssueWriteTx) ReplaceIssueLabels(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
	return t.q.ReplaceIssueLabels(ctx, arg)
}

func (t *pgxIssueWriteTx) Commit(ctx context.Context) error   { return t.tx.Commit(ctx) }
func (t *pgxIssueWriteTx) Rollback(ctx context.Context) error { return t.tx.Rollback(ctx) }

// nonTxIssueWriteTxManager runs the same statements without a transaction. It
// is selected only when the querier cannot begin one (unit-test mocks);
// production passes a *db.Queries and gets pgxIssueWriteTxManager.
type nonTxIssueWriteTxManager struct {
	q IssueQuerier
}

func (m nonTxIssueWriteTxManager) BeginIssueWriteTx(context.Context) (issueWriteTx, error) {
	return nonTxIssueWriteTx{q: m.q}, nil
}

type nonTxIssueWriteTx struct {
	q IssueQuerier
}

func (t nonTxIssueWriteTx) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	return t.q.CreateIssue(ctx, arg)
}

func (t nonTxIssueWriteTx) UpdateIssue(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error) {
	return t.q.UpdateIssue(ctx, arg)
}

func (t nonTxIssueWriteTx) ReplaceIssueAssignees(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error {
	return t.q.ReplaceIssueAssignees(ctx, arg)
}

func (t nonTxIssueWriteTx) ReplaceIssueLabels(ctx context.Context, arg db.ReplaceIssueLabelsParams) error {
	return t.q.ReplaceIssueLabels(ctx, arg)
}

func (nonTxIssueWriteTx) Commit(context.Context) error   { return nil }
func (nonTxIssueWriteTx) Rollback(context.Context) error { return nil }

func newIssueWriteTxManager(q IssueQuerier) issueWriteTxManager {
	if txq, ok := q.(issueTxQuerier); ok {
		return &pgxIssueWriteTxManager{q: txq}
	}
	return nonTxIssueWriteTxManager{q: q}
}

// withIssueWriteTx runs fn in one issue write transaction and commits it only
// when fn succeeds. The deferred rollback is a no-op after a commit.
func (s *IssueService) withIssueWriteTx(ctx context.Context, fn func(tx issueWriteTx) error) error {
	tx, err := s.txManager.BeginIssueWriteTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin issue write").WithCause(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit issue write").WithCause(err)
	}
	return nil
}

// replaceIssueAssociations applies the pre-validated assignee and label sets
// inside tx. A nil pointer leaves that association untouched.
func replaceIssueAssociations(ctx context.Context, tx issueWriteTx, issueID int64, assigneeIDs, labelIDs *[]int64) error {
	if assigneeIDs != nil {
		if err := tx.ReplaceIssueAssignees(ctx, db.ReplaceIssueAssigneesParams{IssueID: issueID, UserIds: *assigneeIDs}); err != nil {
			return pkgerrors.Internal("failed to update issue assignees").WithCause(err)
		}
	}
	if labelIDs != nil {
		if err := tx.ReplaceIssueLabels(ctx, db.ReplaceIssueLabelsParams{IssueID: issueID, LabelIds: *labelIDs}); err != nil {
			return pkgerrors.Internal("failed to update issue labels").WithCause(err)
		}
	}
	return nil
}

func (t *pgxIssueWriteTx) FindIssueRequest(ctx context.Context, repo, author int64, key string) (db.Issue, error) {
	if _, err := t.tx.Exec(ctx, `SELECT id FROM repositories WHERE id=$1 FOR UPDATE`, repo); err != nil {
		return db.Issue{}, err
	}
	var number int64
	if err := t.tx.QueryRow(ctx, `SELECT number FROM issues WHERE repository_id=$1 AND author_id=$2 AND idempotency_key=$3`, repo, author, key).Scan(&number); err != nil {
		return db.Issue{}, err
	}
	return t.q.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repo, Number: number})
}
