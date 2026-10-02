package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type stubEnvironmentImageResolver struct {
	image runtimeports.SandboxEnvironmentImage
	err   error
	calls []string
}

func (s *stubEnvironmentImageResolver) Resolve(_ context.Context, repositoryID int64, kind string) (runtimeports.SandboxEnvironmentImage, error) {
	s.calls = append(s.calls, kind)
	if s.err != nil {
		return runtimeports.SandboxEnvironmentImage{}, s.err
	}
	return s.image, nil
}

func (s *stubEnvironmentImageResolver) Pinned(_ context.Context, _ int64, kind, closureHash string) (runtimeports.SandboxEnvironmentImage, error) {
	s.calls = append(s.calls, "pinned "+kind)
	if s.err != nil {
		return runtimeports.SandboxEnvironmentImage{}, s.err
	}
	if s.image.ClosureHash != closureHash {
		return runtimeports.SandboxEnvironmentImage{}, pkgerrors.EnvironmentImageUnavailable("gone")
	}
	return s.image, nil
}

func nixTestImage(kind string) runtimeports.SandboxEnvironmentImage {
	return runtimeports.SandboxEnvironmentImage{
		ID:             "img-1",
		Kind:           kind,
		Source:         defaultWorkspaceEnvironmentSource,
		SourceRevision: "abc123",
		ClosureHash:    "0123456789abcdefghijklmnopqrstuv",
		Image:          "us-central1-docker.pkg.dev/p/smithers/nixos-guest:base-0123456789abcdefghijklmnopqrstuv",
		Status:         "ready",
	}
}

func TestBuildWorkspaceVMRequestContainerKindIsUnchanged(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{image: nixTestImage("vm")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))

	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", "container")
	require.NoError(t, err)
	assert.Equal(t, "container", req.Kind)
	assert.Empty(t, req.Image, "container workspaces keep the deployment default image")
	assert.Equal(t, defaultWorkspacePackages, req.Packages)
	assert.Empty(t, resolver.calls, "container kind never consults the image registry")
	assert.Contains(t, req.Files[workspaceClaudeScriptPath].Content, "SMITHERS_NODE_INDEX_URL", "container bootstrap downloads node")
}

func TestBuildWorkspaceVMRequestVMKindBootsClosureImage(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{image: nixTestImage("vm")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))

	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "vm")
	require.NoError(t, err)
	assert.Equal(t, "vm", req.Kind)
	assert.Equal(t, resolver.image.Image, req.Image)
	assert.Nil(t, req.Packages, "apt packages never apply to a NixOS guest")
	assert.Empty(t, req.SnapshotID, "a bare request boots the image, not a snapshot")
	assert.Equal(t, []string{"vm"}, resolver.calls)
	script := req.Files[workspaceClaudeScriptPath]
	assert.True(t, script.Executable)
	assert.Contains(t, script.Content, "nix-ld", "NixOS bootstrap variant is rendered")
	assert.NotContains(t, script.Content, "SMITHERS_NODE_INDEX_URL", "NixOS bootstrap never downloads node")
	assert.NotContains(t, script.Content, "smithers-desktop-start", "vm kind has no desktop service")
	_, hasPassword := req.Files["/run/smithers-desktop/password"]
	assert.False(t, hasPassword)
	require.NotNil(t, req.Init)
	var ready *sandbox.ServiceSpec
	for _, service := range req.Init.Services {
		assert.NotEqual(t, "smithers-desktop", service.Name)
		if service.Name == workspaceReadyService {
			ready = &service
		}
	}
	require.NotNil(t, ready)
	assert.Equal(t, []string{"/bin/sh", "-lc", workspaceNixActivationWaitCommand}, ready.Exec,
		"service Exec is an argv; quoting the script as one shell word prevents activation")
	assert.Contains(t, strings.Join(ready.Exec, " "), "systemctl is-system-running")
	assert.Contains(t, strings.Join(ready.Exec, " "), "/run/current-system/sw/bin/bash")
}

