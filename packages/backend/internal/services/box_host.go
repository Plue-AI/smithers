package services

import (
	"context"
	"log/slog"
	"strings"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// boxHostLandingTokenName names the landing credential of one box coding
// host (a flowhost binding), so every start revokes the one before it.
func boxHostLandingTokenName(hostID string) string { return "flow-host-landing-" + hostID }

type boxHostQuerier interface {
	accessTokenStore
	providerPoolTokenLister
	HasWritableWorkspaceShares(context.Context, string) (bool, error)
}

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
	base := strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/")
	q, ok := s.q.(boxHostQuerier)
	if s.sandbox == nil || base == "" || !ok {
		return nil, nil
	}
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	if workspace.UserID != userID {
		return nil, nil
	}
	environment, err := s.boxHostAgentEnvironment(ctx, repositoryID)
	if err != nil {
		return nil, err
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
		workspaceGatewayLandingTokenScopes(repositoryID, workspace.ID), workspaceGatewayLandingTokenTTL)
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
	switch name {
	case "HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME":
		return false
	}
	return agentEnvironmentNamePattern.MatchString(name) && !strings.HasPrefix(name, "SMITHERS_")
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
func (s *WorkspaceService) KeepBoxAwake(ctx context.Context, workspaceID string) {
	if s.q == nil {
		return
	}
	if err := s.q.TouchWorkspaceActivity(ctx, workspaceID); err != nil {
		slog.Warn("record box host activity failed", "workspace_id", workspaceID, "error", err)
	}
}
