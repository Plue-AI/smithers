package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const workspaceOperationTimeoutMS = int64(4 * time.Minute / time.Millisecond)

// ChangeOperationQuerier is the durable operation/revision surface used by
// ChangeOperationService. Operation metadata belongs in the database rather
// than in handlers because the jj operation log may live in a workspace that
// has since been suspended or deleted.
type ChangeOperationQuerier interface {
	GetChangeByChangeID(context.Context, db.GetChangeByChangeIDParams) (db.Change, error)
	GetChangeRevision(context.Context, db.GetChangeRevisionParams) (db.ChangeRevision, error)
	ListJjOperationsForChange(context.Context, db.ListJjOperationsForChangeParams) ([]db.JjOperation, error)
	GetJjOperationForWorkspace(context.Context, db.GetJjOperationForWorkspaceParams) (db.JjOperation, error)
	CountLaterJjOperationsInWorkspace(context.Context, db.CountLaterJjOperationsInWorkspaceParams) (int64, error)
	CreateJjOperation(context.Context, db.CreateJjOperationParams) (db.JjOperation, error)
	UpsertChange(context.Context, db.UpsertChangeParams) (db.Change, error)
	RecordChangeRevision(context.Context, db.RecordChangeRevisionParams) (db.ChangeRevision, error)
}

type ChangeOperationRepoHost interface {
	GetChange(context.Context, string, string, string) (repohost.Change, error)
}

// WorkspaceUndoResult identifies the inverse operation and the operation head
// it was based on. Both are persisted so the server-visible journal preserves
// the real workspace operation graph.
type WorkspaceUndoResult struct {
	OperationID       string
	ParentOperationID string
}

type ChangeOperationWorkspace interface {
	PreviewOperationUndo(context.Context, string, int64, int64, string, []string) (string, error)
	UndoOperation(context.Context, string, int64, int64, string) (WorkspaceUndoResult, error)
}

type ChangeOperationResponse struct {
	OperationID   string    `json:"operation_id"`
	OperationType string    `json:"operation_type"`
	Description   string    `json:"description"`
	Timestamp     time.Time `json:"timestamp"`
	WorkspaceID   *string   `json:"workspace_id"`
	ChangeIDs     []string  `json:"change_ids"`
}

type OperationUndoPreview struct {
	AffectsChanges  []string `json:"affects_changes"`
	LaterOperations int64    `json:"later_operations"`
	State           string   `json:"state"`
}

type OperationUndoResponse struct {
	OperationID       string                   `json:"operation_id"`
	UndoneOperationID string                   `json:"undone_operation_id"`
	AffectsChanges    []string                 `json:"affects_changes"`
	Revisions         []ChangeRevisionResponse `json:"revisions"`
}

type ChangeOperationService struct {
	queries   ChangeOperationQuerier
	repoHost  ChangeOperationRepoHost
	workspace ChangeOperationWorkspace
	pool      *pgxpool.Pool
}

func NewChangeOperationService(queries ChangeOperationQuerier, repoHost ChangeOperationRepoHost, workspace ChangeOperationWorkspace, pool *pgxpool.Pool) *ChangeOperationService {
	return &ChangeOperationService{queries: queries, repoHost: repoHost, workspace: workspace, pool: pool}
}

