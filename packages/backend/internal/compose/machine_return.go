package compose

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

type machineReturn struct {
	registry *machined.Registry
	pool     *pgxpool.Pool
}

func (r machineReturn) RequireReady(branch string) error {
	if r.pool == nil || r.registry == nil || !r.registry.EventConsumerReady() {
		return machined.ErrNotReady
	}
	link, err := r.registry.Current(branch)
	if err != nil {
		return err
	}
	return link.RequireReady(branch)
}
func (r machineReturn) ReturnToItem(ctx context.Context, branch string, login []byte) (machined.RewriteResult, error) {
	if err := r.RequireReady(branch); err != nil {
		return machined.RewriteResult{}, err
	}
	link, err := r.registry.Current(branch)
	if err != nil {
		return machined.RewriteResult{}, err
	}
	// The worker reauthorizes the winning credential immediately before this call.
	// Bind the reference to that durable choice, never to guest principal bytes.
	ref, err := machined.CommitActor(ctx, r.pool, branch, link.Machine(), func(ctx context.Context, tx pgx.Tx) (machined.ActorIdentity, error) {
		var member int64
		err := tx.QueryRow(ctx, `SELECT u.id FROM users u JOIN mythical_items i ON i.workspace_id=$1 JOIN workspaces w ON w.id::text=i.workspace_id CROSS JOIN LATERAL jsonb_array_elements(i.checks->'waits') wait WHERE u.username=$2 AND wait->>'id'=w.moved_off->>'wait' AND wait->>'kind'='moved_off' AND wait->>'answer'='return-to-item' AND (wait->'return'->>'user')::bigint=u.id AND wait->>'settled_at' IS NULL`, branch, string(login)).Scan(&member)
		return machined.ActorIdentity{Kind: "person", MemberID: member, Via: "web"}, err
	})
	if err != nil {
		return machined.RewriteResult{}, err
	}
	return r.registry.ReturnToItem(ctx, branch, ref)
}
