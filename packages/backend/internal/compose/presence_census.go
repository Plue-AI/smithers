package compose

import (
	"context"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// presenceLease is the roster lease. A daemon snapshot older than one lease no
// longer backs its sessions, so it no longer counts toward the census.
const presenceLease = 30 * time.Second

// daemonSnapshots records, per branch, the admitted link whose latest presence
// snapshot reached the roster. Only the daemon consumer writes it.
type daemonSnapshots struct {
	mu      sync.Mutex
	applied map[string]daemonSnapshot
}

type daemonSnapshot struct {
	link *machined.Link
	at   time.Time
}

func (d *daemonSnapshots) mark(branch string, link *machined.Link, at time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.applied == nil {
		d.applied = map[string]daemonSnapshot{}
	}
	d.applied[branch] = daemonSnapshot{link: link, at: at}
}

// clear forgets only this link's snapshot, so an exiting reader cannot erase
// its replacement's.
func (d *daemonSnapshots) clear(branch string, link *machined.Link) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.applied[branch].link == link {
		delete(d.applied, branch)
	}
}

func (d *daemonSnapshots) current(branch string, link *machined.Link, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	applied, ok := d.applied[branch]
	return ok && applied.link == link && now.Sub(applied.at) < presenceLease
}

// presenceRevocation is the revocation bus as the census reads it.
type presenceRevocation interface {
	Positioned() bool
	Done() <-chan struct{}
}

// liveRevocation is the revocation source the live socket consults; browser
// presence exists only while it does. Nil when none is installed.
func liveRevocation() presenceRevocation {
	source, _ := routes.CurrentRevocationSource().(presenceRevocation)
	return source
}

// sourceCensus is the production PresenceOn readiness check. Every source that
// can hold a participant on the branch must be composed and current; one gap
// keeps PresenceOn unknown, which safe-idle and rebase treat as present. It
// reads memory only: no network, database or host start.
func (p *branchPresence) sourceCensus(revocation presenceRevocation, registry *machined.Registry) func(context.Context, db.Workspace) bool {
	return func(_ context.Context, row db.Workspace) bool {
		// The TS roster bridge, the branch authorizer and the terminal manager.
		if p.dispatcher == nil || p.hosts == nil || p.branches == nil || p.queries == nil || p.terminalManager == nil {
			return false
		}
		// Without a positioned revocation watcher the live socket refuses
		// browser presence, so people in the app could not announce.
		if revocation == nil || !revocation.Positioned() {
			return false
		}
		select {
		case <-revocation.Done():
			return false
		default:
		}
		// SSH, terminal and agent sessions, and the writes that place them, arrive
		// over the machine link. Its event consumer carries the attribution.
		if registry == nil || !registry.EventConsumerReady() {
			return false
		}
		link, err := registry.Current(row.ID)
		if err != nil {
			// No current link: only a sleeping or failed machine has no sessions.
			// A running or waking one, or an unknown state, stays unknown.
			switch row.Status {
			case "suspended", "stopped", "failed":
				return true
			}
			return false
		}
		if link.RequireReady(row.ID) != nil {
			return false
		}
		return p.daemons.current(row.ID, link, p.clock())
	}
}

func (p *branchPresence) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}
