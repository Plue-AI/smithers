package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type censusRevocation struct {
	positioned bool
	done       chan struct{}
}

func (r *censusRevocation) Positioned() bool      { return r.positioned }
func (r *censusRevocation) Done() <-chan struct{} { return r.done }

// An empty daemon snapshot: the machine reports no broker sessions.
var emptyPresenceSnapshot = wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, []byte{0, 0}))}

func censusRegistry(t *testing.T) (*machined.Registry, func()) {
	t.Helper()
	registry := new(machined.Registry)
	stop, err := registry.ConsumeEvents(t.Context(), func(context.Context, *machined.Link, string, machined.Event) (machined.Acknowledgement, error) {
		return machined.Acknowledgement{}, context.Canceled
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	return registry, stop
}

// daemonHeartbeat sends the guest's empty snapshot every 2 s, as the daemon
// re-sends its snapshot every 10 s, until the test ends or the link closes.
func daemonHeartbeat(t *testing.T, guest net.Conn) {
	t.Helper()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			if wire.Write(guest, emptyPresenceSnapshot) != nil {
				return
			}
			select {
			case <-t.Context().Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

// censusLink admits a daemon link and drains what the host sends the guest.
func censusLink(t *testing.T, registry *machined.Registry, branch string) (*machined.Link, net.Conn) {
	t.Helper()
	link, guest := presenceTestLink(t, registry, branch)
	go func() { _, _ = io.Copy(io.Discard, guest) }()
	return link, guest
}

func TestPresenceSourceCensus(t *testing.T) {
	start := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	now := start
	registry, stopEvents := censusRegistry(t)
	revocation := &censusRevocation{positioned: true, done: make(chan struct{})}
	complete := func() *branchPresence {
		return &branchPresence{
			dispatcher: presenceBridgeFixture{}, hosts: new(flowhost.Store), branches: new(services.WorkspaceService),
			queries: db.New(nil), terminalManager: routes.NewTerminalSessionManager(nil), now: func() time.Time { return now },
		}
	}
	asleep := db.Workspace{ID: "branch-asleep", Status: "suspended"}
	running := db.Workspace{ID: "branch-awake", Status: "running"}

	p := complete()
	ready := p.sourceCensus(revocation, registry)
	for _, status := range []string{"suspended", "stopped", "failed"} {
		require.True(t, ready(t.Context(), db.Workspace{ID: "no-machine", Status: status}), status)
	}
	// Without a current link, a running, waking or unrecognized machine may hold
	// sessions nobody has reported.
	for _, status := range []string{"running", "starting", "pending", "deleted", ""} {
		require.False(t, ready(t.Context(), db.Workspace{ID: "no-link", Status: status}), status)
	}

	// Each missing composed source alone keeps every branch unknown.
	for name, drop := range map[string]func(*branchPresence){
		"bridge":     func(p *branchPresence) { p.dispatcher = nil },
		"hosts":      func(p *branchPresence) { p.hosts = nil },
		"authorizer": func(p *branchPresence) { p.branches = nil },
		"queries":    func(p *branchPresence) { p.queries = nil },
		"terminals":  func(p *branchPresence) { p.terminalManager = nil },
	} {
		missing := complete()
		drop(missing)
		require.False(t, missing.sourceCensus(revocation, registry)(t.Context(), asleep), name)
	}
	require.False(t, p.sourceCensus(nil, registry)(t.Context(), asleep), "revocation watcher")
	require.False(t, p.sourceCensus(&censusRevocation{done: make(chan struct{})}, registry)(t.Context(), asleep), "unpositioned revocation")
	require.False(t, p.sourceCensus(revocation, nil)(t.Context(), asleep), "machine registry")
	require.False(t, p.sourceCensus(revocation, new(machined.Registry))(t.Context(), asleep), "attribution consumer")

	// A connected link counts only once reconciled and its snapshot applied.
	link, _ := censusLink(t, registry, running.ID)
	require.False(t, ready(t.Context(), running), "unreconciled link")
	require.NoError(t, link.Reconciled())
	require.False(t, ready(t.Context(), running), "no snapshot applied")
	p.daemons.mark(running.ID, link, now)
	require.True(t, ready(t.Context(), running))
	// The link, not the machine status, decides once one is current.
	require.True(t, ready(t.Context(), db.Workspace{ID: running.ID, Status: "suspended"}))
	now = start.Add(29900 * time.Millisecond)
	require.True(t, ready(t.Context(), running))
	now = start.Add(presenceLease)
	require.False(t, ready(t.Context(), running), "a snapshot one lease old backs no session")
	p.daemons.mark(running.ID, link, now)
	require.True(t, ready(t.Context(), running))

	// A replacement boot supersedes the link; the old reader cannot clear the new mark.
	replacement, _ := censusLink(t, registry, running.ID)
	require.False(t, ready(t.Context(), running), "superseded link")
	require.NoError(t, replacement.Reconciled())
	p.daemons.mark(running.ID, replacement, now)
	p.daemons.clear(running.ID, link)
	require.True(t, ready(t.Context(), running))
	p.daemons.clear(running.ID, replacement)
	require.False(t, ready(t.Context(), running))
	p.daemons.mark(running.ID, replacement, now)

	// A stopped revocation watcher or attribution consumer ends the census.
	close(revocation.done)
	require.False(t, ready(t.Context(), running), "revocation stopped")
	require.False(t, ready(t.Context(), asleep), "revocation stopped")
	revocation.done = make(chan struct{})
	require.True(t, ready(t.Context(), running))
	stopEvents()
	require.False(t, ready(t.Context(), running), "attribution consumer stopped")
	require.False(t, ready(t.Context(), asleep), "attribution consumer stopped")
}

// The census the daemon consumer binds reaches the real TS roster through the
// authenticated bridge: PresenceOn and the rebase reader leave unknown only while the daemon
// consumer has applied the current link's snapshot, and return to unknown when
// the machine's link is replaced.
func TestPresenceOnCensusThroughInstall(t *testing.T) {
	f := presenceInstall(t)
	registry, _ := censusRegistry(t)
	f.p.terminalManager = routes.NewTerminalSessionManager(nil)
	require.Nil(t, f.p.sourcesReady)
	// The production binding: the daemon consumer installs the census against
	// the live socket's revocation source.
	stopDaemons := f.p.consumeDaemons(t.Context(), registry)
	t.Cleanup(stopDaemons)
	require.NotNil(t, f.p.sourcesReady)
	presenceOn := func() string {
		raw, err := f.p.call(t.Context(), f.row, "presence-owner/app", "Branch.PresenceOn", map[string]any{})
		require.NoError(t, err)
		var state string
		require.NoError(t, json.Unmarshal(raw, &state))
		return state
	}
	rebase := func() services.RebasePresence {
		state, err := f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
		require.NoError(t, err)
		return state
	}
	require.Equal(t, "running", f.row.Status)
	require.Equal(t, "unknown", presenceOn(), "a running machine without a daemon link")

	link, guest := censusLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	daemonHeartbeat(t, guest)
	// The TS host's own 30 s restart window began with this test's fixture.
	require.Eventually(t, func() bool { return presenceOn() == "empty" }, 45*time.Second, 250*time.Millisecond)
	require.Equal(t, services.RebasePresenceEmpty, rebase())

	browser := f.dial(t)
	sendPresenceFrame(t, browser, fmt.Sprintf(`{"t":"presence","id":1,"where":{"branch":%q,"path":"retry.ts","line":12}}`, f.row.ID))
	require.Eventually(t, func() bool { return presenceOn() == "present" }, time.Second, 10*time.Millisecond)
	require.Equal(t, services.RebasePresencePeople, rebase())

	// A replacement boot: its sessions are unreported until its first snapshot.
	replacement, replacementGuest := censusLink(t, registry, f.row.ID)
	require.Equal(t, "unknown", presenceOn())
	require.Equal(t, services.RebasePresenceUnknown, rebase())
	require.NoError(t, replacement.Reconciled())
	require.Equal(t, "unknown", presenceOn(), "no snapshot from the replacement yet")
	daemonHeartbeat(t, replacementGuest)
	require.Eventually(t, func() bool { return presenceOn() == "present" }, 2*time.Second, 10*time.Millisecond)

	require.NoError(t, browser.Close(1000, ""))
	require.Eventually(t, func() bool { return presenceOn() == "empty" }, time.Second, 10*time.Millisecond)
	require.Equal(t, services.RebasePresenceEmpty, rebase())
}

// The census reads the same revocation source the live socket admits presence
// under; with none installed it has nothing to bind.
func TestLiveRevocationFollowsTheLiveSocketSource(t *testing.T) {
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	routes.SetRevocationSource(nil)
	require.Nil(t, liveRevocation())
	bus := revocation.NewBus(nil, nil)
	routes.SetRevocationSource(bus)
	require.Equal(t, presenceRevocation(bus), liveRevocation())
}

func TestAdmissionIdleObservationMissingSources(t *testing.T) {
	f := presenceInstall(t)
	observe := machineIdleObserver(f.pool, nil, nil, nil, false)
	safety, err := observe(t.Context(), f.row)
	require.NoError(t, err)
	require.True(t, safety.SessionsKnown, "real session queries must succeed")
	require.False(t, safety.PresenceKnown)
	require.False(t, safety.RunKnown)
	require.False(t, safety.BurstsKnown)
	require.True(t, safety.IdleSince.IsZero(), "missing authorities cannot start the safe-idle clock")
}
