package machined

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/stretchr/testify/require"
)

func machineReceiptDatabase(t *testing.T) (*pgxpool.Pool, string, string) {
	t.Helper()
	database := testdb.New(t)
	pool, err := pgxpool.New(t.Context(), database.URL)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(t.Context(), pool))
	var user, repo int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES('w3-owner','w3-owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, user).Scan(&repo))
	var a, b string
	for n, target := range []*string{&a, &b} {
		require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO workspaces(repository_id,user_id,name,target_bookmark,kind,status) SELECT $1,id,$2,$2,'container','running' FROM users WHERE username='smithers-machines' RETURNING id`, repo, fmt.Sprintf("w3-%d", n)).Scan(target))
	}
	return pool, a, b
}
func capturedEvent(seq uint64, id [16]byte) Event {
	return Event{Seq: seq, EventID: id, Payload: wire.Union(2, wire.Field(1, make([]byte, 20)), wire.Field(2, make([]byte, 20)), wire.Field(3, make([]byte, 20)))}
}

func TestMachinedDispatchFailureRevokesReady(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	r := new(Registry)
	authority, err := r.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, daemon := connectTest(t, r, branch, authority)
	require.NoError(t, link.Reconciled())
	failure := errors.New("capture projection unavailable")
	ingestor := &Ingestor{Pool: pool, Write: func(context.Context, pgx.Tx, string, Event) (Acknowledgement, error) {
		return Acknowledgement{}, failure
	}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ingestor.Dispatch(ctx, link, branch) }()
	event := capturedEvent(1, authority.ID)
	require.NoError(t, wire.Write(daemon, wire.Frame{Kind: wire.Events, Payload: wire.Union(1,
		wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]), wire.Field(3, event.Payload))}))
	require.ErrorIs(t, <-done, failure)
	_, err = r.Current(branch)
	require.ErrorIs(t, err, ErrNotReady)
	require.Error(t, link.RequireReady(branch))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Zero(t, count)
	// An outbox entry remains unacknowledged and retryable after reconnection.
	_, err = wire.Read(daemon)
	require.Error(t, err)
}

func TestRegistryIntegration(t *testing.T) {
	pool, a, b := machineReceiptDatabase(t)
	r := new(Registry)
	authority, err := r.MintBoot(a, "vm-a")
	require.NoError(t, err)
	link, _ := connectTest(t, r, a, authority)
	var writes atomic.Int32
	ingestor := &Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, branch string, event Event) (Acknowledgement, error) {
		writes.Add(1)
		_, err := tx.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, branch, "1111111111111111111111111111111111111111")
		return Acknowledgement{Outcome: AckApplied}, err
	}}
	event := capturedEvent(1, authority.ID)
	_, err = ingestor.Commit(t.Context(), link.Connection, b, event)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Zero(t, writes.Load())
	// Concurrent copies share one projection transaction and one durable row.
	results := make(chan Acknowledgement, 12)
	failures := make(chan error, 12)
	for range 12 {
		go func() {
			ack, err := ingestor.Commit(t.Context(), link.Connection, a, event)
			results <- ack
			failures <- err
		}()
	}
	applied, duplicate := 0, 0
	for range 12 {
		require.NoError(t, <-failures)
		ack := <-results
		switch ack.Outcome {
		case AckApplied:
			applied++
		case AckDuplicate:
			duplicate++
		default:
			t.Fatalf("unexpected ack: %+v", ack)
		}
	}
	require.Equal(t, 1, applied)
	require.Equal(t, 11, duplicate)
	require.Equal(t, int32(1), writes.Load())
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1`, a).Scan(&count))
	require.Equal(t, 1, count)
	newer, err := r.MintBoot(a, "vm-a")
	require.NoError(t, err)
	replacement, _ := connectTest(t, r, a, newer)
	_, err = ingestor.Commit(t.Context(), link.Connection, a, capturedEvent(2, newer.ID))
	require.ErrorIs(t, err, ErrUnauthorized)
	ack, err := ingestor.Commit(t.Context(), replacement.Connection, a, event)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
}
func TestMachinedCaptureDispatchDurability(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	r := new(Registry)
	authority, err := r.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, daemon := connectTest(t, r, branch, authority)
	event := capturedEvent(42, authority.ID)
	mode := AckMissingObjects
	failure := false
	ingestor := &Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, branch string, event Event) (Acknowledgement, error) {
		_, err := tx.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, branch, "2222222222222222222222222222222222222222")
		if err != nil {
			return Acknowledgement{}, err
		}
		if failure {
			return Acknowledgement{}, errors.New("injected persistence failure")
		}
		return Acknowledgement{Outcome: mode}, nil
	}}
	ack, err := ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, AckMissingObjects, ack.Outcome)
	var count int
	var head string
	check := func(expected int) {
		t.Helper()
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
		require.Equal(t, expected, count)
	}
	check(0)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&head))
	require.Empty(t, head)
	failure = true
	_, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.ErrorContains(t, err, "injected persistence failure")
	check(0)
	failure = false
	mode = AckStaleBase
	ack, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, AckStaleBase, ack.Outcome)
	check(1)
	ack, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, AckStaleBase, ack.Outcome)
	// A second event crosses the real authenticated dispatcher and wire ACK.
	// The peer independently queries PostgreSQL after observing the ACK.
	mode = AckApplied
	event.EventID[0] ^= 0xff
	event = capturedEvent(43, event.EventID)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ingestor.Dispatch(ctx, link, branch) }()
	require.NoError(t, wire.Write(daemon, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]), wire.Field(3, event.Payload))}))
	require.NoError(t, daemon.SetReadDeadline(time.Now().Add(5*time.Second)))
	frame, err := wire.Read(daemon)
	require.NoError(t, err)
	require.Equal(t, byte(wire.Events), frame.Kind)
	require.Equal(t, wire.Union(3, wire.Field(1, wire.U64(43)), wire.Field(2, []byte{1})), frame.Payload)
	check(2)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&head))
	require.Equal(t, "2222222222222222222222222222222222222222", head)
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
}

