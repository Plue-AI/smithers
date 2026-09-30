package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/runtimeports"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// GoldenSnapshotService maintains the pre-baked "golden" sandbox provider snapshot
// that workspace and gateway VMs boot from. Without it every provision built
// a VM from the bare base image and re-ran the full toolchain install (apt +
// Node + jj + bun + smithers CLI + global pack) — 1–3 minutes per open. The
// bake runs the EXACT workspace VM request once, waits for its bootstrap to
// finish installing the toolchain, snapshots the disk, and records the
// snapshot id; subsequent VMs boot from the snapshot and the command -v-guarded
// bootstrap degrades to a fast verify.
//
// Best-effort by design: when no ready snapshot exists (first boot, bake
// failure) provisioning falls back to the bare image exactly as before.
const (
	goldenSnapshotKindWorkspace = "workspace"
	// goldenSnapshotMaxAge is how old a golden snapshot may get before the
	// refresher bakes a replacement (toolchain versions move; a stale image
	// still works — the bootstrap upgrades nothing, it only fills gaps).
	goldenSnapshotMaxAge = 24 * time.Hour
	// goldenSnapshotRefreshInterval is the refresher's check cadence.
	goldenSnapshotRefreshInterval = 6 * time.Hour
	// goldenSnapshotBakeTimeout bounds one bake end to end: VM boot + apt +
	// every toolchain download on a cold cache.
	goldenSnapshotBakeTimeout = 15 * time.Minute
	// goldenSnapshotStaleBakingAge is how long a 'baking' row may sit before the
	// refresher assumes its owner died mid-bake (pod crash/OOM/deploy) and
	// reclaims the single per-kind baking slot. It sits ABOVE
	// goldenSnapshotBakeTimeout so a genuinely in-flight bake is never reclaimed
	// out from under itself. Without this, one crashed bake wedges the partial
	// unique index forever and every VM silently falls back to the slow
	// bare-image path.
	goldenSnapshotStaleBakingAge = goldenSnapshotBakeTimeout + 5*time.Minute
	// goldenSnapshotCacheTTL bounds how long Current() trusts its in-memory
	// copy before re-reading the DB (a fresh bake on another pod should be
	// picked up promptly, but the read must not run per-provision).
	goldenSnapshotCacheTTL = time.Minute
)

// goldenSnapshotSupersededGraceTTL is how long a snapshot must have been
// superseded before phase-2 GC deletes its sandbox provider snapshot. It sits WELL
// above goldenSnapshotCacheTTL so no other pod's Current() cache can still be
// vending the id when we delete it — making cross-pod GC provably safe against
// handing a deleted snapshot to a VM create.
const goldenSnapshotSupersededGraceTTL = 15 * time.Minute

// goldenSnapshotToolchainCheck must exit 0 only when the slow bootstrap work
// is done. It mirrors the bootstrap's own install guards (bun system-wide, jj
// in /usr/local/bin, node linked into the developer user's ~/.local/bin).
// The claude CLI install is best-effort in the bootstrap and deliberately not
// required here.
var goldenSnapshotToolchainCheck = strings.Join([]string{
	"test -x /usr/local/bin/bun",
	"command -v jj >/dev/null 2>&1",
	"test -x " + workspaceLocalBinDir + "/node",
	"test -x " + workspaceLocalBinDir + "/npm",
}, " && ")

var goldenSnapshotRefreshEvery = goldenSnapshotRefreshInterval

// GoldenSnapshotVMClient is the minimal sandbox provider surface for baking.
type GoldenSnapshotVMClient interface {
	CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	SnapshotSandbox(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error)
	DeleteSandbox(ctx context.Context, vmID string) error
	// DeleteSnapshot removes a superseded golden snapshot from sandbox provider so it
	// stops accruing storage. Tolerating 404 makes GC idempotent.
	DeleteSnapshot(ctx context.Context, snapshotID string) error
}

type GoldenSnapshotService struct {
	db      runtimeports.GoldenSnapshotStore
	sandbox GoldenSnapshotVMClient
	// buildRequest returns the VM request the snapshot must be baked FROM —
	// injected so the bake boots the exact same image workspaces boot.
	buildRequest func() sandbox.CreateRequest

	mu        sync.Mutex
	cachedID  string
	cachedAt  time.Time
	stopCh    chan struct{}
	stopOnce  sync.Once
	startOnce sync.Once

	// keyed holds the CurrentFor cache for closure-keyed snapshots (NixOS
	// environment images); inflight guards one local bake per key.
	keyed    map[string]keyedGoldenSnapshot
	inflight map[string]struct{}
}

