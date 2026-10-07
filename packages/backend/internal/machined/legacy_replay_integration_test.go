package machined

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// A receipt is historical evidence that these exact bytes have already landed.
// Seed the old on-disk format directly: this must survive upgrading away from a
// live resolver, including after the corresponding activity has been pruned.
func TestLegacyBurstReplayUsesExactReceiptWithoutLiveAuthority(t *testing.T) {
	for _, actor := range [][]byte{wire.Union(2, wire.Field(1, wire.U32(1))), wire.Union(3, wire.Field(1, wire.String("old-run")))} {
		t.Run(fmt.Sprint(actor[0]), func(t *testing.T) {
			ctx := t.Context()
			pool, branch, _ := machineReceiptDatabase(t)
			registry := new(Registry)
			authority, err := registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			link, _ := connectTest(t, registry, branch, authority)
			// Recovery precedes readiness and needs no live session or run checkpoint.
			require.ErrorIs(t, link.RequireReady(branch), ErrNotReady)
			objects := &burstObjectFixture{}
			observations := 0
			burst := &BurstIngest{Pool: pool, Objects: objects, ObserveCommitted: func() { observations++ }}
			pump := &Ingestor{Pool: pool, Bursts: burst}
			event := Event{Seq: 1, EventID: [16]byte{1}, Payload: attributedBurst(t, actor, [16]byte{2}, 0, 0)}
			ack, err := pump.Commit(ctx, link.Connection, branch, event)
			require.ErrorIs(t, err, ErrHistoricalActorUnavailable)
			require.Zero(t, ack.Outcome)
			outcome := fmt.Sprintf("applied:%s:%x", uuid.UUID([16]byte{2}).String(), sha256.Sum256(event.Payload))
			_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,$3)`, branch, uuid.UUID(event.EventID).String(), outcome)
			require.NoError(t, err)
			ack, err = pump.Commit(ctx, link.Connection, branch, event)
			require.NoError(t, err)
			require.Equal(t, AckDuplicate, ack.Outcome)
			require.Equal(t, 1, objects.publications)
			require.Zero(t, observations)
			for _, table := range []string{"product_job_events", "burst_files"} {
				var count int
				require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
				require.Zero(t, count, "replay must never create new facts without an author")
			}
			for name, change := range map[string]func(*Event){
				"new event id":           func(e *Event) { e.EventID[0] = 3 },
				"same event other burst": func(e *Event) { e.Payload = attributedBurst(t, actor, [16]byte{3}, 0, 0) },
				"same event other actor": func(e *Event) {
					e.Payload = attributedBurst(t, wire.Union(2, wire.Field(1, wire.U32(999))), [16]byte{2}, 0, 0)
				},
				"multipart without retained authority": func(e *Event) { e.Payload = attributedBurst(t, actor, [16]byte{2}, 1, 2) },
			} {
				t.Run(name, func(t *testing.T) {
					changed := event
					change(&changed)
					got, err := pump.Commit(ctx, link.Connection, branch, changed)
					require.Error(t, err)
					require.Zero(t, got.Outcome)
					require.Equal(t, 1, objects.publications)
				})
			}
			// Duplicate acknowledgements still require the original object retention.
			objects.missing = []string{"0123456789012345678901234567890123456789"}
			ack, err = pump.Commit(ctx, link.Connection, branch, event)
			require.NoError(t, err)
			require.Equal(t, AckMissingObjects, ack.Outcome)
			objects.missing = nil
			objects.publishError = fmt.Errorf("retention failed")
			ack, err = pump.Commit(ctx, link.Connection, branch, event)
			require.ErrorContains(t, err, "retention failed")
			require.Zero(t, ack.Outcome)
			objects.publishError = nil
			// A reconstructed host has no live map; the immutable receipt is enough.
			require.NoError(t, link.Close())
			restarted := new(Registry)
			boot, err := restarted.MintBoot(branch, "replacement-vm")
			require.NoError(t, err)
			replacement, _ := connectTest(t, restarted, branch, boot)
			ack, err = pump.Commit(ctx, replacement.Connection, branch, event)
			require.NoError(t, err)
			require.Equal(t, AckDuplicate, ack.Outcome)
			// A previously connected process can no longer acknowledge even known bytes.
			_, err = pump.Commit(ctx, link.Connection, branch, event)
			require.ErrorIs(t, err, ErrUnauthorized)
			// Legacy hints have no durable receipt or attributable identity.
			require.NoError(t, replacement.Reconciled())
			hint := wire.Union(1, wire.Field(1, wire.String("source.ts")), wire.Field(2, actor), wire.Field(3, make([]byte, 32)))
			require.ErrorIs(t, burst.Hint(context.Background(), replacement.Connection, branch, Event{Payload: hint}), ErrHistoricalActorUnavailable)
		})
	}
}

func TestLegacySplitBurstRecoversRetainedAuthor(t *testing.T) {
	for _, envelope := range [][]byte{wire.Union(2, wire.Field(1, wire.U32(1))), wire.Union(3, wire.Field(1, wire.String("finished-run")))} {
		t.Run(fmt.Sprint(envelope[0]), func(t *testing.T) {
			ctx := t.Context()
			pool, branch, _ := machineReceiptDatabase(t)
			registry := new(Registry)
			authority, err := registry.MintBoot(branch, "vm")
			require.NoError(t, err)
			link, _ := connectTest(t, registry, branch, authority)
			observations := 0
			objects := &burstObjectFixture{}
			pump := &Ingestor{Pool: pool, Bursts: &BurstIngest{Pool: pool, Objects: objects, ObserveCommitted: func() { observations++ }}}
			id := [16]byte{50}
			first := Event{Seq: 1, EventID: [16]byte{51}, Payload: attributedBurst(t, envelope, id, 1, 2)}
			last := Event{Seq: 2, EventID: [16]byte{52}, Payload: attributedBurst(t, envelope, id, 2, 2)}
			// Literal prior-version stage format; do not invoke the current writer to
			// manufacture the evidence it is supposed to recover from.
			original := json.RawMessage(`{"kind":"person","id":"member:1","member_id":"1","via":"ssh"}`)
			if envelope[0] == 3 {
				original = json.RawMessage(`{"kind":"agent","id":"run:finished-run","run_id":"finished-run","agent_kind":"coding","for_member":"1"}`)
			}
			raw, err := json.Marshal(struct {
				Payload []byte
				Actor   json.RawMessage
			}{first.Payload, original})
			require.NoError(t, err)
			retained := "staged:" + uuid.UUID(id).String() + ":" + base64.StdEncoding.EncodeToString(raw)
			_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,$3)`, branch, uuid.UUID(first.EventID).String(), retained)
			require.NoError(t, err)
			for name, change := range map[string]func(*Event){
				"another burst":        func(e *Event) { e.Payload = attributedBurst(t, envelope, [16]byte{70}, 2, 2) },
				"another actor":        func(e *Event) { e.Payload = attributedBurst(t, wire.Union(2, wire.Field(1, wire.U32(100))), id, 2, 2) },
				"different part count": func(e *Event) { e.Payload = attributedBurst(t, envelope, id, 2, 3) },
				"different versions":   func(e *Event) { e.Payload = append([]byte(nil), e.Payload...); e.Payload[len(e.Payload)-8] ^= 1 },
			} {
				t.Run(name, func(t *testing.T) {
					changed := last
					change(&changed)
					ack, err := pump.Commit(ctx, link.Connection, branch, changed)
					require.Error(t, err)
					require.Zero(t, ack.Outcome)
				})
			}
			for _, broken := range []string{"!", base64.StdEncoding.EncodeToString([]byte(`{"Actor":null}`))} {
				_, err = pool.Exec(ctx, `UPDATE machine_event_receipts SET outcome=$2 WHERE workspace_id=$1`, branch, "staged:"+uuid.UUID(id).String()+":"+broken)
				require.NoError(t, err)
				ack, err := pump.Commit(ctx, link.Connection, branch, last)
				require.Error(t, err)
				require.Zero(t, ack.Outcome)
			}
			_, err = pool.Exec(ctx, `UPDATE machine_event_receipts SET outcome=$2 WHERE workspace_id=$1`, branch, retained)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `DELETE FROM collaborators`)
			require.NoError(t, err)
			// No live session or run checkpoint exists; readiness is still pending.
			ack, err := pump.Commit(ctx, link.Connection, branch, last)
			require.NoError(t, err)
			require.Equal(t, AckApplied, ack.Outcome)
			require.Equal(t, 1, observations)
			var author []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT data->'actor' FROM product_job_events WHERE event_type='branch.burst'`).Scan(&author))
			require.JSONEq(t, string(original), string(author))
			for n, event := range []Event{first, last} {
				ack, err := pump.Commit(ctx, link.Connection, branch, event)
				require.NoError(t, err)
				// Earlier parts acknowledge durable staging; the final part
				// confirms the existing complete logical burst receipt.
				require.Equal(t, []AckOutcome{AckApplied, AckDuplicate}[n], ack.Outcome)
			}
			require.Equal(t, 1, observations)
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&count))
			require.Equal(t, 2, count)
		})
	}
}
