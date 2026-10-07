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

type ReconcileObjects interface {
	VerifyReconciliation(context.Context, string, wire.Reconciled) ([]string, error)
	RetainReconciliation(context.Context, string, string, wire.Reconciled) error
	BranchHead(context.Context, string) (string, error)
}

type ReconcileIngest struct {
	Objects ReconcileObjects
	Apply   func(context.Context, wire.Reconciled, string, string) error
}

// Write records the wake outcome without publishing Onto as the rebased result.
// Ingestor supplies the authenticated lease, ordered locks and replay receipt.
func (s *ReconcileIngest) Write(ctx context.Context, tx pgx.Tx, branch string, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	if s == nil || s.Objects == nil || s.Apply == nil || tx == nil {
		return ack, ErrNotReady
	}
	result, err := wire.DecodeReconciled(event.Payload)
	if err != nil {
		return ack, err
	}
	for _, path := range result.Paths {
		if !validBurstPath(path) {
			return ack, wire.BadValue
		}
	}
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, branch).Scan(&repository); err != nil {
		return ack, err
	}
	missing, err := s.Objects.VerifyReconciliation(ctx, branch, result)
	if err != nil {
		return ack, err
	}
	if len(missing) > 0 {
		ack.Outcome, ack.OIDs = AckMissingObjects, missing
		return ack, nil
	}
	current, err := s.Objects.BranchHead(ctx, branch)
	if err != nil {
		return ack, err
	}
	eventID := uuid.UUID(event.EventID).String()
	if err = s.Objects.RetainReconciliation(ctx, branch, eventID, result); err != nil {
		return ack, err
	}
	applied := current == result.Onto
	if err = s.Apply(ctx, result, eventID, current); err != nil {
		return ack, err
	}
	data, err := json.Marshal(map[string]any{"branch": branch, "old": result.Old, "onto": result.Onto, "conflict": result.Conflict, "paths": result.Paths, "applied": applied, "machine_event_id": eventID})
	if err != nil {
		return ack, err
	}
	if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, uuid.NewString(), "branch.reconciled", "completed", data); err != nil {
		return ack, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "branch_"+strings.ReplaceAll(branch, "-", "")+"_activity"); err != nil {
		return ack, err
	}
	ack.Outcome = AckApplied
	if !applied {
		ack.Outcome = AckStaleBase
	}
	return ack, nil
}

func (s GitCaptureObjects) VerifyReconciliation(ctx context.Context, branch string, event wire.Reconciled) ([]string, error) {
	var missing []string
	for _, head := range []string{event.Old, event.Onto} {
		tree, err := s.CommitTree(ctx, branch, head)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// Distinguish absent objects from malformed existing ones with the same
			// verifier used for captures; an absent tree is only a placeholder here.
			tree = strings.Repeat("0", 40)
		}
		absent, err := s.VerifyCapture(ctx, branch, wire.Captured{Head: head, Tree: tree, Base: event.Old})
		if err != nil {
			return nil, err
		}
		missing = append(missing, absent...)
	}
	return missing, nil
}
func (s GitCaptureObjects) RetainReconciliation(ctx context.Context, branch, eventID string, event wire.Reconciled) error {
	id, err := uuid.Parse(eventID)
	if err != nil || id.String() != eventID || id == uuid.Nil {
		return wire.BadValue
	}
	repo, err := (GitBurstObjects{Resolve: s.Resolve}).repository(ctx, branch)
	if err != nil {
		return err
	}
	for _, entry := range []struct{ name, head string }{{"old", event.Old}, {"onto", event.Onto}} {
		if !objectID(entry.head) {
			return wire.BadValue
		}
		ref := "refs/smithers/branches/" + branch + "/reconciliations/" + eventID + "/" + entry.name
		if _, err = burstGit(ctx, repo, 64, "update-ref", ref, entry.head, strings.Repeat("0", 40)); err != nil {
			current, readErr := burstGit(ctx, repo, 64, "rev-parse", "--verify", ref)
			if readErr != nil || strings.TrimSpace(string(current)) != entry.head {
				return fmt.Errorf("retain reconciliation: %w", err)
			}
		}
	}
	return nil
}
