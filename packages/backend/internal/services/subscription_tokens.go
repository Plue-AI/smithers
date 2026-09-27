package services

import (
	"context"
	stdErrors "errors"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
)

// A hosted deployment never stores a user's Claude.ai or ChatGPT subscription
// login, whether as a provider connection or pasted into a secret, variable or
// model credential. The writers refuse one unless the deployment sets
// feature_flags.subscription_connections (self-host only);
// subscriptiontoken.Holds is the one detector.

// refuseSubscriptionToken is the write-path guard. The message starts with
// the feature gate's text so clients treat both refusals the same way.
func refuseSubscriptionToken(allowed bool, name, value string) error {
	if allowed || !subscriptiontoken.Holds(name, value) {
		return nil
	}
	return pkgerrors.Forbidden("feature not available: this deployment does not store Claude or ChatGPT subscription tokens; use an API key")
}

// storedSubscriptionTokenRefused is the read-path refusal for an agent
// environment saved before its setup script was checked. Callers pass a 403
// through unwrapped (agentEnvironmentLoadError) so the user sees why.
func storedSubscriptionTokenRefused() error {
	return pkgerrors.Forbidden("feature not available: this repository's agent environment holds a Claude or ChatGPT subscription token; remove it and use an API key")
}

// refuseStoredSubscriptionToken is the read-path guard for a secret or
// variable saved before the write-path refusal: a path that would deliver one
// holding a subscription token refuses with the feature gate's 403 instead.
// The message names the entry, never its value.
func refuseStoredSubscriptionToken(allowed bool, kind, name, value string) error {
	if allowed || value == "" || !subscriptiontoken.Holds(name, value) {
		return nil
	}
	return pkgerrors.Forbidden("feature not available: " + kind + " " + name + " holds a Claude or ChatGPT subscription token; remove it and use an API key")
}

// rebuildRequiredMarker is the store surface that marks a repository's live
// workspaces and its snapshots as built with a subscription token.
type rebuildRequiredMarker interface {
	MarkRepositoryWorkspacesRebuildRequired(ctx context.Context, repositoryID int64) (int64, error)
	MarkRepositorySnapshotsRebuildRequired(ctx context.Context, repositoryID int64) (int64, error)
}

// markRepositoryRebuildRequired marks every live workspace and snapshot of
// the repository rebuild-required and returns how many were newly marked.
func markRepositoryRebuildRequired(ctx context.Context, q rebuildRequiredMarker, repositoryID int64) error {
	_, _, err := markRepositoryRebuildRequiredCount(ctx, q, repositoryID)
	return err
}

func markRepositoryRebuildRequiredCount(ctx context.Context, q rebuildRequiredMarker, repositoryID int64) (workspaces, snapshots int64, err error) {
	if workspaces, err = q.MarkRepositoryWorkspacesRebuildRequired(ctx, repositoryID); err != nil {
		return 0, 0, pkgerrors.Internal("mark workspaces for rebuild").WithCause(err)
	}
	if snapshots, err = q.MarkRepositorySnapshotsRebuildRequired(ctx, repositoryID); err != nil {
		return 0, 0, pkgerrors.Internal("mark workspace snapshots for rebuild").WithCause(err)
	}
	return workspaces, snapshots, nil
}

// WithWorkspaceSubscriptionTokens mirrors feature_flags.subscription_connections:
// a deployment that allows subscription tokens reuses every workspace.
func WithWorkspaceSubscriptionTokens(allowed bool) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.subscriptionTokens = allowed }
}

// refuseRebuildRequired keeps a workspace built while its repository stored
// a subscription token from being reused: resumed, entered (read-only facets
// included), forked or snapshotted. Deleting it and creating a new workspace
// is the rebuild.
func (s *WorkspaceService) refuseRebuildRequired(workspace db.Workspace) error {
	if s.subscriptionTokens || !workspace.RebuildRequiredAt.Valid {
		return nil
	}
	return pkgerrors.New(pkgerrors.CodeWorkspaceRebuildRequired, "this workspace was built with a Claude or ChatGPT subscription token; delete it and create a new workspace")
}

// refuseRebuildRequiredSnapshot keeps a snapshot of such a workspace from
// being restored.
func (s *WorkspaceService) refuseRebuildRequiredSnapshot(snapshot db.WorkspaceSnapshot) error {
	if s.subscriptionTokens || !snapshot.RebuildRequiredAt.Valid {
		return nil
	}
	return pkgerrors.New(pkgerrors.CodeWorkspaceRebuildRequired, "this snapshot was taken while its repository stored a Claude or ChatGPT subscription token; delete it and create a new workspace")
}

// agentEnvironmentLoadError keeps a refusal as it is and wraps any other load
// failure as internal.
func agentEnvironmentLoadError(err error) error {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) && apiErr.Status == 403 {
		return err
	}
	return pkgerrors.Internal("load agent environment for workspace setup").WithCause(err)
}
