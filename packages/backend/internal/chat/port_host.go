package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type PortHost struct {
	Host            ports.ChatHost
	ProducerBaseURL string
	// Sources names the mirrored repository a turn may read. Without one, or
	// when the turn's admitting credential cannot read it now, the grant
	// carries no source and the model host offers no source tool.
	Sources SourceReader
	// API issues a credential acting for the author while this producer runs.
	// Legacy turns additionally require their original browser session.
	API         CommandAPI
	credentials *turnCredentials
	logger      *slog.Logger
}

func (h PortHost) RunTurn(ctx context.Context, grant ProducerGrant) (result error) {
	grant.ProducerBaseURL = h.ProducerBaseURL
	key := turnKey{userID: grant.OwnerID, runID: grant.RunID, legID: grant.LegID}
	credential, _ := h.credentials.credential(key)
	if h.API != nil {
		api, err := h.API.Begin(ctx, credential, grant.OwnerID, grant.TurnID, grant.Generation)
		if err != nil {
			var request struct {
				SharedConversation bool `json:"sharedConversation"`
			}
			_ = json.Unmarshal(grant.Request, &request)
			// A shared turn must never spend on a model without its author-bound
			// credential. The dispatcher can retry a pre-provider infrastructure fault.
			if request.SharedConversation || !errors.Is(err, ports.ErrAPIForbidden) {
				return err
			}
		} else {
			grant.API = &api
			digest := sha256.Sum256([]byte(api.Token))
			release := h.credentials.bind(key, middleware.Credential{TokenHash: hex.EncodeToString(digest[:])})
			defer func() {
				release()
				// Preserve the legacy browser admission for a retry, but never
				// retain a revoked producer bearer or overwrite a replacement.
				if result != nil && credential.SessionHash != "" {
					h.credentials.admit(key, credential)
				}
			}()
			defer func() {
				cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				if err := h.API.End(cleanup, grant.OwnerID, api.TokenID); err != nil {
					logger := h.logger
					if logger == nil {
						logger = slog.Default()
					}
					logger.Error("chat turn credential cleanup failed", "turn_id", grant.TurnID, "error", err)
				}
			}()
		}
	}
	grant.Source = h.source(ctx, grant)
	if reader, ok := h.Sources.(interface {
		ReadAgentInstructions(context.Context, middleware.Credential, int64, int64) (string, error)
	}); ok && grant.Source != nil {
		current, admitted := h.credentials.credential(key)
		if !admitted {
			return ports.ErrSourceForbidden
		}
		instructions, err := reader.ReadAgentInstructions(ctx, current, grant.OwnerID, grant.RepositoryID)
		if err != nil {
			if errors.Is(err, ports.ErrSourceTooLarge) {
				return &ProviderRefusal{Code: "instructions_invalid", Provider: "App instructions"}
			}
			return err
		}
		grant.AgentInstructions = ports.BuiltinAppInstructions
		if instructions != "" {
			grant.AgentInstructions += "\n\n" + instructions
		}
	}
	err := h.Host.RunChatTurn(ctx, grant)
	if err == nil && grant.API == nil {
		h.credentials.end(key)
	}
	return err
}

// source grants the turn its mirrored main when its current credential
// can read it now. A lookup that fails runs the turn without source rather
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
