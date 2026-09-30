package compose

import (
	"bufio"
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
)

const liveStreamInventoryPath = "../../docs/live-streams.md"

// liveStreamRow is one row of docs/live-streams.md.
type liveStreamRow struct {
	method, path, transport string
	// refusal is the documented owner status when the test composition
	// cannot open the stream; zero means the owner opens it.
	refusal int
}

func (row liveStreamRow) key() string { return strings.ToLower(row.method) + " " + row.path }

var liveStreamRowPattern = regexp.MustCompile("^\\| `([A-Z]+) ([^`]+)` \\| ([^|]+) \\|[^|]*\\|[^|]*\\| (opens|refused (\\d{3})[^|]*) \\|$")

func readLiveStreamInventory(t *testing.T) []liveStreamRow {
	t.Helper()
	file, err := os.Open(liveStreamInventoryPath)
	require.NoError(t, err)
	defer file.Close()
	var rows []liveStreamRow
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "| `") {
			continue
		}
		match := liveStreamRowPattern.FindStringSubmatch(line)
		require.NotNil(t, match, "malformed live stream row: %s", line)
		row := liveStreamRow{method: match[1], path: match[2], transport: strings.Fields(match[3])[0]}
		if match[5] != "" {
			row.refusal, err = strconv.Atoi(match[5])
			require.NoError(t, err)
		}
		rows = append(rows, row)
	}
	require.NoError(t, scanner.Err())
	require.NotEmpty(t, rows)
	return rows
}

// streamingHandlers names every function in the route and chat packages that
// writes a long-lived response, directly or through a helper it calls: an SSE
// or NDJSON content type, a WebSocket upgrade, or the shared SSE broker.
func streamingHandlers(t *testing.T) map[string]bool {
	t.Helper()
	type function struct {
		recv     string
		body     *ast.BlockStmt
		recvName string
	}
	streaming := map[string]bool{}
	for _, pkg := range []string{"routes", "chat"} {
		fset := token.NewFileSet()
		paths, err := filepath.Glob(filepath.Join("..", pkg, "*.go"))
		require.NoError(t, err)
		functions := map[string]function{}
		brokerVars := map[string]bool{}
		for _, path := range paths {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			file, err := parser.ParseFile(fset, path, nil, 0)
			require.NoError(t, err)
			for _, decl := range file.Decls {
				switch decl := decl.(type) {
				case *ast.GenDecl:
					for _, spec := range decl.Specs {
						value, ok := spec.(*ast.ValueSpec)
						if !ok {
							continue
						}
						for i, v := range value.Values {
							if sel, ok := v.(*ast.SelectorExpr); ok && isIdent(sel.X, "sse") && strings.HasPrefix(sel.Sel.Name, "Serve") {
								brokerVars[value.Names[i].Name] = true
							}
						}
					}
				case *ast.FuncDecl:
					if decl.Body == nil {
						continue
					}
					fn := function{body: decl.Body}
					key := decl.Name.Name
					if decl.Recv != nil && len(decl.Recv.List) == 1 {
						recvType := decl.Recv.List[0].Type
						if star, ok := recvType.(*ast.StarExpr); ok {
							recvType = star.X
						}
						if ident, ok := recvType.(*ast.Ident); ok {
							fn.recv = ident.Name
							key = ident.Name + "." + key
						}
						if len(decl.Recv.List[0].Names) == 1 {
							fn.recvName = decl.Recv.List[0].Names[0].Name
						}
					}
					functions[key] = fn
				}
			}
		}
		marked := map[string]bool{}
		calls := map[string][]string{}
		for key, fn := range functions {
			ast.Inspect(fn.body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				switch fun := call.Fun.(type) {
				case *ast.Ident:
					if brokerVars[fun.Name] {
						marked[key] = true
					}
					calls[key] = append(calls[key], fun.Name)
				case *ast.SelectorExpr:
					switch {
					case isIdent(fun.X, "websocket") && fun.Sel.Name == "Accept",
						isIdent(fun.X, "sse") && strings.HasPrefix(fun.Sel.Name, "Serve"):
						marked[key] = true
					case fun.Sel.Name == "Set" && len(call.Args) == 2 && strings.EqualFold(stringLiteral(call.Args[0]), "content-type"):
						if value := stringLiteral(call.Args[1]); value == "text/event-stream" || value == "application/x-ndjson" {
							marked[key] = true
						}
					case fn.recvName != "" && isIdent(fun.X, fn.recvName):
						calls[key] = append(calls[key], fn.recv+"."+fun.Sel.Name)
					}
				}
				return true
			})
		}
		for changed := true; changed; {
			changed = false
			for key, callees := range calls {
				if marked[key] {
					continue
				}
				for _, callee := range callees {
					if marked[callee] {
						marked[key], changed = true, true
						break
					}
				}
			}
		}
		for key := range marked {
			streaming[pkg+"."+key] = true
		}
	}
	return streaming
}