// ListOperations returns only operations linked to the requested stable
// change. When revisionSeq is present, the immutable revision's operation_ids
// are authoritative; the unscoped view also accepts the operation's denormalized
// change_ids so repo-wide operations appear on every touched change.
func (s *ChangeOperationService) ListOperations(ctx context.Context, repositoryID int64, changeID string, revisionSeq *int64) ([]ChangeOperationResponse, error) {
	if s == nil || s.queries == nil {
		return nil, pkgerrors.Internal("change operation service not configured")
	}
	changeID = strings.TrimSpace(changeID)
	if changeID == "" {
		return nil, pkgerrors.BadRequest("change id is required")
	}
	revision := pgtype.Int8{}
	if revisionSeq != nil {
		if *revisionSeq < 1 {
			return nil, pkgerrors.BadRequest("rev must be a positive integer")
		}
		if _, err := s.queries.GetChangeRevision(ctx, db.GetChangeRevisionParams{RepositoryID: repositoryID, ChangeID: changeID, Seq: *revisionSeq}); err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, pkgerrors.NotFound("change revision not found")
			}
			return nil, pkgerrors.Internal("failed to load change revision").WithCause(err)
		}
		revision = pgtype.Int8{Int64: *revisionSeq, Valid: true}
	} else if _, err := s.queries.GetChangeByChangeID(ctx, db.GetChangeByChangeIDParams{RepositoryID: repositoryID, ChangeID: changeID}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("change not found")
		}
		return nil, pkgerrors.Internal("failed to load change").WithCause(err)
	}

	rows, err := s.queries.ListJjOperationsForChange(ctx, db.ListJjOperationsForChangeParams{
		RepositoryID: repositoryID,
		RevisionSeq:  revision,
		ChangeID:     changeID,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list change operations").WithCause(err)
	}
	result := make([]ChangeOperationResponse, 0, len(rows))
	for _, row := range rows {
		changeIDs := row.ChangeIds
		if changeIDs == nil {
			changeIDs = []string{}
		}
		result = append(result, ChangeOperationResponse{
			OperationID:   row.OperationID,
			OperationType: row.OperationType,
			Description:   row.Description,
			Timestamp:     row.CreatedAt,
			WorkspaceID:   optionalUUIDString(row.WorkspaceID),
			ChangeIDs:     changeIDs,
		})
	}
	return result, nil
}

func (s *ChangeOperationService) PreviewUndo(ctx context.Context, repositoryID, userID int64, workspaceID, operationID string) (OperationUndoPreview, error) {
	operation, later, err := s.loadUndoOperation(ctx, repositoryID, workspaceID, operationID)
	if err != nil {
		return OperationUndoPreview{}, err
	}
	if s.workspace == nil {
		return OperationUndoPreview{}, pkgerrors.Internal("workspace operation execution unavailable")
	}
	state, err := s.workspace.PreviewOperationUndo(ctx, workspaceID, repositoryID, userID, operation.OperationID, operation.ChangeIds)
	if err != nil {
		return OperationUndoPreview{}, err
	}
	if state != "clean" && state != "conflicts" {
		return OperationUndoPreview{}, pkgerrors.Internal("workspace returned an invalid undo preview")
	}
	return OperationUndoPreview{AffectsChanges: operationStrings(operation.ChangeIds), LaterOperations: later, State: state}, nil
}

func (s *ChangeOperationService) Undo(ctx context.Context, repositoryID, userID int64, owner, repo, workspaceID, operationID string) (OperationUndoResponse, error) {
	operation, later, err := s.loadUndoOperation(ctx, repositoryID, workspaceID, operationID)
	if err != nil {
		return OperationUndoResponse{}, err
	}
	if s.workspace == nil || s.repoHost == nil {
		return OperationUndoResponse{}, pkgerrors.Internal("change operation service not configured")
	}
	state, err := s.workspace.PreviewOperationUndo(ctx, workspaceID, repositoryID, userID, operation.OperationID, operation.ChangeIds)
	if err != nil {
		return OperationUndoResponse{}, err
	}
	if state == "conflicts" {
		return OperationUndoResponse{}, pkgerrors.Conflict(fmt.Sprintf("undo would conflict after %d later operations", later))
	}
	if state != "clean" {
		return OperationUndoResponse{}, pkgerrors.Internal("workspace returned an invalid undo preview")
	}

	undo, err := s.workspace.UndoOperation(ctx, workspaceID, repositoryID, userID, operation.OperationID)
	if err != nil {
		return OperationUndoResponse{}, err
	}
	if strings.TrimSpace(undo.OperationID) == "" {
		return OperationUndoResponse{}, pkgerrors.Internal("workspace did not return the undo operation id")
	}

	changes := make([]repohost.Change, 0, len(operation.ChangeIds))
	for _, changeID := range operation.ChangeIds {
		change, loadErr := s.repoHost.GetChange(ctx, owner, repo, changeID)
		if loadErr != nil {
			return OperationUndoResponse{}, mapChangeRepoHostError(loadErr, "failed to load change after undo")
		}
		changes = append(changes, change)
	}
	revisions, err := s.persistUndo(ctx, repositoryID, userID, workspaceID, operation, undo, changes)
	if err != nil {
		return OperationUndoResponse{}, err
	}
	return OperationUndoResponse{
		OperationID:       undo.OperationID,
		UndoneOperationID: operation.OperationID,
		AffectsChanges:    operationStrings(operation.ChangeIds),
		Revisions:         revisions,
	}, nil
}

