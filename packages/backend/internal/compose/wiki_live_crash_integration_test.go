package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type wikiCrashNative struct{ native *repohostffi.Client }

func (n wikiCrashNative) MergeWikiDocument(_ context.Context, _, _ string, input repohost.WikiDocumentRequest) (repohost.WikiDocumentResult, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return repohost.WikiDocumentResult{}, err
	}
	return n.native.WikiDocument(string(raw))
}

// This is a test subprocess, never a production kill hook. The parent owns its
// database and kills only the process it started, after a real saved receipt.
func TestWikiHostCrashChild(t *testing.T) {
	databaseURL := os.Getenv("SMITHERS_WIKI_CRASH_DATABASE")
	if databaseURL == "" {
		t.Skip("only the wiki receipt test starts this child")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := postgresfixture.Open(ctx, databaseURL, 8)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	path := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	native := repohostffi.New(path)
	require.NoError(t, native.Load())
	wiki := services.NewWikiService(q, nil, services.WithWikiCollaboration(q, wikiCrashNative{native}), services.WithWikiContent(blob.NewMemoryStore()))
	library, err := livedocument.Load(path)
	require.NoError(t, err)
	defer library.Close()
	host := composeWikiHost(ctx, library, q, wiki)
	defer host.Close()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	cfg.Auth.SessionCookieName = "session"
	topics := &liveTopics{queries: q, wikiDocuments: host}
	var origin string
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{live: handler, wiki: wiki}).ServeHTTP(w, r)
	}))
	defer server.Close()
	origin = server.URL
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	require.NoError(t, os.WriteFile(os.Getenv("SMITHERS_WIKI_CRASH_ADDRESS"), []byte(origin), 0600))
	<-ctx.Done()
}
