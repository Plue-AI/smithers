package compose

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
)

// openAPIPath is the published product API every client is generated from.
// scripts/openapi-bundle.mjs bundles it from the per-tag sources.
const openAPIPath = "../../../../docs/api/openapi.yaml"

// openAPISources holds one source file per tag; see scripts/openapi-bundle.mjs.
const openAPISources = "../../../../docs/api/openapi"

// openAPIUpdateEnv, when "1", appends a skeleton operation for every served
// route the document lacks to its tag's source. Re-bundle, then tighten its
// schemas by hand.
const openAPIUpdateEnv = "SMITHERS_UPDATE_OPENAPI"

var openAPIMethods = []string{"get", "put", "post", "delete", "options", "head", "patch", "trace"}

// servedRoute is one "method path" the composed backend answers under
// /api/ or /webhooks/.
type servedRoute struct {
	method, path string
	authed       bool
}

func (r servedRoute) key() string { return r.method + " " + r.path }

var chiParamPattern = regexp.MustCompile(`\{([^}:]+):[^}]*\}`)

// openAPIRoutePath maps a chi pattern to its OpenAPI path: regexp parameters
// lose their pattern and a trailing catch-all becomes {path}.
func openAPIRoutePath(pattern string) string {
	path := chiParamPattern.ReplaceAllString(pattern, "{$1}")
	if strings.HasSuffix(path, "/*") {
		path = strings.TrimSuffix(path, "*") + "{path}"
	}
	if len(path) > 1 {
		path = strings.TrimSuffix(path, "/")
	}
	return path
}

func TestOpenAPIRoutePath(t *testing.T) {
	t.Parallel()
	for pattern, want := range map[string]string{
		"/api/repos/{owner}/{repo}":                                  "/api/repos/{owner}/{repo}",
		"/api/repos/{owner}/{repo}/":                                 "/api/repos/{owner}/{repo}",
		"/api/repos/{owner}/{repo}/protected-bookmarks/{pattern:.*}": "/api/repos/{owner}/{repo}/protected-bookmarks/{pattern}",
		"/api/repos/{owner}/{repo}/contents/*":                       "/api/repos/{owner}/{repo}/contents/{path}",
		"/api/model/openai/*":                                        "/api/model/openai/{path}",
		"/api/x/{id:[0-9]+}/{name}":                                  "/api/x/{id}/{name}",
		"/":                                                          "/",
	} {
		require.Equal(t, want, openAPIRoutePath(pattern), pattern)
	}
}

var requireAuthPointer = reflect.ValueOf(middleware.RequireAuth).Pointer()

func walkServedRoutes(t *testing.T, router chi.Routes, into map[string]servedRoute) {
	t.Helper()
	require.NoError(t, chi.Walk(router, func(method, pattern string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(pattern, "/api/") && !strings.HasPrefix(pattern, "/webhooks/") {
			// Git transport, health probes, metrics and /internal callbacks
			// are not part of the product API.
			return nil
		}
		route := servedRoute{method: strings.ToLower(method), path: openAPIRoutePath(pattern)}
		for _, mw := range middlewares {
			if reflect.ValueOf(mw).Pointer() == requireAuthPointer {
				route.authed = true
			}
		}
		if previous, ok := into[route.key()]; ok {
			route.authed = route.authed || previous.authed
		}
		into[route.key()] = route
		return nil
	}))
}

