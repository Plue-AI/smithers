package services

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
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

type boxHostQuerier interface {
	accessTokenStore
	providerPoolTokenLister
	HasWritableWorkspaceShares(context.Context, string) (bool, error)
}

var _ boxHostQuerier = (*db.Queries)(nil)

// PrepareBoxHost readies the owner's running box for its coding host, just
// before the host starts, and answers the host's per-start environment
// (#2198): the box's agent environment, and, on an unshared box, the
// repository-scoped landing credential that coding/vibe and the
// repository-job callbacks use, after restoring the source publisher and the
// root-owned landing binding (/etc/smithers/workspace-coding.json) it needs.
// A runtime without that binding (a self-host process or microVM runtime)
// answers none. A box with write shares gets no credential: a guest with the
// owner's UID could read it.
func (s *WorkspaceService) PrepareBoxHost(ctx context.Context, hostID, workspaceID string, repositoryID, userID int64) (map[string]string, error) {
	environment, err := s.boxHostAgentEnvironment(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/")
	q, ok := s.q.(boxHostQuerier)
	if s.sandbox == nil || base == "" || !ok {
		return environment, nil
	}
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	if workspace.UserID != userID {
		return environment, nil
	}
	shared, err := q.HasWritableWorkspaceShares(ctx, workspace.ID)
	if err != nil || shared {
		return environment, err
	}
	if _, err = s.ensureWorkspaceHeadReporter(ctx, workspace); err != nil {
		return nil, err
	}
	s.RetireBoxHostCredential(ctx, hostID, userID)
	token, err := issueTemporaryRepoTokenWithTTL(ctx, q, userID, boxHostLandingTokenName(hostID),
		boxHostLandingTokenScopes(repositoryID, workspace.ID), boxHostLandingTokenTTL)
	if err != nil {
		return nil, err
	}
	environment["SMITHERS_JJHUB_TOKEN"], environment["SMITHERS_JJHUB_API_URL"] = token.Plaintext, base+"/api"
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

// RetireBoxHostCredential revokes a box coding host's landing credential when
// the host stops, is replaced, or fails to start.
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
		if token.Name == boxHostLandingTokenName(hostID) {
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
func (s *WorkspaceService) RestartLostBox(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return err
	}
	if workspace.UserID != userID || workspace.Status != "running" || s.runtime == nil {
		return pkgerrors.Conflict("workspace is not held running")
	}
	_, err = s.ensureRuntimeWorkspaceRunning(ctx, workspace, userID)
	return err
}

// retireBoxHostCredentials revokes every landing credential minted for a
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
		if strings.HasPrefix(token.Name, boxHostLandingTokenName("")) && slices.Contains(strings.Split(token.Scopes, ","), scope) {
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
