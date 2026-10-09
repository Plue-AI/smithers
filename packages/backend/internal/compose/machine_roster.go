package compose

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	// Freeze allocations before locking linked users: invited GitHub writers
	// can be provisioned before login, but a linked inactive user cannot enter.
	// The workspace row takes a key-share lock: it freezes the row's identity
	// against deletion, and admits the machine start's own vm_id and status
	// writes, which reach the row from the pool while a member's start holds
	// this transaction (services.commitWorkspaceMutation). A share lock made
	// that start wait on itself until its context expired.
	if _, err := tx.Exec(ctx, `SELECT c.id FROM collaborators c JOIN workspaces w ON w.repository_id=c.repository_id WHERE w.id=$1::uuid FOR SHARE OF c FOR KEY SHARE OF w`, branch); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT u.id FROM users u JOIN collaborators c ON c.user_id=u.id JOIN workspaces w ON w.repository_id=c.repository_id WHERE w.id=$1::uuid FOR SHARE OF u`, branch); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT c.unix_login,c.unix_uid FROM collaborators c
 JOIN workspaces w ON w.repository_id=c.repository_id
 LEFT JOIN users u ON u.id=c.user_id
 WHERE w.id=$1::uuid AND NOT EXISTS (SELECT 1 FROM workflow_run_flow_invocations i WHERE i.background_workspace_id=w.id) AND c.suspended_at IS NULL
 AND (c.github_id IS NOT NULL OR c.user_id IS NOT NULL)
 AND c.permission IN ('admin','write') AND coalesce(u.prohibit_login,false)=false
 AND (c.user_id IS NULL OR (u.is_active AND u.deleted_at IS NULL))
 ORDER BY c.unix_uid FOR SHARE OF c FOR KEY SHARE OF w`, branch)
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
func (r *machineRoster) withProvisioningRoster(ctx context.Context, branch string, visit func(context.Context, []microsandbox.MemberIdentity) error) error {
	tx := machined.SessionAdmissionTransaction(ctx, branch)
	own := tx == nil
	var err error
	if own {
		tx, err = r.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))
	}
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
	if err = visit(machined.WithSessionAdmissionTransaction(ctx, branch, tx), identities); err != nil {
		return err
	}
	if own {
		return tx.Commit(ctx)
	}
	return nil
}

// commitMemberActor is a fresh authorization read, not a live-presence lookup.
// CommitActor returns only after COMMIT; the launch door rechecks membership
// while holding the owner lock before it sends the attributed session request.
func (r *machineRoster) commitMemberActor(ctx context.Context, branch, machine string, member microsandbox.MemberIdentity, via string) ([]byte, error) {
	if _, err := member.SessionIdentity(); err != nil {
		return nil, err
	}
	return machined.CommitActor(ctx, r.pool, branch, machine, func(ctx context.Context, tx pgx.Tx) (machined.ActorIdentity, error) {
		if _, err := tx.Exec(ctx, `SELECT user_id FROM self_host_owners FOR SHARE`); err != nil {
			return machined.ActorIdentity{}, err
		}
		var repository int64
		if err := tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 AND vm_id=$2 AND kind IN ('vm','container') AND deleted_at IS NULL`, branch, machine).Scan(&repository); err != nil {
			return machined.ActorIdentity{}, err
		}
		user, err := db.New(tx).PresenceSessionMember(ctx, repository, member.Login, uint32(member.UID))
		if err != nil {
			return machined.ActorIdentity{}, err
		}
		return machined.ActorIdentity{Kind: "person", MemberID: user.ID, Via: via}, nil
	})
}
