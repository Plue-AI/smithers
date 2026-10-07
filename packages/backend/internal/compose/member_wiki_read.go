package compose

import (
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func admitInstallExecutionWikiRead(w http.ResponseWriter, r *http.Request, q *db.Queries, next http.Handler) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	subject := services.InstallSubject{}
	var lookup error
	if len(parts) >= 5 && parts[1] == "repos" && parts[4] == "wiki" {
		repository, err := q.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
		lookup = err
		if err == nil {
			resource, source := "", ""
			if visibility := r.URL.Query().Get("visibility"); visibility == "" || visibility == "public" {
				switch {
				case r.Method == http.MethodPost && len(parts) == 6 && parts[5] == "selection":
					resource = "wiki.public-selection"
				case r.Method == http.MethodGet && len(parts) == 6 && parts[5] != "search":
					resource, source = "wiki.public-page", parts[5]
				case r.Method == http.MethodGet && len(parts) == 7 && parts[5] == "history":
					resource, source = "wiki.public-history-id", parts[6]
				case r.Method == http.MethodGet && len(parts) == 7 && parts[6] == "revisions":
					resource, source = "wiki.public-history", parts[5]
				case r.Method == http.MethodGet && len(parts) == 9 && parts[5] == "history" && parts[8] == "content":
					resource, source = "wiki.public-revision", parts[6]+":"+parts[7]
				}
			}
			subject, lookup = services.InstallExecutionWikiSubject(r.Context(), q, repository.ID, resource, source)
		}
	}
	decision, err := services.Authorize(r.Context(), q, "wiki.read", subject)
	if err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	if lookup != nil {
		writeConfirmationDispatchError(w, lookup)
		return
	}
	next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), "wiki.read", decision, subject)))
}
