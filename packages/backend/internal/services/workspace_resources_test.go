package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"math"
	"testing"
	"time"
)

func resourcePtr(v int32) *int32 { return &v }
func TestWorkspaceResourceBounds(t *testing.T) {
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceResourceLimits(16, 32768, 65536))
	for _, tc := range []struct {
		name      string
		resources WorkspaceResources
		code      pkgerrors.Code
	}{
		{"omitted", WorkspaceResources{}, ""},
		{"max", WorkspaceResources{CPUs: resourcePtr(16), MemoryMB: resourcePtr(32768), DiskGiB: resourcePtr(64)}, ""},
		{"zero cpu", WorkspaceResources{CPUs: resourcePtr(0)}, pkgerrors.CodeBadRequest},
		{"negative memory", WorkspaceResources{MemoryMB: resourcePtr(-1)}, pkgerrors.CodeBadRequest},
		{"small memory", WorkspaceResources{MemoryMB: resourcePtr(511)}, pkgerrors.CodeBadRequest},
		{"small disk", WorkspaceResources{DiskGiB: resourcePtr(1)}, pkgerrors.CodeBadRequest},
		{"max cpu", WorkspaceResources{CPUs: resourcePtr(17)}, pkgerrors.CodeWorkspaceResourcesExceeded},
		{"max memory", WorkspaceResources{MemoryMB: resourcePtr(32769)}, pkgerrors.CodeWorkspaceResourcesExceeded},
		{"max disk", WorkspaceResources{DiskGiB: resourcePtr(65)}, pkgerrors.CodeWorkspaceResourcesExceeded},
		{"disk overflow", WorkspaceResources{DiskGiB: resourcePtr(math.MaxInt32)}, pkgerrors.CodeWorkspaceResourcesExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := s.validateWorkspaceResources(CreateWorkspaceInput{Resources: tc.resources})
			if tc.code == "" {
				require.NoError(t, err)
				return
			}
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			require.Equal(t, tc.code, api.Code)
			if tc.code == pkgerrors.CodeWorkspaceResourcesExceeded {
				require.NotNil(t, api.Details)
			}
		})
	}
	for _, input := range []CreateWorkspaceInput{{SnapshotID: "snapshot", Resources: WorkspaceResources{CPUs: resourcePtr(4)}}} {
		require.Error(t, s.validateWorkspaceResources(input))
	}
}
func TestWorkspaceResourcesPersistedAcrossProvisionAndReuse(t *testing.T) {
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceResourceLimits(16, 32768, 65536))
	r := s.resolveWorkspaceResources(WorkspaceResources{CPUs: resourcePtr(4), MemoryMB: resourcePtr(8192), DiskGiB: resourcePtr(40)})
	cpu, mem, disk := workspaceResourceColumns(r)
	row := db.Workspace{ID: "sized", Kind: "container", VcpuCount: cpu, MemoryMb: mem, DiskMb: disk}
	require.Equal(t, int32(40960), row.DiskMb.Int32)
	data, err := json.Marshal(workspaceResourcesResponse(row))
	require.NoError(t, err)
	require.JSONEq(t, `{"vcpu":4,"memory_mib":8192,"disk_gib":40}`, string(data))
	req := sandbox.CreateRequest{}
	applyWorkspaceResources(&req, row)
	require.Equal(t, int32(4), *req.VCPUCount)
	require.Equal(t, int32(8192), *req.MemSizeMB)
	require.Equal(t, int64(40960), *req.RootfsSizeMB)
	require.NoError(t, s.refuseWorkspaceResourceMismatch(row, r))
	require.Error(t, s.refuseWorkspaceResourceMismatch(row, WorkspaceResources{}))
	// Partial and fully specified defaults identify the same shape.
	partial := s.resolveWorkspaceResources(WorkspaceResources{CPUs: resourcePtr(4)})
	cpu, mem, disk = workspaceResourceColumns(partial)
	require.NoError(t, s.refuseWorkspaceResourceMismatch(db.Workspace{VcpuCount: cpu, MemoryMb: mem, DiskMb: disk}, WorkspaceResources{CPUs: resourcePtr(4)}))
	require.NoError(t, s.refuseWorkspaceResourceMismatch(db.Workspace{}, WorkspaceResources{}))
}
func TestWorkspaceOverMaxRefusesBeforeStoreOrProvider(t *testing.T) {
	q := &mockWorkspaceQuerier{}
	s := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}), WithWorkspaceResourceLimits(16, 32768, 65536))
	for _, create := range []func(context.Context, CreateWorkspaceInput) (WorkspaceResponse, error){s.CreateWorkspace, s.CreateWorkspaceAsync} {
		_, err := create(context.Background(), CreateWorkspaceInput{Resources: WorkspaceResources{CPUs: resourcePtr(17)}})
		var api *pkgerrors.APIError
		require.True(t, errors.As(err, &api))
		require.Equal(t, pkgerrors.CodeWorkspaceResourcesExceeded, api.Code)
	}
}