func isIdent(expr ast.Expr, name string) bool {
	ident, ok := expr.(*ast.Ident)
	return ok && ident.Name == name
}

func stringLiteral(expr ast.Expr) string {
	literal, ok := expr.(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return ""
	}
	value, err := strconv.Unquote(literal.Value)
	if err != nil {
		return ""
	}
	return value
}

// handlerKey names a mounted endpoint as package.Receiver.Method.
func handlerKey(handler http.Handler) string {
	value := reflect.ValueOf(handler)
	if value.Kind() != reflect.Func {
		return ""
	}
	name := strings.TrimSuffix(runtime.FuncForPC(value.Pointer()).Name(), "-fm")
	name = name[strings.LastIndex(name, "/")+1:]
	return strings.NewReplacer("(*", "", ")", "").Replace(name)
}

// TestLiveStreamInventoryMatchesTheRouter fails when the composed router
// mounts a streaming handler the inventory does not list, or the inventory
// lists a route that is not served or does not stream.
func TestLiveStreamInventoryMatchesTheRouter(t *testing.T) {
	streaming := streamingHandlers(t)
	require.Contains(t, streaming, "routes.WikiCollaborationHandler.Stream", "the source scan found no known stream")
	served := map[string]bool{}
	selfHosted := testConfigAllFlagsOn()
	selfHosted.Auth.Mode = config.AuthModeSelfHosted
	selfHosted.FeatureFlags.Integrations = true
	multitenant := testConfigAllFlagsOn()
	multitenant.Auth.Mode = config.AuthModeMultitenant
	multitenant.Auth.EnableKeyAuth = true
	multitenant.FeatureFlags.Integrations = true
	for _, cfg := range []*config.Config{selfHosted, multitenant} {
		require.NoError(t, chi.Walk(openAPIConformanceRouter(cfg), func(method, pattern string, handler http.Handler, _ ...func(http.Handler) http.Handler) error {
			if streaming[handlerKey(handler)] {
				served[strings.ToLower(method)+" "+openAPIRoutePath(pattern)] = true
			}
			return nil
		}))
	}
	listed := map[string]bool{}
	for _, row := range readLiveStreamInventory(t) {
		require.False(t, listed[row.key()], "%s is listed twice", row.key())
		listed[row.key()] = true
	}
	var unlisted, stale []string
	for key := range served {
		if !listed[key] {
			unlisted = append(unlisted, key)
		}
	}
	for key := range listed {
		if !served[key] {
			stale = append(stale, key)
		}
	}
	sort.Strings(unlisted)
	sort.Strings(stale)
	require.Empty(t, unlisted, "served streams missing from docs/live-streams.md")
	require.Empty(t, stale, "docs/live-streams.md rows that are not served streams")
}

// liveStreamFixture is alice's stream sources beyond the isolation tenant.
type liveStreamFixture struct {
	alice, bob isolationTenant
	session    string
	lspSession string
	importJob  string
}

type liveStreamRequest struct {
	path    string
	body    string
	headers http.Header
}

// liveStreamRecipe opens one inventory row against alice's resources.
type liveStreamRecipe struct {
	// ownView marks a stream of the caller's own account: another account
	// opens its own view, which must not carry alice's data.
	ownView bool
	// ownerSees marks a stream whose first second carries alice's data, so
	// its absence from other callers' responses is meaningful.
	ownerSees bool
	request   func(f liveStreamFixture) liveStreamRequest
}

