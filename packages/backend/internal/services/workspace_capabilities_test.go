package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestRepositoryJobsIntegrationMissingPrimaryRecovery(t *testing.T) {
	for _, scenario := range []string{"running", "starting", "suspended", "transport", "stale-vm", "registered-during-probe", "already-bound"} {
		t.Run(scenario, func(t *testing.T) {
			pool, q, jobs, g, config := repositoryJobFixture(t)
			ctx := context.Background()
			status := scenario
			if status != "starting" && status != "suspended" {
				status = "running"
			}
			_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='vm',vm_id='missing-primary',status=$2 WHERE id=$1`, config.WorkspaceID, status)
			require.NoError(t, err)
			provider := &mockWorkspaceSandboxVMClient{getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				if scenario == "transport" {
					return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 503, Message: "temporary"}
				}
				return sandbox.Sandbox{}, sandbox.ErrNotFound
			}}

			billing := NewBillingService(q, nil, BillingServiceConfig{})
			s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceBillingPolicy(billing), WithWorkspaceSandboxClient(provider))
			probes := 0
			s.capabilityProbe = func(ctx context.Context, w db.Workspace, _ string) (bool, error) {
				probes++
				_, err := s.ensureExistingWorkspaceRunning(ctx, w)
				if scenario == "stale-vm" {
					_, changeErr := pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement',provisioning_generation=provisioning_generation+1 WHERE id=$1`, w.ID)
					require.NoError(t, changeErr)
				}
				if scenario == "registered-during-probe" {
					_, registerErr := jobs.Register(ctx, "gateway", "token", "issues", config)
					require.NoError(t, registerErr)
				}
				return false, err
			}
			input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
			if scenario == "already-bound" {
				require.NoError(t, q.BindWorkspaceCapability(ctx, db.BindWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability, WorkspaceID: config.WorkspaceID}))
			}
			selected, selectErr := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
			old, err := q.GetWorkspace(ctx, config.WorkspaceID)
			require.NoError(t, err)
			switch scenario {
			case "transport", "stale-vm":
				require.Error(t, selectErr)
				require.Equal(t, "running", old.Status)
				_, err = q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
				require.ErrorIs(t, err, pgx.ErrNoRows)
				if scenario == "stale-vm" {
					require.Equal(t, "replacement", old.VmID)
				}
			case "registered-during-probe", "already-bound":
				require.NoError(t, selectErr)
				require.Equal(t, old.ID, selected.ID)
				require.Equal(t, "running", old.Status)
				if scenario == "already-bound" {
					require.Zero(t, probes)
				}
			default:
				require.NoError(t, selectErr)
				require.Equal(t, "failed", old.Status)
				require.Equal(t, string(pkgerrors.CodeWorkspaceVMMissing), old.FailureCode.String)
				require.Equal(t, "missing-primary", old.VmID)
				require.False(t, old.DeletedAt.Valid)
				require.NotEqual(t, old.ID, selected.ID)
				require.True(t, selected.IsFork)
				require.Equal(t, "starting", selected.Status)
				entitlement, err := billing.SandboxEntitlement(ctx, input.UserID)
				require.NoError(t, err)
				require.Equal(t, int64(1), entitlement.ConcurrentSandboxes)
				require.Equal(t, int64(1), entitlement.ConcurrentInUse)
			}
		})
	}
}