func sizedWorkspace(kind string, vcpus, memoryMB, diskMB int32) db.Workspace {
	column := func(v int32) pgtype.Int4 { return pgtype.Int4{Int32: v, Valid: v > 0} }
	return db.Workspace{ID: "ws-sized", RepositoryID: 7, Kind: kind, VcpuCount: column(vcpus), MemoryMb: column(memoryMB), DiskMb: column(diskMB)}
}

func TestFreshWorkspaceVMRequestBootsPersistedSize(t *testing.T) {
	t.Parallel()
	golden := NewGoldenSnapshotService(&fakeGoldenDB{readyID: "snap-golden", readyCreatedAt: time.Now()}, &fakeGoldenVMClient{}, nil)
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceResources(4096, 2), WithWorkspaceGoldenSnapshots(golden))

	unsized, err := svc.freshWorkspaceVMRequest(context.Background(), sizedWorkspace("container", 0, 0, 0))
	require.NoError(t, err)
	assert.Equal(t, "snap-golden", unsized.SnapshotID)
	assert.Equal(t, int32(2), *unsized.VCPUCount)
	assert.Equal(t, int32(4096), *unsized.MemSizeMB)
	assert.Nil(t, unsized.RootfsSizeMB, "the provider's disk applies")

	cpuMemory, err := svc.freshWorkspaceVMRequest(context.Background(), sizedWorkspace("container", 6, 12288, 0))
	require.NoError(t, err)
	assert.Equal(t, "snap-golden", cpuMemory.SnapshotID, "a snapshot boot honors cpu and memory")
	assert.Equal(t, int32(6), *cpuMemory.VCPUCount)
	assert.Equal(t, int32(12288), *cpuMemory.MemSizeMB)

	disk, err := svc.freshWorkspaceVMRequest(context.Background(), sizedWorkspace("container", 0, 0, 32768))
	require.NoError(t, err)
	assert.Empty(t, disk.SnapshotID)
	assert.NotEmpty(t, disk.Packages, "a bare boot installs the toolchain")
	require.NotNil(t, disk.RootfsSizeMB)
	assert.Equal(t, int64(32768), *disk.RootfsSizeMB)
	assert.Equal(t, int32(2), *disk.VCPUCount)
}

func TestCreateFreshWorkspaceVMBareRetryKeepsSize(t *testing.T) {
	t.Parallel()
	golden := NewGoldenSnapshotService(&fakeGoldenDB{readyID: "snap-golden", readyCreatedAt: time.Now()}, &fakeGoldenVMClient{}, nil)
	var requests []sandbox.CreateRequest
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceGoldenSnapshots(golden), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			requests = append(requests, req)
			if req.SnapshotID != "" {
				return sandbox.CreateResult{}, assert.AnError
			}
			return sandbox.CreateResult{ID: "vm-bare"}, nil
		},
	}))
	_, err := svc.createFreshWorkspaceVM(context.Background(), sizedWorkspace("container", 3, 6144, 0))
	require.NoError(t, err)
	require.Len(t, requests, 2)
	for _, req := range requests {
		assert.Equal(t, int32(3), *req.VCPUCount)
		assert.Equal(t, int32(6144), *req.MemSizeMB)
	}
}

