package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
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

// reviewSlotRuntime is the production admission runtime. Only the sleep
// lifecycle behind automatic release is injected: capture and confirmed stop
// are covered by the C-MCH-02 install test.
type reviewSlotRuntime struct {
	*microsandbox.Runtime
	idle microsandbox.AdmissionIdleProviders
}

func (r *reviewSlotRuntime) SetAdmissionIdleProviders(p microsandbox.AdmissionIdleProviders) error {
	r.idle = p
	return nil
}

// Install run 14 (#3776), capacity 1: TODO 2 went to review holding the only
// machine. The daemon census listed its coding host's own broker session, the
// install refused the whole snapshot, PresenceOn stayed unknown and safe-idle
// release never fired. Its review lane and a /review job waited until a person
// merged blind. Spec §8.4.1: a run in review is not a running step, so the
// machine releases once safe-idle and both reviews run in turn.
func TestInReviewTodoReleasesTheOnlyMachineToItsReviews(t *testing.T) {
	f := presenceInstallWithTodos(t, true)
	ctx := t.Context()
	q := db.New(f.pool)
	registry, _ := censusRegistry(t)
	f.p.terminalManager = routes.NewTerminalSessionManager(nil)
	t.Cleanup(f.p.consumeDaemons(ctx, registry))

	// TODO 1 is in review on its lane: the PR is open and its review has not
	// answered. The review lane is a second machine.
	head := strings.Repeat("c", 40)
	reviewLane := "6f2b9c1e-3d4a-4b5c-8d7e-9f0a1b2c3d4e"
	item, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',workspace_id=$2,pr_number=7,pr_state='open',pr_head=$3,candidate_head=$3,
 checks=jsonb_set(COALESCE(checks,'{}'::jsonb),'{review}',jsonb_build_object('head',$3::text,'candidate',$3::text,'lane',$4::text)) WHERE id=$1`, item.ID, f.row.ID, head, reviewLane)
	require.NoError(t, err)
	card, err := f.todos.Todo(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	require.Equal(t, "in_review", card["state"])

	// The guest daemon: it answers the host's calls and re-sends its session
	// census, which lists the coding host's own session.
	var host string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT id::text FROM flow_runtime_host_bindings WHERE workspace_id=$1`, f.row.ID).Scan(&host))
	link, guest := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	var writes sync.Mutex
	send := func(frame wire.Frame) error { writes.Lock(); defer writes.Unlock(); return wire.Write(guest, frame) }
	go func() {
		for {
			frame, err := wire.Read(guest)
			if err != nil {
				return
			}
			if frame.Kind != wire.Control {
				continue
			}
			request, method, _, err := frame.Request()
			if err != nil {
				return
			}
			var fields [][]byte
			switch wire.Method(method) {
			case wire.OpenSession:
				fields = [][]byte{wire.Field(1, wire.U32(1))}
			case wire.Status:
				fields = [][]byte{wire.Field(1, []byte{3}), wire.Field(2, wire.U16(2)), wire.Field(3, wire.String("smithers-machined")), wire.Field(4, wire.U32(0)),
					wire.Field(5, make([]byte, 20)), wire.Field(6, wire.U16(0)), wire.Field(7, []byte{1}), wire.Field(8, []byte{1})}
			case wire.RegisterRun, wire.SetRoster:
			default:
				return
			}
			if send(wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(request)), wire.Field(2, wire.Union(method, fields...)))}) != nil {
				return
			}
		}
	}()
	// microsandbox native_host opens the coding host exactly so.
	sessions := machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithActor([]byte("actor-reference1"), host).WithPresenceVia("agent:" + host)
	id, err := sessions.OpenSession(ctx, machined.SessionUser{Login: "agent", UID: 19999}, machined.SessionExec, []string{"smithers-coding-host"}, nil)
	require.NoError(t, err)
	require.NoError(t, sessions.RegisterRun(ctx, host, id))
	census := wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, append(wire.U16(1), wire.Struct(wire.Field(1, wire.U32(id)))...)))}
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for send(census) == nil {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	observe := machineIdleObserver(f.pool, f.p, registry, f.todos, false)
	var safety microsandbox.AdmissionSafety
	// The TS host's own 30 s restart window began with this test's fixture.
	require.Eventually(t, func() bool {
		safety, err = observe(ctx, f.row)
		return err == nil && safety.PresenceKnown && !safety.IdleSince.IsZero()
	}, 45*time.Second, 250*time.Millisecond, "the in-review machine never became safe-idle: %+v %v", safety, err)
	require.Equal(t, "in_review", safety.TODOState)
	require.False(t, safety.RunningStep, "a run in review is not a running step (spec §8.4.1)")
	require.Empty(t, f.roster(t), "the coding host's own session is no participant")

	// Capacity 1, the production admission runtime and release composition.
	scratch := t.TempDir()
	root := filepath.Join(scratch, "runtime")
	require.NoError(t, os.MkdirAll(root, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "owner"), []byte("smithers-backend-0123456789abcdef\n"), 0o600))
	msb := filepath.Join(scratch, "msb")
	require.NoError(t, os.WriteFile(msb, []byte("#!/bin/sh\nprintf '[]\\n'\n"), 0o700))
	profile := microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: microsandbox.MinFreeDiskBytes + microsandbox.MachineDiskBytes, MacOSVersion: "15.6", Hypervisor: true}
	sizing := microsandbox.ComputeSizing(profile)
	machines, err := microsandbox.New(ctx, microsandbox.Config{Root: root, Binary: msb, SkipQualification: true, HostProfile: &profile,
		CPUs: sizing.CPUs, MemoryMiB: sizing.MemoryMiB, DiskMiB: int(microsandbox.MachineDiskBytes >> 20), MaxRunningVMs: 1})
	require.NoError(t, err)
	t.Cleanup(func() { _ = machines.Close() })
	runtime := &reviewSlotRuntime{Runtime: machines}
	runtime.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	disk := func(context.Context) (int64, error) { return profile.DiskFreeBytes, nil }
	branches := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool))
	branches.EnableMachineAdmission(disk)
	require.NoError(t, branches.EnableMachineIdleRelease(disk, observe))
	released := []string{}
	release := runtime.idle
	release.Prepare = func(_ context.Context, holder string) error { released = append(released, holder); return nil }
	release.Stop = func(_ context.Context, holder string) error { runtime.ConfirmAdmissionStop(holder, false); return nil }
	grants := microsandbox.AdmissionProviders{Ready: func(context.Context, microsandbox.AdmissionRequest) error { return nil }, FreeDisk: disk}

	coding := "workspace:" + f.row.ID
	_, err = runtime.Request("todo", coding, coding, "machine")
	require.NoError(t, err)
	grant, err := runtime.GrantNext(ctx, grants)
	require.NoError(t, err)
	require.Equal(t, coding, grant.Holder)
	// The stack's review lane asks for its machine for the TODO's person
	// (machineDemand: the lane belongs to the machine service), then the
	// teammate's /review job asks as background work.
	lane, job := "workspace:"+reviewLane, "workspace:review-job"
	_, err = runtime.Request("person", lane, fmt.Sprintf("person:%d", f.user.ID), "machine")
	require.NoError(t, err)
	_, err = runtime.Request("background", job, "review-job", "review")
	require.NoError(t, err)
	grant, err = runtime.GrantNext(ctx, grants)
	require.NoError(t, err)
	require.Empty(t, grant.Holder, "capacity 1 is held by the in-review TODO")

	now := time.Now()
	require.NoError(t, runtime.ReconcileAdmissionIdle(ctx, now, now.Add(-time.Minute), release))
	require.Equal(t, []string{coding}, released, "waiting reviews release the safe-idle in-review machine")
	require.False(t, runtime.AdmissionHeld(coding))
	grant, err = runtime.GrantNext(ctx, grants)
	require.NoError(t, err)
	require.Equal(t, lane, grant.Holder, "the TODO's own review runs first")
	require.Equal(t, 1, runtime.InUse())
	// The review answers and its lane retires; the /review job is next.
	require.True(t, runtime.CancelAdmission(lane, fmt.Sprintf("person:%d", f.user.ID), time.Now()))
	runtime.ConfirmAdmissionStop(lane, false)
	grant, err = runtime.GrantNext(ctx, grants)
	require.NoError(t, err)
	require.Equal(t, job, grant.Holder, "the /review job gets the machine without a person acting")
	require.Equal(t, 1, runtime.InUse())
	require.False(t, runtime.AdmissionHeld(coding), "nothing woke the reviewed branch")
}
