package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Child workspaces (#2802): a running workspace fans out short-lived children
// that boot from one snapshot of its disk. Each child is a workspace row plus a
// receipt; it starts signed out, its egress proxy holds no repository secret,
// and it is reaped when its parent stops, when its batch expires, or when it
// goes idle.

// MaxWorkspaceChildren is the hard cap on one user's live children, whatever
// the plan grants.
const MaxWorkspaceChildren = 128

const (
	defaultWorkspaceChildTTL        = 4 * time.Hour
	workspaceChildUnbilledMaxTTL    = 8 * time.Hour
	workspaceChildIdleAfter         = 10 * time.Minute
	workspaceChildAbandonAfter      = 10 * time.Minute
	workspaceChildBootParallelism   = 8
	workspaceChildReapBatch         = 200
	workspaceChildProfileSmall      = "small"
	workspaceChildProfileBuild      = "build"
	workspaceChildFailureNoSnapshot = "snapshot the parent workspace"
)

// workspaceChildSizes are the guest shapes of each child profile.
var workspaceChildSizes = map[string]struct{ memoryMB, vcpus int32 }{
	workspaceChildProfileSmall: {memoryMB: 2048, vcpus: 1},
	workspaceChildProfileBuild: {memoryMB: 8192, vcpus: 2},
}

// SpawnWorkspaceChildrenInput asks a running workspace for Count children.
type SpawnWorkspaceChildrenInput struct {
	RepositoryID      int64
	UserID            int64
	ParentWorkspaceID string
	Count             int
	// Profile is "small" (the default) or "build".
	Profile string
	// TTL bounds the batch's life; zero takes the default, capped by the plan.
	TTL time.Duration
}

// WorkspaceChildBatch is the admission receipt for one fan-out.
type WorkspaceChildBatch struct {
	ID                string           `json:"id"`
	ParentWorkspaceID string           `json:"parent_workspace_id"`
	Profile           string           `json:"profile"`
	ExpiresAt         time.Time        `json:"expires_at"`
	Children          []WorkspaceChild `json:"children"`
}

// WorkspaceChild is one child's receipt.
type WorkspaceChild struct {
	WorkspaceID    string     `json:"workspace_id"`
	BatchID        string     `json:"batch_id"`
	Ordinal        int32      `json:"ordinal"`
	Profile        string     `json:"profile"`
	Status         string     `json:"status"`
	VMID           string     `json:"vm_id,omitempty"`
	SnapshotID     string     `json:"snapshot_id,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	StoppedAt      *time.Time `json:"stopped_at,omitempty"`
	StopReason     string     `json:"stop_reason,omitempty"`
	FailureMessage string     `json:"failure_message,omitempty"`
	ExpiresAt      time.Time  `json:"expires_at"`
}

// SpawnWorkspaceChildren admits a batch in one transaction and boots it in the
// background. The admission fails closed: the parent must be the caller's own
// running container workspace, not itself a child, and the user's live
// children plus this batch must fit the plan and MaxWorkspaceChildren.
func (s *WorkspaceService) SpawnWorkspaceChildren(ctx context.Context, input SpawnWorkspaceChildrenInput) (WorkspaceChildBatch, error) {
	if s.transactions == nil || s.sandbox == nil || s.runtime != nil {
		return WorkspaceChildBatch{}, pkgerrors.Conflict("child workspaces need the sandbox provider")
	}
	if input.Count < 1 || input.Count > MaxWorkspaceChildren {
		return WorkspaceChildBatch{}, pkgerrors.BadRequest(fmt.Sprintf("count must be between 1 and %d", MaxWorkspaceChildren))
	}
	profile := strings.TrimSpace(input.Profile)
	if profile == "" {
		profile = workspaceChildProfileSmall
	}
	if _, ok := workspaceChildSizes[profile]; !ok {
		return WorkspaceChildBatch{}, pkgerrors.BadRequest(`profile must be "small" or "build"`)
	}
	if input.TTL < 0 {
		return WorkspaceChildBatch{}, pkgerrors.BadRequest("ttl must not be negative")
	}
	limit, maxTTL, err := s.workspaceChildLimits(ctx, input.UserID)
	if err != nil {
		return WorkspaceChildBatch{}, err
	}
	if limit == 0 {
		return WorkspaceChildBatch{}, pkgerrors.QuotaExceeded("child workspaces are not included in your plan")
	}
	ttl := input.TTL
	if ttl == 0 {
		ttl = min(defaultWorkspaceChildTTL, maxTTL)
	}
	if ttl > maxTTL {
		return WorkspaceChildBatch{}, pkgerrors.BadRequest(fmt.Sprintf("ttl must be at most %s", maxTTL))
	}

	var (
		batch    db.WorkspaceChildBatch
		parent   db.Workspace
		rows     []db.Workspace
		ordinals []db.ListWorkspaceChildOrdinalsRow
	)
	err = s.inWorkspaceChildTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockUserForWorkspaceChildren(ctx, input.UserID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("user not found")
			}
			return pkgerrors.Internal("lock child admission").WithCause(err)
		}
		parent, err = q.GetWorkspaceChildParentForUpdate(ctx, input.ParentWorkspaceID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (parent.UserID != input.UserID || parent.RepositoryID != input.RepositoryID)) {
			return pkgerrors.NotFound("workspace not found")
		}
		if err != nil {
			return pkgerrors.Internal("load parent workspace").WithCause(err)
		}
		if parent.Status != "running" || strings.TrimSpace(parent.VmID) == "" {
			return pkgerrors.Conflict("the workspace must be running to spawn children")
		}
		if !workspaceKindForksCleanly(parent.Kind) {
			return pkgerrors.BadRequest("only container workspaces spawn children")
		}
		child, err := q.IsWorkspaceChild(ctx, parent.ID)
		if err != nil {
			return pkgerrors.Internal("check parent workspace").WithCause(err)
		}
		if child {
			return pkgerrors.BadRequest("a child workspace cannot spawn children")
		}
		live, err := q.CountLiveWorkspaceChildren(ctx, input.UserID)
		if err != nil {
			return pkgerrors.Internal("count live child workspaces").WithCause(err)
		}
		if live+int64(input.Count) > limit {
			return pkgerrors.QuotaExceeded(fmt.Sprintf(
				"child workspace limit reached: %d of %d live, %d requested", live, limit, input.Count))
		}
		batch, err = q.CreateWorkspaceChildBatch(ctx, db.CreateWorkspaceChildBatchParams{
			ParentWorkspaceID: parent.ID, UserID: input.UserID, Profile: profile,
			Requested: int32(input.Count), ExpiresAt: time.Now().Add(ttl),
		})
		if err != nil {
			return pkgerrors.Internal("create child batch").WithCause(err)
		}
		if err := q.ReserveWorkspaceChildren(ctx, batch.ID); err != nil {
			return pkgerrors.Internal("reserve child workspaces").WithCause(err)
		}
		rows, err = q.CreateWorkspaceChildRows(ctx, batch.ID)
		if err != nil {
			return pkgerrors.Internal("create child workspaces").WithCause(err)
		}
		ordinals, err = q.ListWorkspaceChildOrdinals(ctx, batch.ID)
		if err != nil {
			return pkgerrors.Internal("list child workspaces").WithCause(err)
		}
		return nil
	})
	if err != nil {
		return WorkspaceChildBatch{}, err
	}

	done := s.trackProvision()
	go func() {
		defer done()
		bootCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workspaceProvisionTimeout)
		defer cancel()
		s.bootWorkspaceChildBatch(bootCtx, batch, parent, rows)
	}()

	out := WorkspaceChildBatch{ID: batch.ID, ParentWorkspaceID: parent.ID, Profile: batch.Profile, ExpiresAt: batch.ExpiresAt}
	status := make(map[string]string, len(rows))
	for _, row := range rows {
		status[row.ID] = row.Status
	}
	for _, child := range ordinals {
		out.Children = append(out.Children, WorkspaceChild{
			WorkspaceID: child.WorkspaceID, BatchID: batch.ID, Ordinal: child.Ordinal, Profile: batch.Profile,
			Status: status[child.WorkspaceID], ExpiresAt: batch.ExpiresAt,
		})
	}
	return out, nil
}

// ListWorkspaceChildren returns the receipts of every child the caller's
// workspace spawned, oldest batch first.
func (s *WorkspaceService) ListWorkspaceChildren(ctx context.Context, workspaceID string, repositoryID, userID int64) ([]WorkspaceChild, error) {
	if s.transactions == nil {
		return nil, pkgerrors.Conflict("child workspaces need the sandbox provider")
	}
	parent, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return nil, err
	}
	var receipts []db.ListWorkspaceChildReceiptsRow
	err = s.inWorkspaceChildTx(ctx, func(q *db.Queries) error {
		receipts, err = q.ListWorkspaceChildReceipts(ctx, parent.ID)
		return err
	})
	if err != nil {
		return nil, pkgerrors.Internal("list child workspaces").WithCause(err)
	}
	children := make([]WorkspaceChild, 0, len(receipts))
	for _, r := range receipts {
		children = append(children, WorkspaceChild{
			WorkspaceID: r.WorkspaceID, BatchID: r.BatchID, Ordinal: r.Ordinal, Profile: r.Profile,
			Status: r.Status, VMID: r.VmID, SnapshotID: r.SnapshotID, ExpiresAt: r.ExpiresAt,
			StartedAt: timePtrFromTimestamptz(r.StartedAt), StoppedAt: timePtrFromTimestamptz(r.StoppedAt),
			StopReason: r.StopReason.String, FailureMessage: r.FailureMessage.String,
		})
	}
	return children, nil
}

// ReapWorkspaceChildren stops every live child that must stop and deletes the
// batch snapshots no live child boots from. The workspace cleaner runs it.
func (s *WorkspaceService) ReapWorkspaceChildren(ctx context.Context) error {
	if s.transactions == nil || s.sandbox == nil {
		return nil
	}
	err := s.reapWorkspaceChildren(ctx, "")
	return errors.Join(err, s.releaseDrainedWorkspaceChildSnapshots(ctx))
}

// cascadeWorkspaceChildren reaps a parent's children in the background once
// the parent leaves running; the cleaner's sweep is the backstop.
func (s *WorkspaceService) cascadeWorkspaceChildren(ctx context.Context, workspaceID, status string) {
	if s.transactions == nil || s.sandbox == nil || status == "running" || status == "starting" || status == "pending" {
		return
	}
	done := s.trackProvision()
	go func() {
		defer done()
		reapCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workspaceProvisionTimeout)
		defer cancel()
		if err := s.reapWorkspaceChildren(reapCtx, workspaceID); err != nil {
			slog.Warn("child workspace cascade failed", "parent_workspace_id", workspaceID, "error", err)
		}
	}()
}

// refuseWorkspaceChildResume keeps a stopped child stopped: resuming would boot
// it through the credentialed workspace path. Spawn a new child instead.
func (s *WorkspaceService) refuseWorkspaceChildResume(ctx context.Context, workspace db.Workspace) error {
	if s.transactions == nil || !workspace.IsFork || workspace.Status == "running" {
		return nil
	}
	var child bool
	err := s.inWorkspaceChildTx(ctx, func(q *db.Queries) (err error) {
		child, err = q.IsWorkspaceChild(ctx, workspace.ID)
		return err
	})
	if err != nil {
		return pkgerrors.Internal("check child workspace").WithCause(err)
	}
	if child {
		return pkgerrors.Conflict("a stopped child workspace cannot be resumed; spawn a new child")
	}
	return nil
}

func (s *WorkspaceService) workspaceChildLimits(ctx context.Context, userID int64) (limit int64, maxTTL time.Duration, err error) {
	if s.billing == nil {
		return MaxWorkspaceChildren, workspaceChildUnbilledMaxTTL, nil
	}
	entitlement, err := sandboxEntitlementForUser(ctx, s.billing, userID)
	if err != nil {
		return 0, 0, err
	}
	limit = min(max(entitlement.ConcurrentChildren, 0), MaxWorkspaceChildren)
	return limit, time.Duration(entitlement.ChildMaxTTLSecs) * time.Second, nil
}

// bootWorkspaceChildBatch takes one snapshot of the parent and boots every
// child from it, a bounded number at a time.
func (s *WorkspaceService) bootWorkspaceChildBatch(ctx context.Context, batch db.WorkspaceChildBatch, parent db.Workspace, rows []db.Workspace) {
	snapshot, err := s.sandbox.SnapshotSandbox(ctx, parent.VmID, sandbox.SnapshotRequest{Name: "children-" + batch.ID})
	if err == nil {
		err = s.inWorkspaceChildTx(ctx, func(q *db.Queries) error {
			return q.SetWorkspaceChildBatchSnapshot(ctx, db.SetWorkspaceChildBatchSnapshotParams{ID: batch.ID, SnapshotID: snapshot.SnapshotID})
		})
		if err != nil {
			// Unrecorded, the snapshot would never be released.
			if deleteErr := s.sandbox.DeleteSnapshot(ctx, snapshot.SnapshotID); deleteErr != nil {
				slog.Warn("child batch snapshot leaked", "batch_id", batch.ID, "snapshot_id", snapshot.SnapshotID, "error", deleteErr)
			}
		}
	}
	if err != nil {
		slog.Error("child batch snapshot failed", "batch_id", batch.ID, "parent_workspace_id", parent.ID, "error", err)
		for _, row := range rows {
			s.failWorkspaceChild(ctx, row.ID, "", workspaceChildFailureNoSnapshot+": "+err.Error())
		}
		return
	}
	size := workspaceChildSizes[batch.Profile]
	slots := make(chan struct{}, workspaceChildBootParallelism)
	var wg sync.WaitGroup
	for _, row := range rows {
		slots <- struct{}{}
		wg.Add(1)
		go func(row db.Workspace) {
			defer func() { <-slots; wg.Done() }()
			s.bootWorkspaceChild(ctx, batch, parent, row, snapshot.SnapshotID, size.memoryMB, size.vcpus)
		}(row)
	}
	wg.Wait()
}

func (s *WorkspaceService) bootWorkspaceChild(ctx context.Context, batch db.WorkspaceChildBatch, parent, row db.Workspace, snapshotID string, memoryMB, vcpus int32) {
	if err := s.inheritOutsiderMark(ctx, row, parent); err != nil {
		s.failWorkspaceChild(ctx, row.ID, "", "inherit the parent's outsider mark: "+err.Error())
		return
	}
	req, err := s.buildWorkspaceVMRequest(ctx, snapshotID, nil, row.RepositoryID, row.ID, row.Kind)
	if err != nil {
		s.failWorkspaceChild(ctx, row.ID, "", "build the child request: "+err.Error())
		return
	}
	// A child reaches the network through its own proxy with no repository
	// secret bound: it inherits the parent's files, never its credentials.
	if req.EgressProxy != nil {
		req.EgressProxy.Secrets = nil
	}
	idle := int64(workspaceChildIdleAfter / time.Second)
	req.MemSizeMB, req.VCPUCount, req.IdleTimeoutSeconds = &memoryMB, &vcpus, &idle
	req.Persistence = &sandbox.PersistencePolicy{Type: sandbox.PersistenceEphemeral}
	withoutWorkspaceBootstrap(&req)
	createCtx := sandboxProvisionContext(ctx, "create", "workspace", row.ID, "child-"+batch.ID)
	vm, err := s.sandbox.CreateSandbox(createCtx, req)
	if err != nil {
		s.failWorkspaceChild(ctx, row.ID, vm.ID, "boot the child: "+err.Error())
		return
	}
	// The snapshot carries the parent's vendor logins (#2805).
	if err := s.scrubSandboxWorkspaceLogins(ctx, vm.ID); err != nil {
		s.failWorkspaceChild(ctx, row.ID, vm.ID, "sign the child out: "+err.Error())
		return
	}
	var started int64
	err = s.inWorkspaceChildTx(ctx, func(q *db.Queries) (err error) {
		started, err = q.StartWorkspaceChild(ctx, db.StartWorkspaceChildParams{WorkspaceID: row.ID, VmID: vm.ID})
		return err
	})
	if err != nil {
		s.failWorkspaceChild(ctx, row.ID, vm.ID, "record the child: "+err.Error())
		return
	}
	if started == 0 {
		// Stopped while it booted: the machine is ours alone to delete.
		s.deleteWorkspaceChildVM(ctx, row.ID, vm.ID)
		return
	}
	s.publishWorkspaceStatus(ctx, row.ID, "running")
}

// withoutWorkspaceBootstrap drops the toolchain bootstrap from a child's
// request: the parent's snapshot already holds the installed toolchain.
func withoutWorkspaceBootstrap(req *sandbox.CreateRequest) {
	delete(req.Files, workspaceClaudeScriptPath)
	if req.Init == nil {
		return
	}
	init := *req.Init
	init.Services = slices.DeleteFunc(slices.Clone(init.Services), func(service sandbox.ServiceSpec) bool {
		return service.Name == workspaceClaudeService
	})
	req.Init = &init
}

func (s *WorkspaceService) failWorkspaceChild(ctx context.Context, workspaceID, vmID, message string) {
	slog.Warn("child workspace failed", "workspace_id", workspaceID, "vm_id", vmID, "error", message)
	if err := s.stopWorkspaceChild(ctx, workspaceID, vmID, "failed", message); err != nil {
		slog.Warn("child workspace failure not recorded; the reaper retries", "workspace_id", workspaceID, "error", err)
	}
}

func (s *WorkspaceService) reapWorkspaceChildren(ctx context.Context, parentWorkspaceID string) error {
	params := db.ListReapableWorkspaceChildrenParams{
		AbandonAfterSecs: int32(workspaceChildAbandonAfter / time.Second),
		IdleAfterSecs:    int32(workspaceChildIdleAfter / time.Second),
		MaxRows:          workspaceChildReapBatch,
	}
	if parentWorkspaceID != "" {
		params.ParentWorkspaceID = stringToUUID(parentWorkspaceID)
	}
	var rows []db.ListReapableWorkspaceChildrenRow
	err := s.inWorkspaceChildTx(ctx, func(q *db.Queries) (err error) {
		rows, err = q.ListReapableWorkspaceChildren(ctx, params)
		return err
	})
	if err != nil {
		return fmt.Errorf("list reapable child workspaces: %w", err)
	}
	var errs []error
	for _, row := range rows {
		if err := s.stopWorkspaceChild(ctx, row.WorkspaceID, row.VmID, row.Reason, ""); err != nil {
			errs = append(errs, fmt.Errorf("stop child workspace %s: %w", row.WorkspaceID, err))
		}
	}
	return errors.Join(errs...)
}

// stopWorkspaceChild deletes the child's machine, then closes its receipt and
// tombstones its row. A machine that cannot be deleted leaves the child live
// for the next sweep.
func (s *WorkspaceService) stopWorkspaceChild(ctx context.Context, workspaceID, vmID, reason, failure string) error {
	if vmID != "" {
		if err := s.sandbox.DeleteSandbox(ctx, vmID); err != nil && !vmAlreadyGone(err) {
			return err
		}
	}
	var held string
	err := s.inWorkspaceChildTx(ctx, func(q *db.Queries) (err error) {
		held, err = q.StopWorkspaceChild(ctx, db.StopWorkspaceChildParams{
			WorkspaceID: workspaceID, StopReason: reason,
			FailureMessage: pgtype.Text{String: failure, Valid: failure != ""},
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// A boot that registered between the listing and this stop.
	if held != "" && held != vmID {
		s.deleteWorkspaceChildVM(ctx, workspaceID, held)
	}
	s.publishWorkspaceStatus(ctx, workspaceID, "stopped")
	return nil
}

func (s *WorkspaceService) deleteWorkspaceChildVM(ctx context.Context, workspaceID, vmID string) {
	if err := s.sandbox.DeleteSandbox(ctx, vmID); err != nil && !vmAlreadyGone(err) {
		slog.Warn("child workspace machine not deleted", "workspace_id", workspaceID, "vm_id", vmID, "error", err)
	}
}

func (s *WorkspaceService) releaseDrainedWorkspaceChildSnapshots(ctx context.Context) error {
	var batches []db.ListDrainedWorkspaceChildSnapshotsRow
	err := s.inWorkspaceChildTx(ctx, func(q *db.Queries) (err error) {
		batches, err = q.ListDrainedWorkspaceChildSnapshots(ctx, workspaceChildReapBatch)
		return err
	})
	if err != nil {
		return fmt.Errorf("list drained child snapshots: %w", err)
	}
	var errs []error
	for _, batch := range batches {
		if err := s.sandbox.DeleteSnapshot(ctx, batch.SnapshotID); err != nil && !vmAlreadyGone(err) {
			errs = append(errs, fmt.Errorf("delete child snapshot %s: %w", batch.SnapshotID, err))
			continue
		}
		if err := s.inWorkspaceChildTx(ctx, func(q *db.Queries) error {
			return q.MarkWorkspaceChildSnapshotDeleted(ctx, batch.ID)
		}); err != nil {
			errs = append(errs, fmt.Errorf("record child snapshot %s deleted: %w", batch.SnapshotID, err))
		}
	}
	return errors.Join(errs...)
}

func (s *WorkspaceService) inWorkspaceChildTx(ctx context.Context, fn func(*db.Queries) error) error {
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := fn(db.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