func TestRepositoryJobsIntegrationCapabilitySelection(t *testing.T) {
	pool, q, _, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='vm', vm_id='old-primary' WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool))
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", Name: "Repository", RequiredCapability: repositoryJobsCapability}
	results, errs := make([]db.Workspace, 8), make([]error, 8)
	var group sync.WaitGroup
	for i := range results {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			results[i], errs[i] = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{Source: defaultWorkspaceEnvironmentSource})
		}(i)
	}
	group.Wait()
	for i := range results {
		require.NoError(t, errs[i])
		require.Equal(t, results[0].ID, results[i].ID)
	}
	selected := results[0]
	require.NotEqual(t, config.WorkspaceID, selected.ID, "initial setup cannot reuse an older primary")
	require.True(t, selected.IsFork)
	require.Equal(t, "starting", selected.Status)
	require.Empty(t, selected.VmID, "one durable identity exists before the provider acknowledges creation")
	primary, err := q.GetWorkspace(ctx, config.WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, "old-primary", primary.VmID)
	require.Equal(t, "running", primary.Status)
	count, err := q.CountWorkspacesByRepo(ctx, db.CountWorkspacesByRepoParams{RepositoryID: input.RepositoryID, UserID: input.UserID})
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
	other, _ := setupTestUserAndRepo(t, pool)
	unauthorized := input
	unauthorized.UserID = other
	_, err = s.findOrCreateCapabilityWorkspace(ctx, unauthorized, "main", WorkspaceEnvironment{})
	require.Error(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, selected.ID)
	require.NoError(t, err)
	_, err = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.ErrorContains(t, err, "binding is preserved")
	bound, err := q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
	require.NoError(t, err)
	require.Equal(t, selected.ID, bound.ID)
}

func TestRepositoryJobsIntegrationCapabilityKeepsEstablishedAuthority(t *testing.T) {
	pool, q, jobs, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='vm', vm_id='established' WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	_, err = jobs.Register(ctx, "gateway", "token", "issues", config)
	require.NoError(t, err)
	_, err = jobs.Pause(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceCapabilityProbe(func(context.Context, db.Workspace, string) (bool, error) {
		return false, errors.New("registered authority must win before any primary probe")
	}))
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
	selected, err := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.NoError(t, err)
	require.Equal(t, config.WorkspaceID, selected.ID, "paused registrations still own their original execution history")
	registrations, err := q.ListRepositoryJobRegistrations(ctx, input.RepositoryID)
	require.NoError(t, err)
	require.Len(t, registrations, 1)
	require.Equal(t, selected.ID, registrations[0].WorkspaceID)
	require.False(t, registrations[0].Enabled)
	count, err := q.CountWorkspacesByRepo(ctx, db.CountWorkspacesByRepoParams{RepositoryID: input.RepositoryID, UserID: input.UserID})
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
}

func TestWorkspaceCapabilityValidation(t *testing.T) {
	for _, input := range []CreateWorkspaceInput{
		{Kind: "desktop", RequiredCapability: repositoryJobsCapability},
		{Kind: "vm", RequiredCapability: "invented"},
		{Kind: "vm", RequiredCapability: repositoryJobsCapability, SnapshotID: "old-host-snapshot"},
	} {
		require.Error(t, validateWorkspaceCreateMetadata(input))
	}
	require.NoError(t, validateWorkspaceCreateMetadata(CreateWorkspaceInput{Kind: "vm", RequiredCapability: repositoryJobsCapability}))
}

