package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func authorizeExecutionMonitor(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	decision, err := authorizeExecutionTodoRead(ctx, q, subject)
	if err != nil {
		return InstallAuthorization{}, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	if subject.Resource != "execution-trace" || subject.RunID == "" || subject.WorkspaceID == "" || subject.Attempt <= 0 || middleware.ParseTokenAgentSessionRestriction(info.RawScopes) != subject.RunID {
		return InstallAuthorization{}, confirmationPermission()
	}
	item, err := q.GetMythicalItemByNumber(ctx, subject.RepositoryID, subject.TodoNumber)
	if err != nil {
		return InstallAuthorization{}, err
	}
	lane, err := q.GetMythicalLane(ctx, subject.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstallAuthorization{}, confirmationPermission()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if lane.RetiredAt.Valid || lane.RepositoryID != subject.RepositoryID || lane.ItemID != item.ID {
		return InstallAuthorization{}, confirmationPermission()
	}
	if item.RequestRunID != subject.RunID || item.Attempt != subject.Attempt {
		return InstallAuthorization{}, confirmationPermission()
	}
	return decision, nil
}

// ReadInstallExecutionMonitor validates the credential, sponsor and current TODO
// before reading, then revalidates that same decision before disclosing bytes.
// The native resolver uses the pool too, so no transaction spans its read.
func ReadInstallExecutionMonitor(ctx context.Context, transactions interface {
	Begin(context.Context) (pgx.Tx, error)
}, repository int64, selector string, read func(context.Context, InstallSubject) (json.RawMessage, error)) (json.RawMessage, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if !InstallExecutionCredential(ctx) || info.User == nil {
		return nil, confirmationPermission()
	}
	tx, err := transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := guardInstallMemberCredential(ctx, tx, repository, info.User.ID, false); err != nil {
		return nil, err
	}
	q := db.New(tx)
	subject, lookup := ResolveInstallExecutionSubject(ctx, q, repository)
	if lookup != nil {
		var refusal *AccessError
		if !errors.As(lookup, &refusal) || refusal.Status != 403 {
			return nil, lookup
		}
	}
	if lookup == nil {
		var attempt int32
		err = tx.QueryRow(ctx, `SELECT attempt FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR SHARE`, repository, subject.TodoNumber).Scan(&attempt)
		if errors.Is(err, pgx.ErrNoRows) {
			lookup = confirmationPermission()
		} else if err != nil {
			return nil, err
		}
		subject.Attempt = attempt
	}
	subject.Resource, subject.RunID = "execution-trace", selector
	if workspace, run, ok := strings.Cut(selector, ":"); ok {
		subject.WorkspaceID, subject.RunID = workspace, run
	}
	decision, err := Authorize(ctx, q, "monitor", subject)
	if err != nil {
		return nil, err
	}
	if lookup != nil {
		return nil, lookup
	}
	// A bound decision cannot bypass a changed stored run or attempt.
	if _, err := authorizeExecutionMonitor(ctx, q, subject); err != nil {
		return nil, err
	}
	ctx = WithInstallAuthorization(ctx, "monitor", decision, subject)
	if err := tx.Rollback(ctx); err != nil {
		return nil, err
	}
	result, readErr := read(ctx, subject)
	final, err := transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = final.Rollback(context.WithoutCancel(ctx)) }()
	if err := guardInstallMemberCredential(ctx, final, repository, info.User.ID, false); err != nil {
		return nil, err
	}
	var present int
	if err := final.QueryRow(ctx, `SELECT 1 FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR SHARE`, repository, subject.TodoNumber).Scan(&present); errors.Is(err, pgx.ErrNoRows) {
		return nil, confirmationPermission()
	} else if err != nil {
		return nil, err
	}
	if _, err := authorizeExecutionMonitor(ctx, db.New(final), subject); err != nil {
		return nil, err
	}
	if readErr != nil {
		return nil, readErr
	}
	return result, nil
}