func liveStreamPath(f liveStreamFixture, pattern string) string {
	values := isolationValues(f.alice, f.alice.user.Username, f.alice.repo.Name, false)
	return fillIsolationPath(pattern, func(segment, param string) string {
		switch {
		case param == "id" && strings.Contains(pattern, "/agent/sessions/"):
			return f.alice.agentSession.ID
		case param == "id" && strings.HasSuffix(pattern, "/lsp"):
			return f.lspSession
		case param == "id" && strings.Contains(pattern, "/workspace/sessions/"):
			return f.session
		case param == "id" && strings.Contains(pattern, "/github/import/"):
			return f.importJob
		}
		return values(segment, param)
	})
}

func liveStreamGet(pattern string) func(liveStreamFixture) liveStreamRequest {
	return func(f liveStreamFixture) liveStreamRequest {
		path := liveStreamPath(f, pattern)
		if strings.HasSuffix(pattern, "/wiki/{slug}/stream") {
			path += "?visibility=private&page_id=" + strconv.FormatInt(f.alice.wiki.ID, 10)
		}
		return liveStreamRequest{path: path, headers: http.Header{"Accept": {"text/event-stream"}}}
	}
}

var liveStreamRecipes = map[string]liveStreamRecipe{
	"get /api/notifications":                                         {ownView: true, request: liveStreamGet("/api/notifications")},
	"get /api/notifications/events/stream":                           {ownView: true, ownerSees: true, request: liveStreamGet("/api/notifications/events/stream")},
	"get /api/github/import/{id}":                                    {request: liveStreamGet("/api/github/import/{id}")},
	"get /api/repos/{owner}/{repo}/changes/events":                   {request: liveStreamGet("/api/repos/{owner}/{repo}/changes/events")},
	"get /api/repos/{owner}/{repo}/mythical/events":                  {request: liveStreamGet("/api/repos/{owner}/{repo}/mythical/events")},
	"get /api/repos/{owner}/{repo}/issues/state-events/stream":       {ownerSees: true, request: liveStreamGet("/api/repos/{owner}/{repo}/issues/state-events/stream")},
	"get /api/repos/{owner}/{repo}/wiki/{slug}/stream":               {request: liveStreamGet("/api/repos/{owner}/{repo}/wiki/{slug}/stream")},
	"get /api/repos/{owner}/{repo}/runs/{id}/logs":                   {request: liveStreamGet("/api/repos/{owner}/{repo}/runs/{id}/logs")},
	"get /api/repos/{owner}/{repo}/runs/{id}/events":                 {request: liveStreamGet("/api/repos/{owner}/{repo}/runs/{id}/events")},
	"get /api/repos/{owner}/{repo}/workflows/runs/{id}/events":       {request: liveStreamGet("/api/repos/{owner}/{repo}/workflows/runs/{id}/events")},
	"get /api/repos/{owner}/{repo}/runs/{id}/status/stream":          {request: liveStreamGet("/api/repos/{owner}/{repo}/runs/{id}/status/stream")},
	"get /api/repos/{owner}/{repo}/agent/sessions/{id}/stream":       {request: liveStreamGet("/api/repos/{owner}/{repo}/agent/sessions/{id}/stream")},
	"get /api/repos/{owner}/{repo}/workspaces/{id}/stream":           {request: liveStreamGet("/api/repos/{owner}/{repo}/workspaces/{id}/stream")},
	"get /api/repos/{owner}/{repo}/workspace/sessions/{id}/stream":   {request: liveStreamGet("/api/repos/{owner}/{repo}/workspace/sessions/{id}/stream")},
	"get /api/repos/{owner}/{repo}/workspace/sessions/{id}/terminal": {request: liveStreamGet("/api/repos/{owner}/{repo}/workspace/sessions/{id}/terminal")},
	"get /api/repos/{owner}/{repo}/workspace/sessions/{id}/lsp":      {request: liveStreamGet("/api/repos/{owner}/{repo}/workspace/sessions/{id}/lsp")},
}

// liveChatRecipes need a composed chat host, which the multitenant product
// composition of the isolation suite does not inject.
var liveChatRecipes = map[string]liveStreamRecipe{
	"post /api/agent/turn": {ownView: true, request: func(f liveStreamFixture) liveStreamRequest {
		body := fmt.Sprintf(`{"runId":%q,"journal":{"version":1,"legId":%q,"token":%q},"instructions":"Answer briefly.","messages":[{"role":"user","content":%q}]}`,
			"live-"+f.alice.user.Username, uuid.NewSHA1(uuid.NameSpaceOID, []byte("live-stream")).String(), strings.Repeat("c", 48), canary("chat"))
		return liveStreamRequest{path: "/api/agent/turn", body: body}
	}},
	"post /api/model/stream": {ownView: true, ownerSees: true, request: func(liveStreamFixture) liveStreamRequest {
		return liveStreamRequest{path: "/api/model/stream", body: `{"messages":[{"role":"user","content":"hello"}]}`}
	}},
}

