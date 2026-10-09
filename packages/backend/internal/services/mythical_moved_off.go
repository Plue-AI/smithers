package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type workspaceMovedOff struct {
	By            json.RawMessage `json:"by"`
	Item          uint64          `json:"item"`
	PreMoveCommit string          `json:"pre_move_commit"`
	Wait          string          `json:"wait"`
}

// PrepareMovedOffEvent runs inside the authenticated event dispatcher. Attribution
// is resolved by its host session provider, never by a guest-supplied display name.
func (s *MythicalService) PrepareMovedOffEvent(resolve func(context.Context, string, wire.Actor) (json.RawMessage, error)) machined.EventPreparation {
	return func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event, commit machined.EventCommit) (machined.Acknowledgement, error) {
		ack := machined.Acknowledgement{Seq: event.Seq}
		if s == nil || resolve == nil {
			return ack, machined.ErrNotReady
		}
		if _, err := wire.DecodeMovedOff(event.Payload); err != nil {
			return ack, err
		}
		if _, err := PrepareMachineCaptureTx(ctx, tx, branch); err != nil {
			return ack, err
		}
		return commit(s.movedOffWriter(func(ctx context.Context, _ pgx.Tx, branch string, actor wire.Actor) (json.RawMessage, error) {
			return resolve(ctx, branch, actor)
		}))
	}
}
func (s *MythicalService) movedOffWriter(resolve func(context.Context, pgx.Tx, string, wire.Actor) (json.RawMessage, error)) machined.EventWriter {
	return func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
		ack := machined.Acknowledgement{Seq: event.Seq}
		if s == nil || tx == nil || resolve == nil {
			return ack, machined.ErrNotReady
		}
		moved, err := wire.DecodeMovedOff(event.Payload)
		if err != nil {
			return ack, err
		}
		by, err := resolve(ctx, tx, branch, moved.Actor)
		if err != nil {
			return ack, err
		}
		if !json.Valid(by) || string(by) == "null" {
			return ack, machined.ErrUnauthorized
		}
		var repository int64
		if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository); err != nil {
			return ack, err
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return ack, err
		}
		var prior []byte
		var number int64
		if err = tx.QueryRow(ctx, `SELECT w.moved_off,i.number FROM workspaces w JOIN mythical_lanes l ON l.workspace_id=w.id::text AND l.retired_at IS NULL JOIN mythical_items i ON i.id=l.item_id AND i.repository_id=w.repository_id WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w`, branch).Scan(&prior, &number); err != nil {
			return ack, err
		}
		if number <= 0 || uint64(number) != moved.Item {
			return ack, machined.ErrUnauthorized
		}
		q := db.New(tx)
		item, err := q.GetMythicalItemByNumber(ctx, repository, number)
		if err != nil {
			return ack, err
		}
		// A retained machine event cannot reopen a settled TODO. Record the
		// transport rejection so its outbox can drain without changing either
		// the branch fact or the item's waits.
		switch item.State {
		case "landed", "cancelled", "rejected", "declined":
			ack.Outcome = machined.AckRejected
			return ack, nil
		}
		from := todoState(item)
		checks := mythicalChecksOf(item)
		var fact workspaceMovedOff
		if len(prior) > 0 {
			if err = json.Unmarshal(prior, &fact); err != nil {
				return ack, err
			}
			if fact.Item != moved.Item {
				return ack, machined.ErrUnauthorized
			}
		}
		if moved.Returned {
			if len(prior) == 0 {
				ack.Outcome = machined.AckApplied
				return ack, nil
			}
			if fact.Item != moved.Item || fact.PreMoveCommit != moved.PreMoveCommit {
				return ack, machined.ErrUnauthorized
			}
			now := s.now().UTC()
			for i := range checks.Waits {
				if checks.Waits[i].ID == fact.Wait && checks.Waits[i].Kind == "moved_off" {
					checks.Waits[i].SettledAt = &now
				}
			}
			prior = nil
		} else {
			// Redelivery under a different transport ID still retains the first target.
			if len(prior) > 0 {
				ack.Outcome = machined.AckApplied
				return ack, nil
			}
			fact = workspaceMovedOff{By: by, Item: moved.Item, PreMoveCommit: moved.PreMoveCommit, Wait: "moved-" + uuid.UUID(event.EventID).String()}
			var actor struct {
				Name  string `json:"name"`
				Login string `json:"login"`
			}
			if err = json.Unmarshal(by, &actor); err != nil {
				return ack, err
			}
			label := actor.Name
			if label == "" {
				label = actor.Login
			}
			if label == "" {
				label = "Outside"
			}
			checks.Waits = append(checks.Waits, TodoWait{ID: fact.Wait, Kind: "moved_off", Prompt: fmt.Sprintf("%s moved this branch off T%d", label, number), Since: s.now().UTC(), SHA: moved.PreMoveCommit, By: by})
			prior, err = json.Marshal(fact)
			if err != nil {
				return ack, err
			}
		}
		item.Checks = checks.encode()
		saved, err := q.SaveMythicalItem(ctx, item)
		if err != nil {
			return ack, err
		}
		if _, err = tx.Exec(ctx, `UPDATE workspaces SET moved_off=$2,updated_at=NOW() WHERE id=$1`, branch, prior); err != nil {
			return ack, err
		}
		text := fmt.Sprintf("moved this branch off T%d", number)
		if moved.Returned {
			text = fmt.Sprintf("returned to T%d", number)
		}
		data, err := json.Marshal(map[string]any{"id": uuid.UUID(event.EventID).String(), "kind": "moved_off", "actor": by, "from": from, "to": todoState(saved), "text": text, "branch": branch, "n": number, "wait": fact.Wait, "moved_off": json.RawMessage(prior), "by": by})
		if err != nil {
			return ack, err
		}
		kind := "todo.moved-off"
		if moved.Returned {
			kind = "todo.returned-to-item"
		}
		if _, err = s.recordTodoFact(ctx, tx, saved, uuid.UUID(event.EventID).String(), kind, todoState(saved), data); err != nil {
			return ack, err
		}
		if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, uuid.NewString(), "branch.moved-off", "completed", data); err != nil {
			return ack, err
		}
		notice, err := json.Marshal(map[string]any{"moved_off": json.RawMessage(prior)})
		if err != nil {
			return ack, err
		}
		if _, err = tx.Exec(ctx, `SELECT pg_notify($1,$2)`, "workspace_status_"+strings.ReplaceAll(branch, "-", ""), string(notice)); err != nil {
			return ack, err
		}
		if _, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "branch_"+strings.ReplaceAll(branch, "-", "")+"_activity"); err != nil {
			return ack, err
		}
		if moved.Returned {
			if _, err = q.RequestMythicalStack(ctx, repository); err != nil {
				return ack, err
			}
		}
		ack.Outcome = machined.AckApplied
		return ack, nil
	}
}

// PrepareStoredMovedOffEvent uses the same immutable host references as bursts.
func (s *MythicalService) PrepareStoredMovedOffEvent(machine string, render func(context.Context, pgx.Tx, json.RawMessage) (json.RawMessage, error)) machined.EventPreparation {
	return func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event, commit machined.EventCommit) (machined.Acknowledgement, error) {
		ack := machined.Acknowledgement{Seq: event.Seq}
		if _, err := wire.DecodeMovedOff(event.Payload); err != nil {
			return ack, err
		}
		if _, err := PrepareMachineCaptureTx(ctx, tx, branch); err != nil {
			return ack, err
		}
		return commit(s.movedOffWriter(func(ctx context.Context, tx pgx.Tx, branch string, actor wire.Actor) (json.RawMessage, error) {
			raw, err := machined.ResolveStoredEventActor(ctx, tx, branch, machine, actor)
			if err != nil {
				return nil, err
			}
			if render == nil {
				return nil, machined.ErrNotReady
			}
			return render(ctx, tx, raw)
		}))
	}
}
