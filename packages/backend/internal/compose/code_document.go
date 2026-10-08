package compose

import (
	"context"
	"errors"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// composeCodeDocumentRelay binds the relay to member admission and the
// authenticated daemon link. Documents live in the daemon (ADR 0003); the host
// runs no document core for code and has no alternate file writer.
func composeCodeDocumentRelay(workspaces *services.WorkspaceService, registry *machined.Registry) *live.DocRelay {
	if workspaces == nil || registry == nil {
		return nil
	}
	return &live.DocRelay{
		Authorize: func(ctx context.Context, topic live.DocumentTopic, repository, member int64) ([]byte, string) {
			actor, err := workspaces.AdmitCodeDocument(ctx, topic.Branch, topic.Path, repository, member)
			if err != nil {
				var api *pkgerrors.APIError
				if errors.Is(err, machined.ErrNotReady) || errors.As(err, &api) && api.Status == http.StatusServiceUnavailable {
					return nil, live.Unsupported
				}
				return nil, live.Forbidden
			}
			link, err := registry.Current(topic.Branch)
			if err != nil {
				return nil, live.Unsupported
			}
			if err := link.Connection.RequireMachine(topic.Branch, actor.MachineID); err != nil {
				return nil, live.Unsupported
			}
			return actor.Reference, ""
		},
		Connection: func(_ context.Context, branch string) (*machined.Connection, live.DocumentRPC) {
			link, err := registry.Current(branch)
			if err != nil {
				return nil, nil
			}
			return link.Connection, machined.Documents(registry, branch)
		},
	}
}
