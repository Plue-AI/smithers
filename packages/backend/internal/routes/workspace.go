package routes

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

// WorkspaceRouteService defines the interface expected by WorkspaceHandler.
type WorkspaceRouteService interface {
	CreateWorkspace(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error)
	GetWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	ListWorkspaces(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceResponse, int64, error)
	ListUserWorkspacesAcrossRepos(ctx context.Context, userID int64, page, perPage int) (services.UserWorkspaceListResult, error)
	ListWorkspaceFiles(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) ([]services.WorkspaceFileEntry, error)
	ReadWorkspaceFile(ctx context.Context, workspaceID string, repositoryID, userID int64, path string) (services.WorkspaceFileContent, error)
	WriteWorkspaceFile(ctx context.Context, workspaceID string, repositoryID, userID int64, path, content string) (services.WorkspaceFileContent, error)
	ListWorkspaceServices(ctx context.Context, workspaceID string, repositoryID, userID int64) ([]services.WorkspaceManagedService, error)
	ManageWorkspaceService(ctx context.Context, workspaceID string, repositoryID, userID int64, serviceName, action string) (services.WorkspaceManagedService, error)
	GetWorkspaceSSHConnectionInfo(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error)
	SuspendWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	ResumeWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
	DeleteWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) error
	ForkWorkspace(ctx context.Context, input services.ForkWorkspaceInput) (services.WorkspaceResponse, error)
	CreateWorkspaceSnapshot(ctx context.Context, input services.CreateWorkspaceSnapshotInput) (services.WorkspaceSnapshotResponse, error)
	GetWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) (services.WorkspaceSnapshotResponse, error)
	ListWorkspaceSnapshots(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSnapshotResponse, int64, error)
	DeleteWorkspaceSnapshot(ctx context.Context, snapshotID string, repositoryID, userID int64) error
	CreateSession(ctx context.Context, input services.CreateWorkspaceSessionInput) (services.WorkspaceSessionResponse, error)
	GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error)
	ListSessions(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]services.WorkspaceSessionResponse, int64, error)
	GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error)
	DestroySession(ctx context.Context, sessionID string, repositoryID, userID int64) error
}

type asyncWorkspaceCreator interface {
	CreateWorkspaceAsync(ctx context.Context, input services.CreateWorkspaceInput) (services.WorkspaceResponse, error)
}

type workspaceCommandRouteService interface {
	ExecuteWorkspaceCommand(ctx context.Context, workspaceID string, repositoryID, userID int64, input services.WorkspaceCommandInput) (services.WorkspaceCommandResult, error)
}

type workspaceServiceLaunchRouteService interface {
	LaunchWorkspaceService(ctx context.Context, workspaceID string, repositoryID, userID int64, input services.WorkspaceServiceLaunchInput) (services.WorkspaceManagedService, error)
}

type workspacePreviewRouteService interface {
	ResolveWorkspacePreview(ctx context.Context, workspaceID string, repositoryID, userID int64, port uint16, hostname string) (services.WorkspacePreviewAccess, error)
}

// WorkspaceHandler handles workspace session API endpoints.
type WorkspaceHandler struct {
	Service     WorkspaceRouteService
	EgressAudit SandboxEgressAuditRouteService
	// Desktop serves kind=desktop stream sessions and the token relay; nil
	// disables the desktop routes.
	Desktop *WorkspaceDesktopHandler
	// EnvironmentImages serves the NixOS environment image registry; nil
	// disables those routes.
	EnvironmentImages *SandboxEnvironmentImageHandler
	// Broker multiplexes all workspace/session LISTEN/NOTIFY streams over one
	// shared database connection and enforces the per-user concurrent stream cap.
	// If nil, the SSE stream endpoints return a 500.
	Broker  *sse.Broker
	Metrics *SmithersMetrics
	// PreviewTickets mints the ticket a hosted preview redirect carries: the
	// preview gateway serves user previews only to a viewer holding one. Nil
	// redirects without a ticket, which the gateway refuses.
	PreviewTickets *previewgateway.Tickets
}

