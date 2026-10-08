package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// quiescePeer is the capture daemon, the repository host and the VM runtime
// for several machines. It records the order of every capture and stop, and
// refuses a stop that no capture preceded.
type quiescePeer struct {
	workspaceapi.WorkspaceRuntime
	workspaceSnapshotStore
	pool *pgxpool.Pool

	mu         sync.Mutex
	heads      map[string]string // machine → captured head
	captureErr map[string]error
	onCapture  func(id string)
	captured   map[string]bool
	stopped    map[string]bool
	events     []string
}

func (p *quiescePeer) Capture(ctx context.Context, id string) (machined.CaptureResult, error) {
	var status string
	if err := p.pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, id).Scan(&status); err != nil {
		return machined.CaptureResult{}, err
	}
	if status != "releasing" {
		return machined.CaptureResult{}, errors.New("capture outside release")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.captureErr[id]; err != nil {
		return machined.CaptureResult{}, err
	}
	if p.onCapture != nil {
		p.onCapture(id)
	}
	p.captured[id] = true
	p.events = append(p.events, "capture "+id)
	return machined.CaptureResult{Head: p.heads[id], Tree: strings.Repeat("b", 40)}, nil
}
func (p *quiescePeer) InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error) {
	refs := scratchHeads{}
	for id, head := range p.heads {
		refs[repohost.BranchHeadRef(id)] = head
	}
	return refs.InfoRefsUploadPack(ctx, owner, repo)
}
func (p *quiescePeer) GetChange(_ context.Context, _, _, commit string) (repohost.Change, error) {
	return repohost.Change{CommitID: commit}, nil
}
func (p *quiescePeer) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := workspaceapi.WorkspaceRunning
	if p.stopped[id] {
		state = workspaceapi.WorkspaceStopped
	}
	return workspaceapi.Workspace{ID: id, State: state}, nil
}
func (p *quiescePeer) StopWorkspace(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.captured[id] {
		return errors.New("stop before capture")
	}
	p.stopped[id] = true
	p.events = append(p.events, "stop "+id)
	return nil
}

type quiesceMachines struct {
	pool    *pgxpool.Pool
	q       *db.Queries
	peer    *quiescePeer
	service *WorkspaceService
	owner   int64
	repo    int64
}

func newQuiesceMachines(t *testing.T) *quiesceMachines {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(7,'quiesce-owner','quiesce-owner')`)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES(7,'quiesce','quiesce') RETURNING id`).Scan(&repo))
	peer := &quiescePeer{pool: pool, heads: map[string]string{}, captureErr: map[string]error{}, captured: map[string]bool{}, stopped: map[string]bool{}}
	service := newWorkspaceServiceForTests(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()),
		WithBranchCapture(peer), WithBranchHeads(peer), WithWorkspaceRuntime(peer))
	return &quiesceMachines{pool: pool, q: q, peer: peer, service: service, owner: owner, repo: repo}
}

// machine seeds one machine row. head is its durable head projection, the
// commit a verified capture must report.
func (f *quiesceMachines) machine(t *testing.T, user int64, branch, status, vm, head string) string {
	t.Helper()
	row, err := f.q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repo, UserID: user, TargetBookmark: branch, Kind: "container", Status: status})
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET vm_id=$2,head_commit_id=$3 WHERE id=$1`, row.ID, vm, head)
	require.NoError(t, err)
	f.peer.heads[row.ID] = head
	return row.ID
}

func (f *quiesceMachines) status(t *testing.T, id string) string {
	t.Helper()
	var status string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT status FROM workspaces WHERE id=$1`, id).Scan(&status))
	return status
}

// Install quiesce's machine step (spec §16.5.1): every awake machine is
// captured and then stopped, a machine already asleep is left alone, and an
// open session does not keep its machine awake.
func TestQuiesceCapturesAndStopsEveryAwakeMachine(t *testing.T) {
	f := newQuiesceMachines(t)
	ctx := t.Context()
	first := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	second := f.machine(t, f.owner, "smithers/todo-b", "running", "vm-b", strings.Repeat("c", 40))
	asleep := f.machine(t, f.owner, "smithers/todo-c", "suspended", "vm-c", strings.Repeat("d", 40))
	_, err := f.pool.Exec(ctx, `INSERT INTO workspace_sessions(workspace_id,repository_id,user_id,kind,status) VALUES($1,$2,7,'terminal','running')`, second, f.repo)
	require.NoError(t, err)

	require.NoError(t, f.service.CaptureAndStop(ctx))

	require.Equal(t, "suspended", f.status(t, first))
	require.Equal(t, "suspended", f.status(t, second))
	require.Equal(t, "suspended", f.status(t, asleep))
	require.ElementsMatch(t, []string{"capture " + first, "stop " + first, "capture " + second, "stop " + second}, f.peer.events)
	for _, id := range []string{first, second} {
		captured, stopped := -1, -1
		for i, event := range f.peer.events {
			switch event {
			case "capture " + id:
				captured = i
			case "stop " + id:
				stopped = i
			}
		}
		require.Less(t, captured, stopped, "machine %s stopped before its capture", id)
	}
	// A second quiesce finds nothing awake and stops nothing.
	require.NoError(t, f.service.CaptureAndStop(ctx))
	require.Len(t, f.peer.events, 4)
}