func (s *ChangeOperationService) loadUndoOperation(ctx context.Context, repositoryID int64, workspaceID, operationID string) (db.JjOperation, int64, error) {
	if s == nil || s.queries == nil {
		return db.JjOperation{}, 0, pkgerrors.Internal("change operation service not configured")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	operationID = strings.TrimSpace(operationID)
	if workspaceID == "" || operationID == "" {
		return db.JjOperation{}, 0, pkgerrors.BadRequest("workspace id and operation id are required")
	}
	operation, err := s.queries.GetJjOperationForWorkspace(ctx, db.GetJjOperationForWorkspaceParams{
		RepositoryID: repositoryID,
		OperationID:  operationID,
		WorkspaceID:  workspaceID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.JjOperation{}, 0, pkgerrors.NotFound("undoable workspace operation not found")
		}
		return db.JjOperation{}, 0, pkgerrors.Internal("failed to load workspace operation").WithCause(err)
	}
	if len(operation.ChangeIds) == 0 {
		return db.JjOperation{}, 0, pkgerrors.Conflict("operation has no server-visible changes to undo")
	}
	later, err := s.queries.CountLaterJjOperationsInWorkspace(ctx, db.CountLaterJjOperationsInWorkspaceParams{
		RepositoryID: repositoryID,
		WorkspaceID:  workspaceID,
		CreatedAt:    operation.CreatedAt,
		ID:           operation.ID,
	})
	if err != nil {
		return db.JjOperation{}, 0, pkgerrors.Internal("failed to count later workspace operations").WithCause(err)
	}
	return operation, later, nil
}

type changeOperationWriter interface {
	CreateJjOperation(context.Context, db.CreateJjOperationParams) (db.JjOperation, error)
	UpsertChange(context.Context, db.UpsertChangeParams) (db.Change, error)
	RecordChangeRevision(context.Context, db.RecordChangeRevisionParams) (db.ChangeRevision, error)
}

func (s *ChangeOperationService) persistUndo(ctx context.Context, repositoryID, userID int64, workspaceID string, original db.JjOperation, undo WorkspaceUndoResult, changes []repohost.Change) ([]ChangeRevisionResponse, error) {
	persist := func(writer changeOperationWriter) ([]ChangeRevisionResponse, error) {
		if _, err := writer.CreateJjOperation(ctx, db.CreateJjOperationParams{
			RepositoryID:      repositoryID,
			OperationID:       undo.OperationID,
			OperationType:     "undo",
			Description:       "undo of op " + original.OperationID,
			UserID:            userID,
			ParentOperationID: undo.ParentOperationID,
			WorkspaceID:       workspaceID,
			ChangeIds:         operationStrings(original.ChangeIds),
		}); err != nil {
			return nil, pkgerrors.Internal("failed to record undo operation").WithCause(err)
		}
		revisions := make([]ChangeRevisionResponse, 0, len(changes))
		for _, change := range changes {
			parents := change.ParentChangeIDs
			if parents == nil {
				parents = []string{}
			}
			parentJSON, err := json.Marshal(parents)
			if err != nil {
				return nil, pkgerrors.Internal("failed to encode undo change parents").WithCause(err)
			}
			if _, err := writer.UpsertChange(ctx, db.UpsertChangeParams{
				RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID,
				Description: change.Description, AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail,
				HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIds: parentJSON,
			}); err != nil {
				return nil, pkgerrors.Internal("failed to store change after undo").WithCause(err)
			}
			revision, err := writer.RecordChangeRevision(ctx, db.RecordChangeRevisionParams{
				RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID,
				ParentCommitID: change.ParentCommitID, Source: "undo", OperationIds: []string{undo.OperationID},
			})
			if err != nil {
				return nil, pkgerrors.Internal("failed to record undo change revision").WithCause(err)
			}
			revisions = append(revisions, ChangeRevisionResponse{
				Seq: revision.Seq, CommitID: revision.CommitID, ParentCommitID: revision.ParentCommitID,
				Source: revision.Source, OperationIDs: operationStrings(revision.OperationIds), CreatedAt: revision.CreatedAt,
			})
		}
		return revisions, nil
	}

	if s.pool == nil {
		return persist(s.queries)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, pkgerrors.Internal("failed to begin undo transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	revisions, err := persist(db.New(tx))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, pkgerrors.Internal("failed to commit undo transaction").WithCause(err)
	}
	return revisions, nil
}

func optionalUUIDString(value pgtype.UUID) *string {
	if !value.Valid {
		return nil
	}
	text := uuidString(value)
	return &text
}

func operationStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// PreviewOperationUndo performs a real inverse operation in a disposable copy
// of the workspace repository, then inspects the copy for conflicts. The live
// workspace operation graph and working copy are never touched by preview.
func (s *WorkspaceService) PreviewOperationUndo(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string, changeIDs []string) (string, error) {
	var state string
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, _ db.Workspace) error {
		var err error
		state, err = s.previewOperationUndo(ctx, workspaceID, repositoryID, userID, operationID, changeIDs)
		return err
	})
	return state, err
}