// RegisterWorkspaceRuntimeRoutes adds the execution endpoints beside the
// existing repository-scoped workspace routes. Composition supplies the same
// auth, scope, repository permission, quota, and product gate middleware used
// by the rest of WorkspaceHandler.
func RegisterWorkspaceRuntimeRoutes(r chi.Router, handler *WorkspaceHandler, readWorkspace, writeWorkspace []func(http.Handler) http.Handler) {
	if r == nil || handler == nil {
		return
	}
	r.With(writeWorkspace...).Post("/workspaces/{id}/commands", handler.ExecuteWorkspaceCommand)
	r.With(writeWorkspace...).Post("/workspaces/{id}/services", handler.LaunchWorkspaceService)
	r.With(readWorkspace...).Get("/workspaces/{id}/preview/{port}", handler.ProxyWorkspacePreview)
	r.With(readWorkspace...).Get("/workspaces/{id}/preview/{port}/*", handler.ProxyWorkspacePreview)
}

// ListEgressAudit handles GET /api/repos/{owner}/{repo}/workspaces/{id}/egress.
func (h *WorkspaceHandler) ListEgressAudit(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}
	if _, svcErr := h.Service.GetWorkspace(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	serveSandboxEgressAudit(w, r, h.EgressAudit, "workspace", workspaceID)
}

// serveWorkspaceBrokerSSE is a package-level seam so route tests can stub the
// SSE serving without a live broker.
var serveWorkspaceBrokerSSE = sse.ServeBrokerSSE

