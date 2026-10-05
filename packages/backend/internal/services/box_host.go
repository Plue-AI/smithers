package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// boxHostLandingTokenName names the landing credential of one box coding
// host (a flowhost binding), so every start revokes the one before it.
func boxHostLandingTokenName(hostID string) string { return "flow-host-landing-" + hostID }

// boxHostLandingTokenTTL bounds the coding host's landing credential. Every
// stop revokes it, so the TTL is only a leak backstop for a host whose box
// disappears without a verified stop. It matches the workspace head token.
const boxHostLandingTokenTTL = 7 * 24 * time.Hour

// boxHostLandingTokenScopes is the minimum the coding/vibe landing flow
// needs: it lists bookmarks, prepares an append, creates the landing request
// and queues the append, all under write:repository (which implies
// read:repository). repo:<id> narrows the credential to the box's repository,
// so a leaked token cannot act on the owner's other repositories. Unlike the
// head-reporter token it carries NO workspace:<id> restriction: a
// workspace-bound token may only push and report that workspace's head ref and
// is refused on every landing route. The existing agent-authorship contract
// is a path-bound repository token: the host can edit the whole repository,
// ** preserves that boundary while distinguishing its submissions from a
// human PAT, and the inert workspace entry records which box opens each
// landing.
func boxHostLandingTokenScopes(repositoryID int64, workspaceID string) string {
	return strings.Join(append([]string{string(middleware.ScopeWriteRepository), middleware.RepositoryRestrictionScope(repositoryID),
		middleware.LandingWorkspaceScope(workspaceID)}, middleware.PathRestrictionScopes([]string{"**"})...), ",")
}

// boxHostCacheTokenName names the build-cache read credential of one box
// coding host, minted and revoked with its landing credential.
func boxHostCacheTokenName(hostID string) string { return "flow-host-cache-" + hostID }

// boxHostCacheTokenScopes lets the coding host's checks read the repository's
// remote target cache and nothing else. It never publishes: it is a
// system-issued credential, which BuildCacheAccess never classifies as a
// writer, and it lacks write:repository besides. It is a separate credential
// from the landing one because checks run the change's unreviewed code, which
// must not hold a credential that can land. The inert workspace entry lets a
// box's stop revoke it.
func boxHostCacheTokenScopes(repositoryID int64, workspaceID string) string {
	return strings.Join([]string{string(middleware.ScopeReadRepository), middleware.RepositoryRestrictionScope(repositoryID),
		middleware.LandingWorkspaceScope(workspaceID)}, ",")
}

// boxHostTokenName reports whether a token is one a box coding host holds.
func boxHostTokenName(name string) bool {
	return strings.HasPrefix(name, boxHostLandingTokenName("")) || strings.HasPrefix(name, boxHostCacheTokenName(""))
}

type boxHostQuerier interface {
	accessTokenStore
	providerPoolTokenLister
	WorkspaceSoleWriter(context.Context, db.WorkspaceSoleWriterParams) (bool, error)
	GetRepoByID(context.Context, int64) (db.Repository, error)
	GetUserByID(context.Context, int64) (db.User, error)
	GetOrgByID(context.Context, int64) (db.Organization, error)
}

var _ boxHostQuerier = (*db.Queries)(nil)

