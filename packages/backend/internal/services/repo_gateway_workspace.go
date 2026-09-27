package services

// Workspace-bound gateways compose the existing authorized workspace lifecycle.
// The nullable association is an ownership boundary: these rows own only their
// service and ingress, and must never reclaim the workspace's VM or checkout.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func WithRepoGatewayWorkspaces(workspaces *WorkspaceService) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.workspaces = workspaces }
}

func repositoryWorkspacePending(message string) *pkgerrors.APIError {
	return pkgerrors.New(pkgerrors.CodeRepositoryWorkspacePending, message)
}

func gatewayWorkspaceID(g runtimeports.RepoGateway) string {
	if g.WorkspaceID.Valid {
		return g.WorkspaceID.String()
	}
	return ""
}
func gatewayIngressDomain(g runtimeports.RepoGateway) string {
	if g.WorkspaceID.Valid {
		return repoGatewayDomain(g.ID)
	}
	return repoGatewayDomain(g.VmID)
}
func workspaceGatewayServiceName(g runtimeports.RepoGateway) string {
	return "smithers-gateway-" + g.ID
}

// The process lock belongs to the workspace, while cleanup belongs to a gateway
// row. Root owns this directory so a coding flow cannot unlink the held lock.
const workspaceGatewayLockDirectory = "/run/smithers-workspace-coding"

// workspaceGatewayLandingTokenTTL bounds the coding host's landing credential.
// Teardown revokes it, so the TTL is only a leak backstop for a gateway whose
// VM disappears without a verified stop. It matches the workspace head token.
const workspaceGatewayLandingTokenTTL = 7 * 24 * time.Hour

type workspaceGatewayLifecycleQuerier interface {
	ListDiscardedWorkspaceGateways(context.Context, runtimeports.ListDiscardedWorkspaceGatewaysParams) ([]runtimeports.RepoGateway, error)
	HasWritableWorkspaceShares(context.Context, string) (bool, error)
	ClearDiscardedWorkspaceGatewayCredential(context.Context, string) error
	SetRepoGatewayLandingTokenID(context.Context, runtimeports.SetRepoGatewayLandingTokenIDParams) error
	ListPendingWorkspaceGatewayCleanup(context.Context) ([]runtimeports.RepoGateway, error)
	TouchDiscardedWorkspaceGatewayCleanup(context.Context, string) error
}

func workspaceGatewaySharingConflict(err error) bool {
	var constraint *pgconn.PgError
	return errors.As(err, &constraint) && constraint.Code == "23514" && constraint.ConstraintName == "workspace_gateway_private_execution"
}

func workspaceGatewayLockPath(g runtimeports.RepoGateway) string {
	return workspaceGatewayLockDirectory + "/" + gatewayWorkspaceID(g) + ".lock"
}

