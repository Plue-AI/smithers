package services

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceService_ListWorkspaceFiles(t *testing.T) {
	t.Parallel()
	zero := int32(0)
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, vmID string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		assert.Equal(t, "vm-source-1", vmID)
		assert.Contains(t, request.Command, "/workspace/src")
		return sandbox.ExecResult{StatusCode: &zero, Stdout: strings.Join([]string{
			"main.go", "f", "42",
			"pkg", "d", "4096",
			"latest", "l", "8",
		}, "\x00") + "\x00"}, nil
	}}

	entries, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
		ListWorkspaceFiles(context.Background(), "ws-1", 101, 1, "src")
	require.NoError(t, err)
	require.Len(t, entries, 3)
	assert.Equal(t, WorkspaceFileEntry{Name: "pkg", Path: "src/pkg", Type: "dir", Size: 0}, entries[0])
	assert.Equal(t, WorkspaceFileEntry{Name: "latest", Path: "src/latest", Type: "symlink", Size: 8}, entries[1])
	assert.Equal(t, WorkspaceFileEntry{Name: "main.go", Path: "src/main.go", Type: "file", Size: 42}, entries[2])
}

func TestWorkspaceService_ReadWorkspaceFile(t *testing.T) {
	t.Parallel()
	zero := int32(0)
	content := []byte("hello\n")
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		assert.Contains(t, request.Command, "realpath -e")
		return sandbox.ExecResult{
			StatusCode: &zero,
			Stdout:     "6\x00" + base64.StdEncoding.EncodeToString(content),
		}, nil
	}}

	result, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
		ReadWorkspaceFile(context.Background(), "ws-1", 101, 1, "README.md")
	require.NoError(t, err)
	assert.Equal(t, WorkspaceFileContent{Name: "README.md", Path: "README.md", Type: "file", Encoding: "utf-8", Content: "hello\n", Size: 6}, result)
}

func TestWorkspaceService_ReadWorkspaceFile_MapsGuestErrors(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name       string
		code       int32
		wantStatus int
	}{
		{name: "missing", code: workspaceExecNotFound, wantStatus: http.StatusNotFound},
		{name: "escape", code: workspaceExecOutsideRoot, wantStatus: http.StatusBadRequest},
		{name: "directory", code: workspaceExecWrongFileType, wantStatus: http.StatusBadRequest},
		{name: "large", code: workspaceExecFileTooLarge, wantStatus: http.StatusRequestEntityTooLarge},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{StatusCode: &test.code}, nil
			}}
			_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
				ReadWorkspaceFile(context.Background(), "ws-1", 101, 1, "README.md")
			assertAPIErrorStatus(t, err, test.wantStatus)
		})
	}
}

func TestWorkspaceService_WriteWorkspaceFile(t *testing.T) {
	t.Parallel()
	zero := int32(0)
	var writtenPath, writtenContent string
	vm := &mockWorkspaceSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Contains(t, request.Command, "realpath -m")
			return sandbox.ExecResult{StatusCode: &zero}, nil
		},
		writeFileFn: func(_ context.Context, vmID, filePath string, request sandbox.WriteFileRequest) error {
			assert.Equal(t, "vm-source-1", vmID)
			writtenPath, writtenContent = filePath, request.Content
			return nil
		},
	}

	result, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
		WriteWorkspaceFile(context.Background(), "ws-1", 101, 1, "src/app.go", "package main\n")
	require.NoError(t, err)
	assert.Equal(t, "/workspace/src/app.go", writtenPath)
	assert.Equal(t, "package main\n", writtenContent)
	assert.Equal(t, "src/app.go", result.Path)
	assert.Equal(t, int64(13), result.Size)
}

func TestWorkspaceService_WriteWorkspaceFile_ValidatesBeforeProvider(t *testing.T) {
	t.Parallel()
	called := false
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		called = true
		return sandbox.ExecResult{}, nil
	}}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))

	_, err := svc.WriteWorkspaceFile(context.Background(), "ws-1", 101, 1, "../secret", "x")
	assertAPIErrorStatus(t, err, http.StatusBadRequest)
	_, err = svc.WriteWorkspaceFile(context.Background(), "ws-1", 101, 1, "large", strings.Repeat("x", MaxWorkspaceFileBytes+1))
	assertAPIErrorStatus(t, err, http.StatusRequestEntityTooLarge)
	assert.False(t, called)
}

