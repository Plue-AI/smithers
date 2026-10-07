package routes

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/http/httptest"
	"strings"
)

type wikiRoutesFixture struct{}

func (*wikiRoutesFixture) GetWikiDocument(context.Context, *db.User, string, string, string) (services.WikiDocumentResponse, error) {
	return services.WikiDocumentResponse{State: "AAA="}, nil
}
func wikiRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	return withAuth(withRepoCtx(withRouteParams(r, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"}), 42, "alice", "demo"), 7, "alice")
}