func (s *WorkspaceService) previewOperationUndo(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string, changeIDs []string) (string, error) {
	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return "", err
	}
	command := buildWorkspaceUndoPreviewCommand(operationID, changeIDs)
	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: workspaceOperationTimeoutPtr()})
	if err != nil {
		return "", pkgerrors.Internal("preview workspace operation undo").WithCause(err)
	}
	if !successfulExecStatus(response) {
		return "", pkgerrors.Conflict("operation can no longer be undone in this workspace")
	}
	state := strings.TrimSpace(response.Stdout)
	if state != "clean" && state != "conflicts" {
		return "", pkgerrors.Internal("invalid workspace undo preview")
	}
	return state, nil
}

// UndoOperation applies the inverse in the owning workspace and publishes all
// affected bookmarks without restoring remote-tracking state. The caller then
// reads canonical changes from repo-host and records their undo revisions.
func (s *WorkspaceService) UndoOperation(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string) (WorkspaceUndoResult, error) {
	var result WorkspaceUndoResult
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, _ db.Workspace) error {
		var err error
		result, err = s.undoOperation(ctx, workspaceID, repositoryID, userID, operationID)
		return err
	})
	return result, err
}

func (s *WorkspaceService) undoOperation(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string) (WorkspaceUndoResult, error) {
	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return WorkspaceUndoResult{}, err
	}
	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: buildWorkspaceUndoCommand(operationID), TimeoutMS: workspaceOperationTimeoutPtr()})
	if err != nil {
		return WorkspaceUndoResult{}, pkgerrors.Internal("undo workspace operation").WithCause(err)
	}
	if !successfulExecStatus(response) {
		return WorkspaceUndoResult{}, pkgerrors.Conflict("workspace operation undo failed")
	}
	lines := strings.Fields(response.Stdout)
	if len(lines) != 2 {
		return WorkspaceUndoResult{}, pkgerrors.Internal("invalid workspace undo result")
	}
	return WorkspaceUndoResult{OperationID: lines[0], ParentOperationID: lines[1]}, nil
}

func buildWorkspaceUndoPreviewCommand(operationID string, changeIDs []string) string {
	changeRevsets := make([]string, 0, len(changeIDs))
	for _, changeID := range changeIDs {
		changeRevsets = append(changeRevsets, "change_id("+strconv.Quote(changeID)+")")
	}
	conflictRevset := "none()"
	if len(changeRevsets) > 0 {
		conflictRevset = "conflicts() & (" + strings.Join(changeRevsets, " | ") + ")"
	}
	return fmt.Sprintf(`set -eu
repo=%s
target=%s
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cp -a --reflink=auto "$repo"/. "$tmp"/
jj -R "$tmp" op revert --what repo "$target" >/dev/null
if [ -n "$(jj -R "$tmp" log -r %s --no-graph -T 'commit_id.short(1)')" ]; then
  printf conflicts
else
  printf clean
fi`, shellQuote(defaultWorkspaceClonePath), shellQuote(operationID), shellQuote(conflictRevset))
}

func buildWorkspaceUndoCommand(operationID string) string {
	return fmt.Sprintf(`set -eu
repo=%s
target=%s
jj -R "$repo" op revert --what repo "$target" >/dev/null
undo=$(jj -R "$repo" --at-operation @ op log -n 1 --no-graph -T 'self.id() ++ "\n"')
parent=$(jj -R "$repo" --at-operation @ op log -n 1 --no-graph -T 'self.parents().first().id() ++ "\n"')
jj -R "$repo" git push --all >/dev/null
printf '%%s\n%%s\n' "$undo" "$parent"`, shellQuote(defaultWorkspaceClonePath), shellQuote(operationID))
}

func workspaceOperationTimeoutPtr() *int64 {
	timeout := workspaceOperationTimeoutMS
	return &timeout
}