func TestBuildWorkspaceVMRequestResources(t *testing.T) {
	for _, resources := range []struct {
		name                string
		options             []WorkspaceServiceOption
		memoryMB, vcpuCount int32
	}{
		{name: "defaults", memoryMB: 4096, vcpuCount: 2},
		{name: "configured", options: []WorkspaceServiceOption{WithWorkspaceResources(8192, 4)}, memoryMB: 8192, vcpuCount: 4},
		{name: "non-positive keeps defaults", options: []WorkspaceServiceOption{WithWorkspaceResources(0, -1)}, memoryMB: 4096, vcpuCount: 2},
	} {
		for _, kind := range []string{"container", "vm", "agent"} {
			for _, snapshotID := range []string{"", "snapshot-ready"} {
				t.Run(resources.name+"/"+kind+"/"+snapshotID, func(t *testing.T) {
					resolver := &stubEnvironmentImageResolver{image: nixTestImage(kind)}
					options := append([]WorkspaceServiceOption{
						WithWorkspaceEnvironmentImages(resolver),
						WithWorkspaceAgentResources(12288, 6),
					}, resources.options...)
					svc := NewWorkspaceService(&mockWorkspaceQuerier{}, options...)
					req, err := svc.buildWorkspaceVMRequest(context.Background(), snapshotID, nil, 7, "", kind)
					require.NoError(t, err)
					memoryMB, vcpuCount := resources.memoryMB, resources.vcpuCount
					switch kind {
					case "agent":
						memoryMB, vcpuCount = 12288, 6
					}
					require.NotNil(t, req.MemSizeMB)
					assert.Equal(t, memoryMB, *req.MemSizeMB)
					require.NotNil(t, req.VCPUCount)
					assert.Equal(t, vcpuCount, *req.VCPUCount)
				})
			}
		}
	}
}

func TestBuildWorkspaceVMRequestVMKindWithoutRegistryIsConflict(t *testing.T) {
	svc := NewWorkspaceService(&mockWorkspaceQuerier{})
	_, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "vm")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, 409, apiErr.Status)
}

func TestBuildWorkspaceVMRequestVMKindPropagatesResolverError(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{err: pkgerrors.Conflict("no image")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))
	_, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "vm")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no image")
}

func TestNixBakeVMRequestBootsGivenImageWithoutSnapshot(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{err: errors.New("registry must not be consulted")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))
	image := nixTestImage("vm")
	req := svc.NixBakeVMRequest(image)
	assert.Equal(t, image.Image, req.Image)
	assert.Equal(t, "vm", req.Kind)
	assert.Empty(t, req.SnapshotID)
	assert.Nil(t, req.Packages)
	assert.Empty(t, resolver.calls)
	require.NotNil(t, req.EgressProxy)
	assert.Empty(t, req.EgressProxy.Secrets, "the baked disk never carries repository secrets")
}

func TestGoldenSnapshotKeyForImage(t *testing.T) {
	assert.Equal(t, "nix:vm:abc", goldenSnapshotKeyForImage("vm", " abc "))
	assert.Equal(t, "nix:container:abc", goldenSnapshotKeyForImage("weird", "abc"))
}

type desktopSessionQuerier struct {
	*mockWorkspaceQuerier
	set db.SetWorkspaceDesktopSessionParams
}

type desktopSandbox struct {
	mockWorkspaceSandboxVMClient
	published []sandbox.PublishIngressRequest
	domains   []string
}

// TestRotateWorkspaceDesktopPasswordReportsAnImageWithoutHelpers pins the
// mint's alignment with observe and input: once activation has FINISHED and
// the helper is still missing, the box booted an image that predates it. That
// is terminal, so it answers the same 409 the control routes do instead of
// burning the whole activation window on a 503 that promises a retry will
// work.

type fakeEnvironmentImageQuerier struct {
	rows     []runtimeports.SandboxEnvironmentImage
	upserted []runtimeports.UpsertSandboxEnvironmentImageParams
	listErr  error
}

