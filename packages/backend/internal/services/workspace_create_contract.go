package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A requested guest is at least this large: the provider's smallest
// bootable memory and the default container disk.
const (
	minWorkspaceMemoryMB = 512
	minWorkspaceDiskMB   = 2048
	// defaultWorkspaceMaxDiskMB is the bare kind=vm disk: the largest disk a
	// workspace gets when the operator sets no limit.
	defaultWorkspaceMaxDiskMB = 32 * 1024
)

// WorkspaceResources is the guest size a workspace requested at creation
// (#2939). Omitted fields in a sized request resolve to the configured CPU
// and memory defaults and 32 GiB disk before validation. Every provision of the
// workspace (create, recovery, fork) boots at exactly these values.
type WorkspaceResources struct {
	CPUs     *int32 `json:"vcpu"`
	MemoryMB *int32 `json:"memory_mib"`
	DiskGiB  *int32 `json:"disk_gib"`
}

func (r WorkspaceResources) requested() bool {
	return r.CPUs != nil || r.MemoryMB != nil || r.DiskGiB != nil
}

type workspaceResourceLimits struct {
	vcpuCount, memoryMB, diskMB int32
}

// WithWorkspaceResourceLimits bounds the size one create may request.
// A non-positive value keeps the kind's configured size as the limit, so no
// workspace grows past the default until the operator raises it.
func WithWorkspaceResourceLimits(vcpuCount, memoryMB, diskMB int32) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if vcpuCount > 0 {
			s.resourceLimits.vcpuCount = vcpuCount
		}
		if memoryMB > 0 {
			s.resourceLimits.memoryMB = memoryMB
		}
		if diskMB > 0 {
			s.resourceLimits.diskMB = diskMB
		}
	}
}

// validateWorkspaceResources refuses a size this server cannot boot exactly,
// before any row or guest exists.
func (s *WorkspaceService) validateWorkspaceResources(input CreateWorkspaceInput) error {
	resources := input.Resources
	if !resources.requested() {
		return nil
	}
	if s.runtime != nil && !s.runtime.Capabilities().Resources {
		return pkgerrors.BadRequest("this workspace runtime does not accept resources")
	}
	if s.runtime != nil && resources.DiskGiB != nil && !s.runtime.Capabilities().ResourcesDisk {
		return pkgerrors.BadRequest("this workspace runtime does not accept resources.disk_gib")
	}
	kind := normalizeWorkspaceKind(input.Kind)
	if kind != "container" && kind != "vm" {
		return pkgerrors.BadRequest("resources apply to container and vm workspaces")
	}
	if strings.TrimSpace(input.SnapshotID) != "" {
		return pkgerrors.BadRequest("resources cannot be combined with snapshot_id; a restore keeps the snapshot's size")
	}
	limit := func(configured, fallback int32) int32 {
		if configured > 0 {
			return configured
		}
		return fallback
	}
	minDiskMB := int32(minWorkspaceDiskMB)
	if kind == "vm" {
		minDiskMB = defaultWorkspaceMaxDiskMB
	}
	for _, field := range []struct {
		name       string
		value      *int32
		min, limit int32
	}{
		{"vcpu", resources.CPUs, 1, limit(s.resourceLimits.vcpuCount, s.workspaceVCPUCount)},
		{"memory_mib", resources.MemoryMB, minWorkspaceMemoryMB, limit(s.resourceLimits.memoryMB, s.workspaceMemoryMB)},
		{"disk_gib", resources.DiskGiB, minDiskMB / 1024, limit(s.resourceLimits.diskMB, defaultWorkspaceMaxDiskMB) / 1024},
	} {
		if field.value != nil && (*field.value < field.min || *field.value > field.limit) {
			err := pkgerrors.BadRequest(fmt.Sprintf("resources.%s must be between %d and %d", field.name, field.min, field.limit))
			if *field.value > field.limit {
				err = pkgerrors.New(pkgerrors.CodeWorkspaceResourcesExceeded, err.Message)
			}
			err.Details = map[string]any{"field": "resources." + field.name, "minimum": field.min, "maximum": field.limit, "requested": *field.value}
			return err
		}
	}
	return nil
}

// refuseWorkspaceResourceMismatch keeps find-or-create honest: a request
// that names a size never silently reuses a workspace of another size.
func refuseWorkspaceResourceMismatch(workspace db.Workspace, requested WorkspaceResources) error {
	if !requested.requested() || workspaceResourcesOf(workspace) == workspaceResourcesKey(requested) {
		return nil
	}
	return pkgerrors.Conflict("workspace " + workspace.ID + " exists with different resources; delete it or choose another name")
}

func workspaceResourcesKey(r WorkspaceResources) [3]int32 {
	value := func(v *int32) int32 {
		if v == nil {
			return 0
		}
		return *v
	}
	return [3]int32{value(r.CPUs), value(r.MemoryMB), value(r.DiskGiB)}
}

