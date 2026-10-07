package machined

import (
	"context"
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

// Ingestor is the authenticated dispatcher's commit-before-ack boundary. An
// absent writer refuses admission rather than recording a receipt for lost work.
type Ingestor struct {
	Pool  *pgxpool.Pool
	Write EventWriter
	// Bursts shares this pump and its authenticated lease. Split bursts own
	// their staging transaction; all other durable events use Write below.
	Bursts *BurstIngest
}

func (i *Ingestor) Commit(ctx context.Context, connection *Connection, branch string, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	if i == nil || i.Pool == nil || (i.Write == nil && i.Bursts == nil) {
		return ack, ErrNotReady
	}
	if connection == nil || connection.registry == nil {
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
		if connection.boot == nil || connection.boot.branch != branch {
			return ack, ErrUnauthorized
		}
		var repository int64
		if err := i.Pool.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository); err != nil {
			return ack, err
		}
		return i.Bursts.Apply(ctx, connection, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, event)
	}
	if i.Write == nil {
		return ack, ErrNotReady
	}
	id := event.EventID
	// Fence replacement through commit, including a newer boot arriving while
	// objects are verified. Network acknowledgement runs after releasing the lock.
	r := connection.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if branch != connection.boot.branch || !connection.current() {
		return ack, ErrUnauthorized
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
	eventID := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	// The unique insert serializes concurrent replay across connections/processes.
	inserted, err := tx.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,'pending') ON CONFLICT(workspace_id,event_id) DO NOTHING`, branch, eventID)
	if err != nil {
		return ack, err
	}
	if inserted.RowsAffected() == 0 {
		var outcome string
		if err = tx.QueryRow(ctx, `SELECT outcome FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, eventID).Scan(&outcome); err != nil {
			return ack, err
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
		ack, err = i.Write(ctx, tx, branch, event)
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
	if err = tx.Commit(ctx); err != nil {
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
	// Admission cannot survive loss of the durable consumer. Close this lease
	// on every exit so awake RPCs refuse until a new connection reconciles and
	// replays the outbox. Link.Close fences only this boot's connection.
	defer link.Close()
	if i == nil || i.Pool == nil || (i.Write == nil && i.Bursts == nil) {
		return ErrNotReady
	}
	for {
		event, err := link.Receive(ctx)
		if err != nil {
			return err
		}
		if event.Seq == 0 {
			if i.Bursts == nil || i.Bursts.Pool != i.Pool {
				return ErrNotReady
			}
			if err = i.Bursts.Hint(ctx, link.Connection, branch, event); err != nil {
				return err
			}
			continue // transient hints never receive durable receipts or acks
		}
		ack, err := i.Commit(ctx, link.Connection, branch, event)
		if err != nil {
			return err
		}
		if err = link.Ack(ctx, branch, ack); err != nil {
			return err
		}
	}
}