// openAPIConformanceRouter composes every optional product handler so each
// route family a deployment can enable is mounted.
func openAPIConformanceRouter(cfg *config.Config) chi.Router {
	queries := db.New(nil)
	authHandler := &routes.AuthHandler{}
	if config.IsSingleOwner(cfg.Auth) {
		authHandler.LocalService = (*services.AuthService)(nil)
	}
	workspaceHandler := &routes.WorkspaceHandler{
		Desktop:           &routes.WorkspaceDesktopHandler{Service: (*services.WorkspaceService)(nil)},
		EnvironmentImages: &routes.SandboxEnvironmentImageHandler{},
	}
	wiki := services.NewWikiService(nil, nil, services.WithWikiCollaboration(nil, nil), services.WithWikiContent(nil))
	router := buildRouter(cfg, queries, nil,
		&routes.RepoHandler{}, &routes.GitMirrorSyncHandler{}, authHandler, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.DeployKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.ChangesetHandler{}, &routes.BuildCacheHandler{}, &routes.StackHandler{}, &routes.SearchHandler{}, &routes.IssueHandler{},
		wiki, &routes.GitSmartHandler{}, &routes.NotificationHandler{}, &routes.PairSessionHandler{},
		&routes.AdminUserHandler{}, &routes.AdminOrgHandler{}, &routes.AdminRepoHandler{}, &routes.AdminGitHubAppHandler{}, &routes.AdminAuditHandler{},
		&routes.WebhookHandler{}, &routes.SecretHandler{}, &routes.ProviderConnectionHandler{}, &routes.VariableHandler{}, &routes.BillingHandler{},
		&routes.ProtectedBookmarkHandler{}, &routes.CommitStatusHandler{}, &routes.LFSHandler{}, &routes.JJVCSHandler{}, &routes.AgentInternalHandler{},
		&routes.AgentSessionHandler{}, &routes.AgentSessionStreamHandler{}, &routes.ApprovalsHandler{}, &routes.BranchLockHandler{}, &routes.InternalPushHookHandler{},
		&routes.WorkflowHandler{}, &routes.WorkflowCacheHandler{}, &routes.WorkflowArtifactHandler{},
		&routes.IssueEventHandler{}, workspaceHandler, &routes.WorkspaceInternalHandler{}, &routes.RepositoryJobHandler{}, &routes.GitHubProxyHandler{},
		&routes.GitHubRepoListHandler{}, &routes.GitHubUserReposHandler{}, &routes.GitHubSyncedReposHandler{}, &routes.GitHubImportHandler{},
		&routes.WorkspaceTerminalHandler{}, &routes.TelemetryHandler{}, &routes.FeatureFlagHandler{}, &routes.OAuth2Handler{}, &routes.LinearIntegrationHandler{},
		&routes.GitHubWebhookHandler{}, routes.NewSmithersMetrics(),
		routerExtras{
			BillingCapabilities: services.BillingCapabilities{Overview: true, Plans: true, Checkout: true, Portal: true, Webhook: true},
			Recommender:         &routes.RecommendationHandler{}, ModelStream: &routes.ModelStreamHandler{}, Mythical: &routes.MythicalHandler{},
			UserRefs: &routes.UserRefHandler{}, AdminSystemStatus: &routes.AdminSystemStatusHandler{}, AdminSystemHealth: &routes.AdminSystemHealthHandler{},
			AdminAnalytics: &routes.AdminAnalyticsHandler{}, AdminAgentSessions: &routes.AdminAgentSessionHandler{},
			AdminWorkspaces: &routes.AdminWorkspaceHandler{}, AdminTokens: &routes.AdminTokenHandler{}, ModelProxy: http.NotFoundHandler(),
		},
	)
	// The routes run() mounts beside buildRouter.
	mountBrowserFlow(router, cfg, queries, &browserFlowAPI{}, &repositorySetupAPI{})
	mountChatPublic(router, &chat.Runtime{Handler: &chat.Handler{}}, queries, cfg)
	mountModelPublic(router, modelhost.OwnerModels{}, queries, cfg)
	return router
}