func workspaceResourcesOf(workspace db.Workspace) [3]int32 {
	return [3]int32{workspace.VcpuCount.Int32, workspace.MemoryMb.Int32, workspace.DiskMb.Int32 / 1024}
}

func workspaceResourceColumns(r WorkspaceResources) (vcpuCount, memoryMB, diskMB pgtype.Int4) {
	column := func(v *int32) pgtype.Int4 {
		if v == nil {
			return pgtype.Int4{}
		}
		return pgtype.Int4{Int32: *v, Valid: true}
	}
	disk := pgtype.Int4{}
	if r.DiskGiB != nil {
		disk = pgtype.Int4{Int32: *r.DiskGiB * 1024, Valid: true}
	}
	return column(r.CPUs), column(r.MemoryMB), disk
}

func workspaceResourcesResponse(workspace db.Workspace) WorkspaceResources {
	value := func(v pgtype.Int4) *int32 {
		if !v.Valid {
			return nil
		}
		out := v.Int32
		return &out
	}
	disk := workspace.DiskMb
	disk.Int32 /= 1024
	return WorkspaceResources{CPUs: value(workspace.VcpuCount), MemoryMB: value(workspace.MemoryMb), DiskGiB: value(disk)}
}

// applyWorkspaceResources boots the guest at the workspace's persisted size.
// A snapshot boot keeps the snapshot's disk, so callers that must honor a
// requested disk boot the bare image instead (see freshWorkspaceVMRequest).
func applyWorkspaceResources(req *sandbox.CreateRequest, workspace db.Workspace) {
	if workspace.VcpuCount.Valid {
		vcpus := workspace.VcpuCount.Int32
		req.VCPUCount = &vcpus
	}
	if workspace.MemoryMb.Valid {
		memory := workspace.MemoryMb.Int32
		req.MemSizeMB = &memory
	}
	if workspace.DiskMb.Valid {
		disk := int64(workspace.DiskMb.Int32)
		req.RootfsSizeMB = &disk
	}
}

// runtimeWorkspaceResources is the size a runtime adapter boots the workspace
// at, or nil for the adapter's own size.
func (s *WorkspaceService) runtimeWorkspaceResources(workspace db.Workspace) (*workspaceapi.WorkspaceResources, error) {
	if !workspace.VcpuCount.Valid && !workspace.MemoryMb.Valid && !workspace.DiskMb.Valid {
		return nil, nil
	}
	if !s.runtime.Capabilities().Resources {
		return nil, pkgerrors.BadRequest("this workspace runtime does not accept resources")
	}
	if workspace.DiskMb.Valid && !s.runtime.Capabilities().ResourcesDisk {
		return nil, pkgerrors.BadRequest("this workspace runtime does not accept resources.disk_gib")
	}
	return &workspaceapi.WorkspaceResources{VCPUCount: workspace.VcpuCount.Int32, MemoryMB: workspace.MemoryMb.Int32, DiskMB: workspace.DiskMb.Int32}, nil
}

// resolveWorkspaceResources persists the effective shape of a sized request.
func (s *WorkspaceService) resolveWorkspaceResources(r WorkspaceResources) WorkspaceResources {
	cpu, mem, disk := s.workspaceVCPUCount, s.workspaceMemoryMB, int32(32)
	if r.CPUs == nil {
		r.CPUs = &cpu
	}
	if r.MemoryMB == nil {
		r.MemoryMB = &mem
	}
	if r.DiskGiB == nil {
		r.DiskGiB = &disk
	}
	return r
}
func (s *WorkspaceService) refuseWorkspaceResourceMismatch(row db.Workspace, requested WorkspaceResources) error {
	actual := s.resolveWorkspaceResources(workspaceResourcesResponse(row))
	desired := s.resolveWorkspaceResources(requested)
	return refuseWorkspaceResourceMismatch(db.Workspace{ID: row.ID, VcpuCount: pgtype.Int4{Int32: *actual.CPUs, Valid: true}, MemoryMb: pgtype.Int4{Int32: *actual.MemoryMB, Valid: true}, DiskMb: pgtype.Int4{Int32: *actual.DiskGiB * 1024, Valid: true}}, desired)
}

// A snapshot keeps its source's size even after the source is tombstoned.
func (s *WorkspaceService) workspaceSnapshotSource(ctx context.Context, id string) (db.Workspace, error) {
	if q, ok := s.q.(interface {
		GetWorkspaceIncludingDeleted(context.Context, string) (db.Workspace, error)
	}); ok {
		return q.GetWorkspaceIncludingDeleted(ctx, id)
	}
	return s.q.GetWorkspace(ctx, id)
}
