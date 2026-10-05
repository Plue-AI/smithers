package chat

import (
	"context"
	"errors"
	"log/slog"

	"github.com/smithersai/smithers/packages/backend/ports"
)

type PortHost struct {
	Host            ports.ChatHost
	ProducerBaseURL string
	// Sources names the mirrored repository a turn may read. Without one, or
	// when the turn's admitting credential cannot read it now, the grant
	// carries no source and the model host offers no source tool.
	Sources     SourceReader
	credentials *turnCredentials
	logger      *slog.Logger
}

func (h PortHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	grant.ProducerBaseURL = h.ProducerBaseURL
	grant.Source = h.source(ctx, grant)
	err := h.Host.RunChatTurn(ctx, grant)
	if err == nil {
		// The host committed the turn's terminal frame: it reads no more.
		h.credentials.end(turnKey{userID: grant.OwnerID, runID: grant.RunID, legID: grant.LegID})
	}
	return err
}

// source grants the turn its mirrored main when the credential that admitted
// it can read it now. A lookup that fails runs the turn without source rather
// than failing a turn that may never read.
func (h PortHost) source(ctx context.Context, grant ProducerGrant) *ports.ChatTurnSource {
	if h.Sources == nil {
		return nil
	}
	credential, admitted := h.credentials.credential(turnKey{userID: grant.OwnerID, runID: grant.RunID, legID: grant.LegID})
	if !admitted {
		return nil
	}
	repository, err := h.Sources.Source(ctx, credential, grant.OwnerID, grant.RepositoryID)
	switch {
	case err == nil:
		return &ports.ChatTurnSource{Repository: repository}
	case errors.Is(err, ports.ErrSourceNotReady), errors.Is(err, ports.ErrSourceForbidden):
	default:
		logger := h.logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Warn("chat turn runs without source after its lookup failed", "turn_id", grant.TurnID, "error", err)
	}
	return nil
}