func workspaceGatewayCommand(g runtimeports.RepoGateway) string {
	return strings.Join([]string{
		"set -eu",
		// Reuse the existing repository environment and egress-proxy placeholders.
		// Its ordinary env names are user-controlled, including SMITHERS_API_KEY;
		// restore this service's identity and paths after loading that profile.
		"readonly smithers_bound_gateway_key=\"$SMITHERS_API_KEY\" smithers_bound_gateway_id=\"$SMITHERS_GATEWAY_ID\"",
		// The landing credential is reserved the same way: a repository admin
		// who declares SMITHERS_JJHUB_TOKEN or SMITHERS_JJHUB_API_URL as an
		// agent-environment variable must not be able to redirect or replace
		// the owner's repository-scoped landing token. Both names travel only
		// in this unit's environment, never in profile.d.
		"smithers_bound_landing_token=\"${SMITHERS_JJHUB_TOKEN-}\" smithers_bound_landing_api=\"${SMITHERS_JJHUB_API_URL-}\"",
		"if [ -r /etc/profile.d/10-smithers-agent-environment.sh ]; then . /etc/profile.d/10-smithers-agent-environment.sh; fi",
		workspaceCodingModelFallbackScript(),
		"export SMITHERS_API_KEY=\"$smithers_bound_gateway_key\" SMITHERS_GATEWAY_ID=\"$smithers_bound_gateway_id\"",
		// An empty value is not a credential: unset it so the coding host sees
		// an absent binding rather than a credential it must refuse.
		"if [ -n \"$smithers_bound_landing_token\" ] && [ -n \"$smithers_bound_landing_api\" ]; then export SMITHERS_JJHUB_TOKEN=\"$smithers_bound_landing_token\" SMITHERS_JJHUB_API_URL=\"$smithers_bound_landing_api\"; else unset SMITHERS_JJHUB_TOKEN SMITHERS_JJHUB_API_URL; fi",
		"unset smithers_bound_landing_token smithers_bound_landing_api",
		"export HOME=/home/developer PATH=/usr/local/bin:/run/current-system/sw/bin:/usr/bin:/bin TMPDIR=/home/developer/.cache/smithers/tmp XDG_CACHE_HOME=/home/developer/.cache XDG_CONFIG_HOME=/home/developer/.config",
		"export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=" + shellQuote(workspaceJJExportPath),
		"unset SMITHERS_CODING_LOCAL_OWNER",
		fmt.Sprintf("exec flock --nonblock --no-fork --conflict-exit-code 75 %s env PATH=/home/developer/.local/bin:/usr/local/bin:/home/developer/.bun/bin:/run/current-system/sw/bin:/usr/bin:/bin %s serve --root %s --host 0.0.0.0 --port %d --listen",
			shellQuote(workspaceGatewayLockPath(g)), workspaceCodingHostPath, defaultWorkspaceClonePath, repoGatewayPort),
	}, "\n")
}

// workspaceGatewayLandingTokenScopes is the minimum the coding/vibe landing
// flow needs: it lists bookmarks, prepares an append, creates the landing
// request and queues the append, all under write:repository (which implies
// read:repository). repo:<id> narrows the credential to this gateway's
// repository, so a leaked token cannot act on the owner's other repositories.
// Unlike the head-reporter token it carries NO workspace:<id> restriction: a
// workspace-bound token may only push and report that workspace's head ref and
// is refused on every landing route.
func workspaceGatewayLandingTokenScopes(repositoryID int64, workspaceID string) string {
	// The existing agent-authorship contract is a path-bound repository token.
	// This host can edit the whole repository; ** preserves that boundary while
	// distinguishing its submissions from a human PAT. The inert workspace
	// entry records which workspace opens each landing.
	return strings.Join(append([]string{string(middleware.ScopeWriteRepository), middleware.RepositoryRestrictionScope(repositoryID),
		middleware.LandingWorkspaceScope(workspaceID)}, middleware.PathRestrictionScopes([]string{"**"})...), ",")
}

// landingAPIBaseURL is the public API root the coding host's landing flow
// calls. It must equal the apiBaseUrl recorded in the guest's
// /etc/smithers/workspace-coding.json binding, which the workspace installer
// writes from the same configured public base URL; the coding host refuses a
// credential whose API base does not match its provisioned binding.
func (s *RepoGatewayService) landingAPIBaseURL() string {
	base := strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/")
	if base == "" {
		return ""
	}
	return base + "/api"
}

