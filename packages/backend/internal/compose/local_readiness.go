package compose

import (
	"context"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// withLocalReadiness probes the in-process repository transport instead of a
// separate repo-host listener. The same product DB check remains in both modes.
func withLocalReadiness(next http.Handler, db routes.HealthzChecker, repository *repohost.Client, blobs blob.Store) http.Handler {
	const localRepositoryURL = "http://repository.local"
	checkRepository := func(string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return repository.Health(ctx, localRepositoryURL)
	}
	health := routes.NewHealthzHandler(db, localRepositoryURL)
	health.SetHTTPCheck(checkRepository)
	ready := routes.NewReadyzHandler(db, localRepositoryURL)
	ready.SetHTTPCheck(checkRepository)
	if storage, ok := blobs.(interface{ CheckHeadroom() error }); ok {
		ready.SetStorageCheck(storage.CheckHeadroom)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			switch r.URL.Path {
			case "/healthz":
				health.Healthz(w, r)
				return
			case "/readyz":
				ready.Readyz(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
