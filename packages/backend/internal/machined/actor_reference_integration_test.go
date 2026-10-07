package machined

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestActorReferenceDurabilityAndScope(t *testing.T) {
	pool, branch, other := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine-a' WHERE id=$1`, branch)
	require.NoError(t, err)
	actor := ActorIdentity{Kind: "person", MemberID: 1, Via: "ssh"}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	reference, err := RecordActorInTx(ctx, tx, branch, "machine-a", actor)
	require.NoError(t, err)
	require.Len(t, reference, 16)
	read, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = ResolveActorInTx(ctx, read, branch, "machine-a", reference)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.NoError(t, read.Rollback(ctx))
	require.NoError(t, tx.Commit(ctx))
	random := uuid.New()
	for _, scope := range []struct {
		branch, machine string
		reference       []byte
	}{{other, "machine-a", reference}, {branch, "machine-b", reference}, {branch, "machine-a", random[:]}, {branch, "machine-a", nil}, {branch, "machine-a", make([]byte, 16)}} {
		read, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = ResolveActorInTx(ctx, read, scope.branch, scope.machine, scope.reference)
		require.ErrorIs(t, err, ErrUnauthorized)
		require.NoError(t, read.Rollback(ctx))
	}
	// Resolving past identity never needs today's member allocation or session.
	_, err = pool.Exec(ctx, `DELETE FROM collaborators`)
	require.NoError(t, err)
	read, err = pool.Begin(ctx)
	require.NoError(t, err)
	got, err := ResolveActorInTx(ctx, read, branch, "machine-a", reference)
	require.NoError(t, err)
	require.Equal(t, actor, got)
	require.NoError(t, read.Rollback(ctx))
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	again, err := RecordActorInTx(ctx, tx, branch, "machine-a", actor)
	require.NoError(t, err)
	require.Equal(t, reference, again)
	require.NoError(t, tx.Commit(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references`).Scan(&count))
	require.Equal(t, 1, count)
	_, err = pool.Exec(ctx, `UPDATE machine_actor_references SET machine_id='machine-b' WHERE id=$1`, uuid.Must(uuid.FromBytes(reference)).String())
	require.ErrorContains(t, err, "immutable")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references WHERE machine_id='machine-a'`).Scan(&count))
	require.Equal(t, 1, count)
}

func TestActorReferenceRollbackCancellationAndConcurrentReplay(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine-a' WHERE id=$1`, branch)
	require.NoError(t, err)
	actor := ActorIdentity{Kind: "agent", MemberID: 7, Run: "run-one", AgentKind: "coding", Via: "agent"}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	discarded, err := RecordActorInTx(ctx, tx, branch, "machine-a", actor)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = ResolveActorInTx(ctx, tx, branch, "machine-a", discarded)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.NoError(t, tx.Rollback(ctx))
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = RecordActorInTx(cancelled, tx, branch, "machine-a", actor)
	require.ErrorIs(t, err, context.Canceled)
	_ = tx.Rollback(ctx)
	type result struct {
		reference []byte
		err       error
	}
	results := make(chan result, 12)
	for range 12 {
		go func() {
			tx, e := pool.Begin(ctx)
			if e != nil {
				results <- result{err: e}
				return
			}
			defer tx.Rollback(ctx)
			ref, e := RecordActorInTx(ctx, tx, branch, "machine-a", actor)
			if e == nil {
				e = tx.Commit(ctx)
			}
			results <- result{ref, e}
		}()
	}
	var first []byte
	for range 12 {
		r := <-results
		require.NoError(t, r.err)
		if first == nil {
			first = r.reference
		}
		require.Equal(t, first, r.reference)
	}
	require.NotEqual(t, discarded, first, "rolled-back identity cannot be published later")
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	next := actor
	next.Run = "run-two"
	reference, err := RecordActorInTx(ctx, tx, branch, "machine-a", next)
	require.NoError(t, err)
	require.NotEqual(t, first, reference)
	require.NoError(t, tx.Commit(ctx))
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	got, err := ResolveActorInTx(ctx, tx, branch, "machine-a", first)
	require.NoError(t, err)
	require.Equal(t, actor, got)
	require.NoError(t, tx.Rollback(ctx))
}

