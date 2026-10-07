package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
	"testing"
)

// Former Pair callers cannot resume, snapshot, copy or cold-create a source
// without the same revision writer and machine admission as the install door.
func TestHostedForkLegacyProvidersRefuseBeforeSourceOperations(t *testing.T) {
	for _, state := range []string{"running", "suspended", "stopped"} {
		for _, empty := range []bool{false, true} {
			t.Run(state+map[bool]string{true: "-empty", false: "-provisioned"}[empty], func(t *testing.T) {
				source := forkQuotaSource()
				source.Status = state
				if empty {
					source.VmID = ""
				}
				q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
					t.Fatal("read source before admission")
					return source, nil
				}, createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					t.Fatal("created workspace")
					return db.Workspace{}, nil
				}}
				runtime := &forkQuotaRuntime{}
				unavailable := func(t *testing.T, svc *WorkspaceService) {
					_, err := svc.ForkWorkspace(context.Background(), forkQuotaInput())
					requireBranchMachineUnavailable(t, err)
				}
				t.Run("runtime", func(t *testing.T) {
					unavailable(t, newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime)))
					require.Zero(t, runtime.starts+runtime.creates+runtime.snapshots+runtime.forks)
				})
				t.Run("sandbox", func(t *testing.T) {
					client := &mockWorkspaceSandboxVMClient{
						getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
							t.Fatal("inspected source")
							return sandbox.Sandbox{}, nil
						},
						startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
							t.Fatal("resumed source")
							return sandbox.StartResult{}, nil
						},
						forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
							t.Fatal("copied source")
							return sandbox.CreateResult{}, nil
						},
						createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
							t.Fatal("created machine")
							return sandbox.CreateResult{}, nil
						},
						snapshotVMFn: func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
							t.Fatal("snapshotted source")
							return sandbox.SnapshotResult{}, nil
						},
					}
					unavailable(t, newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client)))
				})
			})
		}
	}
}

// Even fully qualified machine providers cannot reopen the old sandbox path
// when the stack revision writer is absent.
func TestHostedForkMissingRevisionWriterNeverCopiesMachine(t *testing.T) {
	pool := newProductTestPool(t)
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			t.Fatal("missing writer must refuse before reading source")
			return db.Workspace{}, nil
		},
	}
	runtime := &forkQuotaRuntime{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()), WithWorkspaceRuntime(runtime), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.ForkWorkspace(t.Context(), forkQuotaInput())
	require.ErrorContains(t, err, "revision-based fork unavailable")
	require.Zero(t, runtime.starts+runtime.creates+runtime.snapshots+runtime.forks)
}
