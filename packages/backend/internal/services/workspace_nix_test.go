package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

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
	assert.NotContains(t, script.Content, workspaceDesktopStartCommand, "vm kind has no desktop service")
	_, hasPassword := req.Files[workspaceDesktopPasswordPath]
	assert.False(t, hasPassword)
	require.NotNil(t, req.Init)
	var ready *sandbox.ServiceSpec
	for _, service := range req.Init.Services {
		assert.NotEqual(t, workspaceDesktopService, service.Name)
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

func TestBuildWorkspaceVMRequestDesktopKindAddsDesktopBoot(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{image: nixTestImage("desktop")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))

	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "desktop")
	require.NoError(t, err)
	assert.Equal(t, "desktop", req.Kind)
	password := req.Files[workspaceDesktopPasswordPath]
	assert.Len(t, strings.TrimSpace(password.Content), workspaceDesktopVNCPasswordLen, "first VNC password is delivered to tmpfs")
	assert.False(t, password.Executable)
	require.NotNil(t, req.Init)
	var desktop *sandbox.ServiceSpec
	for i := range req.Init.Services {
		if req.Init.Services[i].Name == workspaceDesktopService {
			desktop = &req.Init.Services[i]
		}
	}
	require.NotNil(t, desktop, "desktop init service is declared")
	assert.Equal(t, []string{workspaceDesktopStartCommand}, desktop.Exec)
	assert.Equal(t, "root", desktop.User)
	assert.Equal(t, sandbox.ServiceModeOneshot, desktop.Mode)
	require.NotNil(t, desktop.ReadySignal)
	assert.True(t, *desktop.ReadySignal, "desktop start completion gates sandbox readiness")
	for _, service := range req.Init.Services {
		if service.Name == workspaceReadyService {
			assert.Nil(t, service.ReadySignal, "generic VM readiness must not mark a desktop ready early")
		}
	}
}

func TestBuildWorkspaceVMRequestDesktopKindIsSized(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{image: nixTestImage("desktop")}
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(resolver))

	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "desktop")
	require.NoError(t, err)
	require.NotNil(t, req.MemSizeMB, "a desktop must not fall back to the worker's 512 MiB default: XFCE alone leaves ~180 MB free and one browser tab exhausts it")
	assert.Equal(t, int32(defaultWorkspaceDesktopMemoryMB), *req.MemSizeMB)
	require.NotNil(t, req.VCPUCount)
	assert.Equal(t, int32(defaultWorkspaceDesktopVCPUCount), *req.VCPUCount)
	assert.Nil(t, req.RootfsSizeMB, "disk keeps the provider default")
}

