package compose

import (
	"context"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// The native CLI uses the existing installing-user socket, never a browser
// session or a delegated token. Missing providers refuse before writing a freeze.
func startInstallMaintenanceHandoff(ctx context.Context, stateDir string, pool *pgxpool.Pool, emit func(context.Context, io.Writer) error, database ports.InstallMaintenanceDatabase, summary ports.InstallMaintenanceSummary, coordinated ...*services.InstallQuiesce) (func() error, error) {
	var service *services.InstallQuiesce
	if len(coordinated) == 1 {
		service = coordinated[0]
	}
	if service == nil {
		service = services.NewInstallQuiesce(&services.QuiesceGate{Store: services.InstallQuiesceStore{Pool: pool}, StateDir: stateDir})
	}
	h := &routes.InstallQuiesceHandler{Owners: db.New(pool), Service: service, Database: database, Summary: summary}
	return services.StartInstallSetupHandoff(ctx, stateDir, emit, http.HandlerFunc(h.HandleInstallingOwner))
}