func TestRepositoryJobsIntegrationCompatiblePrimaryFreePlan(t *testing.T) {
	for _, kind := range []string{"container", "vm"} {
		t.Run(kind, func(t *testing.T) {
			pool, q, _, g, config := repositoryJobFixture(t)
			ctx := context.Background()
			_, err := pool.Exec(ctx, `UPDATE workspaces SET kind=$2,vm_id='compatible-primary' WHERE id=$1`, config.WorkspaceID, kind)
			require.NoError(t, err)
			billing := NewBillingService(q, nil, BillingServiceConfig{})
			entitlement, err := billing.SandboxEntitlement(ctx, g.target.UserID)
			require.NoError(t, err)
			require.Equal(t, BillingPlanFree, entitlement.PlanKey)
			require.Equal(t, int64(1), entitlement.ConcurrentSandboxes)
			require.Equal(t, int64(1), entitlement.ConcurrentInUse)
			require.Equal(t, pkgerrors.CodePlanLimitExceeded, assertAPIErrorStatus(t, billing.AuthorizeSandboxStart(ctx, g.target.UserID), http.StatusPaymentRequired).Code)
			gatewayID := uuid.NewString()
			var probes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				probes.Add(1)
				hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
				_ = json.NewEncoder(w).Encode(map[string]any{"gatewayId": gatewayID, "workspaceHash": hex.EncodeToString(hash[:])[:16], "protocolVersion": "1", "capabilities": []string{repositoryJobsCapability, "repository-source/v1"}})
			}))
			defer server.Close()
			gateway := NewRepoGatewayService(nil, WithRepoGatewayHealthProbe(server.URL, server.Client()))
			s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceBillingPolicy(billing),
				WithWorkspaceCapabilityProbe(func(ctx context.Context, w db.Workspace, capability string) (bool, error) {
					// A second connection can take the selector's advisory lock:
					// neither its lock nor its transaction spans the HTTP probe.
					tx, err := pool.Begin(ctx)
					if err != nil {
						return false, err
					}
					defer tx.Rollback(ctx)
					var free bool
					err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('workspace-capability:' || $1::bigint::text || ':' || $2::bigint::text,0))`, w.RepositoryID, w.UserID).Scan(&free)
					if err != nil {
						return false, err
					}
					if !free {
						return false, errors.New("selection lock held during capability probe")
					}
					if err := tx.Rollback(ctx); err != nil {
						return false, err
					}
					err = gateway.requireWorkspaceGatewayCapability(ctx, RepoGatewayConnectionInfo{GatewayID: gatewayID, WorkspaceID: w.ID, VMID: w.VmID}, capability)
					return err == nil, err
				}))
			input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
			selected, err := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
			require.NoError(t, err)
			require.Equal(t, config.WorkspaceID, selected.ID)
			require.Equal(t, kind, selected.Kind)
			require.False(t, selected.IsFork)
			require.Equal(t, int32(1), probes.Load())
			// Bound identity wins even if the host cannot answer a later probe.
			s.capabilityProbe = func(context.Context, db.Workspace, string) (bool, error) {
				return false, errors.New("an established binding must not be probed during selection")
			}
			selected, err = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
			require.NoError(t, err)
			require.Equal(t, config.WorkspaceID, selected.ID)
			count, err := q.CountActiveSandboxesForUser(ctx, input.UserID)
			require.NoError(t, err)
			require.Equal(t, 1, count, "reuse adds no compute and does not bypass the free plan")
		})
	}
}

func TestRepositoryJobsIntegrationCompatiblePrimaryConcurrentBinding(t *testing.T) {
	pool, q, _, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='container',vm_id='compatible-primary' WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceBillingPolicy(NewBillingService(q, nil, BillingServiceConfig{})),
		WithWorkspaceCapabilityProbe(func(context.Context, db.Workspace, string) (bool, error) { return true, nil }))
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
	results, errs := make([]db.Workspace, 8), make([]error, 8)
	var group sync.WaitGroup
	for i := range results {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			results[i], errs[i] = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
		}(i)
	}
	group.Wait()
	for i := range results {
		require.NoError(t, errs[i])
		require.Equal(t, config.WorkspaceID, results[i].ID)
	}
	var bindings, workspaces int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_capability_bindings WHERE repository_id=$1`, input.RepositoryID).Scan(&bindings))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, input.RepositoryID).Scan(&workspaces))
	require.Equal(t, 1, bindings)
	require.Equal(t, 1, workspaces)
}

func TestRepositoryJobsIntegrationIncompatiblePrimaryHonorsBilling(t *testing.T) {
	pool, q, _, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='vm',vm_id='older-primary' WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceBillingPolicy(NewBillingService(q, nil, BillingServiceConfig{})),
		WithWorkspaceCapabilityProbe(func(context.Context, db.Workspace, string) (bool, error) { return false, nil }))
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
	_, err = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.Equal(t, pkgerrors.CodePlanLimitExceeded, assertAPIErrorStatus(t, err, http.StatusPaymentRequired).Code)
	_, err = q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	primary, err := q.GetWorkspace(ctx, config.WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, "running", primary.Status)
	require.Equal(t, "older-primary", primary.VmID)
	// Only after the user has freed capacity may the normal fallback allocate.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	selected, err := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.NoError(t, err)
	require.NotEqual(t, config.WorkspaceID, selected.ID)
	require.True(t, selected.IsFork)
	require.Equal(t, "starting", selected.Status)
}