// ensureWorkspaceGatewayLandingToken mints the repository-scoped credential the
// coding host hands to the landing flow, and records it on the gateway row so
// teardown revokes exactly this token. A credential recorded by an earlier
// start is revoked first: only the live process may hold one. The returned
// plaintext is passed to the service environment and never logged.
func (s *RepoGatewayService) ensureWorkspaceGatewayLandingToken(ctx context.Context, gateway *runtimeports.RepoGateway) (string, error) {
	if s.landingAPIBaseURL() == "" || gateway.RepositoryID <= 0 || !gateway.WorkspaceID.Valid {
		return "", nil
	}
	store, ok := s.q.(workspaceGatewayLifecycleQuerier)
	if !ok {
		return "", pkgerrors.Internal("workspace gateway lifecycle store unavailable")
	}
	s.revokeWorkspaceGatewayLandingToken(ctx, *gateway)
	gateway.LandingTokenID = pgtype.Int8{}
	token, err := issueTemporaryRepoTokenWithTTL(ctx, s.q, gateway.UserID, "workspace-gateway-landing-"+gateway.ID,
		workspaceGatewayLandingTokenScopes(gateway.RepositoryID, uuidString(gateway.WorkspaceID)), workspaceGatewayLandingTokenTTL)
	if err != nil {
		return "", pkgerrors.Internal("mint workspace gateway landing token").WithCause(err)
	}
	if err := store.SetRepoGatewayLandingTokenID(ctx, runtimeports.SetRepoGatewayLandingTokenIDParams{
		ID: gateway.ID, LandingTokenID: pgtype.Int8{Int64: token.ID, Valid: true},
	}); err != nil {
		// An unrecorded credential could never be revoked; drop it now.
		revokeTemporaryRepoCloneToken(ctx, s.q, gateway.UserID, token.ID)
		return "", pkgerrors.Internal("record workspace gateway landing token").WithCause(err)
	}
	gateway.LandingTokenID = pgtype.Int8{Int64: token.ID, Valid: true}
	return token.Plaintext, nil
}

// revokeWorkspaceGatewayLandingToken deletes the recorded landing credential
// and clears the reference. Best effort: a row without one is not an error.
func (s *RepoGatewayService) revokeWorkspaceGatewayLandingToken(ctx context.Context, gateway runtimeports.RepoGateway) {
	if !gateway.LandingTokenID.Valid || gateway.LandingTokenID.Int64 <= 0 {
		return
	}
	revokeTemporaryRepoCloneToken(ctx, s.q, gateway.UserID, gateway.LandingTokenID.Int64)
	if store, ok := s.q.(workspaceGatewayLifecycleQuerier); ok {
		_ = store.SetRepoGatewayLandingTokenID(ctx, runtimeports.SetRepoGatewayLandingTokenIDParams{ID: gateway.ID})
	}
}

func (s *RepoGatewayService) loadGatewayWorkspace(ctx context.Context, id string, repositoryID, userID int64) (db.Workspace, error) {
	parsed, err := uuid.Parse(id)
	if err != nil || parsed == uuid.Nil || parsed.String() != id {
		return db.Workspace{}, pkgerrors.BadRequest("workspace_id must be a canonical nonzero UUID")
	}
	if s.workspaces == nil {
		return db.Workspace{}, pkgerrors.Conflict("workspace-bound gateways are not configured")
	}
	workspace, err := s.workspaces.loadOwnedWorkspace(ctx, id, repositoryID, userID)
	if err != nil {
		return db.Workspace{}, err
	}
	// loadOwnedWorkspace also accepts write shares. A bound gateway's durable
	// operator credential and native principal belong to the workspace owner;
	// shared-user execution requires an authenticated initiating actor binding.
	if workspace.UserID != userID {
		return db.Workspace{}, pkgerrors.Forbidden("workspace-bound gateways currently require the workspace owner")
	}
	if workspace.DeletedAt.Valid {
		return db.Workspace{}, pkgerrors.NotFound("workspace not found")
	}
	q, ok := s.q.(workspaceGatewayLifecycleQuerier)
	if !ok {
		return db.Workspace{}, pkgerrors.Internal("workspace gateway lifecycle store unavailable")
	}
	shared, err := q.HasWritableWorkspaceShares(ctx, id)
	if err != nil {
		return db.Workspace{}, pkgerrors.Internal("check workspace gateway sharing").WithCause(err)
	}
	if shared {
		return db.Workspace{}, pkgerrors.Forbidden("coding gateways require a workspace without write shares until shared execution has actor-bound credentials")
	}
	return workspace, nil
}

func (s *RepoGatewayService) getWorkspaceGateway(ctx context.Context, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	if _, err := s.loadGatewayWorkspace(ctx, input.WorkspaceID, input.RepositoryID, input.UserID); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	binding := pgtype.UUID{Bytes: uuid.MustParse(input.WorkspaceID), Valid: true}
	existing, err := s.q.GetActiveRepoGatewayForUserRepo(ctx, runtimeports.GetActiveRepoGatewayForUserRepoParams{RepositoryID: input.RepositoryID, UserID: input.UserID, WorkspaceID: binding})
	if err == nil {
		return s.resolveExistingGateway(ctx, existing, input)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("load workspace gateway: " + err.Error())
	}
	return s.provisionWorkspaceGateway(ctx, input)
}