func (f *fakeEnvironmentImageQuerier) UpsertSandboxEnvironmentImage(_ context.Context, arg runtimeports.UpsertSandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error) {
	f.upserted = append(f.upserted, arg)
	if !arg.RepositoryID.Valid {
		for index := range f.rows {
			if !f.rows[index].RepositoryID.Valid && f.rows[index].Kind == arg.Kind && f.rows[index].ClosureHash != arg.ClosureHash && f.rows[index].Status == "ready" {
				f.rows[index].Status = "retired"
			}
		}
	}
	row := runtimeports.SandboxEnvironmentImage{ID: "new", RepositoryID: arg.RepositoryID, Kind: arg.Kind, Source: arg.Source, SourceRevision: arg.SourceRevision, ClosureHash: arg.ClosureHash, Image: arg.Image, Status: "ready"}
	f.rows = append([]runtimeports.SandboxEnvironmentImage{row}, f.rows...)
	return row, nil
}

func (f *fakeEnvironmentImageQuerier) GetLatestReadySandboxEnvironmentImage(_ context.Context, arg runtimeports.GetLatestReadySandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error) {
	for _, row := range f.rows {
		if row.Kind == arg.Kind && row.Status == "ready" && row.RepositoryID.Int64 == arg.RepositoryID.Int64 && row.RepositoryID.Valid == arg.RepositoryID.Valid {
			return row, nil
		}
	}
	return runtimeports.SandboxEnvironmentImage{}, pgx.ErrNoRows
}

func (f *fakeEnvironmentImageQuerier) ListSandboxEnvironmentImages(_ context.Context, repositoryID pgtype.Int8) ([]runtimeports.SandboxEnvironmentImage, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []runtimeports.SandboxEnvironmentImage
	for _, row := range f.rows {
		if row.RepositoryID == repositoryID {
			out = append(out, row)
		}
	}
	return out, nil
}

func (f *fakeEnvironmentImageQuerier) RetireSandboxEnvironmentImage(_ context.Context, arg runtimeports.RetireSandboxEnvironmentImageParams) (runtimeports.SandboxEnvironmentImage, error) {
	for i := range f.rows {
		if f.rows[i].ID == arg.ID && f.rows[i].RepositoryID == arg.RepositoryID {
			f.rows[i].Status = "retired"
			return f.rows[i], nil
		}
	}
	return runtimeports.SandboxEnvironmentImage{}, pgx.ErrNoRows
}

func TestSandboxEnvironmentImageResolveFallsBackToBase(t *testing.T) {
	q := &fakeEnvironmentImageQuerier{rows: []runtimeports.SandboxEnvironmentImage{
		{ID: "base-vm", Kind: "vm", ClosureHash: "b", Image: "reg/nixos-guest:base-b", Status: "ready"},
		{ID: "repo-vm", RepositoryID: pgtype.Int8{Int64: 7, Valid: true}, Kind: "vm", ClosureHash: "r", Image: "reg/nixos-guest:o--r-r", Status: "ready"},
	}}
	svc := NewSandboxEnvironmentImageService(q)

	row, err := svc.Resolve(context.Background(), 7, "vm")
	require.NoError(t, err)
	assert.Equal(t, "repo-vm", row.ID, "repository image wins")

	row, err = svc.Resolve(context.Background(), 8, "vm")
	require.NoError(t, err)
	assert.Equal(t, "base-vm", row.ID, "repositories without an image boot the base")

	_, err = svc.Resolve(context.Background(), 8, "desktop")
	assertAPIStatus(t, err, 400)
	_, err = svc.Resolve(context.Background(), 8, "container")
	assertAPIStatus(t, err, 400)
}

