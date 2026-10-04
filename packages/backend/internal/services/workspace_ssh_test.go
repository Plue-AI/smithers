package services

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceService_GetWorkspaceSSHConnectionInfo_MintsScopedIdentityToken(t *testing.T) {
	t.Parallel()
	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-ssh-123"
			return workspace, nil
		},
	}
	var granted, minted string
	client := &mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		grantVMPermissionFn: func(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
			require.Equal(t, "vm-ssh-123", vmID)
			granted = identityID
			return sandbox.AccessGrant{ID: "grant"}, nil
		},
		createIdentityTokenFn: func(ctx context.Context, identityID string) (sandbox.CreatedToken, error) {
			minted = identityID
			return sandbox.CreatedToken{Token: "scoped-token"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))
	info, err := svc.GetWorkspaceSSHConnectionInfo(context.Background(), wsID, 101, 1)
	require.NoError(t, err)
	require.NotEmpty(t, granted)
	require.Equal(t, granted, minted, "token must belong to the identity granted this workspace")
	require.Equal(t, "scoped-token", info.AccessToken)
	require.Equal(t, wsID, info.WorkspaceID)
	require.Contains(t, info.Command, "vm-ssh-123+agent:scoped-token@")
}

func TestWorkspaceService_GetSSHConnectionInfo_PersistsSessionSSHInfo(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	var storedPayload json.RawMessage
	var grantedUsers []string
	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: wsID, RepositoryID: arg.RepositoryID, UserID: 1, Status: "running"}, nil
		},
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-source"
			return workspace, nil
		},
		updateWorkspaceSessionSSHConnectionFn: func(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error) {
			storedPayload = arg.SshConnectionInfo
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: wsID, RepositoryID: 101, UserID: 1, Status: "running", SshConnectionInfo: arg.SshConnectionInfo}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		grantVMPermissionFn: func(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
			grantedUsers = append([]string(nil), req.AllowedUsers...)
			return sandbox.AccessGrant{ID: "perm-test-123"}, nil
		},
	}))

	info, err := svc.GetSSHConnectionInfo(context.Background(), "sess-1", 101, 1)
	require.NoError(t, err)
	assert.Equal(t, "sess-1", info.SessionID)
	require.NotEmpty(t, storedPayload)

	// Ticket 0117: the PERSISTED payload must never contain the minted
	// access_token or the executable command. The safe identifier fields
	// (workspace_id, session_id, host, port, username) must round-trip so
	// clients receiving realtime updates can still reconnect; credentials
	// are re-minted on demand by the HTTP route.
	//
	// Inspect the raw JSON bytes, not a Go struct field access — a
	// future regression that re-adds AccessToken to the type would slip
	// past a struct-field assertion but still show up as a JSON key.
	storedJSON := string(storedPayload)
	assert.NotContains(t, storedJSON, "access_token",
		"persisted ssh_connection_info must not contain access_token key")
	assert.NotContains(t, storedJSON, `"command"`,
		"persisted ssh_connection_info must not contain command key")
	// Even on a malformed serializer, guarantee the raw token string
	// itself never appears in the persisted bytes.
	require.NotEmpty(t, info.AccessToken)
	assert.NotContains(t, storedJSON, info.AccessToken,
		"persisted payload must not contain the raw token value")

	// Safe fields must be present so the client has enough to reconnect.
	var stored PersistedWorkspaceSSHConnectionInfo
	require.NoError(t, json.Unmarshal(storedPayload, &stored))
	assert.Equal(t, info.SessionID, stored.SessionID)
	assert.Equal(t, info.WorkspaceID, stored.WorkspaceID)
	assert.Equal(t, info.VMID, stored.VMID)
	assert.Equal(t, info.Host, stored.Host)
	assert.Equal(t, info.SSHHost, stored.SSHHost)
	assert.Equal(t, info.Username, stored.Username)
	assert.Equal(t, info.Port, stored.Port)
	assert.Equal(t, info.Workdir, stored.Workdir)
	assert.Equal(t, "agent", info.Username)
	assert.Equal(t, "/workspace", info.Workdir)
	assert.Equal(t, []string{"agent"}, grantedUsers)
	assert.Contains(t, info.SSHHost, "+agent@")
	assert.Contains(t, info.Command, "+agent:")
	// HostKeys (0130) must be preserved — public keys, not credentials,
	// and the client needs them to verify host identity on reconnect.
	assert.Equal(t, len(info.HostKeys), len(stored.HostKeys))

	// The HTTP response still carries the minted credentials — existing
	// API consumers must not break.
	assert.NotEmpty(t, info.AccessToken)
	assert.NotEmpty(t, info.Command)
	assert.Contains(t, info.Command, info.AccessToken,
		"returned command should embed the freshly-minted token (in-memory only)")
}

