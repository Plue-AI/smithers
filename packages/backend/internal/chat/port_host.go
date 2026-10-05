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
	Sources SourceReader
	// API names the person whose install API a turn's commands may read.
	// Without one, or when the turn's admitting credential is not that
	// person's browser session now, the grant carries no API and the model
	// host offers no command that reads it.
	API         CommandAPI
	credentials *turnCredentials
	logger      *slog.Logger
}

func (h PortHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	grant.ProducerBaseURL = h.ProducerBaseURL
	grant.Source = h.source(ctx, grant)
	grant.API = h.api(ctx, grant)
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

// api grants the turn its author's install API reads when the credential that
// admitted it is that author's browser session now. A lookup that fails runs
// the turn without them rather than failing a turn that may never read.
func (h PortHost) api(ctx context.Context, grant ProducerGrant) *ports.ChatTurnAPI {
	if h.API == nil {
		return nil
	}
	credential, admitted := h.credentials.credential(turnKey{userID: grant.OwnerID, runID: grant.RunID, legID: grant.LegID})
	if !admitted {
		return nil
	}
	author, err := h.API.Author(ctx, credential, grant.OwnerID)
	switch {
	case err == nil:
		return &ports.ChatTurnAPI{Author: author}
	case errors.Is(err, ports.ErrAPIForbidden):
	default:
		logger := h.logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Warn("chat turn runs without the install API after its lookup failed", "turn_id", grant.TurnID, "error", err)
	}
	return nil
}