func (s *RepoGatewayService) provisionWorkspaceGateway(ctx context.Context, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	workspace, err := s.loadGatewayWorkspace(ctx, input.WorkspaceID, input.RepositoryID, input.UserID)
	if err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	if strings.TrimSpace(workspace.VmID) == "" {
		if workspace.Status == "starting" || workspace.Status == "pending" {
			return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("Workspace VM provisioning is still in progress")
		}
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("workspace VM has not been provisioned")
	}
	binding := pgtype.UUID{Bytes: uuid.MustParse(input.WorkspaceID), Valid: true}
	gateway, err := s.q.CreateRepoGateway(ctx, runtimeports.CreateRepoGatewayParams{RepositoryID: input.RepositoryID, UserID: input.UserID, WorkspaceID: binding, Status: "pending"})
	if err != nil {
		if workspaceGatewaySharingConflict(err) {
			return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("coding gateways require a workspace without write shares")
		}
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("create workspace gateway: " + err.Error())
	}
	token, hash, err := generateRepoGatewayToken()
	if err != nil {
		s.markGatewayFailed(ctx, gateway.ID)
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("mint workspace gateway token").WithCause(err)
	}
	encrypted, err := s.secretCodec.EncryptString(token)
	if err != nil {
		s.markGatewayFailed(ctx, gateway.ID)
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("encrypt gateway token: " + err.Error())
	}
	gateway.WorkspaceID, gateway.RepositoryID, gateway.UserID = binding, input.RepositoryID, input.UserID
	gateway.VmID, gateway.BaseUrl = workspace.VmID, "https://"+gatewayIngressDomain(gateway)
	gateway.AuthTokenHash, gateway.AuthTokenCiphertext, gateway.Status = hash, encrypted, "starting"
	_, err = s.q.UpdateRepoGatewayExecutionInfo(ctx, runtimeports.UpdateRepoGatewayExecutionInfoParams{ID: gateway.ID, VmID: gateway.VmID, BaseUrl: gateway.BaseUrl, AuthTokenHash: hash, AuthTokenCiphertext: encrypted, Status: "starting"})
	if err != nil {
		s.markGatewayFailed(ctx, gateway.ID)
		// Nothing was installed yet. A racing provision owns a different service
		// name even on the same VM; never stop its service or delete its workspace.
		if isRepoGatewayActiveUniqueViolation(err) {
			return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("workspace gateway provisioning is in progress; retry")
		}
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("persist workspace gateway: " + err.Error())
	}
	// Existing detached singleflight supplies bounded responses and crash retry.
	// No second reservation or job ledger: the ordinary starting row is durable.
	return s.resolveExistingGateway(ctx, gateway, input)
}

