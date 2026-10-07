package compose

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// machineRoster keeps member allocations authoritative across link partitions.
// set_roster returns only after the broker has emptied every unlisted session
// cgroup. The owner row lock orders that receipt with member mutations, so a
// stale snapshot cannot restore a member after their removal commits.
type machineRoster struct {
	pool   *pgxpool.Pool
	client interface {
		SetRoster(context.Context, string, []machined.SessionUser) error
	}
	branches func() []string
	mu       sync.Mutex
	removed  map[int64]revocation.Event
	applied  map[string]map[int64]int64
}

func (r *machineRoster) syncBranch(ctx context.Context, branch string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT user_id FROM self_host_owners FOR SHARE`); err != nil {
		return err
	}
	members, err := readMachineMembers(ctx, tx, branch)
	if err != nil {
		return err
	}
	// A restoration before event delivery must not preserve an old session.
	// Temporarily omit every revoked allocation whose receipt this branch lacks,
	// then restore current access only after the broker confirms cleanup.
	r.mu.Lock()
	pending := []revocation.Event{}
	for user, event := range r.removed {
		if r.applied[branch] == nil || r.applied[branch][user] < event.ID {
			pending = append(pending, event)
		}
	}
	r.mu.Unlock()
	excluded := map[uint32]bool{}
	for _, event := range pending {
		rows, err := tx.Query(ctx, `SELECT c.unix_uid FROM collaborators c JOIN workspaces w ON w.repository_id=c.repository_id
   WHERE w.id=$1::uuid AND (c.user_id=$2 OR c.unix_github_id::text IN
   (SELECT provider_user_id FROM oauth_accounts WHERE user_id=$2 AND provider='workos'))`, branch, event.UserID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var uid uint32
			if err = rows.Scan(&uid); err != nil {
				rows.Close()
				return err
			}
			excluded[uid] = true
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return err
		}
	}
	if len(excluded) > 0 {
		restricted := []machined.SessionUser{}
		for _, member := range members {
			if !excluded[member.UID] {
				restricted = append(restricted, member)
			}
		}
		if err = r.client.SetRoster(ctx, branch, restricted); err != nil {
			return err
		}
	}
	if err = r.client.SetRoster(ctx, branch, members); err != nil {
		return err
	}
	r.mu.Lock()
	if r.applied == nil {
		r.applied = map[string]map[int64]int64{}
	}
	if r.applied[branch] == nil {
		r.applied[branch] = map[int64]int64{}
	}
	for _, event := range pending {
		if event.ID > r.applied[branch][event.UserID] {
			r.applied[branch][event.UserID] = event.ID
		}
	}
	r.mu.Unlock()
	return nil
}

// start uses the durable bus for latency and a one-second recovery poll for
// missed notifications, additions and reconnects. Each branch progresses
// independently; a partition cannot delay revocation on another machine.
func (r *machineRoster) start(ctx context.Context, bus *revocation.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	wake := make(chan struct{}, 1)
	unsubscribe := bus.Subscribe(func(event revocation.Event) {
		switch event.Kind {
		case revocation.KindCollaboratorRemoved, revocation.KindUserDisabled:
			r.mu.Lock()
			if r.removed == nil {
				r.removed = map[int64]revocation.Event{}
			}
			if event.ID > r.removed[event.UserID].ID {
				r.removed[event.UserID] = event
			}
			r.mu.Unlock()
			select {
			case wake <- struct{}{}:
			default:
			}
		}
	})
	var workers sync.WaitGroup
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		var mu sync.Mutex
		busy := map[string]bool{}
		for {
			for _, branch := range r.branches() {
				mu.Lock()
				if busy[branch] {
					mu.Unlock()
					continue
				}
				busy[branch] = true
				mu.Unlock()
				workers.Add(1)
				go func(branch string) {
					defer workers.Done()
					defer func() { mu.Lock(); delete(busy, branch); mu.Unlock() }()
					callCtx, stop := context.WithTimeout(ctx, 3*time.Second)
					defer stop()
					if err := r.syncBranch(callCtx, branch); err != nil && ctx.Err() == nil {
						slog.Warn("machine roster reconciliation failed", "branch", branch, "error", err)
					}
				}(branch)
			}
			select {
			case <-ctx.Done():
				workers.Wait()
				return
			case <-ticker.C:
			case <-wake:
			}
		}
	}()
	return func() { unsubscribe(); cancel(); <-done }
}

func readMachineMembers(ctx context.Context, tx pgx.Tx, branch string) ([]machined.SessionUser, error) {
	rows, err := tx.Query(ctx, `SELECT c.unix_login,c.unix_uid FROM collaborators c
 JOIN workspaces w ON w.repository_id=c.repository_id
 LEFT JOIN users u ON u.id=c.user_id
 WHERE w.id=$1::uuid AND c.suspended_at IS NULL
 AND (c.github_id IS NOT NULL OR c.user_id IS NOT NULL)
 AND c.permission IN ('admin','write') AND coalesce(u.prohibit_login,false)=false
 ORDER BY c.unix_uid`, branch)
	if err != nil {
		return nil, err
	}
	members := []machined.SessionUser{}
	for rows.Next() {
		var member machined.SessionUser
		if err = rows.Scan(&member.Login, &member.UID); err != nil {
			rows.Close()
			return nil, err
		}
		members = append(members, member)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return members, nil
}

// withProvisioningRoster holds the same owner lock as broker reconciliation,
// so removal cannot commit between reading allocations and guest setup.
func (r *machineRoster) withProvisioningRoster(ctx context.Context, branch string, visit func([]microsandbox.MemberIdentity) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT user_id FROM self_host_owners FOR SHARE`); err != nil {
		return err
	}
	members, err := readMachineMembers(ctx, tx, branch)
	if err != nil {
		return err
	}
	identities := make([]microsandbox.MemberIdentity, 0, len(members))
	for _, member := range members {
		identities = append(identities, microsandbox.MemberIdentity{Login: member.Login, UID: int(member.UID), Active: true})
	}
	return visit(identities)
}
