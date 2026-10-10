package compose

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type installMachineBarrier struct {
	pool     *pgxpool.Pool
	registry *machined.Registry
	sessions bool
}

func (b installMachineBarrier) Check(ctx context.Context) error {
	if b.pool == nil || b.registry == nil {
		return errors.New("authenticated machine authority unavailable")
	}
	rows, err := db.New(b.pool).ListRunningWorkspaces(ctx)
	if err != nil {
		return err
	}
	var refusals []error
	for _, row := range rows {
		link, err := b.registry.Current(row.ID)
		if err == nil {
			err = link.RequireMachine(row.ID, row.VmID)
		}
		if err != nil {
			refusals = append(refusals, fmt.Errorf("branch %s: %w", row.ID, err))
			continue
		}
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		idle, _, err := b.registry.IdleSafety(probe, row.ID)
		cancel()
		if err != nil {
			refusals = append(refusals, fmt.Errorf("branch %s: %w", row.ID, err))
		} else if !b.sessions && !idle {
			refusals = append(refusals, fmt.Errorf("open burst: %s", row.TargetBookmark))
		}
	}
	return errors.Join(refusals...)
}
func (b installMachineBarrier) Drain(ctx context.Context) error {
	if err := b.Check(ctx); err != nil {
		return err
	}
	rows, err := db.New(b.pool).ListRunningWorkspaces(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !b.sessions {
			// Reuse authenticated capture's document flush and durable outbox
			// acknowledgement. The machine phase captures again after sessions
			// end, so this is never substituted for the final snapshot.
			if _, err := b.registry.Capture(ctx, row.ID); err != nil {
				return fmt.Errorf("branch %s: flush documents: %w", row.ID, err)
			}
			continue
		}
		link, err := b.registry.Current(row.ID)
		if err != nil {
			return err
		}
		if err := link.RequireMachine(row.ID, row.VmID); err != nil {
			return err
		}
		// Include suspended accounts: lingering processes remain owned by their
		// allocated uid even after roster removal. Broker confirms cgroup empty.
		members, err := b.pool.Query(ctx, `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=$1 AND unix_login<>'' ORDER BY unix_uid`, row.RepositoryID)
		if err != nil {
			return err
		}
		users := []machined.SessionUser{{Login: "agent", UID: 19999}}
		for members.Next() {
			var user machined.SessionUser
			if err := members.Scan(&user.Login, &user.UID); err != nil {
				members.Close()
				return err
			}
			users = append(users, user)
		}
		members.Close()
		if err := members.Err(); err != nil {
			return err
		}
		peer := machined.NewSessions(link.Connection, row.ID, b.registry.Sessions(row.ID))
		for _, user := range users {
			if _, err := peer.KillUser(ctx, user); err != nil {
				return fmt.Errorf("branch %s: end sessions: %w", row.ID, err)
			}
		}
	}
	return nil
}
func (b installMachineBarrier) Resume(ctx context.Context) error { return ctx.Err() }

// Capture already stops branch hosts. Stop also covers hosts without an awake
// machine, under the existing binding lock and pinned-run predicate. Hosts
// restart lazily through the ordinary resolver after admission reopens.
type installQuiesceFlowRuntime struct{ flow *flowComposition }

func (h installQuiesceFlowRuntime) Stop(ctx context.Context) error {
	f := h.flow
	if f == nil || f.pool == nil || f.bindings == nil || f.stopper == nil || f.jobs == nil {
		return &services.QuiesceDependencyError{Ticket: "T-FLW-01"}
	}
	rows, err := f.pool.Query(ctx, `SELECT DISTINCT workspace_id FROM flow_runtime_host_bindings WHERE state<>'retired' AND (state<>'pending' OR service_identity<>'') ORDER BY workspace_id`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	active := flowhost.ActiveRunsFunc(func(ctx context.Context, host flowhost.Binding) (bool, error) {
		return flowdispatch.HasPinnedLaunches(ctx, f.jobs, jobs.Scope{TenantID: host.TenantID, PrincipalID: host.PrincipalID}, flowruntime.Identity{RuntimeArtifactDigest: host.RuntimeArtifactDigest, SourceRevision: host.SourceRevision})
	})
	for _, id := range ids {
		if err := f.bindings.PrepareWorkspaceCapture(ctx, id, f.stopper, active); err != nil {
			return err
		}
	}
	return nil
}
func (h installQuiesceFlowRuntime) Resume(ctx context.Context) error { return ctx.Err() }

// Merge preflight reports both durable merge fences and every open burst.
type installMergeBarrier struct {
	stack    services.StackQuiesceBarrier
	machines installMachineBarrier
}

func (b installMergeBarrier) Check(ctx context.Context) error {
	return errors.Join(b.stack.Check(ctx), b.machines.Check(ctx))
}
func (b installMergeBarrier) Drain(ctx context.Context) error  { return b.Check(ctx) }
func (b installMergeBarrier) Resume(ctx context.Context) error { return ctx.Err() }

func composeInstallQuiesceBarriers(s *services.InstallQuiesce, pool *pgxpool.Pool, registry *machined.Registry, flow *flowComposition) {
	s.Barriers = map[string]services.QuiesceBarrier{
		"T-STK-04": services.StackQuiesceBarrier{Pool: pool},
		"T-GH-09":  services.StackQuiesceBarrier{Pool: pool, ExternalWrites: true},
		"T-SEC-01": services.SecurityQuiesceBarrier{},
	}
	if registry != nil {
		s.Barriers["T-STK-04"] = installMergeBarrier{stack: services.StackQuiesceBarrier{Pool: pool}, machines: installMachineBarrier{pool: pool, registry: registry}}
		s.Barriers["T-COL-08"] = installMachineBarrier{pool: pool, registry: registry}
		s.Barriers["T-TRM-07"] = installMachineBarrier{pool: pool, registry: registry, sessions: true}
	}
	if flow != nil {
		s.Host = installQuiesceFlowRuntime{flow}
	}
}