func NewGoldenSnapshotService(db runtimeports.GoldenSnapshotStore, sandbox GoldenSnapshotVMClient, buildRequest func() sandbox.CreateRequest) *GoldenSnapshotService {
	return &GoldenSnapshotService{
		db:           db,
		sandbox:      sandbox,
		buildRequest: buildRequest,
		stopCh:       make(chan struct{}),
	}
}

// Current returns the newest ready golden snapshot id, or "" when none exists
// (callers fall back to the bare base image). Never returns an error: golden
// snapshots are an accelerator, not a dependency.
func (s *GoldenSnapshotService) Current(ctx context.Context) string {
	if s == nil || s.db == nil {
		return ""
	}
	s.mu.Lock()
	if time.Since(s.cachedAt) < goldenSnapshotCacheTTL {
		id := s.cachedID
		s.mu.Unlock()
		return id
	}
	s.mu.Unlock()

	id, _, err := s.db.LatestReadyGoldenSnapshot(ctx, goldenSnapshotKindWorkspace)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("golden snapshot lookup failed", "error", err)
		}
		id = ""
	}
	s.mu.Lock()
	s.cachedID = id
	s.cachedAt = time.Now()
	s.mu.Unlock()
	return id
}

// MarkBad retires a golden snapshot that sandbox provider rejected at VM-create time,
// clears the in-memory cache, and nudges an immediate re-bake so healing takes
// minutes rather than up to goldenSnapshotMaxAge. It MUST only be called on a
// differential signal (the snapshot boot failed AND a bare-image boot of the
// same request succeeded) — invalidating on any create error would let a
// transient sandbox provider outage destroy a good snapshot and churn re-bakes.
func (s *GoldenSnapshotService) MarkBad(ctx context.Context, snapshotID string) {
	if s == nil || s.db == nil || strings.TrimSpace(snapshotID) == "" {
		return
	}
	// A canceled request context must not abort invalidation.
	bg := context.WithoutCancel(ctx)
	if err := s.db.MarkBadGoldenSnapshot(bg, goldenSnapshotKindWorkspace, snapshotID); err != nil {
		slog.Warn("golden snapshot mark-bad failed", "snapshot_id", snapshotID, "error", err)
		return
	}
	s.mu.Lock()
	if s.cachedID == snapshotID {
		s.cachedID = ""
		s.cachedAt = time.Now()
	}
	s.mu.Unlock()
	slog.Warn("golden snapshot invalidated after vm-create rejection", "snapshot_id", snapshotID)
	// Nudge a re-bake now instead of waiting for the ticker. refresh()'s
	// baking-slot claim (partial unique index) makes concurrent nudges safe.
	if s.sandbox != nil && s.buildRequest != nil {
		go s.refresh(bg)
	}
}

// Start launches the background refresher: bake immediately when no fresh
// snapshot exists, then re-check on an interval. Concurrent pods race on the
// partial unique index — exactly one wins the 'baking' row.
func (s *GoldenSnapshotService) Start(ctx context.Context) {
	if s == nil || s.db == nil || s.sandbox == nil || s.buildRequest == nil {
		return
	}
	s.startOnce.Do(func() {
		go s.cleanupFailedBuildersLoop(ctx)
		// Read the (test-overridable) refresh interval on the caller's goroutine
		// so the background goroutine never reads the mutable package var
		// concurrently with a test swapping it.
		refreshEvery := goldenSnapshotRefreshEvery
		go func() {
			s.refresh(ctx)
			ticker := time.NewTicker(refreshEvery)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-s.stopCh:
					return
				case <-ticker.C:
					s.refresh(ctx)
				}
			}
		}()
	})
}

func (s *GoldenSnapshotService) Stop() {
	s.stopOnce.Do(func() { close(s.stopCh) })
}