func TestForkWorkspaceSandboxBootsChildAtPersistedSize(t *testing.T) {
	t.Parallel()
	var got sandbox.ForkRequest
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceResources(4096, 2), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		forkVMFn: func(_ context.Context, _ string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			got = req
			return sandbox.CreateResult{ID: "vm-child"}, nil
		},
	}))
	_, err := svc.forkWorkspaceSandbox(context.Background(), "vm-source", sizedWorkspace("container", 8, 16384, 32768), nil)
	require.NoError(t, err)
	assert.Equal(t, int32(8), *got.VCPUCount)
	assert.Equal(t, int32(16384), *got.MemSizeMB)
}

func TestProvisioningPathsBootPersistedSize(t *testing.T) {
	t.Parallel()
	probe := &forkKindProbe{}
	svc := newWorkspaceServiceForTests(forkKindQuerier(), WithWorkspaceSandboxClient(probe.client()))
	sized := sampleDBWorkspace("ws-sized")
	sized.VmID = ""
	sized.VcpuCount, sized.MemoryMb, sized.DiskMb = pgtype.Int4{Int32: 8, Valid: true}, pgtype.Int4{Int32: 16384, Valid: true}, pgtype.Int4{Int32: 40960, Valid: true}
	_, err := svc.createWorkspaceVM(context.Background(), sized, CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "acme", RepoName: "repo"})
	require.NoError(t, err)

	source := sampleDBWorkspace("ws-empty-source")
	source.VmID = ""
	fork := sized
	fork.ID = "ws-fork"
	_, err = svc.forkWorkspaceVM(context.Background(), fork, source)
	require.NoError(t, err)

	require.Len(t, probe.created, 2)
	for _, req := range probe.created {
		assert.Equal(t, int32(8), *req.VCPUCount)
		assert.Equal(t, int32(16384), *req.MemSizeMB)
		assert.Equal(t, int64(40960), *req.RootfsSizeMB)
		assert.Empty(t, req.SnapshotID)
	}
}

func TestRuntimeForkOfSizedWorkspaceRefusesBeforeSideEffects(t *testing.T) {
	t.Parallel()
	source := forkQuotaSource()
	source.VcpuCount = pgtype.Int4{Int32: 4, Valid: true}
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
		getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return source, nil },
		createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
			t.Fatal("a refused fork must not insert a workspace")
			return db.Workspace{}, nil
		},
	}
	runtime := &forkQuotaRuntime{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	_, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{RepositoryID: source.RepositoryID, UserID: source.UserID, WorkspaceID: source.ID, Name: "fork"})
	assert.ErrorContains(t, err, "revision-based fork unavailable")
	assert.Zero(t, runtime.starts+runtime.creates+runtime.snapshots+runtime.forks)
}

func TestApplyWorkspaceResourcesOverridesOnlyPersistedFields(t *testing.T) {
	t.Parallel()
	memory, vcpus := int32(4096), int32(2)
	req := sandbox.CreateRequest{MemSizeMB: &memory, VCPUCount: &vcpus}
	applyWorkspaceResources(&req, sizedWorkspace("container", 0, 2048, 0))
	assert.Equal(t, int32(2), *req.VCPUCount)
	assert.Equal(t, int32(2048), *req.MemSizeMB)
	assert.Nil(t, req.RootfsSizeMB)
}

func TestRuntimeWorkspaceSpecCarriesPersistedSize(t *testing.T) {
	t.Parallel()
	sized := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(&resourceRuntime{caps: workspaceapi.WorkspaceCapabilities{Resources: true, ResourcesDisk: true}}))
	spec, err := sized.runtimeWorkspaceSpec(context.Background(), sizedWorkspace("container", 4, 8192, 20480))
	require.NoError(t, err)
	assert.Equal(t, &workspaceapi.WorkspaceResources{VCPUCount: 4, MemoryMB: 8192, DiskMB: 20480}, spec.Resources)

	unsized, err := sized.runtimeWorkspaceSpec(context.Background(), sizedWorkspace("container", 0, 0, 0))
	require.NoError(t, err)
	assert.Nil(t, unsized.Resources)

	noDisk := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(&resourceRuntime{caps: workspaceapi.WorkspaceCapabilities{Resources: true}}))
	_, err = noDisk.runtimeWorkspaceSpec(context.Background(), sizedWorkspace("container", 0, 0, 32768))
	assert.ErrorContains(t, err, "this workspace runtime does not accept resources.disk_gib")
	_, err = noDisk.runtimeWorkspaceSpec(context.Background(), sizedWorkspace("container", 4, 8192, 0))
	require.NoError(t, err)

	plain := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(&resourceRuntime{}))
	_, err = plain.runtimeWorkspaceSpec(context.Background(), sizedWorkspace("container", 4, 0, 0))
	assert.ErrorContains(t, err, "this workspace runtime does not accept resources")
}