func TestWorkspaceService_GetSSHConnectionInfo_PendingSessionDoesNotProvisionSynchronously(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	workspaceLookups := 0
	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: wsID, RepositoryID: arg.RepositoryID, UserID: 1, Status: "pending"}, nil
		},
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspaceLookups++
			return sampleDBWorkspace(arg.ID), nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Fatal("pending sessions must not create a VM on SSH attach")
			return sandbox.CreateResult{}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			t.Fatal("pending sessions must not start a VM on SSH attach")
			return sandbox.StartResult{}, nil
		},
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			t.Fatal("pending sessions must not touch the VM on SSH attach")
			return sandbox.Sandbox{}, nil
		},
	}))

	_, err := svc.GetSSHConnectionInfo(context.Background(), "sess-pending", 101, 1)
	requireAPIErrorStatus(t, err, http.StatusConflict)
	// One workspace load is expected: session access is authorized against the
	// owning workspace. What must NOT happen is synchronous provisioning.
	assert.Equal(t, 1, workspaceLookups, "pending sessions must only load the workspace for authorization, not provision it on SSH attach")
}

func TestWorkspaceService_GetWorkspaceSSHConnectionInfo_SeparatesPublicAndDialHosts(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-public-dial"
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}),
		WithWorkspaceSSHHost("ssh.jjhub.tech"),
		WithWorkspaceSSHDialHost("smithers-ssh.smithers.svc.cluster.local"),
	)

	info, err := svc.GetWorkspaceSSHConnectionInfo(context.Background(), wsID, 101, 1)
	require.NoError(t, err)
	assert.Equal(t, "ssh.jjhub.tech", info.Host)
	assert.Equal(t, "smithers-ssh.smithers.svc.cluster.local", info.DialHost)
	assert.Equal(t, "vm-public-dial+agent@ssh.jjhub.tech", info.SSHHost)
	assert.Contains(t, info.Command, "@ssh.jjhub.tech")

	bytes, err := json.Marshal(info)
	require.NoError(t, err)
	raw := string(bytes)
	assert.Contains(t, raw, `"host":"ssh.jjhub.tech"`)
	assert.NotContains(t, raw, "smithers-ssh.smithers.svc.cluster.local")
	assert.NotContains(t, raw, "dial_host")
}

// TestWorkspaceService_GetSSHConnectionInfo_ShapePayloadHasNoCredentials
// is the ticket 0117 security regression test from the client's point of
// view. It mimics what the realtime API streams to a subscribing client: the
// replicated row is the `WorkspaceSession` db model, whose
// `ssh_connection_info` field is a json.RawMessage holding exactly the
// bytes we persisted.
//
// The assertion is stricter than the persistence-layer test above: we
// serialize the whole WorkspaceSession row — including the embedded
// ssh_connection_info bytes — and verify no credential material appears
// anywhere in the payload. This protects against a future regression
// where someone adds a secret-bearing field to the WorkspaceSession
// model directly (not just to the JSON blob).
func TestWorkspaceService_GetSSHConnectionInfo_ShapePayloadHasNoCredentials(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	const sessionID = "sess-shape-1"

	var persistedRow db.WorkspaceSession
	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: wsID, RepositoryID: arg.RepositoryID, UserID: 1, Status: "running"}, nil
		},
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-shape-test"
			return workspace, nil
		},
		updateWorkspaceSessionSSHConnectionFn: func(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error) {
			// Capture exactly what the DB row looks like after the write.
			// This is what the realtime API would deliver to clients.
			persistedRow = db.WorkspaceSession{
				ID:                arg.ID,
				WorkspaceID:       wsID,
				RepositoryID:      101,
				UserID:            1,
				Status:            "running",
				Cols:              120,
				Rows:              40,
				SshConnectionInfo: arg.SshConnectionInfo,
			}
			return persistedRow, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
	}))

	info, err := svc.GetSSHConnectionInfo(context.Background(), sessionID, 101, 1)
	require.NoError(t, err)
	require.NotEmpty(t, info.AccessToken, "in-memory info must carry the minted token")

	// Serialize the entire replicated row exactly as a realtime client would —
	// including the embedded ssh_connection_info raw bytes. This is the
	// byte-for-byte shape payload a subscribing client will receive.
	shapeBytes, err := json.Marshal(persistedRow)
	require.NoError(t, err)
	shapeJSON := string(shapeBytes)

	// SECURITY: the shape payload MUST NOT contain:
	//   - the raw access_token value,
	//   - the string "access_token" as a JSON key (defense in depth),
	//   - the executable "command" key (contains the token inline),
	//   - any substring of the token (paranoid sanity).
	assert.NotContains(t, shapeJSON, info.AccessToken,
		"shape payload must not contain the raw access token: %s", shapeJSON)
	assert.NotContains(t, shapeJSON, `"access_token"`,
		"shape payload must not contain an access_token key")
	assert.NotContains(t, shapeJSON, `"command"`,
		"shape payload must not contain a command key")

	// But the safe identifiers the client needs MUST still round-trip.
	assert.Contains(t, shapeJSON, `"workspace_id":"`+wsID+`"`)
	assert.Contains(t, shapeJSON, `"session_id":"`+sessionID+`"`)
	// HostKeys (public — not credentials) must survive to the client.
	assert.Contains(t, shapeJSON, `"host_keys"`)
}