func TestMachineReceiptReplayBindsEventPayload(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	r := new(Registry)
	authority, err := r.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, branch, authority)
	for _, outcome := range []AckOutcome{AckApplied, AckStaleBase, AckRejected} {
		t.Run(fmt.Sprint(outcome), func(t *testing.T) {
			writes := 0
			ingestor := &Ingestor{Pool: pool, Write: func(context.Context, pgx.Tx, string, Event) (Acknowledgement, error) {
				writes++
				return Acknowledgement{Outcome: outcome}, nil
			}}
			event := capturedEvent(1, [16]byte{byte(outcome)})
			_, err := ingestor.Commit(t.Context(), link.Connection, branch, event)
			require.NoError(t, err)
			for part := range 3 {
				fields := [][]byte{make([]byte, 20), make([]byte, 20), make([]byte, 20)}
				fields[part][0] = 1
				changed := event
				changed.Payload = wire.Union(2, wire.Field(1, fields[0]), wire.Field(2, fields[1]), wire.Field(3, fields[2]))
				_, err = ingestor.Commit(t.Context(), link.Connection, branch, changed)
				require.ErrorIs(t, err, wire.BadValue, "same ID cannot acknowledge a different head, tree or base")
			}
			event.Seq = 42 // sequence belongs to the connection, not durable identity
			ack, err := ingestor.Commit(t.Context(), link.Connection, branch, event)
			require.NoError(t, err)
			require.Equal(t, uint64(42), ack.Seq)
			require.Equal(t, 1, writes)
			var captured []byte
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT capture_payload FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, fmt.Sprintf("%x-%x-%x-%x-%x", event.EventID[:4], event.EventID[4:6], event.EventID[6:8], event.EventID[8:10], event.EventID[10:])).Scan(&captured))
			require.Equal(t, event.Payload, captured)
		})
	}
	// Non-capture records bind their bytes without retaining transcript content.
	event := Event{Seq: 10, EventID: [16]byte{9}, Payload: wire.Union(4, wire.Field(1, wire.Union(4)), wire.Field(2, wire.U64(1)), wire.Field(3, make([]byte, 20)))}
	writer := &Ingestor{Pool: pool, Write: func(context.Context, pgx.Tx, string, Event) (Acknowledgement, error) {
		return Acknowledgement{Outcome: AckApplied}, nil
	}}
	_, err = writer.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	var payload []byte
	var size int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT capture_payload,octet_length(payload_digest) FROM machine_event_receipts WHERE workspace_id=$1 AND event_id='09000000-0000-0000-0000-000000000000'`, branch).Scan(&payload, &size))
	require.Nil(t, payload)
	require.Equal(t, 32, size)
	// Legacy receipts remain intact but cannot certify an unbound replay.
	_, err = pool.Exec(t.Context(), `UPDATE machine_event_receipts SET payload_digest=NULL WHERE workspace_id=$1 AND event_id='09000000-0000-0000-0000-000000000000'`, branch)
	require.NoError(t, err)
	_, err = writer.Commit(t.Context(), link.Connection, branch, event)
	require.ErrorIs(t, err, ErrNotReady)
}

func TestMachineEventPreparationRefusals(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	registry := new(Registry)
	boot, err := registry.MintBoot(branch, "capture-preparation")
	require.NoError(t, err)
	link, _ := connectTest(t, registry, branch, boot)
	called := 0
	writer := func(context.Context, pgx.Tx, string, Event) (Acknowledgement, error) {
		called++
		return Acknowledgement{Outcome: AckApplied}, nil
	}
	for _, test := range []struct {
		name    string
		prepare EventPreparation
		direct  EventWriter
	}{
		{"preparation failed", func(context.Context, pgx.Tx, string, Event) (EventWriter, error) {
			return nil, errors.New("projection unavailable")
		}, nil},
		{"preparation absent writer", func(context.Context, pgx.Tx, string, Event) (EventWriter, error) { return nil, nil }, nil},
		{"ambiguous writers", func(context.Context, pgx.Tx, string, Event) (EventWriter, error) { return writer, nil }, writer},
	} {
		t.Run(test.name, func(t *testing.T) {
			ingestor := &Ingestor{Pool: pool, Prepare: test.prepare, Write: test.direct}
			_, err := ingestor.Commit(t.Context(), link.Connection, branch, capturedEvent(1, boot.ID))
			require.Error(t, err)
			var receipts int
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
			require.Zero(t, receipts)
			require.Zero(t, called)
		})
	}
}
