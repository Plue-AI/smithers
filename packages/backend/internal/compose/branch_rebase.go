package compose

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// machineRebase shares the install's authenticated connection, object transport
// and event consumer. It never substitutes a host working copy for the daemon.
type machineRebase struct {
	registry    *machined.Registry
	pool        *pgxpool.Pool
	presence    *branchPresence
	ensureReady func(context.Context, string) error
}

func (r machineRebase) Rebase(ctx context.Context, branch string, member int64, onto, base string, admit func(pgx.Tx) error, guard func(func() error) error) (machined.RewriteResult, error) {
	if r.pool == nil || r.registry == nil || guard == nil || !r.registry.EventConsumerReady() {
		return machined.RewriteResult{}, fmt.Errorf("rebase event consumer: %w", machined.ErrNotReady)
	}
	link, err := r.readyLink(ctx, branch)
	if err != nil {
		return machined.RewriteResult{}, err
	}
	if r.presence != nil {
		// Materializing an asleep conflict wakes the daemon first. Its retained
		// coding host must also resume its authenticated roster; host absence
		// on an awake machine remains unknown, never permission to rewrite.
		if r.presence.hosts == nil || r.presence.dispatcher == nil {
			return machined.RewriteResult{}, machined.ErrNotReady
		}
		var target flowruntime.Target
		target.WorkspaceID = branch
		// The private durable binding, including its original principal, is
		// authority for host restart. The browser reader accepts live hosts
		// only and must not acquire a new wake side effect.
		lookup := r.pool.QueryRow(ctx, `SELECT tenant_id,principal_id,binding_kind,binding_id FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND catalog_key=$2 AND state<>'retired' AND binding_kind IN ($3,'browser-flow')`, branch, flowhost.CatalogCoding, flowdispatch.StackBindingKind).Scan(&target.TenantID, &target.PrincipalID, &target.BindingKind, &target.BindingID)
		if errors.Is(lookup, pgx.ErrNoRows) {
			// Scratch has no coding run to resume. It still requires the full
			// composed source census below; absence never becomes agent-alone.
			row, err := r.presence.queries.GetWorkspace(ctx, branch)
			if err != nil || !row.IsFork || !strings.HasPrefix(row.TargetBookmark, "scratch/") {
				return machined.RewriteResult{}, machined.ErrNotReady
			}
			_, slug, err := installRepository(ctx, r.presence.queries)
			if err != nil {
				return machined.RewriteResult{}, err
			}
			target = flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", member), WorkspaceID: branch, BindingKind: "browser-flow", BindingID: slug}
			ready, err := r.presence.dispatcher.StartHost(ctx, target)
			if err != nil {
				return machined.RewriteResult{}, err
			}
			if !ready {
				return machined.RewriteResult{}, machined.ErrNotReady
			}
		} else {
			if lookup != nil {
				return machined.RewriteResult{}, lookup
			}
			ready, err := r.presence.dispatcher.StartHost(ctx, target)
			if err != nil {
				return machined.RewriteResult{}, err
			}
			if !ready {
				return machined.RewriteResult{}, machined.ErrNotReady
			}
		}
	}
	actor, err := machined.CommitActor(ctx, r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: member, Via: "web"}, nil
	})
	if err != nil {
		return machined.RewriteResult{}, err
	}
	ctx = context.WithValue(ctx, machineRebaseExportKey{}, machineRebaseExport{branch: branch, target: onto, admit: admit})
	result, err := r.registry.RebaseWithObjects(ctx, branch, actor, onto, base, func(rewrite func() error) error {
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

// Capture and rewrite use the same admitted daemon. Preparing a Scratch
// capture must not require a previous rebase to have started its transport.
func (r machineRebase) readyLink(ctx context.Context, branch string) (*machined.Link, error) {
	if r.registry == nil {
		return nil, machined.ErrNotReady
	}
	link, err := r.registry.Current(branch)
	if (err != nil || link.RequireReady(branch) != nil) && r.ensureReady != nil {
		if err := r.ensureReady(ctx, branch); err != nil {
			return nil, err
		}
		link, err = r.registry.Current(branch)
	}
	if err != nil {
		return nil, fmt.Errorf("rebase connection: %w", err)
	}
	if err := link.RequireReady(branch); err != nil {
		return nil, fmt.Errorf("rebase readiness: %w", err)
	}
	return link, nil
}

func (r machineRebase) Capture(ctx context.Context, branch string) (machined.CaptureResult, error) {
	if _, err := r.readyLink(ctx, branch); err != nil {
		return machined.CaptureResult{}, err
	}
	return r.registry.Capture(ctx, branch)
}

func (r machineRebase) InspectConflict(ctx context.Context, branch, change, onto string) ([]string, error) {
	if r.registry == nil {
		return nil, machined.ErrNotReady
	}
	return r.registry.InspectConflict(ctx, branch, change, onto)
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