type liveStreamResponse struct {
	status      int
	contentType string
	body        string
}

// openLiveStream opens one stream over real HTTP and reads what arrives in
// its first second. WebSocket rows perform a real upgrade.
func openLiveStream(t *testing.T, server *httptest.Server, row liveStreamRow, request liveStreamRequest, token string) liveStreamResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	headers := http.Header{}
	for name, values := range request.headers {
		headers[name] = values
	}
	if token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}
	if row.transport == "WebSocket" {
		conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+request.path, &websocket.DialOptions{HTTPHeader: headers})
		if err == nil {
			_ = conn.CloseNow()
			return liveStreamResponse{status: http.StatusSwitchingProtocols}
		}
		require.NotNil(t, response, "WebSocket dial failed before a response: %v", err)
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
		return liveStreamResponse{status: response.StatusCode, contentType: response.Header.Get("Content-Type"), body: string(data)}
	}
	var body io.Reader
	if request.body != "" {
		body = strings.NewReader(request.body)
		headers.Set("Content-Type", "application/json")
	}
	req, err := http.NewRequestWithContext(ctx, row.method, server.URL+request.path, body)
	require.NoError(t, err)
	req.Header = headers
	response, err := server.Client().Do(req)
	require.NoError(t, err)
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return liveStreamResponse{status: response.StatusCode, contentType: response.Header.Get("Content-Type"), body: string(data)}
}

func checkLiveStream(t *testing.T, server *httptest.Server, row liveStreamRow, recipe liveStreamRecipe, f liveStreamFixture) {
	t.Helper()
	request := recipe.request(f)
	owner := openLiveStream(t, server, row, request, f.alice.token)
	if row.refusal != 0 {
		require.Equal(t, row.refusal, owner.status, "documented owner refusal changed: %s", owner.body)
	} else {
		switch row.transport {
		case "SSE":
			require.Equal(t, http.StatusOK, owner.status, owner.body)
			require.Equal(t, "text/event-stream", owner.contentType)
			require.True(t, strings.HasPrefix(owner.body, ":") || strings.HasPrefix(owner.body, "id:") || strings.HasPrefix(owner.body, "event:") || strings.HasPrefix(owner.body, "data:"), "not an SSE frame: %q", owner.body)
		case "NDJSON":
			require.Equal(t, http.StatusOK, owner.status, owner.body)
			require.Equal(t, "application/x-ndjson", owner.contentType)
			first, _, _ := strings.Cut(owner.body, "\n")
			require.True(t, strings.HasPrefix(first, "{") && strings.HasSuffix(first, "}"), "not an NDJSON line: %q", owner.body)
		case "WebSocket":
			require.Equal(t, http.StatusSwitchingProtocols, owner.status, owner.body)
		default:
			t.Fatalf("unknown transport %q", row.transport)
		}
	}
	require.Equal(t, recipe.ownerSees, leaksCanary(owner.body), "owner's first frames: %s", owner.body)
	outsider := openLiveStream(t, server, row, request, f.bob.token)
	require.False(t, leaksCanary(outsider.body), "another account read alice's stream: %s", outsider.body)
	if !recipe.ownView {
		require.True(t, isolationDenied(outsider.status), "another account opened alice's stream: %d %s", outsider.status, outsider.body)
	}
	anonymous := openLiveStream(t, server, row, request, "")
	require.True(t, isolationDenied(anonymous.status), "an anonymous caller opened alice's stream: %d %s", anonymous.status, anonymous.body)
	require.False(t, leaksCanary(anonymous.body))
}