// Pinned answers exactly the placed image, the repository's or the platform
// base's, and never another one when that image is gone.
func TestSandboxEnvironmentImagePinned(t *testing.T) {
	ctx := context.Background()
	repo := pgtype.Int8{Int64: 7, Valid: true}
	q := &fakeEnvironmentImageQuerier{rows: []runtimeports.SandboxEnvironmentImage{
		{ID: "base-vm", Kind: "vm", ClosureHash: "b", Status: "ready"},
		{ID: "repo-new", RepositoryID: repo, Kind: "vm", ClosureHash: "n", Status: "ready"},
		{ID: "repo-old", RepositoryID: repo, Kind: "vm", ClosureHash: "o", Status: "ready"},
		{ID: "repo-retired", RepositoryID: repo, Kind: "vm", ClosureHash: "r", Status: "retired"},
		{ID: "repo-desktop", RepositoryID: repo, Kind: "desktop", ClosureHash: "d", Status: "ready"},
	}}
	svc := NewSandboxEnvironmentImageService(q)
	for closure, want := range map[string]string{"o": "repo-old", "n": "repo-new", "b": "base-vm"} {
		row, err := svc.Pinned(ctx, 7, "vm", closure)
		require.NoError(t, err)
		assert.Equal(t, want, row.ID, "closure %s", closure)
	}
	row, err := svc.Pinned(ctx, 0, "vm", "b")
	require.NoError(t, err)
	assert.Equal(t, "base-vm", row.ID, "a repository-less workspace pins the base")
	for name, pin := range map[string][2]string{
		"retired":                  {"vm", "r"},
		"unregistered":             {"vm", "x"},
		"another kind":             {"vm", "d"},
		"the base of another kind": {"desktop", "b"},
		"container":                {"agent", "o"},
	} {
		_, err := svc.Pinned(ctx, 7, pin[0], pin[1])
		assertAPIStatus(t, err, 409)
		var api *pkgerrors.APIError
		require.ErrorAs(t, err, &api, name)
		assert.Equal(t, pkgerrors.CodeEnvironmentImageUnavailable, api.Code, name)
	}
	q.listErr = errors.New("down")
	_, err = svc.Pinned(ctx, 7, "vm", "o")
	assertAPIStatus(t, err, 500)
	_, err = (*SandboxEnvironmentImageService)(nil).Pinned(ctx, 7, "vm", "o")
	assertAPIStatus(t, err, 500)
}

func TestSandboxEnvironmentImageRegisterValidatesInput(t *testing.T) {
	q := &fakeEnvironmentImageQuerier{}
	svc := NewSandboxEnvironmentImageService(q)
	valid := RegisterSandboxEnvironmentImageInput{
		RepositoryID: 7,
		Kind:         "vm",
		ClosureHash:  "0123456789abcdefghijklmnopqrstuv",
		Image:        "us-central1-docker.pkg.dev/p/smithers/nixos-guest:o--r-0123456789abcdefghijklmnopqrstuv",
		CreatedBy:    3,
	}
	resp, err := svc.Register(context.Background(), valid)
	require.NoError(t, err)
	assert.Equal(t, int64(7), resp.RepositoryID)
	assert.Equal(t, "vm", resp.Kind)
	assert.Equal(t, defaultWorkspaceEnvironmentSource, q.upserted[0].Source, "source defaults to the contract path")
	assert.Equal(t, int64(3), q.upserted[0].CreatedBy.Int64)

	bad := valid
	bad.Kind = "container"
	_, err = svc.Register(context.Background(), bad)
	assertAPIStatus(t, err, 400)

	bad = valid
	bad.ClosureHash = "short"
	_, err = svc.Register(context.Background(), bad)
	assertAPIStatus(t, err, 400)

	bad = valid
	bad.Image = "reg/nixos-guest:unrelated"
	_, err = svc.Register(context.Background(), bad)
	assertAPIStatus(t, err, 400)

	bad = valid
	bad.Image = "reg/nixos guest:x"
	_, err = svc.Register(context.Background(), bad)
	assertAPIStatus(t, err, 400)

	bad = valid
	bad.Source = "flake.nix"
	_, err = svc.Register(context.Background(), bad)
	assertAPIStatus(t, err, 400)

	base := valid
	base.RepositoryID = 0
	resp, err = svc.Register(context.Background(), base)
	require.NoError(t, err)
	assert.Equal(t, int64(0), resp.RepositoryID)
	assert.False(t, q.upserted[1].RepositoryID.Valid, "base images carry a NULL repository")

	items, err := svc.List(context.Background(), 0)
	require.NoError(t, err)
	require.Len(t, items, 1)
	retired, err := svc.Retire(context.Background(), 0, items[0].ID)
	require.NoError(t, err)
	assert.Equal(t, "retired", retired.Status)
	_, err = svc.Retire(context.Background(), 0, "missing")
	assertAPIStatus(t, err, 404)
}