func (s *RepoGatewayService) reuseWorkspaceGateway(ctx context.Context, gateway runtimeports.RepoGateway) (RepoGatewayConnectionInfo, error) {
	workspace, err := s.loadGatewayWorkspace(ctx, gateway.WorkspaceID.String(), gateway.RepositoryID, gateway.UserID)
	if err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	if workspace.VmID != gateway.VmID {
		return RepoGatewayConnectionInfo{}, fmt.Errorf("%w: workspace VM changed", errRepoGatewayUnrecoverable)
	}
	token, err := s.secretCodec.DecryptString(gateway.AuthTokenCiphertext)
	if err != nil || token == "" {
		return RepoGatewayConnectionInfo{}, fmt.Errorf("%w: gateway credential cannot be restored", errRepoGatewayUnrecoverable)
	}
	workspace, err = s.workspaces.ensureExistingWorkspaceRunning(ctx, workspace)
	if err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	if _, err = s.workspaces.ensureWorkspaceHeadReporter(ctx, workspace); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	if err = s.checkGatewayWorkspaceIdentity(ctx, gateway); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	// Healthy existing processes keep their in-flight runs. Resume and first
	// provision re-declare the same deterministic service; no legacy install,
	// clone, global pack rewrite, or engine patch is permitted in this path.
	if gateway.Status == "running" && s.healthProbeBaseURL != "" && s.probeWorkspaceGatewayHealth(ctx, gateway) == nil {
		return s.workspaceGatewayInfo(ctx, gateway, token)
	}
	// A tombstoned host may still own the process lock after a failed stop on a
	// sleeping VM. Retry only names from its durable rows, never a wildcard.
	if err = s.cleanupDiscardedWorkspaceGateways(ctx, gateway); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	timeout := int64(time.Minute / time.Millisecond)
	result, err := s.sandbox.Execute(ctx, gateway.VmID, sandbox.ExecRequest{Command: workspaceGatewayPreflight(gateway), TimeoutMS: &timeout})
	if err != nil {
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("workspace gateway preflight could not execute; retry")
	}
	if result.StatusCode != nil && *result.StatusCode == 43 {
		return RepoGatewayConnectionInfo{}, pkgerrors.New(pkgerrors.CodeCodingProviderRefreshRequired, "No usable coding model is bound. Connect a provider and resume an idle computer, or open a fresh computer. SMITHERS_CODING_IMPLEMENT_MODEL may override the default.")
	}
	if result.StatusCode == nil || *result.StatusCode != 0 {
		return RepoGatewayConnectionInfo{}, codingHostUnavailable("workspace needs the current staged Smithers 1.x coding host and native coding adapter; update its provisioned runtime")
	}
	if err = s.checkGatewayWorkspaceIdentity(ctx, gateway); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	// The developer owns this VM and can inspect same-UID environments. Never
	// copy platform/provider secrets from the standalone gateway configuration.
	// Model routing uses the workspace's existing authorized provider setup.
	env := map[string]string{
		"SMITHERS_API_KEY": token, "SMITHERS_GATEWAY_ID": gateway.ID,
		"HOME": defaultWorkspaceHome, "PATH": "/home/developer/.local/bin:/usr/local/bin:/home/developer/.bun/bin:/run/current-system/sw/bin:/usr/bin:/bin",
		"TMPDIR": defaultWorkspaceHome + "/.cache/smithers/tmp", "XDG_CACHE_HOME": defaultWorkspaceHome + "/.cache",
		"XDG_CONFIG_HOME": defaultWorkspaceHome + "/.config",
	}
	// Without these two the coding host's landing configuration resolves to
	// nothing and coding/vibe — the only flow that creates and lands a landing
	// request — is never registered, so no coding run in this workspace can
	// land. They belong to this unit's environment alone: profile.d is the
	// ordinary approved shell environment and must never inherit the token.
	landingToken, err := s.ensureWorkspaceGatewayLandingToken(ctx, &gateway)
	if err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	if landingToken != "" {
		env["SMITHERS_JJHUB_TOKEN"] = landingToken
		env["SMITHERS_JJHUB_API_URL"] = s.landingAPIBaseURL()
	}
	restartSeconds := int64(5)
	response, err := s.sandbox.CreateService(ctx, gateway.VmID, sandbox.ServiceSpec{
		Name: workspaceGatewayServiceName(gateway), Mode: sandbox.ServiceModeService,
		Exec: []string{"/bin/sh", "-c", workspaceGatewayCommand(gateway)},
		User: defaultWorkspaceUser, Workdir: defaultWorkspaceClonePath, Env: env,
		RestartPolicy: &sandbox.RestartPolicy{Kind: sandbox.RestartPolicyOnFailure, Sec: &restartSeconds},
	})
	if err != nil || !response.Success {
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("workspace gateway service could not start; retry")
	}
	if err = s.checkGatewayWorkspaceIdentity(ctx, gateway); err != nil {
		s.stopWorkspaceGateway(ctx, gateway)
		return RepoGatewayConnectionInfo{}, err
	}
	_, err = s.sandbox.PublishIngress(ctx, gatewayIngressDomain(gateway), sandbox.PublishIngressRequest{SandboxID: gateway.VmID, Port: repoGatewayPort})
	if err != nil {
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("workspace gateway ingress is not ready; retry")
	}
	if err = s.probeWorkspaceGatewayHealth(ctx, gateway); err != nil {
		if errors.Is(err, errCodingGatewayNotConfigured) {
			return RepoGatewayConnectionInfo{}, &pkgerrors.APIError{
				Status: http.StatusServiceUnavailable, Code: pkgerrors.CodeCodingGatewayNotConfigured, Message: err.Error(),
			}
		}
		if errors.Is(err, errCodingHostCapability) {
			return RepoGatewayConnectionInfo{}, codingHostUnavailable(err.Error())
		}
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("workspace coding gateway is not ready: " + err.Error())
	}
	if err = s.checkGatewayWorkspaceIdentity(ctx, gateway); err != nil {
		s.stopWorkspaceGateway(ctx, gateway)
		return RepoGatewayConnectionInfo{}, err
	}
	if _, err = s.q.UpdateRepoGatewayStatus(ctx, runtimeports.UpdateRepoGatewayStatusParams{ID: gateway.ID, Status: "running"}); err != nil {
		// The status write also checks the tombstone, closing the race after
		// the identity read above. Cleanup is scoped to this row's resources.
		s.discardGatewayAfterReuse(ctx, gateway)
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("workspace gateway changed before readiness; retry")
	}
	gateway.Status = "running"
	return s.workspaceGatewayInfo(ctx, gateway, token)
}