// TestLiveStreamsServeOnlyTheirSubscribersPostgres opens every inventoried
// stream through the multitenant product composition: alice gets the
// stream's transport, bob and anonymous callers are refused her resources.
func TestLiveStreamsServeOnlyTheirSubscribersPostgres(t *testing.T) {
	rows := readLiveStreamInventory(t)
	for _, row := range rows {
		_, repository := liveStreamRecipes[row.key()]
		_, chat := liveChatRecipes[row.key()]
		require.True(t, repository != chat, "%s needs exactly one recipe", row.key())
	}
	pool, server, _ := startIsolationProduct(t)
	ctx := context.Background()
	carol, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "carol", LowerUsername: "carol", DisplayName: "carol"})
	require.NoError(t, err)
	f := liveStreamFixture{alice: seedIsolationTenant(t, pool, "alice", carol.ID, canary)}
	f.bob = seedIsolationTenant(t, pool, "bob", 0, func(kind string) string { return "bob-" + kind })
	session, err := db.New(pool).CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{RepositoryID: f.alice.repo.ID, UserID: f.alice.user.ID, Cols: 80, Rows: 24, WorkspaceID: f.alice.workspace.ID})
	require.NoError(t, err)
	f.session = session.ID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace_sessions(workspace_id, repository_id, user_id, kind, language) VALUES ($1, $2, $3, 'lsp', 'go') RETURNING id::text`,
		f.alice.workspace.ID, f.alice.repo.ID, f.alice.user.ID).Scan(&f.lspSession))
	_, err = pool.Exec(ctx, `UPDATE workspace_sessions SET status = 'running' WHERE workspace_id = $1`, f.alice.workspace.ID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO import_jobs(user_id, github_owner, github_repo, status, error) VALUES ($1, 'octo', $2, 'failed', 'stopped') RETURNING id::text`,
		f.alice.user.ID, canary("import")).Scan(&f.importJob))
	for _, row := range rows {
		recipe, ok := liveStreamRecipes[row.key()]
		if !ok {
			continue
		}
		t.Run(row.key(), func(t *testing.T) { checkLiveStream(t, server, row, recipe, f) })
	}
}

// liveChatHost holds every chat response open and answers model streams
// with the requesting account's own line.
type liveChatHost struct{ owner int64 }

func (liveChatHost) RunChatTurn(ctx context.Context, _ ports.ChatTurnGrant) error {
	<-ctx.Done()
	return ctx.Err()
}

func (h liveChatHost) RunModelStream(_ context.Context, grant ports.ModelStreamGrant) (io.ReadCloser, error) {
	line := `{"type":"text","text":"another account"}` + "\n"
	if grant.OwnerID == h.owner {
		line = fmt.Sprintf(`{"type":"text","text":%q}`, canary("model")) + "\n"
	}
	return io.NopCloser(strings.NewReader(line)), nil
}

// TestLiveChatStreamsServeOnlyTheirSubscribersPostgres opens the chat and
// model streams through a composition with a chat host.
func TestLiveChatStreamsServeOnlyTheirSubscribersPostgres(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	// Another account exists only in the multitenant identity mode.
	t.Setenv("SMITHERS_AUTH_MODE", "multitenant")
	t.Setenv("SMITHERS_BILLING_MODE", "metered")
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	callbacks, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	ctx := context.Background()
	q := db.New(pool)
	alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "alice"})
	require.NoError(t, err)
	bob, err := q.CreateUser(ctx, db.CreateUserParams{Username: "bob", LowerUsername: "bob", DisplayName: "bob"})
	require.NoError(t, err)
	var f liveStreamFixture
	f.alice.user, f.bob.user = alice, bob
	f.alice.token, _ = isolationToken(t, q, alice, "alice-chat")
	f.bob.token, _ = isolationToken(t, q, bob, "bob-chat")
	server := httptest.NewServer(startSplitProcess(t, Options{Admission: policy, ComputeProvider: sandboxfake.New(), ChatHost: liveChatHost{owner: alice.ID},
		ChatCallbackListener: callbacks, ChatProducerBaseURL: "http://" + callbacks.Addr().String()}))
	t.Cleanup(server.Close)
	var tested []string
	for _, row := range readLiveStreamInventory(t) {
		recipe, ok := liveChatRecipes[row.key()]
		if !ok {
			continue
		}
		tested = append(tested, row.key())
		t.Run(row.key(), func(t *testing.T) { checkLiveStream(t, server, row, recipe, f) })
	}
	slices.Sort(tested)
	require.Equal(t, []string{"post /api/agent/turn", "post /api/model/stream"}, tested)
}