func TestWorkspaceDesktopResourcesOptionOverridesAndRejectsNonPositive(t *testing.T) {
	resolver := &stubEnvironmentImageResolver{image: nixTestImage("desktop")}
	sized := NewWorkspaceService(&mockWorkspaceQuerier{},
		WithWorkspaceEnvironmentImages(resolver),
		WithWorkspaceDesktopResources(4096, 2),
	)
	req, err := sized.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "desktop")
	require.NoError(t, err)
	require.NotNil(t, req.MemSizeMB)
	assert.Equal(t, int32(4096), *req.MemSizeMB)
	require.NotNil(t, req.VCPUCount)
	assert.Equal(t, int32(2), *req.VCPUCount)

	// An unset or nonsense deployment value must not boot a 0 MiB guest.
	fallback := NewWorkspaceService(&mockWorkspaceQuerier{},
		WithWorkspaceEnvironmentImages(resolver),
		WithWorkspaceDesktopResources(0, -1),
	)
	req, err = fallback.buildWorkspaceVMRequest(context.Background(), "", nil, 7, "", "desktop")
	require.NoError(t, err)
	require.NotNil(t, req.MemSizeMB)
	assert.Equal(t, int32(defaultWorkspaceDesktopMemoryMB), *req.MemSizeMB)
	require.NotNil(t, req.VCPUCount)
	assert.Equal(t, int32(defaultWorkspaceDesktopVCPUCount), *req.VCPUCount)
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
		for _, kind := range []string{"container", "vm", "desktop", "agent"} {
			for _, snapshotID := range []string{"", "snapshot-ready"} {
				t.Run(resources.name+"/"+kind+"/"+snapshotID, func(t *testing.T) {
					resolver := &stubEnvironmentImageResolver{image: nixTestImage(kind)}
					options := append([]WorkspaceServiceOption{
						WithWorkspaceEnvironmentImages(resolver),
						WithWorkspaceDesktopResources(6144, 3),
						WithWorkspaceAgentResources(12288, 6),
					}, resources.options...)
					svc := NewWorkspaceService(&mockWorkspaceQuerier{}, options...)
					req, err := svc.buildWorkspaceVMRequest(context.Background(), snapshotID, nil, 7, "", kind)
					require.NoError(t, err)
					memoryMB, vcpuCount := resources.memoryMB, resources.vcpuCount
					switch kind {
					case "desktop":
						memoryMB, vcpuCount = 6144, 3
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
	image := nixTestImage("desktop")
	req := svc.NixBakeVMRequest(image)
	assert.Equal(t, image.Image, req.Image)
	assert.Equal(t, "desktop", req.Kind)
	assert.Empty(t, req.SnapshotID)
	assert.Nil(t, req.Packages)
	assert.Empty(t, resolver.calls)
	require.NotNil(t, req.EgressProxy)
	assert.Empty(t, req.EgressProxy.Secrets, "the baked disk never carries repository secrets")
}

func TestGoldenSnapshotKeyForImage(t *testing.T) {
	assert.Equal(t, "nix:vm:abc", goldenSnapshotKeyForImage("vm", " abc "))
	assert.Equal(t, "nix:desktop:abc", goldenSnapshotKeyForImage("desktop", "abc"))
	assert.Equal(t, "nix:container:abc", goldenSnapshotKeyForImage("weird", "abc"))
}

func TestWorkspaceResponseDesktopBlock(t *testing.T) {
	svc := NewWorkspaceService(nil)
	workspace := sampleDBWorkspace("ws-desk")
	workspace.Kind = "desktop"
	workspace.EnvironmentImage = "registry/nixos-guest:base-hash"
	workspace.EnvironmentClosureHash = "hash"

	resp := svc.toWorkspaceResponse(workspace)
	require.NotNil(t, resp.Desktop)
	assert.True(t, resp.Desktop.Ready)
	assert.Equal(t, "/api/workspaces/ws-desk/desktop/", resp.Desktop.StreamURL)
	assert.Nil(t, resp.Desktop.Session, "no session before the first mint")
	assert.Equal(t, "registry/nixos-guest:base-hash", resp.Environment.Image)

	expires := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	workspace.DesktopSessionID = "dsk_1"
	workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: expires, Valid: true}
	resp = svc.toWorkspaceResponse(workspace)
	require.NotNil(t, resp.Desktop.Session)
	assert.Equal(t, "dsk_1", resp.Desktop.Session.ID)
	assert.Equal(t, expires, resp.Desktop.Session.ExpiresAt)

	workspace.Kind = "vm"
	resp = svc.toWorkspaceResponse(workspace)
	assert.Nil(t, resp.Desktop, "desktop block only for kind=desktop")

	workspace.Kind = "desktop"
	workspace.Status = "starting"
	resp = svc.toWorkspaceResponse(workspace)
	require.NotNil(t, resp.Desktop)
	assert.False(t, resp.Desktop.Ready, "desktop readiness follows the gated running transition")
}

func TestWorkspaceDesktopViewerPathEmbedsRelayAndCredentials(t *testing.T) {
	path := workspaceDesktopViewerPath("ws-1", "tok_abc", "pw12345")
	assert.True(t, strings.HasPrefix(path, "/api/workspaces/ws-1/desktop/tok_abc/vnc.html?"), path)
	assert.Contains(t, path, "autoconnect=1")
	assert.Contains(t, path, "resize=remote")
	assert.Contains(t, path, "path=api%2Fworkspaces%2Fws-1%2Fdesktop%2Ftok_abc%2Fwebsockify")
	assert.Contains(t, path, "password=pw12345")
	assert.Equal(t, "smithers-desk-vm-abc-1.preview.jjhub.tech", workspaceDesktopDomain("VM_abc_1"))
}

func TestAuthorizeDesktopRelay(t *testing.T) {
	token, hash := generateDesktopSessionToken()
	workspace := sampleDBWorkspace("ws-desk")
	workspace.Kind = "desktop"
	workspace.DesktopSessionID = "dsk_1"
	workspace.DesktopSessionTokenHash = hash
	workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
	touched := 0
	q := &mockWorkspaceQuerier{
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			if id != workspace.ID {
				return db.Workspace{}, pgx.ErrNoRows
			}
			return workspace, nil
		},
		touchWorkspaceActivityFn: func(context.Context, string) error { touched++; return nil },
	}
	svc := NewWorkspaceService(q)

	target, err := svc.AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
	require.NoError(t, err)
	assert.Equal(t, workspaceDesktopDomain(workspace.VmID), target.Domain)
	assert.Equal(t, workspace.UserID, target.UserID)
	assert.Equal(t, workspace.RepositoryID, target.RepositoryID)
	assert.Equal(t, 1, touched)

	_, err = svc.AuthorizeDesktopRelay(context.Background(), workspace.ID, "smithers_desk_wrong")
	assertAPIStatus(t, err, 401)
	_, err = svc.AuthorizeDesktopRelay(context.Background(), "missing", token)
	assertAPIStatus(t, err, 401)
	_, err = svc.AuthorizeDesktopRelay(context.Background(), workspace.ID, "")
	assertAPIStatus(t, err, 401)

	workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}
	_, err = svc.AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
	assertAPIStatus(t, err, 401)

	workspace.DesktopSessionExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
	workspace.Status = "suspended"
	_, err = svc.AuthorizeDesktopRelay(context.Background(), workspace.ID, token)
	assertAPIStatus(t, err, 409)
}

type desktopSessionQuerier struct {
	*mockWorkspaceQuerier
	set db.SetWorkspaceDesktopSessionParams
}

func (q *desktopSessionQuerier) SetWorkspaceDesktopSession(_ context.Context, arg db.SetWorkspaceDesktopSessionParams) error {
	q.set = arg
	return nil
}

type desktopSandbox struct {
	mockWorkspaceSandboxVMClient
	published []sandbox.PublishIngressRequest
	domains   []string
}

func (s *desktopSandbox) PublishIngress(_ context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
	s.domains = append(s.domains, domain)
	s.published = append(s.published, req)
	return sandbox.IngressRoute{ID: domain, Hostname: domain, SandboxID: req.SandboxID, Port: req.Port}, nil
}

func TestCreateDesktopSessionRotatesPasswordAndPublishesPort(t *testing.T) {
	workspace := sampleDBWorkspace("ws-desk")
	workspace.Kind = "desktop"
	var written struct {
		path    string
		content string
	}
	var executed []string
	sb := &desktopSandbox{}
	sb.writeFileFn = func(_ context.Context, vmID, path string, req sandbox.WriteFileRequest) error {
		assert.Equal(t, workspace.VmID, vmID)
		written.path, written.content = path, req.Content
		return nil
	}
	sb.execAwaitFn = func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		executed = append(executed, req.Command)
		status := int32(0)
		return sandbox.ExecResult{StatusCode: &status}, nil
	}
	q := &desktopSessionQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return workspace, nil
		},
	}}
	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(sb))

	resp, err := svc.CreateDesktopSession(context.Background(), workspace.ID, workspace.RepositoryID, workspace.UserID)
	require.NoError(t, err)
	assert.Equal(t, workspaceDesktopPasswordPath, written.path)
	assert.Equal(t, resp.Password+"\n", written.content, "the guest receives exactly the returned password")
	assert.Equal(t, []string{desktopHelperCommand(workspaceDesktopPasswdHelper, "")}, executed)
	require.Len(t, sb.published, 1)
	assert.Equal(t, workspaceDesktopPort, sb.published[0].Port)
	assert.Equal(t, workspace.VmID, sb.published[0].SandboxID)
	assert.Equal(t, workspaceDesktopDomain(workspace.VmID), sb.domains[0])
	assert.Equal(t, resp.Session.ID, q.set.DesktopSessionID)
	assert.NotEqual(t, resp.Token, q.set.DesktopSessionTokenHash, "only the token hash is stored")
	assert.True(t, strings.HasPrefix(resp.Token, "smithers_desk_"))
	assert.Contains(t, resp.StreamURL, "/api/workspaces/ws-desk/desktop/"+resp.Token+"/vnc.html?")
	assert.WithinDuration(t, time.Now().Add(workspaceDesktopSessionTTL), resp.Session.ExpiresAt, time.Minute)

	// Token round-trips through the relay authorizer.
	workspace.DesktopSessionTokenHash = q.set.DesktopSessionTokenHash
	workspace.DesktopSessionExpiresAt = q.set.DesktopSessionExpiresAt
	q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return workspace, nil }
	target, err := svc.AuthorizeDesktopRelay(context.Background(), workspace.ID, resp.Token)
	require.NoError(t, err)
	assert.Equal(t, workspaceDesktopDomain(workspace.VmID), target.Domain)
}