func (s *RepoGatewayService) checkGatewayWorkspaceIdentity(ctx context.Context, gateway runtimeports.RepoGateway) error {
	workspace, err := s.loadGatewayWorkspace(ctx, gateway.WorkspaceID.String(), gateway.RepositoryID, gateway.UserID)
	if err != nil {
		return err
	}
	if workspace.VmID != gateway.VmID || workspace.Status != "running" {
		return pkgerrors.Conflict("workspace changed while resolving gateway; retry")
	}
	// A stale detached resolve must not resurrect a gateway tombstoned by the
	// reaper. The real query filters deleted rows; tests use the same capability.
	if q, ok := s.q.(RepoGatewayRelayQuerier); ok {
		current, err := q.GetRepoGatewayByID(ctx, gateway.ID)
		if err != nil {
			return pkgerrors.Conflict("workspace gateway was removed; retry")
		}
		if current.VmID != gateway.VmID || current.WorkspaceID != gateway.WorkspaceID {
			return pkgerrors.Conflict("workspace gateway binding changed; retry")
		}
	}
	return nil
}
func (s *RepoGatewayService) workspaceGatewayInfo(ctx context.Context, gateway runtimeports.RepoGateway, token string) (RepoGatewayConnectionInfo, error) {
	if err := s.checkGatewayWorkspaceIdentity(ctx, gateway); err != nil {
		return RepoGatewayConnectionInfo{}, err
	}
	_ = s.q.TouchRepoGatewayActivity(ctx, gateway.ID)
	_ = s.workspaces.q.TouchWorkspaceActivity(ctx, gateway.WorkspaceID.String())
	return RepoGatewayConnectionInfo{BaseURL: gateway.BaseUrl, Token: token, ExpiresAt: time.Now().UTC().Add(repoGatewayTokenAdvertisedTTL), GatewayID: gateway.ID, VMID: gateway.VmID, Status: "running", WorkspaceID: gatewayWorkspaceID(gateway)}, nil
}

