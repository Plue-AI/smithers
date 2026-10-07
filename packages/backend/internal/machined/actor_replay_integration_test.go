package machined

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func attributedBurst(t *testing.T, actor []byte, id [16]byte, part, parts uint16) []byte {
	t.Helper()
	fields, err := wire.Fields("burst", burstPayload(id, fmt.Sprintf("source-%d.ts", part))[1:])
	require.NoError(t, err)
	result := [][]byte{wire.Field(1, fields[1]), wire.Field(2, actor), wire.Field(3, fields[3]), wire.Field(4, fields[4])}
	if parts != 0 {
		result = append(result, wire.Field(5, wire.U16(part)), wire.Field(6, wire.U16(parts)))
	}
	return wire.Union(1, result...)
}

func TestActorReplaySurvivesHostRestartAndMemberRemoval(t *testing.T) {
	for _, identity := range []ActorIdentity{{Kind: "person", MemberID: 1, Via: "ssh"}, {Kind: "agent", MemberID: 1, Via: "agent", AgentKind: "coding", Run: "old-attempt"}} {
		t.Run(identity.Kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			pool, branch, _ := machineReceiptDatabase(t)
			_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='vm' WHERE id=$1`, branch)
			require.NoError(t, err)
			ref, err := CommitActor(ctx, pool, branch, "vm", func(context.Context, pgx.Tx) (ActorIdentity, error) { return identity, nil })
			require.NoError(t, err)
			// One connection catches accidental nested pool acquisition by attribution.
			config := pool.Config()
			config.MaxConns = 1
			config.MinConns = 0
			single, err := pgxpool.NewWithConfig(ctx, config)
			require.NoError(t, err)
			defer single.Close()
			objects := &burstObjectFixture{}
			pump := &Ingestor{Pool: single, Bursts: &BurstIngest{Pool: single, Objects: objects}}
			registry := new(Registry)
			authority, err := registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			link, _ := connectTest(t, registry, branch, authority)
			require.ErrorIs(t, link.RequireReady(branch), ErrNotReady)
			_, err = pool.Exec(ctx, `DELETE FROM collaborators`)
			require.NoError(t, err)
			event := Event{Seq: 1, EventID: [16]byte{31}, Payload: attributedBurst(t, principal(ref), [16]byte{32}, 0, 0)}
			ack, err := pump.Commit(ctx, link.Connection, branch, event)
			require.NoError(t, err)
			require.Equal(t, AckApplied, ack.Outcome)
			// The host disappears before ACK; reconstruct both host objects. Neither a
			// session number nor a live run/roster lookup exists on the recovered host.
			require.NoError(t, registry.Close())
			registry = new(Registry)
			authority, err = registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			link, _ = connectTest(t, registry, branch, authority)
			pump = &Ingestor{Pool: single, Bursts: &BurstIngest{Pool: single, Objects: objects}}
			event.Seq = 2
			ack, err = pump.Commit(ctx, link.Connection, branch, event)
			require.NoError(t, err)
			require.Equal(t, AckDuplicate, ack.Outcome)
			var count int
			var raw []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&count))
			require.Equal(t, 1, count)
			require.NoError(t, pool.QueryRow(ctx, `SELECT data->'actor' FROM product_job_events WHERE event_type='branch.burst'`).Scan(&raw))
			var actor map[string]any
			require.NoError(t, json.Unmarshal(raw, &actor))
			require.Equal(t, identity.Kind, actor["kind"])

			if identity.Kind == "person" {
				require.Equal(t, "member:1", actor["id"])
				require.Equal(t, "1", actor["member_id"])
				require.Equal(t, "ssh", actor["via"])
			} else {
				require.Equal(t, "run:old-attempt", actor["id"])
				require.Equal(t, "old-attempt", actor["run_id"])
				require.Equal(t, "coding", actor["agent_kind"])
				require.Equal(t, "1", actor["for_member"])
			}
			require.Equal(t, 2, objects.publications)
		})
	}
}

func TestActorReplayRejectsCrossScopeAndNeverFallsBack(t *testing.T) {
	pool, branch, foreign := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='vm' WHERE id=$1 OR id=$2`, branch, foreign)
	require.NoError(t, err)
	identity := ActorIdentity{Kind: "person", MemberID: 1, Via: "terminal"}
	record := func(b string) []byte {
		ref, err := CommitActor(ctx, pool, b, "vm", func(context.Context, pgx.Tx) (ActorIdentity, error) { return identity, nil })
		require.NoError(t, err)
		return ref
	}
	own, other := record(branch), record(foreign)
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, registry, branch, authority)
	objects := &burstObjectFixture{}
	bursts := &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
		t.Error("principal fell back to legacy identity")
		return json.RawMessage(`{"kind":"outside"}`), nil
	}}
	pump := &Ingestor{Pool: pool, Bursts: bursts}
	unknown := uuid.New()
	for _, ref := range [][]byte{other, unknown[:], make([]byte, 16), []byte(`{"member_id":1}`)} {
		ack, err := pump.Commit(ctx, link.Connection, branch, Event{Seq: 1, EventID: [16]byte{1}, Payload: attributedBurst(t, principal(ref), [16]byte{2}, 0, 0)})
		require.ErrorIs(t, err, ErrUnauthorized)
		require.Zero(t, ack.Outcome)
	}
	// A new machine cannot replay another lineage's reference even in one branch.
	authority, err = registry.MintBoot(branch, "replacement")
	require.NoError(t, err)
	link, _ = connectTest(t, registry, branch, authority)
	ack, err := pump.Commit(ctx, link.Connection, branch, Event{Seq: 1, EventID: [16]byte{1}, Payload: attributedBurst(t, principal(own), [16]byte{2}, 0, 0)})
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Zero(t, ack.Outcome)
	bursts.ResolveActor = nil
	for _, actor := range [][]byte{wire.Union(2, wire.Field(1, wire.U32(1))), wire.Union(3, wire.Field(1, wire.String("old-run")))} {
		ack, err = pump.Commit(ctx, link.Connection, branch, Event{Seq: 1, EventID: [16]byte{1}, Payload: attributedBurst(t, actor, [16]byte{2}, 0, 0)})
		require.ErrorIs(t, err, ErrNotReady)
		require.Zero(t, ack.Outcome)
	}
	require.Zero(t, objects.publications)
	for _, table := range []string{"product_job_events", "machine_event_receipts", "burst_files"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count)
	}
}

