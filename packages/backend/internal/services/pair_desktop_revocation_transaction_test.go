package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type desktopShareCommitProbe struct {
	pool        *pgxpool.Pool
	workspaceID string
	memberID    int64
	levels      []string
	events      []revocation.Event
	readErr     error
	deadlineSet bool
	ctxErr      error
}

func (p *desktopShareCommitProbe) Publish(ctx context.Context, event revocation.Event) error {
	_, p.deadlineSet = ctx.Deadline()
	p.ctxErr = ctx.Err()
	var level string
	p.readErr = p.pool.QueryRow(ctx,
		`SELECT level FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
		p.workspaceID, p.memberID).Scan(&level)
	p.levels = append(p.levels, level)
	p.events = append(p.events, event)
	return p.readErr
}

type cancelAfterCommitBegin struct {
	pool   *pgxpool.Pool
	cancel context.CancelFunc
}

func (b cancelAfterCommitBegin) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &cancelAfterCommitTx{Tx: tx, cancel: b.cancel}, nil
}

type cancelAfterCommitTx struct {
	pgx.Tx
	cancel context.CancelFunc
}

func (tx *cancelAfterCommitTx) Commit(ctx context.Context) error {
	err := tx.Tx.Commit(ctx)
	if err == nil {
		tx.cancel()
	}
	return err
}

type failRevocationBegin struct {
	pool  *pgxpool.Pool
	mode  string
	err   error
	calls *int
}

func (b failRevocationBegin) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &failRevocationTx{Tx: tx, mode: b.mode, err: b.err, calls: b.calls}, nil
}

type failRevocationTx struct {
	pgx.Tx
	mode  string
	err   error
	calls *int
}

type failRevocationRow struct{ err error }

func (r failRevocationRow) Scan(...any) error { return r.err }

func (tx *failRevocationTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if tx.mode == "insert" && strings.Contains(sql, "-- name: InsertRevocationEvent :one") {
		(*tx.calls)++
		return failRevocationRow{err: tx.err}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func (tx *failRevocationTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if tx.mode == "notify" && strings.Contains(sql, "-- name: NotifyRevocation :exec") {
		(*tx.calls)++
		return pgconn.CommandTag{}, tx.err
	}
	return tx.Tx.Exec(ctx, sql, args...)
}

func TestPairDesktopDowngradeRevocationIsPublishedAfterCommitAndDiscardedOnRollback(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "desktop-tx-owner")
	editor := mkPairUser(t, fx.pool, "desktop-tx-editor")
	source := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	pairs := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
	session, err := pairs.CreateSession(ctx, owner, fx.repoID, source)
	require.NoError(t, err)
	workspaceID := UUIDString(session.WorkspaceID)
	link, err := pairs.MintLink(ctx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)
	_, err = pairs.ResolveByLink(ctx, link.Slug, editor)
	require.NoError(t, err)
	probe := &desktopShareCommitProbe{pool: fx.pool, workspaceID: workspaceID, memberID: editor}
	pairs.revocations = probe

	_, err = pairs.SetMemberRole(ctx, session.ID, owner, editor, PairRoleViewer)
	require.NoError(t, err)
	require.NoError(t, probe.readErr)
	require.Equal(t, []string{"read"}, probe.levels, "event must be visible only after downgraded share commits")
	require.Len(t, probe.events, 1)
	require.Equal(t, revocation.KindWorkspaceShareRemoved, probe.events[0].Kind)
	require.Equal(t, editor, probe.events[0].UserID)
	require.Equal(t, workspaceID, probe.events[0].WorkspaceID)

	rollback := errors.New("force mutation rollback")
	err = pairs.withPairSessionMutation(ctx, session.ID, func(locked *PairSessionService) error {
		_, err := locked.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
			WorkspaceID: workspaceID, OwnerUserID: owner, GranteeUserID: editor, Level: "write",
		})
		if err != nil {
			return err
		}
		revocation.PublishBestEffort(ctx, locked.revocations, revocation.Event{
			Kind: revocation.KindWorkspaceShareRemoved, UserID: editor, WorkspaceID: workspaceID,
		})
		return rollback
	})
	require.ErrorIs(t, err, rollback)
	require.Len(t, probe.events, 1, "rolled-back mutation must not announce a revocation")
	var level string
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT level FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
		workspaceID, editor).Scan(&level))
	require.Equal(t, "read", level, "rolled-back mutation must not change the share")

	// The durable publisher must also use the mutation transaction: a failed
	// mutation cannot leave an event row that would close healthy relays.
	pairs.revocations = revocation.NewDBPublisher(db.New(fx.pool), nil)
	err = pairs.withPairSessionMutation(ctx, session.ID, func(locked *PairSessionService) error {
		_, err := locked.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
			WorkspaceID: workspaceID, OwnerUserID: owner, GranteeUserID: editor, Level: "write",
		})
		if err != nil {
			return err
		}
		revocation.PublishBestEffort(ctx, locked.revocations, revocation.Event{
			Kind: revocation.KindWorkspaceShareRemoved, UserID: editor, WorkspaceID: workspaceID,
		})
		return rollback
	})
	require.ErrorIs(t, err, rollback)
	var eventRows int
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT count(*) FROM revocation_events WHERE kind='workspace_share_removed' AND user_id=$1 AND workspace_id=$2`,
		editor, workspaceID).Scan(&eventRows))
	require.Zero(t, eventRows, "rolled-back mutation must not persist a revocation")
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT level FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
		workspaceID, editor).Scan(&level))
	require.Equal(t, "read", level)
}