func workspaceGatewayPreflight(gateway runtimeports.RepoGateway) string {
	// Only nonsecret identity is passed in argv. The installed native adapter
	// itself validates root-owned config and runs as the effective owner.
	return strings.Join([]string{
		"set -eu",
		"export PATH=/usr/local/bin:/run/current-system/sw/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"test -x " + workspaceCodingHostPath,
		"flock --help | grep -q -- --no-fork",
		"install -d -o root -g root -m 0755 " + workspaceGatewayLockDirectory,
		"test ! -L " + shellQuote(workspaceGatewayLockPath(gateway)),
		// touch preserves an existing inode and its held lock across retries.
		"touch " + shellQuote(workspaceGatewayLockPath(gateway)),
		"chown root:root " + shellQuote(workspaceGatewayLockPath(gateway)),
		"chmod 0644 " + shellQuote(workspaceGatewayLockPath(gateway)),
		"test -x " + workspaceJJExportPath,
		"test -r " + workspaceCodingConfigPath,
		"case $(runuser -u developer -- env -i HOME=/home/developer USER=developer LOGNAME=developer PATH=/home/developer/.local/bin:/usr/local/bin:/run/current-system/sw/bin:/usr/bin:/bin " + workspaceCodingHostPath + " --version) in 1.*|smithers\\ 1.*) ;; *) exit 42;; esac",
		workspaceJJExportPath + " --check-config " + shellQuote(defaultWorkspaceClonePath) + " " + shellQuote(gatewayWorkspaceID(gateway)) + " " + shellQuote(fmt.Sprint(gateway.UserID)),
		// Read the same workspace-owned model selection as the service. Never
		// print environment values or copy platform credentials into the VM.
		"runuser -u developer -- /bin/sh -c " + shellQuote("if [ -r /etc/profile.d/10-smithers-agent-environment.sh ]; then . /etc/profile.d/10-smithers-agent-environment.sh; fi\n"+workspaceCodingModelFallbackScript()+"\nprintf '%s\\n' \"${SMITHERS_CODING_IMPLEMENT_MODEL-}\" | grep -Eq '^[a-z0-9-]+:[^[:space:]:]+$' || exit 43"),
		"runuser -u developer -- env HOME=/home/developer mkdir -p /home/developer/.cache/smithers/tmp",
	}, "\n")
}

func (s *RepoGatewayService) stopWorkspaceGateway(ctx context.Context, gateway runtimeports.RepoGateway) {
	if err := s.stopWorkspaceGatewayChecked(ctx, gateway); err != nil {
		slog.Warn("stop workspace gateway", "gateway_id", gateway.ID, "error", err)
	}
}

func (s *RepoGatewayService) stopWorkspaceGatewayChecked(ctx context.Context, gateway runtimeports.RepoGateway) error {
	if gateway.VmID == "" {
		return nil
	}
	q, ok := s.q.(workspaceGatewayLifecycleQuerier)
	if !ok {
		return pkgerrors.Internal("workspace gateway lifecycle store unavailable")
	}
	unit := shellQuote(workspaceGatewayServiceName(gateway) + ".service")
	command := "set -eu\nstate=$(systemctl show --property=LoadState --value " + unit + ")\n" +
		"if [ \"$state\" != not-found ]; then systemctl disable --now " + unit + "; fi\n" +
		"if systemctl is-active --quiet " + unit + "; then exit 75; fi"
	timeout := int64(15 * time.Second / time.Millisecond)
	result, err := s.sandbox.Execute(ctx, gateway.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: &timeout})
	if (err != nil && !vmAlreadyGone(err)) || (err == nil && (result.StatusCode == nil || *result.StatusCode != 0)) {
		return pkgerrors.Conflict("a discarded workspace gateway could not be stopped; retry")
	}
	if err := s.sandbox.RevokeIngress(ctx, gatewayIngressDomain(gateway)); err != nil && !vmAlreadyGone(err) {
		return pkgerrors.Conflict("discarded workspace gateway ingress could not be revoked; retry")
	}
	// The stopped process cannot use the landing credential any more, and the
	// row is going away: revoke the token itself before dropping the reference.
	s.revokeWorkspaceGatewayLandingToken(ctx, gateway)
	// A tombstone alone does not prove process death. Keep the credential
	// marker until this verified stop, so write sharing stays fenced on failure.
	if err := q.ClearDiscardedWorkspaceGatewayCredential(ctx, gateway.ID); err != nil {
		return pkgerrors.Conflict("discarded workspace gateway credential cleanup could not be saved; retry")
	}
	return nil
}