// servedAPIRoutes is the union of the self-hosted and multitenant compositions,
// plus the bootstrap document withAppBootstrap serves in front of the router.
func servedAPIRoutes(t *testing.T) map[string]servedRoute {
	t.Helper()
	selfHosted := testConfigAllFlagsOn()
	selfHosted.Auth.Mode = config.AuthModeSelfHosted
	selfHosted.FeatureFlags.Integrations = true
	multitenant := testConfigAllFlagsOn()
	multitenant.Auth.Mode = config.AuthModeMultitenant
	multitenant.Auth.EnableKeyAuth = true
	multitenant.FeatureFlags.Integrations = true

	served := map[string]servedRoute{}
	for _, cfg := range []*config.Config{selfHosted, multitenant} {
		walkServedRoutes(t, openAPIConformanceRouter(cfg), served)
	}
	// A pattern mounted for every method (chi also lists CONNECT for it) is
	// a byte relay such as the desktop viewer, not a described operation.
	for _, route := range served {
		if route.method == "connect" {
			for key, other := range served {
				if other.path == route.path {
					delete(served, key)
				}
			}
		}
	}
	bootstrap := withAppBootstrap(http.NotFoundHandler(), appBootstrap{}, cors.Options{})
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		recorder := httptest.NewRecorder()
		bootstrap.ServeHTTP(recorder, httptest.NewRequest(method, "/api/bootstrap", nil))
		require.Equal(t, http.StatusOK, recorder.Code, "%s /api/bootstrap", method)
		route := servedRoute{method: strings.ToLower(method), path: "/api/bootstrap"}
		served[route.key()] = route
	}
	return served
}

func loadOpenAPIPaths(t *testing.T) *yaml.Node {
	t.Helper()
	data, err := os.ReadFile(openAPIPath)
	require.NoError(t, err)
	var document yaml.Node
	require.NoError(t, yaml.Unmarshal(data, &document))
	root := document.Content[0]
	paths := mappingValue(root, "paths")
	require.NotNil(t, paths, "OpenAPI document has no paths")
	return paths
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func documentedOperations(paths *yaml.Node) map[string]bool {
	operations := map[string]bool{}
	for i := 0; i+1 < len(paths.Content); i += 2 {
		path, item := paths.Content[i].Value, paths.Content[i+1]
		for _, method := range openAPIMethods {
			if mappingValue(item, method) != nil {
				operations[method+" "+path] = true
			}
		}
	}
	return operations
}

// TestOpenAPIDescribesEveryServedRoute fails when docs/api/openapi.yaml and
// the composed router disagree, in either direction.
func TestOpenAPIDescribesEveryServedRoute(t *testing.T) {
	served := servedAPIRoutes(t)
	paths := loadOpenAPIPaths(t)
	documented := documentedOperations(paths)

	var missing []servedRoute
	for key, route := range served {
		if !documented[key] {
			missing = append(missing, route)
		}
	}
	sort.Slice(missing, func(i, j int) bool { return missing[i].key() < missing[j].key() })
	if len(missing) > 0 && os.Getenv(openAPIUpdateEnv) == "1" {
		for _, file := range appendOpenAPISkeletons(t, openAPISources, paths, missing) {
			t.Errorf("appended skeletons to docs/api/openapi/%s; run `pnpm exec smithers-build run '//:openapiBundle'` to re-bundle", file)
		}
		missing = nil
	}
	for _, route := range missing {
		t.Errorf("served but undocumented: %s (%s=1 go test -run %s appends a skeleton)", route.key(), openAPIUpdateEnv, t.Name())
	}
	var stale []string
	for key := range documented {
		if _, ok := served[key]; !ok {
			stale = append(stale, key)
		}
	}
	sort.Strings(stale)
	for _, key := range stale {
		t.Errorf("documented but not served: %s", key)
	}
}

// TestOpenAPIDescribesBootstrap pins the one document every product client
// loads first.
func TestOpenAPIDescribesBootstrap(t *testing.T) {
	t.Parallel()
	paths := loadOpenAPIPaths(t)
	documented := documentedOperations(paths)
	require.True(t, documented["get /api/bootstrap"], "GET /api/bootstrap must be documented")
	require.True(t, documented["head /api/bootstrap"], "HEAD /api/bootstrap must be documented")
}

var operationIDUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// openAPITagFile is the source file owning tag; scripts/openapi-bundle.mjs
// derives the same name.
func openAPITagFile(tag string) string {
	return strings.Trim(operationIDUnsafe.ReplaceAllString(strings.ToLower(tag), "-"), "-") + ".yaml"
}

// appendOpenAPISkeletons appends a skeleton operation for each route to the
// source of the tag openAPITag picks against the bundled paths, and returns
// the source files it wrote.
func appendOpenAPISkeletons(t *testing.T, sources string, bundled *yaml.Node, routes []servedRoute) []string {
	t.Helper()
	documents := map[string]*yaml.Node{}
	var files []string
	for _, route := range routes {
		tag := openAPITag(bundled, route.path)
		file := openAPITagFile(tag)
		document, ok := documents[file]
		if !ok {
			document = &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
			if data, err := os.ReadFile(filepath.Join(sources, file)); err == nil {
				require.NoError(t, yaml.Unmarshal(data, document))
			} else {
				require.ErrorIs(t, err, os.ErrNotExist)
			}
			documents[file] = document
			files = append(files, file)
		}
		root := document.Content[0]
		paths := mappingValue(root, "paths")
		if paths == nil {
			paths = &yaml.Node{Kind: yaml.MappingNode}
			root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "paths"}, paths)
		}
		appendOpenAPIOperation(t, paths, route, tag)
	}
	sort.Strings(files)
	for _, file := range files {
		var out bytes.Buffer
		encoder := yaml.NewEncoder(&out)
		encoder.SetIndent(2)
		require.NoError(t, encoder.Encode(documents[file]))
		require.NoError(t, encoder.Close())
		require.NoError(t, os.WriteFile(filepath.Join(sources, file), out.Bytes(), 0o644))
	}
	return files
}