type createWorkspaceSessionRequest struct {
	Cols        int32  `json:"cols"`
	Rows        int32  `json:"rows"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	// Kind is terminal (default) or lsp; Language is required with lsp (#505).
	Kind     string `json:"kind,omitempty"`
	Language string `json:"language,omitempty"`
}

type createWorkspaceRequest struct {
	Name           string                        `json:"name"`
	SnapshotID     string                        `json:"snapshot_id"`
	SourceBookmark string                        `json:"source_bookmark,omitempty"`
	Kind           string                        `json:"kind,omitempty"`
	Environment    services.WorkspaceEnvironment `json:"environment,omitempty"`
}

type forkWorkspaceRequest struct {
	Name string `json:"name"`
}

type createWorkspaceSnapshotRequest struct {
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
}

type writeWorkspaceFileRequest struct {
	Content string `json:"content"`
}

// ExecuteWorkspaceCommand handles POST
// /api/repos/{owner}/{repo}/workspaces/{id}/commands. Product middleware owns
// authentication, repository permission, admission, and request limits before
// this method invokes the shared runtime service.
func (h *WorkspaceHandler) ExecuteWorkspaceCommand(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, routeErr := workspaceFacetRouteContext(r)
	if routeErr != nil {
		pkgerrors.WriteError(w, routeErr)
		return
	}
	service, ok := h.Service.(workspaceCommandRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace execution unavailable"))
		return
	}
	var input services.WorkspaceCommandInput
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	result, err := service.ExecuteWorkspaceCommand(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

// LaunchWorkspaceService starts a runtime-managed process. Its declared port
// is the only port the local authenticated preview proxy may resolve.
func (h *WorkspaceHandler) LaunchWorkspaceService(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, routeErr := workspaceFacetRouteContext(r)
	if routeErr != nil {
		pkgerrors.WriteError(w, routeErr)
		return
	}
	service, ok := h.Service.(workspaceServiceLaunchRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace managed services unavailable"))
		return
	}
	var input services.WorkspaceServiceLaunchInput
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	managed, err := service.LaunchWorkspaceService(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, managed)
}

// ProxyWorkspacePreview authenticates each request before forwarding it to a
// local loopback service. Hosted adapters return their existing authenticated
// routed preview URL and this handler redirects to that gateway.
func (h *WorkspaceHandler) ProxyWorkspacePreview(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, routeErr := workspaceFacetRouteContext(r)
	if routeErr != nil {
		pkgerrors.WriteError(w, routeErr)
		return
	}
	rawPort, err := routeParam(r, "port", "preview port is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	parsedPort, parseErr := strconv.ParseUint(rawPort, 10, 16)
	if parseErr != nil || parsedPort == 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid preview port"))
		return
	}
	service, ok := h.Service.(workspacePreviewRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable"))
		return
	}
	access, resolveErr := service.ResolveWorkspacePreview(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, uint16(parsedPort), "")
	if resolveErr != nil {
		writeRouteError(w, r, resolveErr)
		return
	}
	resource := previewResourceURL(r)
	target, parseTargetErr := url.Parse(access.URL)
	if parseTargetErr != nil || target.Host == "" || target.User != nil || target.Fragment != "" ||
		(target.Scheme != "http" && target.Scheme != "https") {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable"))
		return
	}
	if !access.Proxy {
		// The hosted gateway serves the whole preview: the asset, deep link
		// or query the client asked for goes with it, under the routed base.
		redirect := previewRedirectURL(target, resource, r.URL)
		if h.PreviewTickets != nil {
			ticketed, ticketErr := withPreviewTicket(h.PreviewTickets, redirect, previewgateway.Grant{
				WorkspaceID: workspaceID, RepositoryID: repoCtx.Repository.ID, UserID: user.ID,
			})
			if ticketErr != nil {
				pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable"))
				return
			}
			redirect = ticketed
			// The Location carries a credential: never cache it.
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
		}
		http.Redirect(w, r, redirect.String(), http.StatusTemporaryRedirect)
		return
	}
	if target.Scheme != "http" || !previewLoopbackHost(target.Hostname()) ||
		target.Port() != strconv.FormatUint(parsedPort, 10) || (target.Path != "" && target.Path != "/") ||
		target.RawQuery != "" {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable"))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	externalPrefix := strings.TrimSuffix(r.URL.Path, resource.Path)
	if resource.Path == "/" {
		externalPrefix = strings.TrimSuffix(r.URL.Path, "/")
	}
	proxy := newWorkspacePreviewProxy(target, externalPrefix)
	r.URL.Path = resource.Path
	r.URL.RawPath = resource.RawPath
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		pkgerrors.WriteError(response, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable"))
	}
	proxy.ServeHTTP(w, r)
}

// workspacePreviewCredentialHeaders are the API-origin credentials and
// identity assertions no user-controlled guest may see: what the browser
// attaches (cookies, the CSRF token), what an auth proxy in front of the API
// asserts, and the Authorization header. The local preview proxy and the
// preview-gateway relays (stripAPICredentials) both strip them.
// previewResourceURL is the path under the preview root the client asked
// for, "/" at the root. chi matches on RawPath when the request has one, so
// the wildcard is then still escaped: an encoded slash stays one segment
// instead of becoming a separator.
func previewResourceURL(r *http.Request) *url.URL {
	previewPath := "/" + strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if r.URL.RawPath != "" {
		if resource, err := url.Parse(previewPath); err == nil && resource.Path != "" {
			return &url.URL{Path: resource.Path, RawPath: resource.RawPath}
		}
	}
	return &url.URL{Path: previewPath}
}

// previewRedirectURL joins the hosted preview's base URL with the requested
// resource and query: the base keeps any path prefix and query of its own.
func previewRedirectURL(base *url.URL, resource *url.URL, requested *url.URL) *url.URL {
	target := *base
	if resource.Path != "/" {
		target.RawPath = strings.TrimSuffix(base.EscapedPath(), "/") + resource.EscapedPath()
		target.Path = strings.TrimSuffix(base.Path, "/") + resource.Path
	}
	if requested.RawQuery != "" {
		if target.RawQuery != "" {
			target.RawQuery += "&"
		}
		target.RawQuery += requested.RawQuery
	}
	target.ForceQuery = target.ForceQuery || requested.ForceQuery
	return &target
}

var workspacePreviewCredentialHeaders = []string{
	"Authorization",
	"Cookie",
	"Proxy-Authorization",
	"X-CSRF-Token",
	"Cf-Access-Jwt-Assertion",
	"X-Forwarded-Access-Token",
	"X-Forwarded-Email",
	"X-Forwarded-User",
	"X-Goog-Authenticated-User-Email",
	"X-Goog-Authenticated-User-Id",
}

// workspacePreviewSandboxPolicy runs proxied preview content in an opaque
// origin. The preview is served from the product origin, so without it the
// repository's own script could read the non-HttpOnly CSRF cookie and call
// any /api endpoint as whoever opened the preview.
const workspacePreviewSandboxPolicy = "sandbox allow-scripts allow-forms allow-popups"

func newWorkspacePreviewProxy(target *url.URL, externalPrefix string) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		// Rewrite (unlike Director) starts from a request that already lacks
		// client-supplied Forwarded and X-Forwarded-* headers.
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			for _, header := range workspacePreviewCredentialHeaders {
				request.Out.Header.Del(header)
			}
			if externalPrefix != "" {
				request.Out.Header.Set("X-Forwarded-Prefix", externalPrefix)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			// A preview shares the product origin and must not mint or
			// overwrite the product session cookie.
			response.Header.Del("Set-Cookie")
			response.Header.Add("Content-Security-Policy", workspacePreviewSandboxPolicy)
			return nil
		},
	}
}

func previewLoopbackHost(host string) bool {
	if strings.EqualFold(strings.TrimSpace(host), "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// CreateWorkspace handles POST /api/repos/{owner}/{repo}/workspaces.
func (h *WorkspaceHandler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	var req createWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}

	input := services.CreateWorkspaceInput{
		RepositoryID:   repoCtx.Repository.ID,
		UserID:         user.ID,
		RepoOwner:      repoCtx.Owner,
		RepoName:       repoCtx.Repository.Name,
		Name:           req.Name,
		SnapshotID:     req.SnapshotID,
		SourceBookmark: req.SourceBookmark,
		Kind:           req.Kind,
		Environment:    req.Environment,
	}
	status := http.StatusCreated
	var workspace services.WorkspaceResponse
	var svcErr error
	if asyncService, ok := h.Service.(asyncWorkspaceCreator); ok {
		workspace, svcErr = asyncService.CreateWorkspaceAsync(r.Context(), input)
		status = http.StatusAccepted
	} else {
		workspace, svcErr = h.Service.CreateWorkspace(r.Context(), input)
	}
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	workspace.RepoFullName = repoCtx.Owner + "/" + repoCtx.Repository.Name
	workspace.Slug = strings.ToLower(repoCtx.Owner + "-" + repoCtx.Repository.Name + "-" + workspace.ID)
	workspace.Branch = strings.TrimSpace(req.SourceBookmark)
	workspace.HTMLURL = "/repos/" + repoCtx.Owner + "/" + repoCtx.Repository.Name + "/workspaces/" + workspace.ID

	pkgerrors.WriteJSON(w, status, workspace)
}

// GetWorkspace handles GET /api/repos/{owner}/{repo}/workspaces/{id}.
func (h *WorkspaceHandler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	workspace, svcErr := h.Service.GetWorkspace(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, workspace)
}

// ListWorkspaceFiles handles GET /api/repos/{owner}/{repo}/workspaces/{id}/files?path=.
func (h *WorkspaceHandler) ListWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	entries, svcErr := h.Service.ListWorkspaceFiles(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, r.URL.Query().Get("path"))
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, entries)
}

// ReadWorkspaceFile handles GET /api/repos/{owner}/{repo}/workspaces/{id}/files/content?path=.
func (h *WorkspaceHandler) ReadWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	content, svcErr := h.Service.ReadWorkspaceFile(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, r.URL.Query().Get("path"))
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, content)
}

// WriteWorkspaceFile handles PUT /api/repos/{owner}/{repo}/workspaces/{id}/files/content?path=.
func (h *WorkspaceHandler) WriteWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	var request writeWorkspaceFileRequest
	decoder := json.NewDecoder(r.Body)
	if decodeErr := decoder.Decode(&request); decodeErr != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	content, svcErr := h.Service.WriteWorkspaceFile(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, r.URL.Query().Get("path"), request.Content)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, content)
}

// ListWorkspaceServices handles GET /api/repos/{owner}/{repo}/workspaces/{id}/services.
func (h *WorkspaceHandler) ListWorkspaceServices(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	managedServices, svcErr := h.Service.ListWorkspaceServices(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, managedServices)
}

// ManageWorkspaceService handles POST /api/repos/{owner}/{repo}/workspaces/{id}/services/{name}/{action}.
func (h *WorkspaceHandler) ManageWorkspaceService(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, err := workspaceFacetRouteContext(r)
	if err != nil {
		pkgerrors.WriteError(w, err)
		return
	}
	name, paramErr := routeParam(r, "name", "service name is required")
	if paramErr != nil {
		pkgerrors.WriteError(w, paramErr.(*pkgerrors.APIError))
		return
	}
	action, paramErr := routeParam(r, "action", "service action is required")
	if paramErr != nil {
		pkgerrors.WriteError(w, paramErr.(*pkgerrors.APIError))
		return
	}
	managedService, svcErr := h.Service.ManageWorkspaceService(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, name, action)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, managedService)
}

func workspaceFacetRouteContext(r *http.Request) (*db.User, *middleware.RepoContext, string, *pkgerrors.APIError) {
	user, err := requireRouteUser(r)
	if err != nil {
		return nil, nil, "", err.(*pkgerrors.APIError)
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		return nil, nil, "", pkgerrors.BadRequest("repository context required")
	}
	workspaceID, paramErr := routeParam(r, "id", "workspace id is required")
	if paramErr != nil {
		return nil, nil, "", paramErr.(*pkgerrors.APIError)
	}
	return user, repoCtx, workspaceID, nil
}

// ListWorkspaces handles GET /api/repos/{owner}/{repo}/workspaces.
func (h *WorkspaceHandler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	workspaces, total, svcErr := h.Service.ListWorkspaces(r.Context(), repoCtx.Repository.ID, user.ID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setOffsetCursorPaginationHeaders(w, r, page, limit, len(workspaces), total)
	pkgerrors.WriteJSON(w, http.StatusOK, workspaces)
}

// GetWorkspaceSSHConnectionInfo handles GET /api/repos/{owner}/{repo}/workspaces/{id}/ssh.
func (h *WorkspaceHandler) GetWorkspaceSSHConnectionInfo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var (
		info   services.WorkspaceSSHConnectionInfo
		svcErr error
	)
	if guestUser := strings.TrimSpace(r.URL.Query().Get("user")); guestUser != "" {
		selector, ok := h.Service.(workspaceSSHUserSelector)
		if !ok {
			pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeWorkspaceSSHUserInvalid, "this workspace offers no other ssh user"))
			return
		}
		info, svcErr = selector.GetWorkspaceSSHConnectionInfoAs(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, guestUser)
	} else {
		info, svcErr = h.Service.GetWorkspaceSSHConnectionInfo(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	}
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// The response carries a freshly minted plaintext SSH access token — never
	// let a browser or intermediary cache store it.
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, info)
}

// SuspendWorkspace handles POST /api/repos/{owner}/{repo}/workspaces/{id}/suspend.
func (h *WorkspaceHandler) SuspendWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	updated, svcErr := h.Service.SuspendWorkspace(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, updated)
}

// ResumeWorkspace handles POST /api/repos/{owner}/{repo}/workspaces/{id}/resume.
func (h *WorkspaceHandler) ResumeWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	updated, svcErr := h.Service.ResumeWorkspace(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, updated)
}

// DeleteWorkspace handles DELETE /api/repos/{owner}/{repo}/workspaces/{id}.
func (h *WorkspaceHandler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	svcErr := h.Service.DeleteWorkspace(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ForkWorkspace handles POST /api/repos/{owner}/{repo}/workspaces/{id}/fork.
func (h *WorkspaceHandler) ForkWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req forkWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}

	forked, svcErr := h.Service.ForkWorkspace(r.Context(), services.ForkWorkspaceInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		WorkspaceID:  workspaceID,
		Name:         req.Name,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, forked)
}

// CreateWorkspaceSnapshot handles POST /api/repos/{owner}/{repo}/workspaces/{id}/snapshot.
func (h *WorkspaceHandler) CreateWorkspaceSnapshot(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req createWorkspaceSnapshotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}

	snapshot, svcErr := h.Service.CreateWorkspaceSnapshot(r.Context(), services.CreateWorkspaceSnapshotInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		WorkspaceID:  workspaceID,
		Name:         req.Name,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, snapshot)
}

// CreateWorkspaceSnapshotTemplate handles POST /api/repos/{owner}/{repo}/workspace-snapshots.
func (h *WorkspaceHandler) CreateWorkspaceSnapshotTemplate(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	var req createWorkspaceSnapshotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	if strings.TrimSpace(req.WorkspaceID) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("workspace_id is required"))
		return
	}

	snapshot, svcErr := h.Service.CreateWorkspaceSnapshot(r.Context(), services.CreateWorkspaceSnapshotInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		WorkspaceID:  req.WorkspaceID,
		Name:         req.Name,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, snapshot)
}

// GetWorkspaceSnapshot handles GET /api/repos/{owner}/{repo}/workspace-snapshots/{id}.
func (h *WorkspaceHandler) GetWorkspaceSnapshot(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	snapshotID, err := routeParam(r, "id", "workspace snapshot id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	snapshot, svcErr := h.Service.GetWorkspaceSnapshot(r.Context(), snapshotID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, snapshot)
}

// ListWorkspaceSnapshots handles GET /api/repos/{owner}/{repo}/workspace-snapshots.
func (h *WorkspaceHandler) ListWorkspaceSnapshots(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	snapshots, total, svcErr := h.Service.ListWorkspaceSnapshots(r.Context(), repoCtx.Repository.ID, user.ID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setOffsetCursorPaginationHeaders(w, r, page, limit, len(snapshots), total)
	pkgerrors.WriteJSON(w, http.StatusOK, snapshots)
}

// DeleteWorkspaceSnapshot handles DELETE /api/repos/{owner}/{repo}/workspace-snapshots/{id}.
func (h *WorkspaceHandler) DeleteWorkspaceSnapshot(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	snapshotID, err := routeParam(r, "id", "workspace snapshot id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	svcErr := h.Service.DeleteWorkspaceSnapshot(r.Context(), snapshotID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// CreateSession handles POST /api/repos/{owner}/{repo}/workspace/sessions.
func (h *WorkspaceHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	var req createWorkspaceSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}

	session, svcErr := h.Service.CreateSession(r.Context(), services.CreateWorkspaceSessionInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		Cols:         req.Cols,
		Rows:         req.Rows,
		RepoOwner:    repoCtx.Owner,
		RepoName:     repoCtx.Repository.Name,
		WorkspaceID:  req.WorkspaceID,
		Kind:         req.Kind,
		Language:     req.Language,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, session)
}

// GetSession handles GET /api/repos/{owner}/{repo}/workspace/sessions/{id}.
func (h *WorkspaceHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	session, svcErr := h.Service.GetSession(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, session)
}

// ListSessions handles GET /api/repos/{owner}/{repo}/workspace/sessions.
func (h *WorkspaceHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	sessions, total, svcErr := h.Service.ListSessions(r.Context(), repoCtx.Repository.ID, user.ID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setOffsetCursorPaginationHeaders(w, r, page, limit, len(sessions), total)
	pkgerrors.WriteJSON(w, http.StatusOK, sessions)
}

// GetSSHConnectionInfo handles GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/ssh.
func (h *WorkspaceHandler) GetSSHConnectionInfo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	info, svcErr := h.Service.GetSSHConnectionInfo(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// The response carries a freshly minted plaintext SSH access token — never
	// let a browser or intermediary cache store it.
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, info)
}

// DestroySession handles POST /api/repos/{owner}/{repo}/workspace/sessions/{id}/destroy.
func (h *WorkspaceHandler) DestroySession(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	svcErr := h.Service.DestroySession(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// StreamWorkspace handles GET /api/repos/{owner}/{repo}/workspaces/{id}/stream.
func (h *WorkspaceHandler) StreamWorkspace(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	workspace, svcErr := h.Service.GetWorkspace(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	safeID := strings.ReplaceAll(workspace.ID, "-", "")
	channel := "workspace_status_" + safeID

	cfg := sse.BrokerStreamConfig{
		Broker:  h.Broker,
		Channel: channel,
		UserID:  user.ID,
		// The pre-broker single-channel path (sse.NewListener) tagged every event
		// with Type "message"; pin it here so the wire format is unchanged.
		EventType: "message",
	}

	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repoCtx.Repository.ID, WorkspaceID: workspace.ID})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}

	serveWorkspaceBrokerSSE(w, r, cfg)
}

// StreamSession handles GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/stream.
// SSE endpoint for workspace session status/signaling updates.
func (h *WorkspaceHandler) StreamSession(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	// Verify session exists
	_, svcErr := h.Service.GetSession(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	safeID := strings.ReplaceAll(sessionID, "-", "")
	channel := "workspace_status_" + safeID

	cfg := sse.BrokerStreamConfig{
		Broker:  h.Broker,
		Channel: channel,
		UserID:  user.ID,
		// The pre-broker single-channel path (sse.NewListener) tagged every event
		// with Type "message"; pin it here so the wire format is unchanged.
		EventType: "message",
	}

	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repoCtx.Repository.ID})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}

	serveWorkspaceBrokerSSE(w, r, cfg)
}

// extractWorkspaceEventID extracts an "id" or "sequence" field from a JSON
// workspace event payload. Returns the stringified value, or "" if extraction fails.
func extractWorkspaceEventID(data string) string {
	var partial struct {
		ID       int64 `json:"id"`
		Sequence int64 `json:"sequence"`
	}
	if err := json.Unmarshal([]byte(data), &partial); err != nil {
		return ""
	}
	if partial.ID > 0 {
		return strconv.FormatInt(partial.ID, 10)
	}
	if partial.Sequence > 0 {
		return strconv.FormatInt(partial.Sequence, 10)
	}
	return ""
}

// GetUserWorkspaces handles GET /api/user/workspaces (ticket 0135). Returns
// the authenticated user's workspaces across every repo they can still
// read, pre-sorted by best-available recency (last_accessed_at falls back
// to last_activity_at and created_at via COALESCE).
//
// Authorization: RequireAuth + RequireScope(ScopeReadRepository) at the
// route-registration layer. This handler additionally enforces owner-scope
// in the service/query (workspaces.user_id = current_user).
func (h *WorkspaceHandler) GetUserWorkspaces(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	cursor, limit, perr := parseUserWorkspacesPagination(r)
	if perr != nil {
		pkgerrors.WriteError(w, perr)
		return
	}
	page := cursorToPage(cursor, limit)

	result, svcErr := h.Service.ListUserWorkspacesAcrossRepos(r.Context(), user.ID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setOffsetCursorPaginationHeaders(w, r, result.Page, limit, len(result.Items), result.TotalCount)
	pkgerrors.WriteJSON(w, http.StatusOK, result.Items)
}

// parseUserWorkspacesPagination reads cursor+limit for /api/user/workspaces.
// Cap is MaxUserWorkspacesPerPage (100) per ticket 0135.
func parseUserWorkspacesPagination(r *http.Request) (string, int, *pkgerrors.APIError) {
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	limit := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return "", 0, pkgerrors.BadRequest("invalid limit")
		}
		if parsed > services.MaxUserWorkspacesPerPage {
			parsed = services.MaxUserWorkspacesPerPage
		}
		limit = parsed
	}
	return cursor, limit, nil
}

// Ensure WorkspaceHandler.Service satisfies the interface at compile time.
var _ WorkspaceRouteService = (*services.WorkspaceService)(nil)

// Ensure db.Queries satisfies WorkspaceQuerier at compile time.
var _ services.WorkspaceQuerier = (*db.Queries)(nil)

type workspaceSSHUserSelector interface {
	GetWorkspaceSSHConnectionInfoAs(ctx context.Context, workspaceID string, repositoryID, userID int64, guestUser string) (services.WorkspaceSSHConnectionInfo, error)
}