func TestRepositoryJobsIntegrationCompatiblePrimaryStaleProbe(t *testing.T) {
	for _, mutation := range []string{"vm", "bookmark", "default", "deleted", "owner", "generation"} {
		t.Run(mutation, func(t *testing.T) {
			pool, q, _, g, config := repositoryJobFixture(t)
			ctx := context.Background()
			_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='vm',vm_id='probed-primary' WHERE id=$1`, config.WorkspaceID)
			require.NoError(t, err)
			s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool),
				WithWorkspaceCapabilityProbe(func(ctx context.Context, w db.Workspace, _ string) (bool, error) {
					var err error
					switch mutation {
					case "vm":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement-primary' WHERE id=$1`, w.ID)
					case "bookmark":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET target_bookmark='other' WHERE id=$1`, w.ID)
					case "default":
						_, err = pool.Exec(ctx, `UPDATE repositories SET default_bookmark='other' WHERE id=$1`, w.RepositoryID)
					case "deleted":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, w.ID)
					case "owner":
						_, err = pool.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, w.UserID)
					case "generation":
						_, err = pool.Exec(ctx, `UPDATE workspaces SET provisioning_generation=provisioning_generation+1 WHERE id=$1`, w.ID)
					}
					require.NoError(t, err, "the race must actually change durable state")
					return true, err
				}))
			input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
			_, err = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
			require.Error(t, err)
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_capability_bindings WHERE repository_id=$1`, input.RepositoryID).Scan(&count))
			require.Zero(t, count, "stale proof must never bind a replacement identity")
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, input.RepositoryID).Scan(&count))
			require.Equal(t, 1, count, "a stale probe is retryable, not permission to allocate")
		})
	}
}