func TestActorReferenceRejectsChangedAuthority(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine-a' WHERE id=$1`, branch)
	require.NoError(t, err)
	actor := ActorIdentity{Kind: "person", MemberID: 1, Via: "terminal"}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	reference, err := RecordActorInTx(ctx, tx, branch, "machine-a", actor)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	for _, machine := range []string{"wrong-machine", ""} {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = RecordActorInTx(ctx, tx, branch, machine, actor)
		require.Error(t, err)
		_ = tx.Rollback(ctx)
	}
	lock, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = lock.Exec(ctx, `UPDATE workspaces SET vm_id='replacement' WHERE id=$1`, branch)
	require.NoError(t, err)
	blocked, err := pool.Begin(ctx)
	require.NoError(t, err)
	short, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	defer stop()
	_, err = RecordActorInTx(short, blocked, branch, "machine-a", actor)
	require.Error(t, err)
	_ = blocked.Rollback(ctx)
	require.NoError(t, lock.Commit(ctx))
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = RecordActorInTx(ctx, tx, branch, "machine-a", actor)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, tx.Rollback(ctx))
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = ResolveActorInTx(ctx, tx, branch, "machine-a", reference)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	raw, _ := actor.canonical()
	digest := sha256.Sum256(raw)
	tampered := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO machine_actor_references(id,workspace_id,machine_id,actor,digest) VALUES($1,$2,'replacement',$3,$4)`, tampered.String(), branch, json.RawMessage(`{"kind":"person","member_id":2,"via":"terminal"}`), digest[:])
	require.NoError(t, err)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = RecordActorInTx(ctx, tx, branch, "replacement", actor)
	require.ErrorIs(t, err, ErrUnauthorized)
	_, err = ResolveActorInTx(ctx, tx, branch, "replacement", tampered[:])
	require.ErrorIs(t, err, ErrUnauthorized)
	require.NoError(t, tx.Rollback(ctx))
}

func TestCommitActorDoesNotExposeUncommittedIdentity(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine-a' WHERE id=$1`, branch)
	require.NoError(t, err)
	actor := ActorIdentity{Kind: "person", MemberID: 1, Via: "ssh"}
	authorize := func(context.Context, pgx.Tx) (ActorIdentity, error) { return actor, nil }
	reference, err := CommitActor(ctx, pool, branch, "machine-a", nil)
	require.ErrorIs(t, err, ErrNotReady)
	require.Nil(t, reference)
	reference, err = CommitActor(ctx, nil, branch, "machine-a", authorize)
	require.ErrorIs(t, err, ErrNotReady)
	require.Nil(t, reference)
	reference, err = CommitActor(ctx, pool, branch, "machine-a", func(context.Context, pgx.Tx) (ActorIdentity, error) { return ActorIdentity{}, ErrUnauthorized })
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Nil(t, reference)
	// Failure is deliberately deferred until COMMIT, after reference allocation.
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_actor_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit refused'; END $$;
 CREATE CONSTRAINT TRIGGER fail_actor_commit AFTER INSERT ON machine_actor_references DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_actor_commit()`)
	require.NoError(t, err)
	reference, err = CommitActor(ctx, pool, branch, "machine-a", authorize)
	require.ErrorContains(t, err, "fixture commit refused")
	require.Nil(t, reference)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references`).Scan(&count))
	require.Zero(t, count)
	_, err = pool.Exec(ctx, `DROP TRIGGER fail_actor_commit ON machine_actor_references`)
	require.NoError(t, err)
	reference, err = CommitActor(ctx, pool, branch, "machine-a", authorize)
	require.NoError(t, err)
	read, err := pool.Begin(ctx)
	require.NoError(t, err)
	got, err := ResolveActorInTx(ctx, read, branch, "machine-a", reference)
	require.NoError(t, err)
	require.Equal(t, actor, got)
	require.NoError(t, read.Rollback(ctx))
	// Reuse still calls the admission authorizer and cannot resurrect permission.
	reference, err = CommitActor(ctx, pool, branch, "machine-a", func(context.Context, pgx.Tx) (ActorIdentity, error) { return ActorIdentity{}, ErrUnauthorized })
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Nil(t, reference)
}