// TestWorkspaceService_GetSSHConnectionInfo_RedactForPersistence_Unit is a
// belt-and-suspenders unit test for the redaction projection. If anyone
// adds a new secret field to WorkspaceSSHConnectionInfo, they MUST also
// think about whether it belongs in PersistedWorkspaceSSHConnectionInfo;
// this test locks the current contract so silent drift fails loudly.
func TestWorkspaceService_GetSSHConnectionInfo_RedactForPersistence_Unit(t *testing.T) {
	t.Parallel()

	in := WorkspaceSSHConnectionInfo{
		WorkspaceID: "ws-1",
		SessionID:   "sess-1",
		VMID:        "vm-1",
		Kind:        "vm",
		Host:        "vm-ssh.smithers.sh",
		SSHHost:     "vm-1+agent@vm-ssh.smithers.sh",
		Username:    "agent",
		Port:        22,
		Workdir:     "/workspace",
		AccessToken: "SECRET_TOKEN_DO_NOT_LEAK",
		Command:     "ssh vm-1+agent:SECRET_TOKEN_DO_NOT_LEAK@vm-ssh.smithers.sh",
		HostKeys: []WorkspaceSSHHostKey{
			{Algorithm: "ssh-ed25519", PublicKey: "AAAA", FingerprintSHA256: "SHA256:abc"},
		},
	}

	safe := in.RedactedForPersistence()
	bytes, err := json.Marshal(safe)
	require.NoError(t, err)
	raw := string(bytes)

	// Secret fields absent in JSON.
	assert.NotContains(t, raw, "access_token")
	assert.NotContains(t, raw, `"command"`)
	assert.NotContains(t, raw, "SECRET_TOKEN_DO_NOT_LEAK")

	// Safe fields present and host_keys preserved.
	assert.Contains(t, raw, `"workspace_id":"ws-1"`)
	assert.Contains(t, raw, `"session_id":"sess-1"`)
	assert.Contains(t, raw, `"kind":"vm"`)
	assert.Contains(t, raw, `"workdir":"/workspace"`)
	assert.Contains(t, raw, `"host_keys"`)
	assert.Contains(t, raw, "SHA256:abc")
}

func TestWorkspaceService_WaitForWorkspaceGuestActivation(t *testing.T) {
	t.Run("container passes without exec", func(t *testing.T) {
		calls := 0
		vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			calls++
			return sandbox.ExecResult{}, nil
		}}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		workspace := sampleDBWorkspace("ws-container")

		require.NoError(t, svc.waitForWorkspaceGuestActivation(context.Background(), workspace))
		assert.Zero(t, calls)
	})

	t.Run("vm checks systemd and login shell", func(t *testing.T) {
		vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-nix", vmID)
			assert.Contains(t, req.Command, "systemctl is-system-running")
			assert.Contains(t, req.Command, "/run/current-system/sw/bin/bash")
			require.NotNil(t, req.TimeoutMS)
			assert.Equal(t, workspaceGuestActivationWait.Milliseconds(), *req.TimeoutMS)
			zero := int32(0)
			return sandbox.ExecResult{StatusCode: &zero}, nil
		}}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		workspace := sampleDBWorkspace("ws-vm")
		workspace.Kind = "vm"
		workspace.VmID = "vm-nix"

		require.NoError(t, svc.waitForWorkspaceGuestActivation(context.Background(), workspace))
	})

	t.Run("activation timeout is retryable", func(t *testing.T) {
		status := int32(75)
		vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return sandbox.ExecResult{StatusCode: &status}, nil
		}}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(vm))
		workspace := sampleDBWorkspace("ws-vm")
		workspace.Kind = "vm"

		err := svc.waitForWorkspaceGuestActivation(context.Background(), workspace)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, http.StatusServiceUnavailable, apiErr.Status)
		assert.Equal(t, pkgerrors.CodeGuestNotReady, apiErr.Code)
		assert.Equal(t, 3, apiErr.RetryAfter)
	})
}