func TestSandboxEnvironmentImageRegisterBaseRetiresPriorKindOnly(t *testing.T) {
	q := &fakeEnvironmentImageQuerier{rows: []runtimeports.SandboxEnvironmentImage{
		{ID: "old-vm", Kind: "vm", ClosureHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Image: "reg/base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Status: "ready"},
		{ID: "desktop", Kind: "desktop", ClosureHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Image: "reg/base:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Status: "ready"},
		{ID: "repo-vm", RepositoryID: pgtype.Int8{Int64: 7, Valid: true}, Kind: "vm", ClosureHash: "cccccccccccccccccccccccccccccccc", Image: "reg/repo:cccccccccccccccccccccccccccccccc", Status: "ready"},
	}}
	svc := NewSandboxEnvironmentImageService(q)
	_, err := svc.Register(context.Background(), RegisterSandboxEnvironmentImageInput{
		Kind: "vm", ClosureHash: "dddddddddddddddddddddddddddddddd",
		Image: "reg/base:dddddddddddddddddddddddddddddddd", CreatedBy: 3,
	})
	require.NoError(t, err)

	assert.Equal(t, "retired", q.rows[1].Status, "the prior vm base is retired")
	assert.Equal(t, "ready", q.rows[2].Status, "another base kind remains ready")
	assert.Equal(t, "ready", q.rows[3].Status, "repository images are never implicitly retired")
}

func TestDevelopmentWorkspaceHasDependencyAndCheckDiskSpace(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{image: nixTestImage("vm")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))
	req, err := svc.buildWorkspaceVMRequest(context.Background(), "closure", nil, 7, "", "vm")
	require.NoError(t, err)
	require.NotNil(t, req.RootfsSizeMB)
	assert.EqualValues(t, 32*1024, *req.RootfsSizeMB)
}

// A repository without its own registered closure still gets CI: its job
// guests boot the platform base closure through the same workspace request.
func TestCIGuestVMRequestBootsBaseClosureForRepositoryWithoutImage(t *testing.T) {
	images := NewSandboxEnvironmentImageService(&fakeEnvironmentImageQuerier{rows: []runtimeports.SandboxEnvironmentImage{
		{ID: "base-vm", Kind: "vm", ClosureHash: "b", Image: "reg/nixos-guest:base-b", Status: "ready"},
	}})
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(images))
	checkout := []sandbox.GitRepositorySpec{{Repo: "https://git.example.test/acme/app.git", Path: nixCITaskWorkdir, Rev: "cafebabe"}}

	req, err := svc.CIGuestVMRequest(context.Background(), 8, checkout)
	require.NoError(t, err)
	assert.Equal(t, "vm", req.Kind)
	assert.Equal(t, "reg/nixos-guest:base-b", req.Image)
	assert.Nil(t, req.Packages, "the toolchain comes from the closure, never apt")
	assert.Equal(t, checkout, req.GitRepos)
}

// With no image registered at all the guest cannot boot; provisioning fails
// the job visibly instead of leaving the run queued.
func TestCIGuestVMRequestWithoutAnyImageIsUnavailable(t *testing.T) {
	images := NewSandboxEnvironmentImageService(&fakeEnvironmentImageQuerier{})
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(images))

	_, err := svc.CIGuestVMRequest(context.Background(), 8, nil)
	assertAPIStatus(t, err, 409)
}
