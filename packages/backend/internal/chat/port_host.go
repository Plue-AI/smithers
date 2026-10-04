package chat

import (
	"context"
	"errors"
	"fmt"

	"github.com/smithersai/smithers/packages/backend/ports"
)

type PortHost struct {
	Host            ports.ChatHost
	ProducerBaseURL string
	// Sources names the mirrored repository a turn's author may read. Without
	// one, or when Source is not ready for the author, the grant carries no
	// source and the model host offers no source tool.
	Sources SourceReader
}

func (h PortHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	grant.ProducerBaseURL = h.ProducerBaseURL
	if h.Sources != nil {
		repository, err := h.Sources.Source(ctx, grant.OwnerID, grant.RepositoryID)
		switch {
		case err == nil:
			grant.Source = &ports.ChatTurnSource{Repository: repository}
		case errors.Is(err, ports.ErrSourceNotReady), errors.Is(err, ports.ErrSourceForbidden):
			// The turn runs without the source tool.
		default:
			// The provider has not started, so the dispatcher reruns the turn.
			return fmt.Errorf("resolve turn source: %w", err)
		}
	}
	return h.Host.RunChatTurn(ctx, grant)
}