type resourceRuntime struct {
	workspaceapi.WorkspaceRuntime
	caps workspaceapi.WorkspaceCapabilities
}

func (r *resourceRuntime) Capabilities() workspaceapi.WorkspaceCapabilities { return r.caps }

func TestWorkspacePartialRequestCannotExceedCapThroughDefault(t *testing.T) {
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}), WithWorkspaceResourceLimits(16, 2048, 65536))
	_, err := s.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{Resources: WorkspaceResources{CPUs: resourcePtr(4)}})
	var api *pkgerrors.APIError
	require.ErrorAs(t, err, &api)
	require.Equal(t, pkgerrors.CodeWorkspaceResourcesExceeded, api.Code)
}

func TestWorkspaceResourceAdmissionRuntimeAndDefaultLimits(t *testing.T) {
	r := WorkspaceResources{CPUs: resourcePtr(4), MemoryMB: resourcePtr(8192), DiskGiB: resourcePtr(40)}
	for _, caps := range []workspaceapi.WorkspaceCapabilities{{}, {Resources: true}} {
		s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(&resourceRuntime{caps: caps}), WithWorkspaceResourceLimits(16, 32768, 65536))
		require.Error(t, s.validateWorkspaceResources(CreateWorkspaceInput{Resources: r}))
	}
	defaults := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	for _, r := range []WorkspaceResources{{CPUs: resourcePtr(3)}, {MemoryMB: resourcePtr(4097)}, {DiskGiB: resourcePtr(33)}} {
		var api *pkgerrors.APIError
		require.ErrorAs(t, defaults.validateWorkspaceResources(CreateWorkspaceInput{Resources: r}), &api)
		require.Equal(t, pkgerrors.CodeWorkspaceResourcesExceeded, api.Code)
	}
	s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceResourceLimits(16, 32768, 65536))
	require.Error(t, s.validateWorkspaceResources(CreateWorkspaceInput{Kind: "vm", Resources: WorkspaceResources{DiskGiB: resourcePtr(31)}}))
	require.NoError(t, s.validateWorkspaceResources(CreateWorkspaceInput{Kind: "vm", Resources: r}))
	// Nullable columns represent an omitted value, never explicit zero.
	cpu, mem, disk := workspaceResourceColumns(WorkspaceResources{CPUs: resourcePtr(4)})
	require.True(t, cpu.Valid)
	require.False(t, mem.Valid)
	require.False(t, disk.Valid)
	require.NoError(t, refuseWorkspaceResourceMismatch(db.Workspace{VcpuCount: cpu}, WorkspaceResources{CPUs: resourcePtr(4)}))
}

type snapshotSourceResourceQueries struct {
	*mockWorkspaceQuerier
	row db.Workspace
}

func (q *snapshotSourceResourceQueries) GetWorkspaceIncludingDeleted(context.Context, string) (db.Workspace, error) {
	return q.row, nil
}
func TestSnapshotResourceSizeRemainsReadableAfterDeletion(t *testing.T) {
	row := sizedWorkspace("container", 4, 8192, 40960)
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
	s := newWorkspaceServiceForTests(q)
	got, err := s.workspaceSnapshotSource(context.Background(), row.ID)
	require.NoError(t, err)
	require.Equal(t, row, got)
	s.q = &snapshotSourceResourceQueries{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
		t.Fatal("snapshot read filtered tombstones")
		return db.Workspace{}, nil
	}}, row: row}
	got, err = s.workspaceSnapshotSource(context.Background(), row.ID)
	require.NoError(t, err)
	require.Equal(t, row, got)
}
