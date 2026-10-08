package machined

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type CaptureObjects interface {
	VerifyCapture(context.Context, string, wire.Captured) ([]string, error)
	PublishCapture(context.Context, string, wire.Captured) (bool, error)
}

// CaptureIngest projects verified snapshots through Ingestor's fenced,
// commit-before-ack transaction. Reconcile must persist stale-base recovery and
// pending-work delivery in that same transaction; an absent adapter refuses
// capture rather than silently dropping either obligation.
type CaptureIngest struct {
	Objects   CaptureObjects
	Reconcile func(context.Context, pgx.Tx, string, wire.Captured, bool) error
}

func (s *CaptureIngest) Write(ctx context.Context, tx pgx.Tx, branch string, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	if s == nil || s.Objects == nil || s.Reconcile == nil || tx == nil {
		return ack, ErrNotReady
	}
	capture, err := wire.DecodeCaptured(event.Payload)
	if err != nil {
		return ack, err
	}
	// Serialize with other host writers before Git publication. Ref CAS is
	// still authoritative if a rewrite happens outside this transaction.
	var repository int64
	var status string
	if err = tx.QueryRow(ctx, `SELECT repository_id,status FROM workspaces WHERE id=$1 FOR NO KEY UPDATE`, branch).Scan(&repository, &status); err != nil {
		return ack, err
	}
	missing, err := s.Objects.VerifyCapture(ctx, branch, capture)
	if err != nil {
		return ack, err
	}
	if len(missing) != 0 {
		ack.Outcome, ack.OIDs = AckMissingObjects, missing
		return ack, nil
	}
	applied, err := s.Objects.PublishCapture(ctx, branch, capture)
	if err != nil {
		return ack, err
	}
	// Publication may survive a SQL rollback. Replay repairs the projection;
	// the immutable capture pin keeps the bytes throughout that interruption.
	if err = s.Reconcile(ctx, tx, branch, capture, applied); err != nil {
		return ack, err
	}
	ack.Outcome = AckStaleBase
	if applied {
		if _, err = tx.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2,updated_at=NOW() WHERE id=$1`, branch, capture.Head); err != nil {
			return ack, err
		}
		ack.Outcome = AckApplied
	}
	data, err := json.Marshal(map[string]any{"branch": branch, "head": capture.Head, "tree": capture.Tree, "base": capture.Base, "applied": applied, "machine_event_id": uuid.UUID(event.EventID).String()})
	if err != nil {
		return ack, err
	}
	if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, uuid.NewString(), "branch.captured", "completed", data); err != nil {
		return ack, err
	}
	if applied {
		payload, err := json.Marshal(map[string]any{"status": status, "head": map[string]string{"commit_id": capture.Head}})
		if err != nil {
			return ack, err
		}
		if _, err = tx.Exec(ctx, `SELECT pg_notify($1,$2)`, "workspace_status_"+strings.ReplaceAll(branch, "-", ""), string(payload)); err != nil {
			return ack, err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "branch_"+strings.ReplaceAll(branch, "-", "")+"_activity"); err != nil {
		return ack, err
	}
	return ack, nil
}