// PrepareBoxHost readies the owner's running box for its coding host, just
// before the host starts, and answers the host's per-start environment
// (#2198): the box's agent environment, and, on an unshared box, the
// repository-scoped landing credential that coding/vibe and the
// repository-job callbacks use, after restoring the source publisher and the
// root-owned landing binding (/etc/smithers/workspace-coding.json) it needs,
// plus SMITHERS_CACHE_URL and a read-only SMITHERS_CACHE_TOKEN for the
// repository's remote target cache, which the host forwards to its checks.
// A sandboxed self-host runtime installs the same binding through its narrow
// provisioning capability. A box with write shares gets no credential: a guest with the
// owner's UID could read it.
func (s *WorkspaceService) PrepareBoxHost(ctx context.Context, hostID, workspaceID string, repositoryID, userID int64) (map[string]string, error) {
	if err := s.verifyBoxTools(ctx, hostID, workspaceID, repositoryID, userID); err != nil {
		return nil, err
	}
	environment, err := s.boxHostAgentEnvironment(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/")
	q, ok := s.q.(boxHostQuerier)
	guest := s.runtime != nil && s.runtime.Isolation() == workspaceapi.IsolationSandboxed
	// A trusted-process box is a host process, never a sandbox client's VM,
	// even when the composition also holds a sandbox client. It binds its
	// source as a runtime guest does only when its runtime installs a
	// binding: no install composes one; a test runtime that publishes does.
	process := s.runtime != nil && s.runtime.Isolation() == workspaceapi.IsolationTrustedProcess
	_, installs := s.runtime.(workspaceapi.WorkspaceCodingBindingInstaller)
	runtimeBinding := (guest && s.sandbox == nil) || (process && installs)
	if (s.sandbox == nil || process) && !guest && !runtimeBinding {
		return environment, nil
	}
	if base == "" || !ok {
		if guest || runtimeBinding {
			return nil, pkgerrors.Conflict("workspace coding source binding configuration is unavailable")
		}
		return environment, nil
	}
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	// Only a box that is the user's alone gets the user's credential: their
	// own with no write share, or a branch machine shared with them only.
	alone, err := q.WorkspaceSoleWriter(ctx, db.WorkspaceSoleWriterParams{WorkspaceID: workspace.ID, UserID: userID})
	if err != nil || !alone {
		return environment, err
	}
	if runtimeBinding {
		if err = s.installRuntimeBoxCodingBinding(ctx, workspace, userID); err != nil {
			return nil, err
		}
	} else {
		if _, err = s.ensureWorkspaceHeadReporter(ctx, workspace); err != nil {
			return nil, err
		}
		// The host runs the box's helper: bring it to this release first (#3111).
		if err = s.ensureWorkspaceCodingRuntime(ctx, workspace); err != nil {
			return nil, err
		}
	}
	repository, err := q.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	owner, err := repositoryOwnerName(ctx, q, repository)
	if err != nil {
		return nil, err
	}
	s.RetireBoxHostCredential(ctx, hostID, userID)
	token, err := issueTemporaryRepoTokenWithTTL(ctx, q, userID, boxHostLandingTokenName(hostID),
		boxHostLandingTokenScopes(repositoryID, workspace.ID), boxHostLandingTokenTTL)
	if err != nil {
		return nil, err
	}
	cache, err := issueTemporaryRepoTokenWithTTL(ctx, q, userID, boxHostCacheTokenName(hostID),
		boxHostCacheTokenScopes(repositoryID, workspace.ID), boxHostLandingTokenTTL)
	if err != nil {
		revokeTemporaryRepoCloneToken(ctx, q, userID, token.ID)
		return nil, err
	}
	environment["SMITHERS_JJHUB_TOKEN"], environment["SMITHERS_JJHUB_API_URL"] = token.Plaintext, base+"/api"
	environment["SMITHERS_CACHE_TOKEN"] = cache.Plaintext
	environment["SMITHERS_CACHE_URL"] = base + "/api/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repository.Name) + "/build-cache"
	return environment, nil
}

// boxHostAgentEnvironment is what the box's profile gives every shell: the
// repository's nonsecret agent variables and a placeholder for each
// egress-bound secret, which the box's egress proxy swaps for its value. The
// coding host's agents run their tools with it. Smithers' own names and the
// host's paths stay the host's.
func (s *WorkspaceService) boxHostAgentEnvironment(ctx context.Context, repositoryID int64) (map[string]string, error) {
	environment := map[string]string{}
	if s.agentEnvironment == nil {
		return environment, nil
	}
	config, err := s.agentEnvironment.LoadForProvisioning(ctx, repositoryID)
	if err != nil {
		return nil, agentEnvironmentLoadError(err)
	}
	for _, variable := range config.Env {
		if boxHostAgentVariable(variable.Name) {
			environment[variable.Name] = variable.Value
		}
	}
	for _, name := range config.ProxyBound {
		if boxHostAgentVariable(name) {
			environment[name] = sandbox.EgressProxyPlaceholder(name)
		}
	}
	return environment, nil
}

func boxHostAgentVariable(name string) bool {
	return agentEnvironmentNamePattern.MatchString(name) && flowhost.RepositoryVariable(name)
}

// RetireBoxHostCredential revokes a box coding host's landing and cache
// credentials when the host stops, is replaced, or fails to start.
func (s *WorkspaceService) RetireBoxHostCredential(ctx context.Context, hostID string, userID int64) {
	q, ok := s.q.(boxHostQuerier)
	if !ok || userID <= 0 {
		return
	}
	tokens, err := q.ListAccessTokensByUserID(ctx, userID)
	if err != nil {
		slog.Warn("list box host credentials failed", "host_id", hostID, "error", err)
		return
	}
	for _, token := range tokens {
		if token.Name == boxHostLandingTokenName(hostID) || token.Name == boxHostCacheTokenName(hostID) {
			revokeTemporaryRepoCloneToken(ctx, q, userID, token.ID)
		}
	}
}

// KeepBoxAwake records activity on a box whose coding host is being used, so
// the idle sweep does not suspend it under a run that is progressing.
// It writes at most once per boxHostActivityInterval per box, far inside any
// idle timeout.
func (s *WorkspaceService) KeepBoxAwake(ctx context.Context, workspaceID string) {
	if s.q == nil || s.boxHostActivity == nil {
		return
	}
	now := time.Now()
	if last, ok := s.boxHostActivity.Load(workspaceID); ok && now.Sub(last.(time.Time)) < boxHostActivityInterval {
		return
	}
	s.boxHostActivity.Store(workspaceID, now)
	if err := s.q.TouchWorkspaceActivity(ctx, workspaceID); err != nil {
		s.boxHostActivity.Delete(workspaceID)
		slog.Warn("record box host activity failed", "workspace_id", workspaceID, "error", err)
	}
}

const boxHostActivityInterval = time.Minute

// RestartLostBox starts again a box the product holds running whose runtime
// no longer runs it: a backend restart stops every workspace. A box stopped,
// suspended or deleted on purpose is refused, never woken by its host.
//
// A box the runtime no longer has at all is replaced under the same workspace
// when its hosts' journals live in PostgreSQL (#1868): parked runs and their
// approvals are in the journal, not the box, so the resolver restarts the
// host on the replacement at a new owner generation. With journals in the
// box, the loss stays a refusal.
func (s *WorkspaceService) RestartLostBox(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return err
	}
	if workspace.UserID != userID || s.runtime == nil {
		return pkgerrors.Conflict("workspace is not held running")
	}
	// One critical section, so a stop or suspend that lands meanwhile is
	// never undone by this start.
	unlock := s.lockRuntimeWorkspace(workspace.ID)
	defer unlock()
	current, err := s.currentRuntimeWorkspaceLocked(ctx, workspace)
	if err != nil {
		return err
	}
	if current.Status != "running" {
		return pkgerrors.Conflict("workspace is not held running")
	}
	if s.flowJournals != nil {
		if err := s.replaceMissingBoxLocked(ctx, current, userID); err != nil {
			return err
		}
	}
	_, err = s.ensureRuntimeWorkspaceRunningLocked(ctx, current, userID)
	return err
}