func (s *GoldenSnapshotService) refresh(ctx context.Context) {
	_, createdAt, err := s.db.LatestReadyGoldenSnapshot(ctx, goldenSnapshotKindWorkspace)
	if err == nil && time.Since(createdAt) < goldenSnapshotMaxAge {
		return
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("golden snapshot freshness check failed", "error", err)
		return
	}

	// Free the baking slot if a previous baker died mid-bake, otherwise the
	// partial unique index blocks this (and every future) claim forever.
	s.reclaimStaleBaking(ctx)

	// Claim the single 'baking' slot; losing the race means another pod bakes.
	rowID, err := s.db.ClaimGoldenSnapshotBake(ctx, goldenSnapshotKindWorkspace)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return // another pod holds the baking slot
		}
		slog.Warn("golden snapshot bake claim failed", "error", err)
		return
	}

	snapshotID, bakeErr := s.bake(ctx, rowID)
	status := "ready"
	if bakeErr != nil {
		status = "failed"
		snapshotID = ""
		slog.Error("golden snapshot bake failed", "error", bakeErr)
	}
	finished, err := s.db.FinishGoldenSnapshot(context.WithoutCancel(ctx), rowID, status, snapshotID)
	if err != nil {
		slog.Warn("golden snapshot finish write failed", "row_id", rowID, "error", err)
		if bakeErr == nil {
			// The bake succeeded but its snapshot id never reached a durable
			// row: the row stays 'baking' until stale reclaim flips it to
			// 'failed' with a NULL snapshot_id, so no later refresh or GC pass
			// could ever discover the sandbox provider snapshot — it would leak
			// forever. Delete it now and let the next refresh re-bake; never
			// cache or announce an id the DB does not know about.
			delCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			if delErr := s.sandbox.DeleteSnapshot(delCtx, snapshotID); delErr != nil && !vmAlreadyGone(delErr) {
				slog.Warn("golden snapshot orphan delete failed", "snapshot_id", snapshotID, "error", delErr)
			}
		}
		return
	}
	if bakeErr == nil {
		s.mu.Lock()
		s.cachedID = snapshotID
		s.cachedAt = time.Now()
		s.mu.Unlock()
		slog.Info("golden snapshot baked", "snapshot_id", snapshotID)
		// GC superseded snapshots now that a fresh 'ready' row exists. Best
		// effort — never lets a GC failure affect the bake result.
		s.gcSupersededSnapshots(context.WithoutCancel(ctx), finished)
	}
}

// gcSupersededSnapshots two-phase garbage-collects golden snapshots superseded
// by the just-finished bake (rowID). Phase 1 marks prior 'ready' rows
// 'superseded' (excluding rowID and anything newer). Phase 2 deletes the
// sandbox provider snapshot + row for snapshots that have been superseded longer than
// goldenSnapshotSupersededGraceTTL — long enough that no pod's Current() cache
// can still reference them. The newest 'ready' row (what
// latestReadyGoldenSnapshotSQL returns) is never touched. Best effort
// throughout; a sandbox provider 404 is tolerated so GC is idempotent.
func (s *GoldenSnapshotService) gcSupersededSnapshots(ctx context.Context, rowID string) {
	s.gcSupersededSnapshotsFor(ctx, goldenSnapshotKindWorkspace, rowID)
}

// gcSupersededSnapshotsFor is gcSupersededSnapshots for any snapshot key
// (the workspace kind or a NixOS closure key from goldenSnapshotKeyForImage).
func (s *GoldenSnapshotService) gcSupersededSnapshotsFor(ctx context.Context, kind, rowID string) {
	if strings.TrimSpace(rowID) == "" {
		return
	}
	// Phase 1: mark superseded (fast; removes from Current() candidates now).
	if err := s.db.SupersedeGoldenSnapshots(ctx, kind, rowID); err != nil {
		slog.Warn("golden snapshot supersede failed", "row_id", rowID, "error", err)
		// Continue: phase 2 can still collect anything superseded earlier.
	}

	// Phase 2: delete sandbox provider snapshots (then rows) that have been superseded
	// long enough that no Current() cache can still vend them.
	graceSeconds := int64(goldenSnapshotSupersededGraceTTL / time.Second)
	victims, err := s.db.ExpiredGoldenSnapshots(ctx, kind, graceSeconds)
	if err != nil {
		slog.Warn("golden snapshot list superseded failed", "error", err)
		return
	}

	for _, v := range victims {
		// Delete the sandbox provider snapshot FIRST; only drop the row once it is gone
		// (or already 404). If the delete fails for another reason, keep the row
		// so a later sweep retries — never orphan the sandbox provider snapshot.
		if snap := strings.TrimSpace(v.SnapshotID); snap != "" {
			if err := s.sandbox.DeleteSnapshot(ctx, snap); err != nil && !vmAlreadyGone(err) {
				slog.Warn("golden snapshot delete failed; will retry", "row_id", v.ID, "snapshot_id", snap, "error", err)
				continue
			}
		}
		if err := s.db.DeleteGoldenSnapshot(ctx, v.ID); err != nil {
			slog.Warn("golden snapshot row delete failed", "row_id", v.ID, "error", err)
		}
	}
}