// The existing reaper also retries old credential-bearing tombstones. A VM
// asleep during deletion must not make cleanup or later write sharing permanent.
func (s *RepoGatewayService) sweepDiscardedWorkspaceGateways(ctx context.Context) {
	q, ok := s.q.(workspaceGatewayLifecycleQuerier)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, repoGatewayCleanupTimeout)
	defer cancel()
	rows, err := q.ListPendingWorkspaceGatewayCleanup(ctx)
	if err != nil {
		slog.Warn("list discarded workspace gateways", "error", err)
		return
	}
	for _, old := range rows {
		if ctx.Err() != nil {
			return
		}
		if err := q.TouchDiscardedWorkspaceGatewayCleanup(ctx, old.ID); err != nil {
			slog.Warn("record workspace gateway cleanup attempt", "gateway_id", old.ID, "error", err)
			continue
		}
		s.stopWorkspaceGateway(ctx, old)
	}
}

func (s *RepoGatewayService) cleanupDiscardedWorkspaceGateways(ctx context.Context, gateway runtimeports.RepoGateway) error {
	q, ok := s.q.(workspaceGatewayLifecycleQuerier)
	if !ok {
		return pkgerrors.Internal("workspace gateway lifecycle store unavailable")
	}
	rows, err := q.ListDiscardedWorkspaceGateways(ctx, runtimeports.ListDiscardedWorkspaceGatewaysParams{WorkspaceID: gateway.WorkspaceID.String(), VmID: gateway.VmID})
	if err != nil {
		return pkgerrors.Conflict("workspace gateway cleanup could not be checked; retry")
	}
	for _, old := range rows {
		if old.ID == gateway.ID || old.WorkspaceID != gateway.WorkspaceID || old.VmID != gateway.VmID || !old.DeletedAt.Valid {
			return pkgerrors.Internal("discarded gateway identity mismatch")
		}
		if err := s.stopWorkspaceGatewayChecked(ctx, old); err != nil {
			return err
		}
	}
	return nil
}

// A configured private host advertises this only after native binding and
// Executable.Catalog registration validate. An ordinary CLI omits it.
var errCodingHostCapability = errors.New("coding host capability unavailable")

// The deployment never configured a health probe, which is a different failure
// from a box whose staged host is stale: nothing about this box was looked at,
// no box on this pod can open a coding gateway, and only an operator setting
// SMITHERS_GATEWAY_HEALTH_PROBE_BASE_URL changes it. It used to travel as
// errCodingHostCapability and reach the caller as coding_host_unavailable,
// telling them to update a runtime that was never inspected.
var errCodingGatewayNotConfigured = errors.New("workspace gateway health probe is not configured on this deployment")

func codingHostUnavailable(message string) *pkgerrors.APIError {
	return &pkgerrors.APIError{Status: 409, Code: pkgerrors.CodeCodingHostUnavailable, Message: message}
}

func (s *RepoGatewayService) probeWorkspaceGatewayHealth(ctx context.Context, gateway runtimeports.RepoGateway) error {
	if s.healthProbeBaseURL == "" {
		return errCodingGatewayNotConfigured
	}
	return s.probeGatewayHealthChecked(ctx, gateway.ID, func(body io.Reader) error {
		var health struct {
			GatewayID       string   `json:"gatewayId"`
			WorkspaceHash   string   `json:"workspaceHash"`
			ProtocolVersion string   `json:"protocolVersion"`
			Version         string   `json:"version"`
			Capabilities    []string `json:"capabilities"`
		}
		if err := json.NewDecoder(body).Decode(&health); err != nil {
			return fmt.Errorf("%w: invalid workspace health response", errCodingHostCapability)
		}
		hash := sha256.Sum256([]byte(defaultWorkspaceClonePath))
		if health.GatewayID != gateway.ID || health.WorkspaceHash != hex.EncodeToString(hash[:])[:16] || health.ProtocolVersion != "1" || !strings.HasPrefix(health.Version, "1.") {
			return fmt.Errorf("%w: workspace identity or gateway protocol mismatch", errCodingHostCapability)
		}
		for _, capability := range health.Capabilities {
			if capability == "coding-plan/v1" {
				return nil
			}
		}
		return fmt.Errorf("%w: configured host is missing coding-plan/v1; stage the validated coding host artifact", errCodingHostCapability)
	})
}