func TestPairDesktopRevocationPublishesAfterCommitWhenRequestIsCanceled(t *testing.T) {
	setupCtx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "desktop-cancel-owner")
	editor := mkPairUser(t, fx.pool, "desktop-cancel-editor")
	source := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	pairs := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
	session, err := pairs.CreateSession(setupCtx, owner, fx.repoID, source)
	require.NoError(t, err)
	workspaceID := UUIDString(session.WorkspaceID)
	link, err := pairs.MintLink(setupCtx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)
	_, err = pairs.ResolveByLink(setupCtx, link.Slug, editor)
	require.NoError(t, err)

	requestCtx, cancel := context.WithCancel(setupCtx)
	defer cancel()
	pairs.txBeginner = cancelAfterCommitBegin{pool: fx.pool, cancel: cancel}
	probe := &desktopShareCommitProbe{pool: fx.pool, workspaceID: workspaceID, memberID: editor}
	pairs.revocations = probe
	_, err = pairs.SetMemberRole(requestCtx, session.ID, owner, editor, PairRoleViewer)
	require.NoError(t, err, "committed role change must report success")
	require.ErrorIs(t, requestCtx.Err(), context.Canceled, "request canceled exactly after commit")
	require.NoError(t, probe.ctxErr, "post-commit publisher needs a live context")
	require.True(t, probe.deadlineSet, "post-commit publication must remain time bounded")
	require.NoError(t, probe.readErr)
	require.Equal(t, []string{"read"}, probe.levels, "publisher sees the committed downgrade")
	require.Len(t, probe.events, 1, "committed downgrade must still reach publisher")
	require.Equal(t, revocation.KindWorkspaceShareRemoved, probe.events[0].Kind)
}

func TestPairDesktopDowngradeRollsBackWhenDurableRevocationFails(t *testing.T) {
	for _, mode := range []string{"insert", "notify"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			fx := newPairFixture(t)
			owner := mkPairUser(t, fx.pool, "desktop-revoke-fail-owner")
			editor := mkPairUser(t, fx.pool, "desktop-revoke-fail-editor")
			source := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
			pairs := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
			session, err := pairs.CreateSession(ctx, owner, fx.repoID, source)
			require.NoError(t, err)
			workspaceID := UUIDString(session.WorkspaceID)
			link, err := pairs.MintLink(ctx, session.ID, owner, PairRoleEditor)
			require.NoError(t, err)
			_, err = pairs.ResolveByLink(ctx, link.Slug, editor)
			require.NoError(t, err)

			failure := errors.New("forced revocation " + mode + " failure")
			calls := 0
			pairs.txBeginner = failRevocationBegin{pool: fx.pool, mode: mode, err: failure, calls: &calls}
			pairs.revocations = revocation.NewDBPublisher(db.New(fx.pool), nil)
			_, err = pairs.SetMemberRole(ctx, session.ID, owner, editor, PairRoleViewer)
			require.Error(t, err, "role change must fail when durable revocation fails")
			require.Equal(t, 500, httpStatus(err))
			require.Contains(t, err.Error(), failure.Error())
			require.Equal(t, 1, calls, "fault must reach the revocation insert or NOTIFY boundary")
			member, err := fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{
				SessionID: session.ID, UserID: editor,
			})
			require.NoError(t, err)
			require.Equal(t, PairRoleEditor, member.Role)
			var level string
			require.NoError(t, fx.pool.QueryRow(ctx,
				`SELECT level FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
				workspaceID, editor).Scan(&level))
			require.Equal(t, "write", level)
			var events int
			require.NoError(t, fx.pool.QueryRow(ctx,
				`SELECT count(*) FROM revocation_events WHERE kind='workspace_share_removed' AND user_id=$1 AND workspace_id=$2`,
				editor, workspaceID).Scan(&events))
			require.Zero(t, events)
		})
	}
}