// replaceMissingBoxLocked creates a box the runtime lost outright again,
// under the same workspace ID, after ending the lost box's journal sessions.
// A box with no journal database (its host kept SQLite in the box) is left
// missing, so the start that follows refuses it. The start prepares a
// replacement like a fresh box: repository checkout included.
func (s *WorkspaceService) replaceMissingBoxLocked(ctx context.Context, row db.Workspace, requesterID int64) error {
	inspectCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "inspect"))
	if err != nil {
		return err
	}
	if _, err := s.runtime.InspectWorkspace(inspectCtx, row.ID); !errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return nil
	}
	if err := s.authorizeWorkspaceResume(ctx, row); err != nil {
		return err
	}
	if err := s.withholdRuntimeConversation(ctx, row, requesterID); err != nil {
		return err
	}
	journaled, err := s.flowJournals.Fence(ctx, row.ID)
	if err != nil {
		return pkgerrors.Internal("fence the lost box's flow journal").WithCause(err)
	}
	if !journaled {
		return nil
	}
	spec, err := s.runtimeWorkspaceSpec(ctx, row)
	if err != nil {
		return err
	}
	createCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "replace"))
	if err != nil {
		return err
	}
	observed, err := s.runtime.CreateWorkspace(createCtx, spec)
	if err != nil {
		return runtimeOperationError("replace workspace runtime", err)
	}
	if err := validateRuntimeWorkspace(row.ID, observed); err != nil {
		return pkgerrors.Internal(err.Error())
	}
	slog.InfoContext(ctx, "workspace box replaced", "workspace_id", row.ID, "repository_id", row.RepositoryID, "vm_id", row.VmID)
	return nil
}

