package services

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Box gateway retirement (#2198).
//
// ONE-RELEASE CONVERGENCE. A box once ran two coding hosts: the box gateway
// (a repo_gateways row plus the smithers-gateway-<id> service on the box,
// reached at smithers-gw-<id> ingress) and the flowhost coding host every
// caller now uses. Nothing provisions, relays to or authorizes a box gateway
// any more; this reaper discards the rows and services still running from
// before, then stops. Delete this file, ports.RepoGatewayStore,
// runtimeports.RepoGateway, their wiring in compose and the smithers-gw-*
// refusal in previewgateway once production answers zero for:
//
//	SELECT count(*) FROM repo_gateways
//	 WHERE deleted_at IS NULL
//	    OR (workspace_id IS NOT NULL AND auth_token_hash <> '');
//
// Precedent: the librarian host retirement (product migration 0047 and
// flowhost.Store.ReconcileRetired).

// repoGatewayRetirementInterval is the sweep cadence while rows remain.
const repoGatewayRetirementInterval = 5 * time.Minute

// repoGatewayRetirementCleanupTimeout bounds one pass over tombstoned rows, so
// boxes that are asleep cannot hold a sweep open.
const repoGatewayRetirementCleanupTimeout = 30 * time.Second

// RepoGatewayRetirementStore is the deployment's repo_gateways inventory.
type RepoGatewayRetirementStore interface {
	// ListActiveRepoGateways answers the live 'running' and 'suspended' rows.
	ListActiveRepoGateways(ctx context.Context) ([]runtimeports.RepoGateway, error)
	// ListStaleRepoGateways answers live 'pending', 'starting' and 'failed'
	// rows last updated more than ageSeconds ago.
	ListStaleRepoGateways(ctx context.Context, ageSeconds int64) ([]runtimeports.RepoGateway, error)
	SoftDeleteRepoGateway(ctx context.Context, id string) (runtimeports.RepoGateway, error)
	// ListPendingWorkspaceGatewayCleanup answers tombstoned box-bound rows
	// whose service is not yet verified stopped (their credential is kept).
	ListPendingWorkspaceGatewayCleanup(ctx context.Context) ([]runtimeports.RepoGateway, error)
	// TouchDiscardedWorkspaceGatewayCleanup rotates a failed attempt to the
	// back, so an asleep box cannot starve the rows behind it.
	TouchDiscardedWorkspaceGatewayCleanup(ctx context.Context, id string) error
	// ClearDiscardedWorkspaceGatewayCredential records the verified stop.
	ClearDiscardedWorkspaceGatewayCredential(ctx context.Context, id string) error
}

// RepoGatewayRetirementVMClient is the sandbox provider surface the reaper
// needs: stop a box's gateway service, unmap its ingress, and delete the VM
// of a box-less (repository-level) gateway, which owned it.
type RepoGatewayRetirementVMClient interface {
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	RevokeIngress(ctx context.Context, domain string) error
	DeleteSandbox(ctx context.Context, vmID string) error
}

type repoGatewayRetirementTokens interface {
	accessTokenStore
	providerPoolTokenLister
}

// RepoGatewayRetirement discards every remaining box gateway.
type RepoGatewayRetirement struct {
	gateways RepoGatewayRetirementStore
	tokens   repoGatewayRetirementTokens
	sandbox  RepoGatewayRetirementVMClient
	interval time.Duration
}

// NewRepoGatewayRetirement wires the reaper. tokens is the product store
// holding the gateways' landing and model-proxy credentials.
func NewRepoGatewayRetirement(gateways RepoGatewayRetirementStore, tokens repoGatewayRetirementTokens, vm RepoGatewayRetirementVMClient) *RepoGatewayRetirement {
	return &RepoGatewayRetirement{gateways: gateways, tokens: tokens, sandbox: vm, interval: repoGatewayRetirementInterval}
}

// Run sweeps at once and then every interval until a sweep finds nothing left
// to retire, then returns. Run it in its own goroutine.
func (r *RepoGatewayRetirement) Run(ctx context.Context) {
	if r == nil || r.gateways == nil || r.sandbox == nil {
		return
	}
	for !r.Sweep(ctx) {
		timer := time.NewTimer(r.interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
	slog.Info("box gateways retired: no repo_gateways row remains")
}

// Sweep discards every live row, then retries the verified stop of every
// tombstoned one. It reports true only when it found nothing to do.
func (r *RepoGatewayRetirement) Sweep(ctx context.Context) bool {
	active, activeErr := r.gateways.ListActiveRepoGateways(ctx)
	unfinished, unfinishedErr := r.gateways.ListStaleRepoGateways(ctx, 0)
	if err := errors.Join(activeErr, unfinishedErr); err != nil {
		slog.Warn("box gateway retirement: list live rows failed", "error", err)
		return false
	}
	live := append(active, unfinished...)
	for _, row := range live {
		r.discard(ctx, row)
	}
	cleanupCtx, cancel := context.WithTimeout(ctx, repoGatewayRetirementCleanupTimeout)
	defer cancel()
	pending, err := r.gateways.ListPendingWorkspaceGatewayCleanup(cleanupCtx)
	if err != nil {
		slog.Warn("box gateway retirement: list tombstoned rows failed", "error", err)
		return false
	}
	for _, row := range pending {
		if cleanupCtx.Err() != nil {
			break
		}
		if err := r.gateways.TouchDiscardedWorkspaceGatewayCleanup(cleanupCtx, row.ID); err != nil {
			slog.Warn("box gateway retirement: record cleanup attempt failed", "gateway_id", row.ID, "error", err)
			continue
		}
		if err := r.stopBoxGateway(cleanupCtx, row); err != nil {
			slog.Warn("box gateway retirement: stop failed; retried next sweep", "gateway_id", row.ID, "vm_id", row.VmID, "error", err)
		}
	}
	return len(live) == 0 && len(pending) == 0
}

// discard tombstones a live row. A box-bound row keeps its credential until
// its service is verified stopped (the pending pass); a box-less row owned
// its VM, which goes with it.
func (r *RepoGatewayRetirement) discard(ctx context.Context, row runtimeports.RepoGateway) {
	if vmID := strings.TrimSpace(row.VmID); !row.WorkspaceID.Valid && vmID != "" {
		if err := r.sandbox.RevokeIngress(ctx, repoGatewayDomain(vmID)); err != nil && !vmAlreadyGone(err) {
			slog.Warn("box gateway retirement: unmap ingress failed", "gateway_id", row.ID, "vm_id", vmID, "error", err)
		}
		if err := r.sandbox.DeleteSandbox(ctx, vmID); err != nil && !vmAlreadyGone(err) {
			slog.Warn("box gateway retirement: delete VM failed", "gateway_id", row.ID, "vm_id", vmID, "error", err)
		}
	}
	if _, err := r.gateways.SoftDeleteRepoGateway(ctx, row.ID); err != nil {
		slog.Warn("box gateway retirement: tombstone failed", "gateway_id", row.ID, "error", err)
		return
	}
	r.revokeCredentials(ctx, row)
}

// stopBoxGateway stops and disables the row's service on its box, unmaps its
// ingress, revokes its credentials and only then clears the credential
// marker. A box that is gone counts as stopped.
func (r *RepoGatewayRetirement) stopBoxGateway(ctx context.Context, row runtimeports.RepoGateway) error {
	if row.VmID != "" {
		unit := shellQuote("smithers-gateway-" + row.ID + ".service")
		command := "set -eu\nstate=$(systemctl show --property=LoadState --value " + unit + ")\n" +
			"if [ \"$state\" != not-found ]; then systemctl disable --now " + unit + "; fi\n" +
			"if systemctl is-active --quiet " + unit + "; then exit 75; fi"
		timeout := int64(15 * time.Second / time.Millisecond)
		result, err := r.sandbox.Execute(ctx, row.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: &timeout})
		if err != nil && !vmAlreadyGone(err) {
			return err
		}
		if err == nil && (result.StatusCode == nil || *result.StatusCode != 0) {
			return errors.New("gateway service is still running")
		}
	}
	if err := r.sandbox.RevokeIngress(ctx, repoGatewayDomain(row.ID)); err != nil && !vmAlreadyGone(err) {
		return err
	}
	r.revokeCredentials(ctx, row)
	return r.gateways.ClearDiscardedWorkspaceGatewayCredential(ctx, row.ID)
}

// revokeCredentials deletes the row's landing credential and model-proxy
// credentials by name, recorded or not.
func (r *RepoGatewayRetirement) revokeCredentials(ctx context.Context, row runtimeports.RepoGateway) {
	if r.tokens == nil || row.UserID <= 0 {
		return
	}
	tokens, err := r.tokens.ListAccessTokensByUserID(ctx, row.UserID)
	if err != nil {
		slog.Warn("box gateway retirement: list credentials failed", "gateway_id", row.ID, "error", err)
		return
	}
	for _, token := range tokens {
		if token.Name == "workspace-gateway-landing-"+row.ID || token.Name == modelProxyTokenPrefix+"gateway-"+row.ID {
			revokeTemporaryRepoCloneToken(ctx, r.tokens, row.UserID, token.ID)
		}
	}
}

// repoGatewayDomain is a gateway's preview ingress hostname: its row ID for a
// box-bound gateway, its VM ID for a box-less one.
func repoGatewayDomain(label string) string {
	return "smithers-gw-" + strings.ReplaceAll(strings.ToLower(strings.TrimSpace(label)), "_", "-") + ".preview.jjhub.tech"
}
