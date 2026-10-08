package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/repository"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Inject only the idle clock; admission and automatic reconciliation remain the
// production runtime. This does not qualify the reference host or its guests.
type parallelIdleRuntime struct {
	*microsandbox.Runtime
	now        atomic.Int64
	boots      sync.Map
	idleError  atomic.Value
	safetySeen atomic.Value
}

func (r *parallelIdleRuntime) CreateWorkspace(ctx context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	result, err := r.Runtime.CreateWorkspace(ctx, spec)
	r.boots.Store(spec.ID, true)
	return result, err
}
func (r *parallelIdleRuntime) SetAdmissionIdleProviders(p microsandbox.AdmissionIdleProviders) error {
	safety := p.Safety
	if safety != nil {
		p.Safety = func(ctx context.Context) ([]microsandbox.AdmissionSafety, error) {
			rows, err := safety(ctx)
			r.safetySeen.Store(fmt.Sprintf("clock=%s offset=%s rows=%+v err=%v", time.Now(), time.Duration(r.now.Load()), rows, err))
			return rows, err
		}
	}
	prepare := p.Prepare
	if prepare != nil {
		p.Prepare = func(ctx context.Context, holder string) error {
			r.idleError.Store("prepare entered")
			err := prepare(ctx, holder)
			if err != nil {
				r.idleError.Store(err.Error())
			}
			return err
		}
	}
	p.Now = func() time.Time { return time.Now().Add(time.Duration(r.now.Load())) }
	return r.Runtime.SetAdmissionIdleProviders(p)
}