// reclaimStaleBaking flips any 'baking' row older than
// goldenSnapshotStaleBakingAge back to 'failed', freeing the per-kind baking
// slot a crashed baker would otherwise hold forever. Best-effort: no stale row
// (the common case) is not an error.
func (s *GoldenSnapshotService) reclaimStaleBaking(ctx context.Context) {
	s.reclaimStaleBakingFor(ctx, goldenSnapshotKindWorkspace)
}

// reclaimStaleBakingFor is reclaimStaleBaking for any snapshot key.
func (s *GoldenSnapshotService) reclaimStaleBakingFor(ctx context.Context, kind string) {
	staleSeconds := int64(goldenSnapshotStaleBakingAge / time.Second)
	reclaimedID, err := s.db.ReclaimStaleGoldenSnapshot(ctx, kind, staleSeconds)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("golden snapshot stale-baking reclaim failed", "error", err)
		}
		return
	}
	slog.Warn("reclaimed stale golden snapshot baking slot", "row_id", reclaimedID)
}

// bake boots one builder VM from the bare image with the exact workspace
// request, waits for the bootstrap to finish installing the toolchain,
// snapshots the disk, and deletes the builder.
func (s *GoldenSnapshotService) bake(ctx context.Context, rowIDs ...string) (string, error) {
	rowID := ""
	if len(rowIDs) > 0 {
		rowID = strings.TrimSpace(rowIDs[0])
	}
	return s.bakeWith(ctx, rowID, s.buildRequest, goldenSnapshotToolchainCheck)
}

// bakeWith is bake for an arbitrary builder request and readiness probe: the
// NixOS closure images boot a different image and prove readiness with
// systemd + the closure's tools rather than the apt/npm toolchain check.
func (s *GoldenSnapshotService) bakeWith(ctx context.Context, rowID string, build func() sandbox.CreateRequest, readyCheck string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, goldenSnapshotBakeTimeout)
	defer cancel()
	if build == nil {
		return "", errors.New("golden snapshot builder request is nil")
	}
	if strings.TrimSpace(readyCheck) == "" {
		readyCheck = goldenSnapshotToolchainCheck
	}

	createCtx := sandboxProvisionContext(ctx, "create", "golden_snapshot_bake", rowID, "builder")
	vm, err := createWorkspaceSandbox(createCtx, s.sandbox, build())
	defer func() {
		if vm.ID == "" {
			return
		}
		cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancelCleanup()
		if err := s.sandbox.DeleteSandbox(cleanupCtx, vm.ID); err != nil {
			slog.Warn("golden snapshot builder vm cleanup failed", "vm_id", vm.ID, "error", err)
		}
	}()
	if err != nil {
		return "", fmt.Errorf("create builder vm: %w", err)
	}

	timeoutMS := int64(60_000)
	for {
		resp, err := s.sandbox.Execute(ctx, vm.ID, sandbox.ExecRequest{
			Command:   readyCheck,
			TimeoutMS: &timeoutMS,
		})
		if err == nil && resp.StatusCode != nil && *resp.StatusCode == 0 {
			break
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("toolchain never became ready in builder vm %s: %w", vm.ID, ctx.Err())
		case <-time.After(10 * time.Second):
		}
	}

	snapshot, err := s.sandbox.SnapshotSandbox(ctx, vm.ID, sandbox.SnapshotRequest{
		Name: "smithers-golden-" + time.Now().UTC().Format("20060102-150405"),
	})
	if err != nil {
		return "", fmt.Errorf("snapshot builder vm: %w", err)
	}
	if strings.TrimSpace(snapshot.SnapshotID) == "" {
		return "", errors.New("sandbox provider returned an empty snapshot id")
	}
	return snapshot.SnapshotID, nil
}
