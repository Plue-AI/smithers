package compose

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

type machineBurstStore struct{ host *repohost.Client }

func (s machineBurstStore) WithBurstObjects(ctx context.Context, tx pgx.Tx, branch string, visit func(machined.BurstObjects) error) error {
	return withMachineRepositoryTx(ctx, tx, branch, s.host, func(path string) error {
		return visit(machined.GitBurstObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }})
	})
}

// A cumulative counter supplies burst rate to the existing metrics collector.
// An install without a daemon producer does not fabricate zero observations.
func machineBurstObservations(metrics *routes.SmithersMetrics, registry *machined.Registry) func() {
	if registry == nil {
		return nil
	}
	bursts := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "smithers_machine_bursts_total",
		Help: "Logical machine bursts committed by this process; staging, replay and failed ingestion are excluded.",
	})
	metrics.MustRegister(bursts)
	return bursts.Inc
}

func bindMachineEvents(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client, observeCommitted func()) (func(), error) {
	if registry == nil {
		return func() {}, nil
	}
	if pool == nil || host == nil {
		return nil, machined.ErrNotReady
	}
	// No live-presence fallback: only immutable references or retained receipts
	// can establish an earlier actor after close, revocation or counter reuse.
	burst := &machined.BurstIngest{Pool: pool, Objects: machineBurstStore{host}, ObserveCommitted: observeCommitted}
	return registry.ConsumeEvents(ctx, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) (machined.Acknowledgement, error) {
		ingest := &machined.Ingestor{Pool: pool, Bursts: burst, Prepare: func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.EventWriter, error) {
			if len(event.Payload) == 0 || (event.Payload[0] != 2 && event.Payload[0] != 3) {
				return nil, machined.ErrNotReady
			}
			return prepareMachineCaptureWriter(host)(ctx, tx, branch, event)
		}}
		return ingest.Commit(ctx, link.Connection, branch, event)
	}, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) error {
		return burst.Hint(ctx, link.Connection, branch, event)
	})
}

func machineBranchHead(pool *pgxpool.Pool, host *repohost.Client) func(context.Context, string) (string, error) {
	return func(ctx context.Context, branch string) (string, error) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return "", err
		}
		defer tx.Rollback(ctx)
		var head string
		err = withMachineRepositoryTx(ctx, tx, branch, host, func(path string) error {
			row, err := db.New(tx).GetWorkspace(ctx, branch)
			if err != nil {
				return err
			}
			if row.HeadPushTokenID.Valid {
				return machined.ErrNotReady
			}
			seed := row.HeadCommitID
			if seed == "" {
				seed = row.SourceCommit
			}
			objects := machined.HostObjects{Visit: func(ctx context.Context, _ string, visit func(string) error) error { return visit(path) }}
			var readErr error
			head, readErr = objects.Head(ctx, branch, seed)
			return readErr
		})
		return head, err
	}
}