// Prior verified candidate input scopes this oracle to admission and safe-idle;
// Native guest/root qualification requires the separate C-SEC-02 receipt.
func parallelAutomaticIdleRelease(t *testing.T, pool *pgxpool.Pool, branches *services.WorkspaceService, stack *services.MythicalService, runtime *parallelIdleRuntime, gitHost *pollingGitHost, repositoryID, ownerID int64, pending, acknowledged, firstBoot string, disk func(context.Context) (int64, error), retained func()) {
	t.Helper()
	ctx := t.Context()
	q := db.New(pool)
	first, err := q.GetMythicalItemByNumber(ctx, repositoryID, 1)
	require.NoError(t, err)
	row, err := q.GetWorkspace(ctx, first.WorkspaceID)
	require.NoError(t, err)
	holder := "workspace:" + row.ID
	require.True(t, runtime.AdmissionHeld(holder))
	sum := sha256.Sum256([]byte(row.ID))
	machine := "smthrs-ws-01234567-" + hex.EncodeToString(sum[:])[:20]
	require.NoError(t, os.WriteFile(pending, []byte(machine), 0600))
	require.NoError(t, os.WriteFile(firstBoot, []byte(machine), 0600))
	// Let the injected boot response settle before exercising sleep's lifecycle
	// barrier. Repository initialization is outside this conformance guest;
	// a running machine keeps its reservation even if that preparation refuses.
	require.True(t, assertEventually(10*time.Second, func() bool { _, done := runtime.boots.Load(row.ID); return done }), "boot response did not settle")
	require.True(t, runtime.AdmissionHeld(holder), "a running machine retains its reservation")
	// Retained guest boot/candidate input. No machine qualification is enabled in
	// product code, and no real GitHub credential or repository is used here.
	var headBytes strings.Builder
	require.NoError(t, gitHost.git(ctx, nil, &headBytes, "rev-parse", "refs/heads/main"))
	head := strings.TrimSpace(headBytes.String())
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running',vm_id=id,head_commit_id=$2 WHERE id=$1`, row.ID, head)
	require.NoError(t, err)

	row, err = q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	storage := t.TempDir()
	engine, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "parallel-idle", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := engine.Client()
	require.NoError(t, client.InitRepo(ctx, "maya", "app", "main", false))
	// Import immutable capture bytes as data into the real native repository.
	transport := filepath.Join(storage, "maya", "app", ".jj/repo/store/git")
	command := exec.CommandContext(ctx, "git", "-c", "core.hooksPath="+os.DevNull, "--git-dir", gitHost.dir, "push", transport, head+":"+repohost.BranchHeadRef(row.ID))
	out, err := command.CombinedOutput()
	require.NoError(t, err, string(out))
	require.NoError(t, client.ImportRefs(ctx, "maya", "app"))
	registry := new(machined.Registry)
	stop, err := bindMachineEvents(ctx, registry, pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	services.WithBranchHeads(client)(branches)
	services.WithBranchCapture(registry)(branches)
	link, peer := presenceTestLink(t, registry, row.ID)
	require.NoError(t, link.Reconciled())
	rawHead, err := hex.DecodeString(head)
	require.NoError(t, err)
	var treeText strings.Builder
	require.NoError(t, gitHost.git(ctx, nil, &treeText, "rev-parse", head+"^{tree}"))
	rawTree, err := hex.DecodeString(strings.TrimSpace(treeText.String()))
	require.NoError(t, err)
	var captures atomic.Int32
	var drained atomic.Bool
	go func() {
		for {
			frame, err := wire.Read(peer)
			if err != nil {
				return
			}
			if frame.Kind == wire.Events {
				fields, err := wire.Fields("ack", frame.Payload[1:])
				if err != nil || !bytes.Equal(fields[2], []byte{byte(machined.AckApplied)}) {
					return
				}
				drained.Store(true)
				continue
			}
			request, method, _, err := frame.Request()
			if err != nil {
				return
			}
			var fields [][]byte
			switch wire.Method(method) {
			case wire.Capture:
				captures.Add(1)
				drained.Store(false)
				fields = [][]byte{wire.Field(1, rawHead), wire.Field(2, rawTree), wire.Field(3, wire.U16(0))}
			case wire.Status:
				depth := uint32(0)
				if captures.Load() > 0 && !drained.Load() {
					depth = 1
				}
				fields = [][]byte{wire.Field(1, []byte{3}), wire.Field(2, wire.U16(2)), wire.Field(3, wire.String("smithers-machined")), wire.Field(4, wire.U32(depth)), wire.Field(5, rawHead), wire.Field(6, wire.U16(0)), wire.Field(7, []byte{1}), wire.Field(8, []byte{1})}
			case wire.SetRoster:
			default:
				return
			}
			if wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(request)), wire.Field(2, wire.Union(method, fields...)))}) != nil {
				return
			}
			if wire.Method(method) == wire.Status {
				if wire.Write(peer, emptyPresenceSnapshot) != nil {
					return
				}
			}
			if wire.Method(method) == wire.Capture {
				event := machined.Event{Seq: 1, EventID: [16]byte{1}, Payload: wire.Union(2, wire.Field(1, rawHead), wire.Field(2, rawTree), wire.Field(3, rawHead))}
				if wire.Write(peer, transcriptEventFrame(event)) != nil {
					return
				}
			}
		}
	}()
	hosts, _ := presenceHostBinding(t, pool, row, ownerID)
	bridge := realPresenceBridge(t)
	presence := &branchPresence{queries: q, branches: branches, hosts: hosts, dispatcher: presenceBridgeFixture{bridge}, terminalManager: routes.NewTerminalSessionManager(nil), members: &services.Members{Pool: pool}}
	stopPresence := presence.consumeDaemons(ctx, registry)
	t.Cleanup(stopPresence)
	runtime.now.Store(int64(31 * time.Second))
	observe := machineIdleObserver(pool, presence, registry, stack, false)
	var safety microsandbox.AdmissionSafety
	require.True(t, assertEventually(45*time.Second, func() bool {
		safety, err = observe(ctx, row)
		return err == nil && safety.PresenceKnown
	}), "authenticated presence must finish its reconstruction window: %+v", safety)
	require.True(t, safety.RunKnown)
	require.Equal(t, "working", safety.TODOState)
	require.True(t, safety.RunningStep)
	require.True(t, safety.IdleSince.IsZero())
	require.NoError(t, branches.EnableMachineIdleRelease(disk, observe))
	runtime.now.Add(int64(2 * time.Hour))
	// Wait for the real event/tick loop to read the advanced clock. The
	// production census must protect a working run regardless of its age.
	require.True(t, assertEventually(5*time.Second, func() bool {
		seen, _ := runtime.safetySeen.Load().(string)
		return strings.Contains(seen, "offset=2h0m31s")
	}), "scheduler never observed the two-hour working interval: %v", runtime.safetySeen.Load())
	require.True(t, runtime.AdmissionHeld(holder))
	require.Zero(t, captures.Load(), "a working agent must never be captured for release")
	_, err = os.Stat(acknowledged)
	require.True(t, os.IsNotExist(err), "a working agent must never be stopped")
	working, err := stack.Todo(ctx, repositoryID, 1)
	require.NoError(t, err)
	require.Equal(t, "working", working["state"])
	require.NotContains(t, working, "pause", "waiting demand cannot pause a working agent")
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',candidate_base=base_commit,candidate_head=$2,candidate_verified=true,pr_head=$2,pr_state='open',checks=jsonb_set(checks,'{review}',jsonb_build_object('head',$2::text,'candidate',$2::text,'verdict','approve','runId','reviewed-t1')) WHERE id=$1`, first.ID, head)
	require.NoError(t, err)
	require.True(t, assertEventually(5*time.Second, func() bool {
		safety, err = observe(ctx, row)
		return err == nil && safety.TODOState == "in_review" && !safety.IdleSince.IsZero()
	}), "review must become safe-idle through the production census: %+v", safety)
	require.Equal(t, "in_review", safety.TODOState)
	require.False(t, safety.RunningStep)
	require.False(t, safety.IdleSince.IsZero())
	retained()
	runtime.now.Add(int64(time.Second))
	require.True(t, assertEventually(15*time.Second, func() bool { _, err := os.Stat(acknowledged); return err == nil }), "automatic release never requested stop: capture=%d error=%v safety=%v admission=%+v", captures.Load(), runtime.idleError.Load(), runtime.safetySeen.Load(), runtime.AdmissionSnapshot())
	require.Equal(t, int32(1), captures.Load(), "capture precedes stop")
	require.True(t, drained.Load(), "capture must be durably acknowledged")
	retained()
	require.True(t, runtime.AdmissionHeld(holder), "stop acknowledgment retains the slot")
	sleeping, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "releasing", sleeping.Status)
	require.NoError(t, os.Remove(pending))
	require.True(t, assertEventually(15*time.Second, func() bool {
		current, err := q.GetWorkspace(ctx, row.ID)
		return err == nil && current.Status == "suspended" && !runtime.AdmissionHeld(holder)
	}), "observed stop must publish sleep and release admission")
	require.NoError(t, peer.Close())
}

// The browser controls only observation checkpoints, never scheduler state.
func parallelBrowserCheckpoint(t *testing.T, step string) {
	t.Helper()
	directory := os.Getenv("SMITHERS_PARALLEL_BROWSER_DIR")
	if directory == "" {
		return
	}
	require.NoError(t, os.WriteFile(filepath.Join(directory, step+".ready"), nil, 0600))
	require.True(t, assertEventually(time.Minute, func() bool { _, err := os.Stat(filepath.Join(directory, step+".done")); return err == nil }), "browser did not observe %s", step)
}