func TestRepositoryJobsIntegrationRegistrationWinsDuringPrimaryProbe(t *testing.T) {
	pool, q, jobs, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(repository_id,user_id,kind,status,vm_id,target_bookmark) VALUES($1,$2,'vm','running','other-primary','main')`, g.target.RepositoryID, g.target.UserID)
	require.NoError(t, err)
	s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceCapabilityProbe(func(ctx context.Context, candidate db.Workspace, _ string) (bool, error) {
		require.NotEqual(t, config.WorkspaceID, candidate.ID)
		_, err := jobs.Register(ctx, "gateway", "token", "issues", config)
		require.NoError(t, err)
		return false, errors.New("candidate host became unavailable")
	}))
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
	selected, err := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.NoError(t, err)
	require.Equal(t, config.WorkspaceID, selected.ID, "an authoritative registration wins even when the concurrent candidate probe fails")
	bound, err := q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
	require.NoError(t, err)
	require.Equal(t, config.WorkspaceID, bound.ID)
}

func TestRepositoryJobsIntegrationPendingImportReusesReservation(t *testing.T) {
	pool, q, _, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='container',status='starting',vm_id='' WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceBillingPolicy(NewBillingService(q, nil, BillingServiceConfig{})),
		WithWorkspaceCapabilityProbe(func(context.Context, db.Workspace, string) (bool, error) {
			return false, errors.New("no live host exists yet")
		}))
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
	selected, err := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, assertAPIErrorStatus(t, err, http.StatusConflict).Code)
	require.Empty(t, selected.ID, "a cold imported primary must not become a client binding")
	_, err = q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
	require.ErrorIs(t, err, pgx.ErrNoRows, "a pending import is not a verified host")
	count, err := q.CountActiveSandboxesForUser(ctx, input.UserID)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

func TestRepositoryJobsIntegrationPendingPrimaryWaitsForCompatibility(t *testing.T) {
	for _, scenario := range []string{"no-vm-compatible", "suspended-compatible", "starting-incompatible", "generic-conflict", "transport", "registration-race"} {
		t.Run(scenario, func(t *testing.T) {
			pool, q, jobs, g, config := repositoryJobFixture(t)
			ctx := context.Background()
			status, vmID := "starting", "cold-primary"
			if scenario == "no-vm-compatible" {
				vmID = ""
			}
			if scenario == "suspended-compatible" {
				status = "suspended"
			}
			_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='container',status=$2,vm_id=$3 WHERE id=$1`, config.WorkspaceID, status, vmID)
			require.NoError(t, err)
			ready, probes := false, 0
			billing := NewBillingService(q, nil, BillingServiceConfig{})
			s := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceBillingPolicy(billing), WithWorkspaceCapabilityProbe(func(ctx context.Context, w db.Workspace, _ string) (bool, error) {
				probes++
				if ready {
					return scenario != "starting-incompatible", nil
				}
				if scenario == "generic-conflict" {
					return false, pkgerrors.Conflict("workspace changed")
				}
				if scenario == "transport" {
					return false, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "transport unavailable")
				}
				if scenario == "registration-race" {
					_, err := jobs.Register(ctx, "gateway", "token", "issues", config)
					require.NoError(t, err)
				}
				return false, repositoryWorkspacePending("still starting")
			}))
			input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
			selected, err := s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
			if scenario == "registration-race" {
				require.NoError(t, err)
				require.Equal(t, config.WorkspaceID, selected.ID)
				return
			}
			require.Error(t, err)
			require.Empty(t, selected.ID)
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			if scenario == "generic-conflict" || scenario == "transport" {
				require.NotEqual(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
			} else {
				require.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, api.Code)
				require.Equal(t, 2, api.RetryAfter)
				require.Nil(t, api.Details)
			}
			_, err = q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
			require.ErrorIs(t, err, pgx.ErrNoRows)
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND user_id=$2`, input.RepositoryID, input.UserID).Scan(&count))
			require.Equal(t, 1, count)
			if scenario == "generic-conflict" || scenario == "transport" {
				return
			}
			if scenario == "no-vm-compatible" {
				require.Zero(t, probes)
			}
			ready = true
			_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running',vm_id='cold-primary' WHERE id=$1`, config.WorkspaceID)
			require.NoError(t, err)
			selected, err = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
			if scenario == "starting-incompatible" {
				require.Equal(t, pkgerrors.CodePlanLimitExceeded, assertAPIErrorStatus(t, err, http.StatusPaymentRequired).Code)
				require.Empty(t, selected.ID)
				_, err = q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
				require.ErrorIs(t, err, pgx.ErrNoRows)
				// Freeing the real slot permits the ordinary dedicated fallback;
				// the unverified primary was never silently made authoritative.
				_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, config.WorkspaceID)
				require.NoError(t, err)
				selected, err = s.findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
				require.NoError(t, err)
				require.NotEqual(t, config.WorkspaceID, selected.ID)
				require.True(t, selected.IsFork)
			} else {
				require.NoError(t, err)
				require.Equal(t, config.WorkspaceID, selected.ID)
				require.False(t, selected.IsFork)
			}
			entitlement, err := billing.SandboxEntitlement(ctx, input.UserID)
			require.NoError(t, err)
			require.Equal(t, int64(1), entitlement.ConcurrentInUse)
			require.Equal(t, int64(1), entitlement.ConcurrentSandboxes)
		})
	}
}

// #2206: a repository job never binds to a workspace built with a
// subscription token; a deployment that allows the tokens still does.
func TestRepositoryJobsIntegrationCapabilityRefusesRebuildRequired(t *testing.T) {
	pool, q, jobs, g, config := repositoryJobFixture(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE workspaces SET kind='vm', vm_id='established', rebuild_required_at=now() WHERE id=$1`, config.WorkspaceID)
	require.NoError(t, err)
	_, err = jobs.Register(ctx, "gateway", "token", "issues", config)
	require.NoError(t, err)
	input := CreateWorkspaceInput{RepositoryID: g.target.RepositoryID, UserID: g.target.UserID, Kind: "vm", RequiredCapability: repositoryJobsCapability}
	_, err = NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool)).findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	requireRebuildRequired(t, err)
	selected, err := NewWorkspaceService(q, WithWorkspaceCapabilityTransactions(pool), WithWorkspaceSubscriptionTokens(true)).findOrCreateCapabilityWorkspace(ctx, input, "main", WorkspaceEnvironment{})
	require.NoError(t, err)
	require.Equal(t, config.WorkspaceID, selected.ID)
}
