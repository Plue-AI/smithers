package machined

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func sendConsumerEvent(t *testing.T, peer net.Conn, event Event) {
	t.Helper()
	require.NoError(t, peer.SetDeadline(time.Now().Add(10*time.Second)))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]), wire.Field(3, event.Payload))}))
}
func readConsumerAck(t *testing.T, peer net.Conn, seq uint64, outcome AckOutcome) {
	t.Helper()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, wire.Events, frame.Kind)
	require.Equal(t, byte(3), frame.Payload[0])
	fields, err := wire.Fields("ack", frame.Payload[1:])
	require.NoError(t, err)
	require.Equal(t, seq, binary.BigEndian.Uint64(fields[1]))
	require.Equal(t, []byte{byte(outcome)}, fields[2])
}

func TestEventConsumerCommitReplayAndControl(t *testing.T) {
	for _, bindFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(bindFirst), func(t *testing.T) {
			pool, branch, _ := machineReceiptDatabase(t)
			var repository int64
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository))
			registry := new(Registry)
			authority, err := registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			var writes atomic.Int32
			generic := &Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, b string, event Event) (Acknowledgement, error) {
				writes.Add(1)
				_, err := tx.Exec(ctx, `UPDATE workspaces SET head_commit_id='captured' WHERE id=$1`, b)
				return Acknowledgement{Outcome: AckApplied}, err
			}}
			bursts := &BurstIngest{Pool: pool, Objects: &burstObjectFixture{}, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
				return json.RawMessage(`{"id":"outside","kind":"outside"}`), nil
			}}
			held, release := make(chan struct{}), make(chan struct{})
			var once atomic.Bool
			apply := func(ctx context.Context, link *Link, b string, event Event) (Acknowledgement, error) {
				if once.CompareAndSwap(false, true) {
					close(held)
					select {
					case <-release:
					case <-ctx.Done():
						return Acknowledgement{}, ctx.Err()
					}
				}
				if event.Payload[0] == 1 {
					return bursts.Apply(ctx, link.Connection, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + b}, event)
				}
				return generic.Commit(ctx, link.Connection, b, event)
			}
			var stop func()
			if bindFirst {
				stop, err = registry.ConsumeEvents(t.Context(), apply)
				require.NoError(t, err)
				t.Cleanup(stop)
			}
			link, peer := connectTest(t, registry, branch, authority)
			if !bindFirst {
				stop, err = registry.ConsumeEvents(t.Context(), apply)
				require.NoError(t, err)
				t.Cleanup(stop)
			}
			require.ErrorIs(t, link.RequireReady(branch), ErrNotReady)
			// The consumer is already active while wake reconciliation is pending.
			event := capturedEvent(1, [16]byte{1})
			sendConsumerEvent(t, peer, event)
			<-held
			var count int
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
			require.Zero(t, count)
			// A held writer does not own the transport reader: the roster control
			// request/reply completes before the event can acquire a receipt or ACK.
			control := make(chan error, 1)
			go func() { control <- registry.SetRoster(t.Context(), branch, nil) }()
			answer(t, peer, wire.SetRoster)
			require.NoError(t, <-control)
			close(release)
			readConsumerAck(t, peer, 1, AckApplied)
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
			require.Equal(t, 1, count)
			// Burst and generic events use the same ordered consumer and their own
			// existing receipt transactions; no second reader competes for the queue.
			burst := Event{Seq: 2, EventID: [16]byte{2}, Payload: burstPayload([16]byte{3}, "ordered.ts")}
			sendConsumerEvent(t, peer, burst)
			readConsumerAck(t, peer, 2, AckApplied)
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM burst_files`).Scan(&count))
			require.Equal(t, 1, count)
			// A lost ACK/new authenticated connection replays the durable identity,
			// with a connection-specific sequence and no repeated projection.
			replacement, newPeer := connectTest(t, registry, branch, authority)
			require.ErrorIs(t, link.RequireReady(branch), ErrUnauthorized)
			event.Seq = 9
			sendConsumerEvent(t, newPeer, event)
			readConsumerAck(t, newPeer, 9, AckDuplicate)
			require.Equal(t, int32(1), writes.Load())
			require.ErrorIs(t, replacement.RequireReady(branch), ErrNotReady)
			_, err = registry.ConsumeEvents(t.Context(), apply)
			require.ErrorIs(t, err, ErrNotReady)
			stop()
			select {
			case <-replacement.done:
			case <-time.After(time.Second):
				t.Fatal("consumer stop left its connection alive")
			}
		})
	}
}

func TestEventConsumerFailedCommitReplays(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	var fail atomic.Bool
	fail.Store(true)
	ingestor := &Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, b string, event Event) (Acknowledgement, error) {
		_, err := tx.Exec(ctx, `UPDATE workspaces SET head_commit_id='captured' WHERE id=$1`, b)
		if err != nil {
			return Acknowledgement{}, err
		}
		if fail.Load() {
			return Acknowledgement{}, errors.New("injected projection failure")
		}
		return Acknowledgement{Outcome: AckApplied}, nil
	}}
	stop, err := registry.ConsumeEvents(t.Context(), func(ctx context.Context, l *Link, b string, e Event) (Acknowledgement, error) {
		return ingestor.Commit(ctx, l.Connection, b, e)
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	link, peer := connectTest(t, registry, branch, authority)
	event := capturedEvent(1, [16]byte{1})
	sendConsumerEvent(t, peer, event)
	_, err = wire.Read(peer)
	require.Error(t, err, "failed commit must close without ACK")
	<-link.done
	var count int
	var head string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&head))
	require.Empty(t, head)
	fail.Store(false)
	_, peer = connectTest(t, registry, branch, authority)
	sendConsumerEvent(t, peer, event)
	readConsumerAck(t, peer, 1, AckApplied)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Equal(t, 1, count)
}

func TestEventConsumerCancellationAndShutdown(t *testing.T) {
	for _, action := range []string{"transport", "replacement", "stop", "cancel", "registry"} {
		t.Run(action, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			registry := new(Registry)
			authority, err := registry.MintBoot("branch", "vm")
			require.NoError(t, err)
			entered, exited := make(chan struct{}), make(chan struct{})
			stop, err := registry.ConsumeEvents(ctx, func(ctx context.Context, _ *Link, _ string, _ Event) (Acknowledgement, error) {
				close(entered)
				<-ctx.Done()
				close(exited)
				return Acknowledgement{}, ctx.Err()
			})
			require.NoError(t, err)
			t.Cleanup(stop)
			link, peer := connectTest(t, registry, "branch", authority)
			sendConsumerEvent(t, peer, capturedEvent(1, [16]byte{1}))
			<-entered
			switch action {
			case "transport":
				require.NoError(t, peer.Close())
			case "replacement":
				_, err = registry.MintBoot("branch", "new-vm")
				require.NoError(t, err)
			case "stop":
				stop()
			case "cancel":
				cancel()
			case "registry":
				require.NoError(t, registry.Close())
			}
			select {
			case <-exited:
			case <-time.After(time.Second):
				t.Fatal("writer context was not cancelled")
			}
			select {
			case <-link.done:
			case <-time.After(time.Second):
				t.Fatal("old connection remained alive")
			}
			stop() // idempotent, and joins shutdown initiated by another source
			if action == "registry" {
				_, err = registry.ConsumeEvents(t.Context(), func(context.Context, *Link, string, Event) (Acknowledgement, error) { return Acknowledgement{}, nil })
				require.ErrorIs(t, err, ErrNotReady)
			} else {
				again, err := registry.ConsumeEvents(t.Context(), func(context.Context, *Link, string, Event) (Acknowledgement, error) {
					return Acknowledgement{}, ErrNotReady
				})
				require.NoError(t, err)
				again()
			}
		})
	}
}

func TestEventConsumerRefusesWrongAcknowledgement(t *testing.T) {
	registry := new(Registry)
	authority, err := registry.MintBoot("branch", "vm")
	require.NoError(t, err)
	var calls atomic.Int32
	stop, err := registry.ConsumeEvents(t.Context(), func(_ context.Context, _ *Link, _ string, event Event) (Acknowledgement, error) {
		calls.Add(1)
		return Acknowledgement{Seq: event.Seq + 1, Outcome: AckApplied}, nil
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	_, peer := connectTest(t, registry, "branch", authority)
	// A transient file notification never reaches a durable writer or gets ACKed.
	hint := wire.Union(1, wire.Field(1, wire.String("changed.ts")), wire.Field(2, wire.Union(4)))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Events, Payload: wire.Union(2, wire.Field(1, hint))}))
	sendConsumerEvent(t, peer, capturedEvent(7, [16]byte{1}))
	_, err = wire.Read(peer)
	require.Error(t, err, "writer cannot acknowledge a different event sequence")
	require.Equal(t, int32(1), calls.Load())
}

func TestEventConsumerRequiresLiveBinding(t *testing.T) {
	var missing *Registry
	require.False(t, missing.EventConsumerReady())
	_, err := missing.ConsumeEvents(t.Context(), nil)
	require.ErrorIs(t, err, ErrNotReady)
	registry := new(Registry)
	_, err = registry.ConsumeEvents(t.Context(), nil)
	require.ErrorIs(t, err, ErrNotReady)
	_, err = registry.ConsumeEvents(t.Context(), func(context.Context, *Link, string, Event) (Acknowledgement, error) { return Acknowledgement{}, nil }, nil, nil)
	require.ErrorIs(t, err, ErrNotReady)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = registry.ConsumeEvents(ctx, func(context.Context, *Link, string, Event) (Acknowledgement, error) { return Acknowledgement{}, nil })
	require.ErrorIs(t, err, context.Canceled)
}

func TestEventConsumerRegistryCloseCancelsTransaction(t *testing.T) {
	pool, branch, _ := machineReceiptDatabase(t)
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	entered := make(chan struct{})
	writer := &Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, branch string, _ Event) (Acknowledgement, error) {
		_, err := tx.Exec(ctx, `UPDATE workspaces SET head_commit_id='must rollback' WHERE id=$1`, branch)
		if err != nil {
			return Acknowledgement{}, err
		}
		close(entered)
		<-ctx.Done()
		return Acknowledgement{}, ctx.Err()
	}}
	stop, err := registry.ConsumeEvents(t.Context(), func(ctx context.Context, l *Link, b string, e Event) (Acknowledgement, error) {
		return writer.Commit(ctx, l.Connection, b, e)
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	_, peer := connectTest(t, registry, branch, authority)
	sendConsumerEvent(t, peer, capturedEvent(1, [16]byte{1}))
	<-entered
	// The transaction holds the boot fence. Close must cancel its context
	// before waiting for that fence, or neither operation can complete.
	require.NoError(t, registry.Close())
	var head string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&head))
	require.Empty(t, head)
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Zero(t, count)
}

func TestEventConsumerTransientHints(t *testing.T) {
	for _, mode := range []string{"absent", "published", "refused"} {
		t.Run(mode, func(t *testing.T) {
			registry := new(Registry)
			authority, err := registry.MintBoot("branch", "vm")
			require.NoError(t, err)
			var writes, hints atomic.Int32
			apply := func(_ context.Context, _ *Link, _ string, event Event) (Acknowledgement, error) {
				writes.Add(1)
				return Acknowledgement{Seq: event.Seq, Outcome: AckApplied}, nil
			}
			var consumeHint HintHandler
			if mode != "absent" {
				consumeHint = func(_ context.Context, link *Link, branch string, event Event) error {
					hints.Add(1)
					require.NotNil(t, link.Connection)
					require.Equal(t, "branch", branch)
					require.Zero(t, event.Seq)
					require.Zero(t, event.EventID)
					written, err := wire.DecodeFileWritten(event.Payload)
					require.NoError(t, err)
					require.Equal(t, "changed.ts", written.Path)
					if mode == "refused" {
						return ErrNotReady
					}
					return nil
				}
			}
			stop, err := registry.ConsumeEvents(t.Context(), apply, consumeHint)
			require.NoError(t, err)
			t.Cleanup(stop)
			_, peer := connectTest(t, registry, "branch", authority)
			require.NoError(t, peer.SetDeadline(time.Now().Add(5*time.Second)))
			hint := wire.Union(1, wire.Field(1, wire.String("changed.ts")), wire.Field(2, wire.Union(4)))
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Events, Payload: wire.Union(2, wire.Field(1, hint))}))
			if mode == "refused" {
				_, err = wire.Read(peer)
				require.Error(t, err)
				require.Equal(t, int32(1), hints.Load())
				require.Zero(t, writes.Load())
				return
			}
			sendConsumerEvent(t, peer, capturedEvent(7, [16]byte{1}))
			// The first frame is the durable event's ACK, never a hint ACK.
			readConsumerAck(t, peer, 7, AckApplied)
			require.Equal(t, int32(1), writes.Load())
			if mode == "published" {
				require.Equal(t, int32(1), hints.Load())
			} else {
				require.Zero(t, hints.Load())
			}
		})
	}
}
