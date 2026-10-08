package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"net/http"
	"strconv"
	"strings"
)

// InstallBranchForkSubject binds every caller to the requested repository and
// fork payload. Execution credentials may fork only their current TODO.
func InstallBranchForkSubject(ctx context.Context, repository int64, input BranchForkInput) InstallSubject {
	subject := InstallSubject{RepositoryID: repository, WorkspaceID: input.WorkspaceID}
	if match := branchForkTodo.FindStringSubmatch(strings.TrimSpace(input.From)); match != nil {
		subject.TodoNumber, _ = strconv.ParseInt(match[1], 10, 64)
	}
	raw, _ := json.Marshal(input)
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject
}

func guardInstallForkWrite(ctx context.Context, tx pgx.Tx, repository, actor int64, input BranchForkInput) error {
	if err := guardInstallTodoWrite(ctx, tx, repository, actor); err != nil {
		return err
	}
	if !InstallExecutionCredential(ctx) {
		return nil
	}
	subject := InstallBranchForkSubject(ctx, repository, input)
	var present int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR SHARE`, repository, subject.TodoNumber).Scan(&present); err != nil {
		if err == pgx.ErrNoRows {
			return confirmationPermission()
		}
		return err
	}
	// Recheck stored sponsor/run/workspace under the write lock; the command's
	// catalog decision is still the single bound admission decision.
	_, err := authorizeExecutionTodoRead(ctx, db.New(tx), subject)
	return err
}

// New execution forks have their own credential-scoped replay key. Preserve
// existing session/delegated identities so their persisted receipts stay readable.
func branchForkRequestCredential(ctx context.Context, actor int64) (string, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if info != nil && info.User != nil && info.User.ID == actor && info.IsTokenAuth && info.TokenSystemIssued && info.TokenID > 0 && info.TokenHash != "" && info.CredentialKind() == middleware.CredentialAgentRun {
		identity, _ := json.Marshal([]any{"run", info.TokenID, actor, info.TokenHash})
		return string(identity), nil
	}
	return todoRequestCredential(ctx, actor)
}

// InstallWorkspaceForkSubject resolves the retained route from stored state.
// The revision writer resolves it again so a changed source cannot reuse the
// admission decision. Workspace ACL checks stay in withWorkspaceMutation.
func InstallWorkspaceForkSubject(ctx context.Context, q *db.Queries, input ForkWorkspaceInput) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: input.RepositoryID, WorkspaceID: input.WorkspaceID}
	source, err := q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: input.WorkspaceID, RepositoryID: input.RepositoryID})
	if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
		return subject, &BranchError{404, "not_found", "user", "Workspace not found"}
	}
	if err != nil {
		return subject, err
	}
	resolved, err := workspaceForkRevisionInput(ctx, q, source, input)
	if err != nil {
		return subject, err
	}
	return InstallBranchForkSubject(ctx, input.RepositoryID, resolved), nil
}
func workspaceForkRevisionInput(ctx context.Context, q *db.Queries, source db.Workspace, input ForkWorkspaceInput) (BranchForkInput, error) {
	resolved := BranchForkInput{From: "main", Name: input.Name, Request: input.Request, WorkspaceID: source.ID}
	if strings.HasPrefix(source.TargetBookmark, scratchBranchPrefix) {
		resolved.From = source.TargetBookmark
		return resolved, nil
	}
	number, err := q.MythicalForkItemNumber(ctx, source.RepositoryID, source.ID)
	if err == nil {
		resolved.From = "T" + strconv.FormatInt(number, 10)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return resolved, err
	} else if source.TargetBookmark != "main" {
		return resolved, &BranchError{http.StatusConflict, "no_verified_head", "conflict", "Workspace has no verified revision to fork"}
	}
	return resolved, nil
}
