package machined

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// EventWriter verifies already transferred objects and writes the head/activity
// projection, pending-work signal and notification in this transaction. It must
// not acknowledge, call the registry, or publish outside the transaction. Git
// objects must be durably installed before returning AckApplied. Missing objects
// return AckMissingObjects and leave no receipt so the same event can retry.
type EventWriter func(context.Context, pgx.Tx, string, Event) (Acknowledgement, error)

// EventCommit fences the current boot through receipt publication and commit.
// Its writer is not called for a duplicate delivery.
type EventCommit func(EventWriter) (Acknowledgement, error)

// EventPreparation acquires database and repository locks before invoking
// commit, and retains them until commit returns. Never acquire a repository
// lock inside the writer: burst ingestion takes it before the registry fence.
type EventPreparation func(context.Context, pgx.Tx, string, Event, EventCommit) (Acknowledgement, error)

// Ingestor is the authenticated dispatcher's commit-before-ack boundary. An
// absent writer refuses admission rather than recording a receipt for lost work.
type Ingestor struct {
	Pool  *pgxpool.Pool
	Write EventWriter
	// Prepare and Write are exclusive; use Prepare for ordered cross-row locks.
	Prepare EventPreparation
	// Bursts shares this pump and its authenticated lease. Split bursts own
	// their staging transaction; other events use Write or Prepare.
	Bursts *BurstIngest
}

func (i *Ingestor) Commit(ctx context.Context, connection *Connection, branch string, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	if i == nil || i.Pool == nil || (i.Write == nil && i.Prepare == nil && i.Bursts == nil) || (i.Write != nil && i.Prepare != nil) {
		return ack, ErrNotReady
	}
	// Reject a caller-selected branch before preparing database projections.
	// Preparation acquires stack/workspace locks; the final registry fence below
	// still validates this connection's live boot lease through commit.
	if connection == nil || connection.registry == nil || connection.boot == nil || connection.boot.branch != branch {
		return ack, ErrUnauthorized
	}
	// Payload is the inner event union supplied by the authenticated link.
	// Rebuild the canonical envelope through the shared codec, so direct
	// callers get the same validation without a second wire representation.
	if event.Seq == 0 || event.EventID == ([16]byte{}) {
		return ack, wire.BadValue
	}
	f := wire.Frame{Kind: wire.Events, Payload: wire.Union(1,
		wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]),
		wire.Field(3, event.Payload))}
	if _, err := wire.Encode(f); err != nil {
		return ack, err
	}
	if event.Payload[0] == 1 {
		if i.Bursts == nil || i.Bursts.Pool != i.Pool {
			return ack, ErrNotReady
		}
		// Scope comes from the host row; neither caller nor daemon chooses a
		// repository stream. Apply fences this exact lease through commit.
		var repository int64
		if err := i.Pool.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository); err != nil {
			return ack, err
		}
		return i.Bursts.Apply(ctx, connection, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, event)
	}
	if i.Write == nil && i.Prepare == nil {
		return ack, ErrNotReady
	}
	id := event.EventID
	digest := sha256.Sum256(event.Payload)
	var capture []byte
	if event.Payload[0] == 2 {
		// These fixed-size identities, unlike transcript content, are needed
		// for recovery after a stale-base ACK releases the guest's outbox pin.
		capture = event.Payload
	}
	tx, err := i.Pool.Begin(ctx)
	if err != nil {
		return ack, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	commit := func(writer EventWriter) (Acknowledgement, error) {
		if writer == nil {
			return ack, ErrNotReady
		}
		return commitPreparedEvent(ctx, tx, connection, branch, event, writer, id, digest, capture)
	}
	if i.Prepare != nil {
		return i.Prepare(ctx, tx, branch, event, commit)
	}
	return commit(i.Write)
}

func commitPreparedEvent(ctx context.Context, tx pgx.Tx, connection *Connection, branch string, event Event, writer EventWriter, id [16]byte, digest [32]byte, capture []byte) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	// Acquire database and repository authority before the registry fence. A stack worker may
	// hold these rows while opening this daemon; holding the registry mutex
	// while waiting for those rows would deadlock both. Fence replacement
	// through persistent effects and commit after preparation completes.
	r := connection.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if branch != connection.boot.branch || !connection.current() {
		return ack, ErrUnauthorized
	}
	eventID := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	// The unique insert serializes concurrent replay across connections/processes.
	inserted, err := tx.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome,payload_digest,capture_payload) VALUES($1,$2,'pending',$3,$4) ON CONFLICT(workspace_id,event_id) DO NOTHING`, branch, eventID, digest[:], capture)
	if err != nil {
		return ack, err
	}
	if inserted.RowsAffected() == 0 {
		var outcome string
		var previous []byte
		if err = tx.QueryRow(ctx, `SELECT outcome,payload_digest FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, eventID).Scan(&outcome, &previous); err != nil {
			return ack, err
		}
		if len(previous) == 0 {
			// An old receipt has no proof of its payload. Keep it intact and
			// refuse replay instead of applying again or trusting new bytes.
			return ack, ErrNotReady
		}
		if !bytes.Equal(previous, digest[:]) {
			return ack, wire.BadValue
		}
		switch outcome {
		case "applied":
			ack.Outcome = AckDuplicate
		case "stale_base":
			ack.Outcome = AckStaleBase
		case "rejected":
			ack.Outcome = AckRejected
		default:
			return ack, errors.New("invalid machine event receipt")
		}
	} else {
		ack, err = writer(ctx, tx, branch, event)
		if err != nil {
			return Acknowledgement{Seq: event.Seq}, err
		}
		ack.Seq = event.Seq
		var outcome string
		switch ack.Outcome {
		case AckApplied:
			outcome = "applied"
		case AckStaleBase:
			outcome = "stale_base"
		case AckRejected:
			outcome = "rejected"
		case AckMissingObjects:
			return ack, nil
		default:
			return ack, wire.BadValue
		}
		if _, err = tx.Exec(ctx, `UPDATE machine_event_receipts SET outcome=$3 WHERE workspace_id=$1 AND event_id=$2`, branch, eventID, outcome); err != nil {
			return ack, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Acknowledgement{Seq: event.Seq}, err
	}
	return ack, nil
}

// Dispatch drains this particular authenticated boot. Never look up the latest
// link when acknowledging an older event: doing so could release a new boot's
// outbox entry with the same sequence number.
func (i *Ingestor) Dispatch(ctx context.Context, link *Link, branch string) error {
	if link == nil {
		return ErrNotReady
	}
	if link.Connection == nil || link.Connection.registry == nil {
		return ErrUnauthorized
	}
	// A failed direct consumer cannot leave this lease ready for RPCs.
	defer link.Close()
	if i == nil || i.Pool == nil || (i.Write == nil && i.Prepare == nil && i.Bursts == nil) || (i.Write != nil && i.Prepare != nil) {
		return ErrNotReady
	}
	return dispatchEvents(ctx, link, branch, func(ctx context.Context, link *Link, branch string, event Event) (Acknowledgement, error) {
		return i.Commit(ctx, link.Connection, branch, event)
	}, func(ctx context.Context, link *Link, branch string, event Event) error {
		if i.Bursts == nil || i.Bursts.Pool != i.Pool {
			return ErrNotReady
		}
		return i.Bursts.Hint(ctx, link.Connection, branch, event)
	})
}
