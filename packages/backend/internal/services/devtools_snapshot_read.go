package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type DevtoolsSnapshotAPIQuerier interface {
	GetAgentSession(context.Context, string) (db.AgentSession, error)
	UpsertDevtoolsSnapshot(context.Context, db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	GetDevtoolsSnapshot(context.Context, db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error)
	ListDevtoolsSnapshotsBySession(context.Context, db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error)
}
type DevtoolsSnapshotReadInput struct{ SessionID, Kind, WorkspaceID string }
type DevtoolsSnapshotAPI struct {
	queries DevtoolsSnapshotAPIQuerier
	install bool
	pool    *pgxpool.Pool
}

func NewDevtoolsSnapshotAPI(q DevtoolsSnapshotAPIQuerier, installPools ...*pgxpool.Pool) *DevtoolsSnapshotAPI {
	s := &DevtoolsSnapshotAPI{queries: q}
	if len(installPools) > 0 {
		s.install = true
		s.pool = installPools[0]
	}
	return s
}
func InstallDevtoolsSnapshotReadSubject(repository int64, in DevtoolsSnapshotReadInput) InstallSubject {
	return InstallSubject{RepositoryID: repository, RunID: in.SessionID, WorkspaceID: in.WorkspaceID, Resource: "devtools:" + in.Kind}
}

type DevtoolsSnapshotWriteInput struct {
	DevtoolsSnapshotReadInput
	Payload json.RawMessage
}

func InstallDevtoolsSnapshotWriteSubject(repository int64, in DevtoolsSnapshotWriteInput) InstallSubject {
	subject := InstallDevtoolsSnapshotReadSubject(repository, in.DevtoolsSnapshotReadInput)
	digest := sha256.Sum256(in.Payload)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject
}
func (s *DevtoolsSnapshotAPI) Read(ctx context.Context, repository, actor int64, in DevtoolsSnapshotReadInput) ([]db.DevtoolsSnapshot, error) {
	return withDevtoolsSnapshotAction(ctx, s, repository, actor, "devtools.read", InstallDevtoolsSnapshotReadSubject(repository, in), false, func(ctx context.Context, q DevtoolsSnapshotAPIQuerier) ([]db.DevtoolsSnapshot, error) {
		return readDevtoolsSnapshotRows(ctx, q, repository, in)
	})
}
func (s *DevtoolsSnapshotAPI) Write(ctx context.Context, repository, actor int64, in DevtoolsSnapshotWriteInput) (db.DevtoolsSnapshot, error) {
	return withDevtoolsSnapshotAction(ctx, s, repository, actor, "devtools.write", InstallDevtoolsSnapshotWriteSubject(repository, in), true, func(ctx context.Context, q DevtoolsSnapshotAPIQuerier) (db.DevtoolsSnapshot, error) {
		session, err := q.GetAgentSession(ctx, in.SessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return db.DevtoolsSnapshot{}, pkgerrors.NotFound("agent session not found")
		}
		if err != nil {
			return db.DevtoolsSnapshot{}, err
		}
		if session.RepositoryID != repository {
			return db.DevtoolsSnapshot{}, pkgerrors.NotFound("agent session not found")
		}
		return q.UpsertDevtoolsSnapshot(ctx, db.UpsertDevtoolsSnapshotParams{SessionID: in.SessionID, RepositoryID: repository, Kind: in.Kind, Payload: in.Payload})
	})
}
func withDevtoolsSnapshotAction[T any](ctx context.Context, s *DevtoolsSnapshotAPI, repository, actor int64, command string, subject InstallSubject, write bool, effect func(context.Context, DevtoolsSnapshotAPIQuerier) (T, error)) (T, error) {
	var zero T
	if !s.install {
		return effect(ctx, s.queries)
	}
	if s.pool == nil {
		return zero, confirmationPermission()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	decision, err := Authorize(ctx, q, command, subject)
	if err != nil {
		return zero, err
	}
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return zero, err
	}
	if installed != repository || actor != decision.UserID {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return zero, err
	}
	var sessionOwner int64
	err = tx.QueryRow(ctx, `SELECT user_id FROM agent_sessions WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR SHARE`, subject.RunID, repository).Scan(&sessionOwner)
	if errors.Is(err, pgx.ErrNoRows) {
		return zero, pkgerrors.NotFound("devtools snapshot not found")
	}
	if err != nil {
		return zero, err
	}
	if sessionOwner != actor {
		return zero, confirmationPermission()
	}
	result, err := effect(ctx, q)
	if err != nil {
		return zero, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return zero, err
	}
	if write {
		if err = tx.Commit(ctx); err != nil {
			return zero, err
		}
	}
	return result, nil
}
func readDevtoolsSnapshotRows(ctx context.Context, q DevtoolsSnapshotAPIQuerier, repository int64, in DevtoolsSnapshotReadInput) ([]db.DevtoolsSnapshot, error) {
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
