package machined

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// WriteReconciliation records the journaled wake settlement through Ingestor.
// It cannot publish a host ref or replace a captured head with a guest claim.
func WriteReconciliation(ctx context.Context, tx pgx.Tx, branch string, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq, Outcome: AckApplied}
	settlement, err := wire.DecodeReconciled(event.Payload)
	if err != nil {
		return ack, err
	}
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 FOR UPDATE`, branch).Scan(&repository); err != nil {
		return ack, err
	}
	data, err := json.Marshal(map[string]any{"branch": branch, "from": settlement.Old, "to": settlement.Onto, "conflict": settlement.Conflict, "paths": settlement.Paths})
	if err != nil {
		return ack, err
	}
	_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, uuid.NewString(), "branch.reconciled", "completed", data)
	return ack, err
}