// retireBoxHostCredentials revokes every credential minted for a
// box's coding hosts when the box stops, suspends or is destroyed: its host
// process ends with it, and the next start mints its own.
func (s *WorkspaceService) retireBoxHostCredentials(ctx context.Context, workspace db.Workspace) {
	q, ok := s.q.(boxHostQuerier)
	if !ok || workspace.UserID <= 0 {
		return
	}
	tokens, err := q.ListAccessTokensByUserID(ctx, workspace.UserID)
	if err != nil {
		slog.Warn("list box host credentials failed", "workspace_id", workspace.ID, "error", err)
		return
	}
	scope := middleware.LandingWorkspaceScope(workspace.ID)
	for _, token := range tokens {
		if boxHostTokenName(token.Name) && slices.Contains(strings.Split(token.Scopes, ","), scope) {
			revokeTemporaryRepoCloneToken(ctx, q, workspace.UserID, token.ID)
		}
	}
}

// workspaceGatewaySharingConflict reports the refusal of a write share on a
// box whose coding host is starting or running (product migration 0049), or
// whose retired gateway still holds its credential (the deployment's fence).
func workspaceGatewaySharingConflict(err error) bool {
	var constraint *pgconn.PgError
	return errors.As(err, &constraint) && constraint.Code == "23514" && constraint.ConstraintName == "workspace_gateway_private_execution"
}

// WithWorkspaceBoxTools names the tools a box's placement declares
// (MythicalService.LaneTools), so every coding host start first verifies the
// booted box has them.
func WithWorkspaceBoxTools(tools func(ctx context.Context, workspaceID string) ([]string, error)) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.boxTools = tools }
}

// boxToolsProbe prints each argument that is not a command on the login
// shell's PATH, one per line.
const boxToolsProbe = `for tool do command -v "$tool" >/dev/null 2>&1 || printf '%s\n' "$tool"; done`

// verifyBoxTools runs no host on a box that lacks a tool its placement
// declares: the start fails with a typed refusal the run cannot retry past.
func (s *WorkspaceService) verifyBoxTools(ctx context.Context, hostID, workspaceID string, repositoryID, userID int64) error {
	if s.boxTools == nil {
		return nil
	}
	tools, err := s.boxTools(ctx, workspaceID)
	if err != nil || len(tools) == 0 {
		return err
	}
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().Execution {
		return boxToolsMissing{tools: tools}
	}
	row, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return err
	}
	// The box runs before its host starts; a box that is not running yet
	// fails the probe as it would fail the start, and the start is retried.
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, workspaceLifecycleOperation(row, "box-tools:"+hostID))
	if err != nil {
		return err
	}
	result, err := s.runtime.ExecuteCommand(operationCtx, row.ID, workspaceapi.Command{
		Args: append([]string{"/bin/sh", "-lc", boxToolsProbe, "sh"}, tools...),
	})
	if err != nil {
		return runtimeOperationError("verify the box's tools", err)
	}
	if result.ExitCode != 0 || result.OutputTruncated {
		return pkgerrors.Internal(fmt.Sprintf("verify the box's tools: the probe exited %d", result.ExitCode))
	}
	var missing []string
	for _, tool := range strings.Fields(result.Stdout) {
		if slices.Contains(tools, tool) && !slices.Contains(missing, tool) {
			missing = append(missing, tool)
		}
	}
	if len(missing) > 0 {
		return boxToolsMissing{tools: missing}
	}
	return nil
}

// boxToolsMissing refuses a host start on a box without its declared tools.
type boxToolsMissing struct{ tools []string }

func (e boxToolsMissing) Error() string {
	return "the box lacks the declared tools " + strings.Join(e.tools, ", ")
}
func (boxToolsMissing) FlowRuntimeCode() string    { return placementToolsMissing }
func (boxToolsMissing) FlowRuntimeRetryable() bool { return false }
