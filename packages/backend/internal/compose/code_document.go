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

// An install supplies its qualified document host, never its own member
// policy or daemon connection. A nil host remains dark pending the real-machine
// document activation checks; no boolean or alternate file writer bypasses it.
func composeCodeDocumentRelay(host *live.CodeDocuments, workspaces *services.WorkspaceService, registry *machined.Registry) *live.DocRelay {
	if host == nil || host.Library == nil || workspaces == nil || registry == nil {
		return nil
	}
	return &live.DocRelay{
		Host: host,
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