func TestActorReplayMultipartKeepsOriginalIdentity(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='vm' WHERE id=$1`, branch)
	require.NoError(t, err)
	record := func(member int64) []byte {
		ref, err := CommitActor(ctx, pool, branch, "vm", func(context.Context, pgx.Tx) (ActorIdentity, error) {
			return ActorIdentity{Kind: "person", MemberID: member, Via: "ssh"}, nil
		})
		require.NoError(t, err)
		return ref
	}
	first, next := record(1), record(2)
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, registry, branch, authority)
	service := func() *Ingestor {
		return &Ingestor{Pool: pool, Bursts: &BurstIngest{Pool: pool, Objects: &burstObjectFixture{}}}
	}
	event := Event{Seq: 1, EventID: [16]byte{11}, Payload: attributedBurst(t, principal(first), [16]byte{12}, 1, 2)}
	ack, err := service().Commit(ctx, link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, AckApplied, ack.Outcome)
	authority, err = registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, _ = connectTest(t, registry, branch, authority)
	event = Event{Seq: 2, EventID: [16]byte{13}, Payload: attributedBurst(t, principal(next), [16]byte{12}, 2, 2)}
	_, err = service().Commit(ctx, link.Connection, branch, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	event.Payload = attributedBurst(t, principal(first), [16]byte{12}, 2, 2)
	ack, err = service().Commit(ctx, link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, AckApplied, ack.Outcome)
	ack, err = service().Commit(ctx, link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
	var member string
	require.NoError(t, pool.QueryRow(ctx, `SELECT data->'actor'->>'member_id' FROM product_job_events WHERE event_type='branch.burst'`).Scan(&member))
	require.Equal(t, "1", member)
}

func TestActorReplayBlockedLookupDoesNotFenceConnectionReplacement(t *testing.T) {
	for _, action := range []string{"replace", "cancel"} {
		t.Run(action, func(t *testing.T) {
			pool, branch, _ := machineReceiptDatabase(t)
			ctx := t.Context()
			_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='vm' WHERE id=$1`, branch)
			require.NoError(t, err)
			ref, err := CommitActor(ctx, pool, branch, "vm", func(context.Context, pgx.Tx) (ActorIdentity, error) {
				return ActorIdentity{Kind: "person", MemberID: 1, Via: "ssh"}, nil
			})
			require.NoError(t, err)
			config := pool.Config()
			config.MaxConns = 1
			config.MinConns = 0
			single, err := pgxpool.NewWithConfig(ctx, config)
			require.NoError(t, err)
			defer single.Close()
			registry := new(Registry)
			authority, err := registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			link, _ := connectTest(t, registry, branch, authority)
			objects := &burstObjectFixture{}
			pump := &Ingestor{Pool: single, Bursts: &BurstIngest{Pool: single, Objects: objects}}
			lock, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer lock.Rollback(ctx)
			_, err = lock.Exec(ctx, `LOCK TABLE machine_actor_references IN ACCESS EXCLUSIVE MODE`)
			require.NoError(t, err)
			pending, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				ack, err := pump.Commit(pending, link.Connection, branch, Event{Seq: 1, EventID: [16]byte{21}, Payload: attributedBurst(t, principal(ref), [16]byte{22}, 0, 0)})
				if ack.Outcome != 0 {
					err = fmt.Errorf("blocked delivery acknowledged: %+v", ack)
				}
				done <- err
			}()
			require.Eventually(t, func() bool {
				var blocked bool
				err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM machine_actor_references%')`).Scan(&blocked)
				return err == nil && blocked
			}, 5*time.Second, 10*time.Millisecond)
			if action == "replace" {
				replaced := make(chan error, 1)
				go func() { _, err := registry.MintBoot(branch, "replacement"); replaced <- err }()
				select {
				case err := <-replaced:
					require.NoError(t, err)
				case <-time.After(time.Second):
					t.Fatal("attribution lookup held the connection fence")
				}
				require.NoError(t, lock.Rollback(ctx))
				require.ErrorIs(t, <-done, ErrUnauthorized)
			} else {
				cancel()
				require.ErrorIs(t, <-done, context.Canceled)
				require.NoError(t, lock.Rollback(ctx))
			}
			// Both refusal paths release the only pool connection and all SQL effects.
			probe, stop := context.WithTimeout(ctx, time.Second)
			defer stop()
			require.NoError(t, single.Ping(probe))
			require.Zero(t, objects.publications)
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
			require.Zero(t, count)
		})
	}
}
