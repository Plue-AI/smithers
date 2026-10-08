package compose

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// machineRebase shares the install's authenticated connection, object transport
// and event consumer. It never substitutes a host working copy for the daemon.
type machineRebase struct {
	registry *machined.Registry
	pool     *pgxpool.Pool
	presence *branchPresence
}

func (r machineRebase) Rebase(ctx context.Context, branch string, member int64, onto string, admit func(pgx.Tx) error, guard func(func() error) error) (machined.RewriteResult, error) {
	if r.pool == nil || r.registry == nil || guard == nil || !r.registry.EventConsumerReady() {
		return machined.RewriteResult{}, fmt.Errorf("rebase event consumer: %w", machined.ErrNotReady)
	}
	link, err := r.registry.Current(branch)
	if err != nil {
		return machined.RewriteResult{}, fmt.Errorf("rebase connection: %w", err)
	}
	if err := link.RequireReady(branch); err != nil {
		return machined.RewriteResult{}, fmt.Errorf("rebase readiness: %w", err)
	}
	actor, err := machined.CommitActor(ctx, r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: member, Via: "web"}, nil
	})
	if err != nil {
		return machined.RewriteResult{}, err
	}
	ctx = context.WithValue(ctx, machineRebaseExportKey{}, machineRebaseExport{branch: branch, target: onto, admit: admit})
	result, err := r.registry.RebaseWithObjects(ctx, branch, actor, onto, func(rewrite func() error) error {
		// Import temporarily fences ordinary daemon requests. The presence
		// consumer must apply its next complete snapshot before the existing
		// guard opens the rewrite transaction; otherwise every retry imports
		// again and clears the census it is trying to consult.
		if r.presence != nil {
			row, err := r.presence.queries.GetWorkspace(ctx, branch)
			if err != nil {
				return err
			}
			if err := awaitRebaseCensus(ctx, func() bool { return r.presence.sourcesReady != nil && r.presence.sourcesReady(ctx, row) }); err != nil {
				return err
			}
		}
		return guard(rewrite)
	})
	if err != nil {
		return result, fmt.Errorf("native rebase: %w", err)
	}
	return result, nil
}
func (r machineRebase) Capture(ctx context.Context, branch string) (machined.CaptureResult, error) {
	if r.registry == nil {
		return machined.CaptureResult{}, machined.ErrNotReady
	}
	return r.registry.Capture(ctx, branch)
}

// Only the stack executor can select an import target. The exporter rechecks
// its claim, requester and prefix in its own ordered authority transaction.
type machineRebaseExportKey struct{}
type machineRebaseExport struct {
	branch, target string
	admit          func(pgx.Tx) error
}

// Waiting restores no authority: the ordered transaction still checks the
// current requester, target, fences and roster before invoking the daemon.
func awaitRebaseCensus(ctx context.Context, ready func() bool) error {
	ctx, cancel := context.WithTimeout(ctx, presenceLease)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if ready != nil && ready() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