func TestWorkspaceService_FilesHonorReadAndWriteShares(t *testing.T) {
	t.Parallel()
	zero := int32(0)
	q := &mockWorkspaceQuerier{getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
		assert.Equal(t, int64(2), arg.GranteeUserID)
		return db.WorkspaceShare{Level: string(WorkspaceAccessRead)}, nil
	}}
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &zero, Stdout: ""}, nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))

	_, err := svc.ListWorkspaceFiles(context.Background(), "ws-1", 101, 2, "")
	require.NoError(t, err)
	_, err = svc.WriteWorkspaceFile(context.Background(), "ws-1", 101, 2, "README.md", "x")
	assertAPIErrorStatus(t, err, http.StatusForbidden)
}

func TestWorkspaceService_ListAndManageWorkspaceServices(t *testing.T) {
	t.Parallel()
	zero := int32(0)
	call := 0
	var published []sandbox.PublishIngressRequest
	vm := &mockWorkspaceSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
			call++
			if call == 1 {
				assert.Contains(t, request.Command, workspaceServiceUnitDir)
				assert.Contains(t, request.Command, "ControlGroup")
				assert.Contains(t, request.Command, "ss -H -ltnp")
				return sandbox.ExecResult{StatusCode: &zero, Stdout: strings.Join([]string{
					"web.service", "loaded", "active", "running", "3000",
					"db.service", "loaded", "failed", "failed", "",
				}, "\x00") + "\x00"}, nil
			}
			assert.Contains(t, request.Command, "systemctl restart")
			assert.Contains(t, request.Command, "web.service")
			return sandbox.ExecResult{StatusCode: &zero, Stdout: strings.Join([]string{
				"web.service", "loaded", "active", "running", "3000",
			}, "\x00") + "\x00"}, nil
		},
		publishIngressFn: func(_ context.Context, domain string, request sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
			assert.Equal(t, "3000-ws-1.preview.jjhub.tech", domain)
			published = append(published, request)
			return sandbox.IngressRoute{Hostname: domain}, nil
		},
	}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))

	managed, err := svc.ListWorkspaceServices(context.Background(), "ws-1", 101, 1)
	require.NoError(t, err)
	assert.Equal(t, []WorkspaceManagedService{
		{Name: "db", State: "failed"},
		{Name: "web", State: "running", Port: 3000, URL: "https://3000-ws-1.preview.jjhub.tech"},
	}, managed)

	service, err := svc.ManageWorkspaceService(context.Background(), "ws-1", 101, 1, "web", "restart")
	require.NoError(t, err)
	assert.Equal(t, WorkspaceManagedService{Name: "web", State: "running", Port: 3000, URL: "https://3000-ws-1.preview.jjhub.tech"}, service)
	assert.Equal(t, []sandbox.PublishIngressRequest{
		{SandboxID: "vm-source-1", Port: 3000},
		{SandboxID: "vm-source-1", Port: 3000},
	}, published)
}

func TestWorkspaceService_ManageWorkspaceService_ValidationAndMissing(t *testing.T) {
	t.Parallel()
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	_, err := svc.ManageWorkspaceService(context.Background(), "ws-1", 101, 1, "web", "delete")
	assertAPIErrorStatus(t, err, http.StatusBadRequest)
	_, err = svc.ManageWorkspaceService(context.Background(), "ws-1", 101, 1, "../ssh", "start")
	assertAPIErrorStatus(t, err, http.StatusBadRequest)
	_, err = svc.ManageWorkspaceService(context.Background(), "ws-1", 101, 1, "smithers-workspace-ready", "stop")
	assertAPIErrorStatus(t, err, http.StatusNotFound)

	missing := workspaceExecNotFound
	vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{StatusCode: &missing}, nil
	}}
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm)).
		ManageWorkspaceService(context.Background(), "ws-1", 101, 1, "web", "stop")
	assertAPIErrorStatus(t, err, http.StatusNotFound)
}
