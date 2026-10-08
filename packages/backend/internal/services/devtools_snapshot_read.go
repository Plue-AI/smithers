package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type DevtoolsSnapshotReadQuerier interface {
	GetDevtoolsSnapshot(context.Context, db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	ListDevtoolsSnapshotsBySession(context.Context, db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error)
}
type DevtoolsSnapshotReadInput struct{ SessionID, Kind, WorkspaceID string }
type DevtoolsSnapshotReader struct {
	queries DevtoolsSnapshotReadQuerier
	install bool
	pool    *pgxpool.Pool
}

func NewDevtoolsSnapshotReader(q DevtoolsSnapshotReadQuerier, installPools ...*pgxpool.Pool) *DevtoolsSnapshotReader {
	s := &DevtoolsSnapshotReader{queries: q}
	if len(installPools) > 0 {
		s.install = true
		s.pool = installPools[0]
	}
	return s
}
func InstallDevtoolsSnapshotReadSubject(repository int64, in DevtoolsSnapshotReadInput) InstallSubject {
	return InstallSubject{RepositoryID: repository, RunID: in.SessionID, WorkspaceID: in.WorkspaceID, Resource: "devtools:" + in.Kind}
}
func (s *DevtoolsSnapshotReader) Read(ctx context.Context, repository, actor int64, in DevtoolsSnapshotReadInput) ([]db.DevtoolsSnapshot, error) {
	if !s.install {
		return readDevtoolsSnapshotRows(ctx, s.queries, repository, in)
	}
	if s.pool == nil {
		return nil, confirmationPermission()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	subject := InstallDevtoolsSnapshotReadSubject(repository, in)
	decision, err := Authorize(ctx, q, "devtools.read", subject)
	if err != nil {
		return nil, err
	}
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return nil, err
	}
	if installed != repository || actor != decision.UserID {
		return nil, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, "devtools.read", decision, subject)
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return nil, err
	}
	var sessionOwner int64
	err = tx.QueryRow(ctx, `SELECT user_id FROM agent_sessions WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR SHARE`, in.SessionID, repository).Scan(&sessionOwner)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, pkgerrors.NotFound("devtools snapshot not found")
	}
	if err != nil {
		return nil, err
	}
	if sessionOwner != actor {
		return nil, confirmationPermission()
	}
	rows, err := readDevtoolsSnapshotRows(ctx, q, repository, in)
	if err != nil {
		return nil, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return nil, err
	}
	return rows, nil
}
func readDevtoolsSnapshotRows(ctx context.Context, q DevtoolsSnapshotReadQuerier, repository int64, in DevtoolsSnapshotReadInput) ([]db.DevtoolsSnapshot, error) {
	if q == nil {
		return nil, pkgerrors.Internal("devtools snapshot store unavailable")
	}
	var rows []db.DevtoolsSnapshot
	var err error
	if in.Kind != "" {
		var row db.DevtoolsSnapshot
		row, err = q.GetDevtoolsSnapshot(ctx, db.GetDevtoolsSnapshotParams{SessionID: in.SessionID, Kind: in.Kind})
		rows = []db.DevtoolsSnapshot{row}
	} else {
		rows, err = q.ListDevtoolsSnapshotsBySession(ctx, db.ListDevtoolsSnapshotsBySessionParams{RepositoryID: repository, SessionID: in.SessionID})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, pkgerrors.NotFound("devtools snapshot not found")
	}
	if err != nil {
		return nil, err
	}
	out := make([]db.DevtoolsSnapshot, 0, len(rows))
	for _, row := range rows {
		workspace := DevtoolsSnapshotWorkspaceID(row.Payload)
		if row.RepositoryID == repository && (in.WorkspaceID == "" || workspace != nil && *workspace == in.WorkspaceID) {
			out = append(out, row)
		}
	}
	if len(out) == 0 {
		return nil, pkgerrors.NotFound("devtools snapshot not found")
	}
	return out, nil
}
func DevtoolsSnapshotWorkspaceID(payload json.RawMessage) *string {
	var data map[string]any
	if json.Unmarshal(payload, &data) != nil {
		return nil
	}
	raw, ok := data["workspace_id"].(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
