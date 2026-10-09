package compose

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// The broker must know that the install can import before discovering a member's
// processes or opening an owner reader. Admission/identity/confinement remain
// the registry and broker's own gates; this adds their downstream dependencies.
type transcriptImportProviders struct {
	ReceiptStore *pgxpool.Pool
	Ingest       *TranscriptIngest
	Presence     *branchPresence
	Live         *routes.LiveHandler
	Revocation   *revocation.Bus
	History      func(context.Context, int64, string) (json.RawMessage, error)
}

func (p transcriptImportProviders) bind(registry *machined.Registry) {
	if registry == nil {
		return
	}
	ready := p.ReceiptStore != nil && p.Ingest != nil && p.Ingest.Store != nil && p.Ingest.Host != nil &&
		p.Presence != nil && p.Presence.dispatcher != nil && p.Presence.branches != nil && p.Presence.queries != nil && p.Presence.sourcesReady != nil &&
		p.Live != nil && p.Live.Hub != nil && p.Live.Queries != nil && p.Live.Topics != nil && p.Live.Presence != nil && p.Revocation != nil && p.History != nil
	registry.BindTranscriptImport(ready)
}
