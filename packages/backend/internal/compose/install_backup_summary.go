package compose

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// The stack comes from product SQL; captured heads/disks and finished steps
// come from their own authorities. Missing authorities are never empty work.
type installBackupSummary struct {
	pool     *pgxpool.Pool
	captures ports.InstallCaptureSummary
	runs     ports.InstallRunSummary
}

func (s installBackupSummary) Check(ctx context.Context) error {
	var refusals []error
	if s.pool == nil {
		refusals = append(refusals, errors.New("backup database authority unavailable"))
	}
	if s.captures == nil {
		refusals = append(refusals, &services.QuiesceDependencyError{Ticket: "T-MCH-07"})
	} else {
		refusals = append(refusals, s.captures.Check(ctx))
	}
	if s.runs == nil {
		refusals = append(refusals, &services.QuiesceDependencyError{Ticket: "T-FLW-01"})
	} else {
		refusals = append(refusals, s.runs.Check(ctx))
	}
	return errors.Join(append(refusals, ctx.Err())...)
}
func (s installBackupSummary) Summary(ctx context.Context) (hostbackup.Manifest, error) {
	var out hostbackup.Manifest
	if err := s.Check(ctx); err != nil {
		return out, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	repository, err := services.InstallRepositoryID(ctx, db.New(tx))
	if err != nil {
		return out, err
	}
	// No LIMIT: each TODO is represented, including settled work and null places.
	err = tx.QueryRow(ctx, `SELECT coalesce(jsonb_agg(jsonb_build_object('number',number,'state',state,'place',stack_position) ORDER BY stack_position NULLS LAST,number,id),'[]'::jsonb) FROM mythical_items WHERE repository_id=$1`, repository).Scan(&out.Stack)
	if err != nil {
		return out, err
	}
	out.BranchHeads, out.MachineDisks, err = s.captures.Captured(ctx)
	if err != nil {
		return out, err
	}
	out.RunJournals, err = s.runs.FinishedSteps(ctx)
	if err != nil {
		return out, err
	}
	if err = hostbackup.ValidateSummary(out); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