func TestAppendOpenAPISkeletonsWritesTagSources(t *testing.T) {
	t.Parallel()
	sources := t.TempDir()
	admin := "paths:\n  /api/admin/users:\n    get:\n      operationId: get_api_admin_users\n      tags:\n        - Admin\n      responses: {}\n"
	require.NoError(t, os.WriteFile(filepath.Join(sources, "admin.yaml"), []byte(admin), 0o644))
	var bundled yaml.Node
	require.NoError(t, yaml.Unmarshal([]byte(admin), &bundled))

	files := appendOpenAPISkeletons(t, sources, mappingValue(bundled.Content[0], "paths"), []servedRoute{
		{method: "delete", path: "/api/admin/users/{id}", authed: true},
		{method: "head", path: "/api/admin/users"},
		{method: "get", path: "/api/pair_sessions"},
	})
	require.Equal(t, []string{"admin.yaml", "pair-sessions.yaml"}, files)

	adminOut, err := os.ReadFile(filepath.Join(sources, "admin.yaml"))
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(string(adminOut), admin), "existing operations stay byte-identical")
	require.Contains(t, string(adminOut), "  /api/admin/users/{id}:\n    delete:\n      summary: DELETE /api/admin/users/{id}\n      operationId: delete_api_admin_users_id\n      tags:\n        - Admin\n")
	var adminDocument yaml.Node
	require.NoError(t, yaml.Unmarshal(adminOut, &adminDocument))
	adminPaths := mappingValue(adminDocument.Content[0], "paths")
	require.Equal(t, map[string]bool{
		"get /api/admin/users":         true,
		"head /api/admin/users":        true,
		"delete /api/admin/users/{id}": true,
	}, documentedOperations(adminPaths))
	require.NotNil(t, mappingValue(mappingValue(mappingValue(adminPaths, "/api/admin/users/{id}"), "delete"), "security"))

	created, err := os.ReadFile(filepath.Join(sources, "pair-sessions.yaml"))
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(string(created), "paths:\n  /api/pair_sessions:\n    get:\n"), string(created))
	require.Contains(t, string(created), "      tags:\n        - Pair Sessions\n")
}

