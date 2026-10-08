package compose

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// machineRebase shares the install's authenticated connection, object transport
// and event consumer. It never substitutes a host working copy for the daemon.
type machineRebase struct {
	registry *machined.Registry
	pool     *pgxpool.Pool
}

func (r machineRebase) Rebase(ctx context.Context, branch string, member int64, onto string, admit func(pgx.Tx) error, guard func(func() error) error) (machined.RewriteResult, error) {
	if r.pool == nil || r.registry == nil || !r.registry.EventConsumerReady() {
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
	result, err := r.registry.RebaseWithObjects(ctx, branch, actor, onto, guard)
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