func TestCreateDesktopSessionRetriesWhileNixOSActivationLinksHelper(t *testing.T) {
	workspace := sampleDBWorkspace("ws-desk")
	workspace.Kind = "desktop"
	execCalls := 0
	sb := &desktopSandbox{}
	sb.execAwaitFn = func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		execCalls++
		assert.Contains(t, req.Command, "/usr/local/bin/smithers-desktop-passwd")
		status := int32(0)
		if execCalls == 1 {
			// Exit 69: the guest answers exec but systemd has not finished
			// activating, so the helper is not linked YET. Retryable.
			status = desktopExitNotActivated
			return sandbox.ExecResult{StatusCode: &status}, nil
		}
		return sandbox.ExecResult{StatusCode: &status}, nil
	}
	q := &desktopSessionQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return workspace, nil
		},
	}}
	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(sb))

	_, err := svc.CreateDesktopSession(context.Background(), workspace.ID, workspace.RepositoryID, workspace.UserID)
	require.NoError(t, err)
	assert.Equal(t, 2, execCalls)
}

func TestRotateWorkspaceDesktopPasswordTimesOutAsRetryableNotReady(t *testing.T) {
	status := int32(desktopExitNotActivated)
	sb := &desktopSandbox{}
	sb.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &status}, nil
	}

	err := rotateWorkspaceDesktopPasswordWithWait(context.Background(), sb, "vm-starting", 10*time.Millisecond, time.Millisecond)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 503, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeDesktopNotReady, apiErr.Code)
	assert.Equal(t, "desktop is still starting; retry shortly", apiErr.Message)
	assert.Equal(t, 2, apiErr.RetryAfter)
}