func appendOpenAPIOperation(t *testing.T, paths *yaml.Node, route servedRoute, tag string) {
	t.Helper()
	item := mappingValue(paths, route.path)
	if item == nil {
		item = &yaml.Node{Kind: yaml.MappingNode}
		paths.Content = append(paths.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: route.path}, item)
	}
	var operation strings.Builder
	fmt.Fprintf(&operation, "summary: %s %s\n", strings.ToUpper(route.method), route.path)
	fmt.Fprintf(&operation, "operationId: %s\n", strings.Trim(operationIDUnsafe.ReplaceAllString(route.method+"_"+route.path, "_"), "_"))
	fmt.Fprintf(&operation, "tags:\n  - %s\n", tag)
	params := regexp.MustCompile(`\{([^}]+)\}`).FindAllStringSubmatch(route.path, -1)
	if len(params) == 0 {
		operation.WriteString("parameters: []\n")
	} else {
		operation.WriteString("parameters:\n")
		for _, param := range params {
			fmt.Fprintf(&operation, "  - name: %s\n    in: path\n    required: true\n    schema:\n      type: string\n", param[1])
		}
	}
	if route.method == "post" || route.method == "put" || route.method == "patch" {
		operation.WriteString("requestBody:\n  required: false\n  content:\n    application/json:\n      schema:\n        $ref: '#/components/schemas/AnyJSON'\n")
	}
	if route.authed {
		operation.WriteString("security:\n  - tokenAuth: []\n  - bearerAuth: []\n  - sessionCookie: []\n")
	}
	operation.WriteString("responses:\n")
	if route.method == "head" {
		operation.WriteString("  '200':\n    description: Successful response\n")
	} else {
		operation.WriteString("  '200':\n    description: Successful response\n    content:\n      application/json:\n        schema:\n          $ref: '#/components/schemas/AnyJSON'\n")
	}
	for _, status := range []struct{ code, name string }{
		{"400", "BadRequest"}, {"401", "Unauthorized"}, {"403", "Forbidden"}, {"404", "NotFound"},
		{"422", "ValidationError"}, {"429", "RateLimited"}, {"500", "InternalError"},
	} {
		fmt.Fprintf(&operation, "  '%s':\n    $ref: '#/components/responses/%s'\n", status.code, status.name)
	}
	var node yaml.Node
	require.NoError(t, yaml.Unmarshal([]byte(operation.String()), &node))
	item.Content = append(item.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: route.method}, node.Content[0])
}

// openAPITag reuses the tag of the documented path sharing the most leading
// segments beyond /api.
func openAPITag(paths *yaml.Node, path string) string {
	// The first segment after /api/, title-cased, when no documented path
	// shares one.
	segment := strings.Split(strings.TrimPrefix(path, "/api/"), "/")[0]
	words := strings.FieldsFunc(segment, func(r rune) bool { return r == '-' || r == '_' })
	for i, word := range words {
		words[i] = strings.ToUpper(word[:1]) + word[1:]
	}
	best, bestLength := strings.Join(words, " "), 2
	for i := 0; i+1 < len(paths.Content); i += 2 {
		candidate, item := paths.Content[i].Value, paths.Content[i+1]
		length, want, have := 0, strings.Split(path, "/"), strings.Split(candidate, "/")
		for length < len(want) && length < len(have) && want[length] == have[length] {
			length++
		}
		if length <= bestLength {
			continue
		}
		for _, method := range openAPIMethods {
			if operation := mappingValue(item, method); operation != nil {
				if tags := mappingValue(operation, "tags"); tags != nil && len(tags.Content) > 0 {
					best, bestLength = tags.Content[0].Value, length
					break
				}
			}
		}
	}
	return best
}