// A capture that fails names its branch and leaves that machine awake with
// its disk; the other machine is still captured and stopped, so the caller
// reopens with nothing lost.
func TestQuiesceCaptureFailureNamesTheBranch(t *testing.T) {
	f := newQuiesceMachines(t)
	first := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	second := f.machine(t, f.owner, "smithers/todo-b", "running", "vm-b", strings.Repeat("c", 40))
	f.peer.captureErr[second] = errors.New("outbox undrained")

	err := f.service.CaptureAndStop(t.Context())

	require.ErrorContains(t, err, "branch smithers/todo-b: ")
	require.NotContains(t, err.Error(), "smithers/todo-a")
	require.Equal(t, "suspended", f.status(t, first))
	require.Equal(t, "running", f.status(t, second))
	require.Equal(t, []string{"capture " + first, "stop " + first}, f.peer.events)
}

// A capture that reports a head the install has not stored is not a capture:
// the machine keeps running and is never stopped.
func TestQuiesceRefusesAnUnverifiedCapture(t *testing.T) {
	f := newQuiesceMachines(t)
	id := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	f.peer.heads[id] = strings.Repeat("e", 40)

	err := f.service.CaptureAndStop(t.Context())

	require.ErrorContains(t, err, "branch smithers/todo-a: ")
	require.Equal(t, "running", f.status(t, id))
	require.Equal(t, []string{"capture " + id}, f.peer.events)
}

// A machine woken while the others were captured is still awake, so the
// freeze must not report ready.
func TestQuiesceRefusesAMachineWokenDuringCapture(t *testing.T) {
	f := newQuiesceMachines(t)
	first := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	late := f.machine(t, f.owner, "smithers/todo-late", "suspended", "vm-late", strings.Repeat("c", 40))
	f.peer.onCapture = func(string) {
		_, err := f.pool.Exec(context.Background(), `UPDATE workspaces SET status='running' WHERE id=$1`, late)
		require.NoError(t, err)
	}

	err := f.service.CaptureAndStop(t.Context())

	require.EqualError(t, err, "branch smithers/todo-late: still awake after capture")
	require.Equal(t, "suspended", f.status(t, first))
	require.Equal(t, "running", f.status(t, late))
}

// An unavailable provider is never an empty machine list: quiesce refuses
// and neither captures nor stops anything.
func TestQuiesceMachineProvidersFailClosed(t *testing.T) {
	for name, remove := range map[string]WorkspaceServiceOption{
		"capture": func(s *WorkspaceService) { s.branchCapture = nil },
		"runtime": func(s *WorkspaceService) { s.runtime = nil },
		"store":   func(s *WorkspaceService) { s.branchHeads = nil },
		"machine providers": func(s *WorkspaceService) {
			s.branchMachineProviders = BranchMachineProviders{}
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newQuiesceMachines(t)
			id := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
			remove(f.service)

			err := f.service.CaptureAndStop(t.Context())

			require.ErrorContains(t, err, "quiesce requires verified branch capture and the machine runtime")
			require.Equal(t, "running", f.status(t, id))
			require.Empty(t, f.peer.events)
		})
	}
}

// A running machine that is not a branch machine has no capture contract.
// Quiesce refuses it by name instead of stopping it uncaptured.
func TestQuiesceRefusesAMachineItCannotCapture(t *testing.T) {
	f := newQuiesceMachines(t)
	id := f.machine(t, 7, "legacy", "running", "vm-legacy", strings.Repeat("a", 40))

	err := f.service.CaptureAndStop(t.Context())

	require.EqualError(t, err, "branch legacy: not a branch machine; quiesce cannot capture it")
	require.Equal(t, "running", f.status(t, id))
	require.Empty(t, f.peer.events)
}

// The composed quiesce accepts the machine service as its T-MCH-07 provider
// and still refuses before freezing while admission (T-MCH-06) is absent.
func TestInstallQuiesceAcceptsTheMachineService(t *testing.T) {
	f := newQuiesceMachines(t)
	id := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	quiesce := NewInstallQuiesce(&QuiesceGate{Store: InstallQuiesceStore{Pool: f.pool}, StateDir: t.TempDir()})

	missing := "quiesce unavailable: T-MCH-06 required\n" +
		"quiesce unavailable: T-FLW-01 required\n" +
		"quiesce unavailable: T-STK-04 required\n" +
		"quiesce unavailable: T-COL-08 required\n" +
		"quiesce unavailable: T-COL-09 required\n" +
		"quiesce unavailable: T-GH-09 required\n" +
		"quiesce unavailable: T-TRM-07 required\n" +
		"quiesce unavailable: T-SEC-01 required"
	require.EqualError(t, quiesce.Available(), "quiesce unavailable: T-MCH-07 required\n"+missing)
	quiesce.Machines = f.service
	require.EqualError(t, quiesce.Available(), missing)

	_, err := quiesce.Freeze(t.Context(), "backup-1", f.owner)
	require.EqualError(t, err, missing)
	var freezes int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
	require.Zero(t, freezes)
	require.Equal(t, "running", f.status(t, id))
	require.Empty(t, f.peer.events)
}