// TestRotateWorkspaceDesktopPasswordReportsAnImageWithoutHelpers pins the
// mint's alignment with observe and input: once activation has FINISHED and
// the helper is still missing, the box booted an image that predates it. That
// is terminal, so it answers the same 409 the control routes do instead of
// burning the whole activation window on a 503 that promises a retry will
// work.
func TestRotateWorkspaceDesktopPasswordReportsAnImageWithoutHelpers(t *testing.T) {
	status := int32(127)
	calls := 0
	sb := &desktopSandbox{}
	sb.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		calls++
		return sandbox.ExecResult{StatusCode: &status}, nil
	}

	err := rotateWorkspaceDesktopPasswordWithWait(context.Background(), sb, "vm-old-image", time.Minute, time.Millisecond)
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeDesktopToolsUnavailable, apiErr.Code)
	assert.Equal(t, "this box's image has no desktop tools; open a new box to get them", apiErr.Message)
	assert.Equal(t, 1, calls, "a terminal verdict is not retried")
}

func TestCreateDesktopSessionRejectsWrongKindAndState(t *testing.T) {
	workspace := sampleDBWorkspace("ws-1")
	q := &desktopSessionQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return workspace, nil },
	}}
	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(&desktopSandbox{}))
	_, err := svc.CreateDesktopSession(context.Background(), workspace.ID, workspace.RepositoryID, workspace.UserID)
	assertAPIStatus(t, err, 400)

	workspace.Kind = "desktop"
	workspace.Status = "suspended"
	_, err = svc.CreateDesktopSession(context.Background(), workspace.ID, workspace.RepositoryID, workspace.UserID)
	assertAPIStatus(t, err, 409)
}

type fakeEnvironmentImageQuerier struct {
	rows     []runtimeports.SandboxEnvironmentImage
	upserted []runtimeports.UpsertSandboxEnvironmentImageParams
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
	assertAPIStatus(t, err, 409)
	_, err = svc.Resolve(context.Background(), 8, "container")
	assertAPIStatus(t, err, 400)
}

func TestSandboxEnvironmentImageRegisterValidatesInput(t *testing.T) {
	q := &fakeEnvironmentImageQuerier{}
	svc := NewSandboxEnvironmentImageService(q)
	valid := RegisterSandboxEnvironmentImageInput{
		RepositoryID: 7,
		Kind:         "desktop",
		ClosureHash:  "0123456789abcdefghijklmnopqrstuv",
		Image:        "us-central1-docker.pkg.dev/p/smithers/nixos-guest:o--r-0123456789abcdefghijklmnopqrstuv",
		CreatedBy:    3,
	}
	resp, err := svc.Register(context.Background(), valid)
	require.NoError(t, err)
	assert.Equal(t, int64(7), resp.RepositoryID)
	assert.Equal(t, "desktop", resp.Kind)
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
