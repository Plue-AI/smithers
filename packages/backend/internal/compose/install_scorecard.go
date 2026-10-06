package compose

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
)

func composeInstallScorecard(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool) *routes.InstallScorecardHandler {
	if !config.IsSingleOwner(cfg.Auth) {
		return nil
	}
	return &routes.InstallScorecardHandler{Service: &services.ScorecardService{Pool: pool}, Authorize: func(r *http.Request) error {
		_, err := services.Authorize(r.Context(), q, "install.scorecard")
		return err
	}}
}
