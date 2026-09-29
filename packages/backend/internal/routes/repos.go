package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// CreateRepoRequest is the API request for creating a repo.
type CreateRepoRequest struct {
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	Private         bool   `json:"private,omitempty"`
	AutoInit        bool   `json:"auto_init"`
	DefaultBookmark string `json:"default_bookmark,omitempty"`
}

// UpdateRepoRequest is the API request for updating a repo.
type UpdateRepoRequest struct {
	Name                       *string   `json:"name,omitempty"`
	Description                *string   `json:"description,omitempty"`
	Private                    *bool     `json:"private,omitempty"`
	DefaultBookmark            *string   `json:"default_bookmark,omitempty"`
	Topics                     *[]string `json:"topics,omitempty"`
	LandingQueueMode           *string   `json:"landing_queue_mode,omitempty"`
	LandingQueueRequiredChecks *[]string `json:"landing_queue_required_checks,omitempty"`
	Archived                   *bool     `json:"archived,omitempty"`
}

// RepoResponse is the API response for repo operations.
type RepoResponse struct {
	PendingTransfer            *db.RepositoryTransferRequest `json:"pending_transfer,omitempty"`
	ID                         int64                         `json:"id"`
	Owner                      string                        `json:"owner"`
	Name                       string                        `json:"name"`
	FullName                   string                        `json:"full_name"`
	Description                string                        `json:"description"`
	Private                    bool                          `json:"private"`
	IsPublic                   bool                          `json:"is_public"`
	DefaultBookmark            string                        `json:"default_bookmark"`
	Topics                     []string                      `json:"topics"`
	LandingQueueMode           string                        `json:"landing_queue_mode"`
	LandingQueueRequiredChecks []string                      `json:"landing_queue_required_checks"`
	IsArchived                 bool                          `json:"is_archived"`
	ArchivedAt                 *time.Time                    `json:"archived_at,omitempty"`
	IsFork                     bool                          `json:"is_fork"`
	ForkID                     *int64                        `json:"fork_id,omitempty"`
	// ForkOf is "owner/name" of the upstream this repository was forked from,
	// present only on a fork whose upstream still resolves.
	ForkOf *string `json:"fork_of,omitempty"`
	// CanWrite is the requesting viewer's effective write access. It is always
	// present on a single-repository read so a client can show the fork offer
	// instead of guessing — or worse, forking on the user's behalf.
	CanWrite             bool       `json:"can_write"`
	NumStars             int64      `json:"num_stars"`
	NumForks             int64      `json:"num_forks"`
	NumWatches           int64      `json:"num_watches"`
	NumIssues            int64      `json:"num_issues"`
	CloneURL             string     `json:"clone_url"`
	MirrorStatus         string     `json:"mirror_status"`
	BehindRefs           int32      `json:"behind_refs"`
	FailedRefs           int32      `json:"failed_refs"`
	LastMirrorAt         *time.Time `json:"last_mirror_at"`
	LastMirrorError      *string    `json:"last_mirror_error"`
	LastMirrorGitHubHead *string    `json:"last_mirror_github_head"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

type RepoRouteService interface {
	CreateRepo(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error)
	CreateOrgRepo(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error)
	GetRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error)
	UpdateRepo(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error)
	DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error
	GetRepoTopics(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error)
	ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error)

	GetRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error)
	ListRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error)
	ListGitRefs(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error)
	ArchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error)
	UnarchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error)
	TransferRepo(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error)
	ListRepoTransfers(ctx context.Context, actor *db.User) ([]db.RepositoryTransferRequest, error)
	AcceptRepoTransfer(ctx context.Context, actor *db.User, transferID int64) (db.Repository, error)
	DeclineRepoTransfer(ctx context.Context, actor *db.User, transferID int64) error
	CancelRepoTransfer(ctx context.Context, actor *db.User, transferID int64) error
	GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error)
	ForkRepo(ctx context.Context, actor *db.User, owner, repo string, nameOverride, descriptionOverride string) (services.ForkOutcome, error)
}

// RepoHandler handles repository API requests.
type RepoHandler struct {
	Service               RepoRouteService
	RepoConnectionService RepoConnectionRouteService
	RepoSyncService       RepoSyncRouteService
	SSHHost               string
	AuditService          *services.AuditService
}

// TransferRepoRequest is the API request for transferring a repo.
type TransferRepoRequest struct {
	NewOwner string `json:"new_owner"`
}

// ForkRepoRequest is the API request for forking a repo.
type ForkRepoRequest struct {
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

type RepoTopicsResponse struct {
	Topics []string `json:"topics"`
}

type replaceRepoTopicsRequest struct {
	Topics []string `json:"topics"`
}

// CreateRepo handles POST /api/user/repos.
func (h *RepoHandler) CreateRepo(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("not authenticated"))
		return
	}

	var req CreateRepoRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	defaultBookmark := strings.TrimSpace(req.DefaultBookmark)
	if defaultBookmark == "" {
		defaultBookmark = "main"
	}

	repo, err := h.Service.CreateRepo(
		r.Context(),
		user,
		req.Name,
		req.Description,
		!req.Private,
		defaultBookmark,
		req.AutoInit,
	)
	if err != nil {
		if apiErr, ok := err.(*errors.APIError); ok {
			errors.WriteError(w, apiErr)
			return
		}
		errors.WriteError(w, errors.Internal("unexpected error").WithCause(err))
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "repo.create",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "repository",
			TargetID:   &repo.ID,
			TargetName: fmt.Sprintf("%s/%s", user.Username, repo.Name),
			Action:     "create",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusCreated, mapRepoResponse(user.Username, repo, h.SSHHost))
}

// CreateOrgRepo handles POST /api/orgs/{org}/repos.
func (h *RepoHandler) CreateOrgRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req CreateRepoRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	defaultBookmark := strings.TrimSpace(req.DefaultBookmark)
	if defaultBookmark == "" {
		defaultBookmark = "main"
	}

	repo, err := h.Service.CreateOrgRepo(
		r.Context(),
		user,
		orgName,
		req.Name,
		req.Description,
		!req.Private,
		defaultBookmark,
		req.AutoInit,
	)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, mapRepoResponse(orgName, repo, h.SSHHost))
}

// GetRepo handles GET /api/repos/{owner}/{repo}.
func (h *RepoHandler) GetRepo(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	view, err := h.Service.GetRepoView(r.Context(), middleware.UserFromContext(r.Context()), owner, repoName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	resp := mapRepoResponse(owner, view.Repository, h.SSHHost)
	resp.CanWrite = view.CanWrite
	if view.ForkOf != "" {
		forkOf := view.ForkOf
		resp.ForkOf = &forkOf
	}
	errors.WriteJSON(w, http.StatusOK, resp)
}

// PatchRepo handles PATCH /api/repos/{owner}/{repo}.
func (h *RepoHandler) PatchRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req UpdateRepoRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	// Archive changes cannot be combined with ordinary settings updates.
	if req.Archived != nil && (req.Name != nil || req.Description != nil || req.Private != nil ||
		req.DefaultBookmark != nil || req.Topics != nil || req.LandingQueueMode != nil ||
		req.LandingQueueRequiredChecks != nil) {
		errors.WriteError(w, errors.UnprocessableEntity("archived cannot be combined with repository settings"))
		return
	}

	// Handle archive/unarchive via the archived field.
	if req.Archived != nil {
		if *req.Archived {
			updated, svcErr := h.Service.ArchiveRepo(r.Context(), user, owner, repoName)
			if svcErr != nil {
				writeRouteError(w, r, svcErr)
				return
			}
			if h.AuditService != nil {
				h.AuditService.Log(r.Context(), services.AuditEvent{
					EventType:  "repo.archive",
					ActorID:    &user.ID,
					ActorName:  user.Username,
					TargetType: "repository",
					TargetID:   &updated.ID,
					TargetName: fmt.Sprintf("%s/%s", owner, repoName),
					Action:     "archive",
					IPAddress:  r.RemoteAddr,
				})
			}
			errors.WriteJSON(w, http.StatusOK, mapRepoResponse(owner, updated, h.SSHHost))
			return
		}
		// archived=false → unarchive
		updated, svcErr := h.Service.UnarchiveRepo(r.Context(), user, owner, repoName)
		if svcErr != nil {
			writeRouteError(w, r, svcErr)
			return
		}
		if h.AuditService != nil {
			h.AuditService.Log(r.Context(), services.AuditEvent{
				EventType:  "repo.unarchive",
				ActorID:    &user.ID,
				ActorName:  user.Username,
				TargetType: "repository",
				TargetID:   &updated.ID,
				TargetName: fmt.Sprintf("%s/%s", owner, repoName),
				Action:     "unarchive",
				IPAddress:  r.RemoteAddr,
			})
		}
		errors.WriteJSON(w, http.StatusOK, mapRepoResponse(owner, updated, h.SSHHost))
		return
	}

	updated, err := h.Service.UpdateRepo(r.Context(), user, owner, repoName, services.UpdateRepoRequest{
		Name:                       req.Name,
		Description:                req.Description,
		Private:                    req.Private,
		DefaultBookmark:            req.DefaultBookmark,
		Topics:                     req.Topics,
		LandingQueueMode:           req.LandingQueueMode,
		LandingQueueRequiredChecks: req.LandingQueueRequiredChecks,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, mapRepoResponse(owner, updated, h.SSHHost))
}

// DeleteRepo handles DELETE /api/repos/{owner}/{repo}.
func (h *RepoHandler) DeleteRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.DeleteRepo(r.Context(), user, owner, repoName); err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "repo.delete",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "repository",
			TargetName: fmt.Sprintf("%s/%s", owner, repoName),
			Action:     "delete",
			IPAddress:  r.RemoteAddr,
		})
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetRepoTopics handles GET /api/repos/{owner}/{repo}/topics.
func (h *RepoHandler) GetRepoTopics(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	topics, err := h.Service.GetRepoTopics(r.Context(), middleware.UserFromContext(r.Context()), owner, repoName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, RepoTopicsResponse{Topics: topics})
}

// ReplaceRepoTopics handles PUT /api/repos/{owner}/{repo}/topics.
func (h *RepoHandler) ReplaceRepoTopics(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req replaceRepoTopicsRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	topics, err := h.Service.ReplaceRepoTopics(r.Context(), user, owner, repoName, req.Topics)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, RepoTopicsResponse{Topics: topics})
}

// GetRepoContents handles GET /api/repos/{owner}/{repo}/contents and
// GET /api/repos/{owner}/{repo}/contents/{path:.*}.
// An empty path returns the root directory listing as an array.
func (h *RepoHandler) listContentsPage(w http.ResponseWriter, r *http.Request, owner, repo, ref, path string) ([]services.RepoContent, error) {
	limit := 1000
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 1000 {
			return nil, errors.BadRequest("directory page limit must be between 1 and 1000")
		}
		limit = parsed
	}
	after := r.URL.Query().Get("after")
	if verr := validateContentPath(after); verr != nil {
		return nil, verr
	}
	if pager, ok := h.Service.(interface {
		ListRepoContentsPage(context.Context, *db.User, string, string, string, string, string, int) ([]services.RepoContent, string, string, error)
	}); ok {
		entries, next, commit, err := pager.ListRepoContentsPage(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, ref, path, after, limit)
		if err == nil {
			w.Header().Set("X-Contents-Commit", commit)
		}
		if next != "" {
			w.Header().Set("X-Next-Cursor", next)
		}
		return entries, err
	}
	return h.Service.ListRepoContents(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, ref, path)
}

func (h *RepoHandler) GetRepoContents(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	// Read the chi catch-all ("*"), not a "{path}" segment param: a nested
	// path like apps/cli spans multiple '/'-delimited segments, and a regex
	// param ({path:.*}) only ever matches ONE segment, so every 2+ segment
	// path fell through to a 404 and folder/nested-file browsing was broken.
	// The route registers "/contents/*" to capture the full remaining path.
	repoPath := strings.TrimSpace(chi.URLParam(r, "*"))
	ref := strings.TrimSpace(r.URL.Query().Get("ref"))

	// Reject NUL / control chars and absurd lengths before the ref/path reach the
	// git/jj resolver, which would otherwise surface as an opaque 500.
	if verr := validateRef(ref); verr != nil {
		errors.WriteError(w, verr)
		return
	}
	if verr := validateContentPath(repoPath); verr != nil {
		errors.WriteError(w, verr)
		return
	}

	if repoPath == "" {
		entries, err := h.listContentsPage(w, r, owner, repoName, ref, "")
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		errors.WriteJSON(w, http.StatusOK, entries)
		return
	}

	// Try an exact file read before directory enumeration. Notes trees can
	// contain many files, and a file path must return content, not a listing.
	content, err := h.Service.GetRepoContents(r.Context(), middleware.UserFromContext(r.Context()), owner, repoName, ref, repoPath)
	if err == nil {
		errors.WriteJSON(w, http.StatusOK, content)
		return
	}
	if apiErr, ok := err.(*errors.APIError); !ok || apiErr.Status != http.StatusNotFound {
		writeRouteError(w, r, err)
		return
	}
	entries, listErr := h.listContentsPage(w, r, owner, repoName, ref, repoPath)
	if listErr != nil {
		writeRouteError(w, r, listErr)
		return
	}
	if len(entries) == 0 && r.URL.Query().Get("after") == "" {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, entries)
}

const homeDocumentLimit = 128 * 1024
const homeMarkdownLimit = 256 * 1024

type repositoryHomeBlock struct {
	Type        string  `json:"type"`
	Title       string  `json:"title,omitempty"`
	Text        string  `json:"text,omitempty"`
	Flow        string  `json:"flow,omitempty"`
	Placeholder string  `json:"placeholder,omitempty"`
	Picture     string  `json:"picture,omitempty"`
	Path        string  `json:"path,omitempty"`
	Markdown    *string `json:"markdown,omitempty"`
	Links       []struct {
		Label string `json:"label"`
		URL   string `json:"url"`
	} `json:"links,omitempty"`
}

func validHomePath(value string) bool {
	if value == "" || len(value) > 1024 || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\%:?#") || strings.IndexFunc(value, func(r rune) bool { return r < 0x20 }) >= 0 {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// GetRepositoryHome resolves the homepage against main through the same readable
// repository contents service as the public file route.
func (h *RepoHandler) GetRepositoryHome(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	read := func(path string) (services.RepoContent, error) {
		return h.Service.GetRepoContents(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, "main", path)
	}
	missing := func(err error) bool {
		apiErr, ok := err.(*errors.APIError)
		return ok && apiErr.Status == http.StatusNotFound && apiErr.Message != "repository storage not found"
	}
	document, err := read(".smithers/home.json")
	if err == nil {
		if document.Size > homeDocumentLimit || len(document.Content) > homeDocumentLimit || !utf8.ValidString(document.Content) {
			errors.WriteError(w, errors.BadRequest("repository homepage is too large or invalid"))
			return
		}
		var parsed struct {
			Blocks []repositoryHomeBlock `json:"blocks"`
		}
		if json.Unmarshal([]byte(document.Content), &parsed) != nil || len(parsed.Blocks) > 32 || parsed.Blocks == nil {
			errors.WriteError(w, errors.BadRequest("repository homepage is invalid"))
			return
		}
		// A block kind this server does not know is left out, never the whole
		// homepage: a repository can declare a newer block before the server
		// that renders it is deployed.
		blocks := parsed.Blocks[:0]
		for i := range parsed.Blocks {
			block := &parsed.Blocks[i]
			switch block.Type {
			case "prompt", "flows", "text", "links", "stack", "app":
			case "markdown":
				if !validHomePath(block.Path) {
					errors.WriteError(w, errors.BadRequest("repository homepage has an invalid markdown path"))
					return
				}
				file, fileErr := read(block.Path)
				if missing(fileErr) {
					// A declared file that is absent is the declaration's fault, not a missing repository.
					errors.WriteError(w, errors.BadRequest("repository homepage markdown file is missing: "+block.Path))
					return
				}
				if fileErr != nil {
					writeRouteError(w, r, fileErr)
					return
				}
				if file.Size > homeMarkdownLimit || len(file.Content) > homeMarkdownLimit || !utf8.ValidString(file.Content) {
					errors.WriteError(w, errors.BadRequest("repository homepage markdown is too large or invalid"))
					return
				}
				block.Markdown = &file.Content
			default:
				continue
			}
			blocks = append(blocks, *block)
		}
		parsed.Blocks = blocks
		errors.WriteJSON(w, http.StatusOK, map[string]any{"kind": "blocks", "blocks": parsed.Blocks})
		return
	}
	if !missing(err) {
		writeRouteError(w, r, err)
		return
	}
	readme, err := read("README.md")
	if err == nil {
		if readme.Size > homeMarkdownLimit || len(readme.Content) > homeMarkdownLimit || !utf8.ValidString(readme.Content) {
			errors.WriteError(w, errors.BadRequest("repository README is too large or invalid"))
			return
		}
		errors.WriteJSON(w, http.StatusOK, map[string]any{"kind": "readme", "markdown": readme.Content})
		return
	}
	if !missing(err) {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, map[string]string{"kind": "none"})
}

// ListGitRefs handles GET /api/repos/{owner}/{repo}/git/refs.
func (h *RepoHandler) ListGitRefs(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	refs, err := h.Service.ListGitRefs(r.Context(), middleware.UserFromContext(r.Context()), owner, repoName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, refs)
}

// ArchiveRepo handles POST /api/repos/{owner}/{repo}/archive.
func (h *RepoHandler) ArchiveRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	updated, err := h.Service.ArchiveRepo(r.Context(), user, owner, repoName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "repo.archive",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "repository",
			TargetID:   &updated.ID,
			TargetName: fmt.Sprintf("%s/%s", owner, repoName),
			Action:     "archive",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusOK, mapRepoResponse(owner, updated, h.SSHHost))
}

// UnarchiveRepo handles POST /api/repos/{owner}/{repo}/unarchive.
func (h *RepoHandler) UnarchiveRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	updated, err := h.Service.UnarchiveRepo(r.Context(), user, owner, repoName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "repo.unarchive",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "repository",
			TargetID:   &updated.ID,
			TargetName: fmt.Sprintf("%s/%s", owner, repoName),
			Action:     "unarchive",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusOK, mapRepoResponse(owner, updated, h.SSHHost))
}

// TransferRepo handles POST /api/repos/{owner}/{repo}/transfer.
func (h *RepoHandler) TransferRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req TransferRepoRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, err := h.Service.TransferRepo(r.Context(), user, owner, repoName, req.NewOwner)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	action := "transfer"
	if updated.PendingTransfer != nil {
		action = "transfer_requested"
	}
	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "repo." + action,
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "repository",
			TargetID:   &updated.ID,
			TargetName: fmt.Sprintf("%s/%s", owner, repoName),
			Action:     action,
			IPAddress:  r.RemoteAddr,
		})
	}

	response := mapRepoResponse(updated.Owner, updated.Repository, h.SSHHost)
	response.PendingTransfer = updated.PendingTransfer
	errors.WriteJSON(w, http.StatusAccepted, response)
}

// ForkRepo handles POST /api/repos/{owner}/{repo}/fork (and its /forks alias).
//
// It is the only way a repository is ever copied into a user namespace: plue
// forks nothing on its own, so this handler runs only because a person clicked
// a button that named the repository and the namespace.
func (h *RepoHandler) ForkRepo(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req ForkRepoRequest
	if !decodeOptionalJSONBody(w, r, &req) {
		return
	}

	outcome, err := h.Service.ForkRepo(r.Context(), user, owner, repoName, req.Name, req.Description)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	forkedRepo := outcome.Repository

	if h.AuditService != nil && outcome.Created {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "repo.fork",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "repository",
			TargetID:   &forkedRepo.ID,
			TargetName: fmt.Sprintf("%s/%s", user.Username, forkedRepo.Name),
			Action:     "fork",
			IPAddress:  r.RemoteAddr,
		})
	}

	// 202 when this request created the fork (the ref copy completes
	// asynchronously), 200 when the caller already had it. A repeated fork is
	// answered with the same repository rather than a second copy, so the UI
	// can treat both as "go to my fork".
	status := http.StatusOK
	if outcome.Created {
		status = http.StatusAccepted
	}
	resp := mapRepoResponse(user.Username, forkedRepo, h.SSHHost)
	resp.CanWrite = true
	forkOf := fmt.Sprintf("%s/%s", owner, repoName)
	resp.ForkOf = &forkOf
	errors.WriteJSON(w, status, resp)
}

func mapRepoResponse(owner string, repo db.Repository, sshHost string) RepoResponse {
	trimmedOwner := strings.TrimSpace(owner)
	if trimmedOwner == "" {
		trimmedOwner = "unknown"
	}
	if strings.TrimSpace(sshHost) == "" {
		sshHost = "localhost"
	}
	mirrorStatus := repo.MirrorStatus
	if mirrorStatus == "" {
		mirrorStatus = "unconfigured"
	}

	resp := RepoResponse{
		ID:                         repo.ID,
		Owner:                      trimmedOwner,
		Name:                       repo.Name,
		FullName:                   fmt.Sprintf("%s/%s", trimmedOwner, repo.Name),
		Description:                repo.Description,
		Private:                    !repo.IsPublic,
		IsPublic:                   repo.IsPublic,
		DefaultBookmark:            repo.DefaultBookmark,
		Topics:                     repo.Topics,
		LandingQueueMode:           repo.LandingQueueMode,
		LandingQueueRequiredChecks: repo.LandingQueueRequiredChecks,
		IsArchived:                 repo.IsArchived,
		IsFork:                     repo.IsFork,
		NumStars:                   repo.NumStars,
		NumForks:                   repo.NumForks,
		NumWatches:                 repo.NumWatches,
		NumIssues:                  repo.NumIssues,
		CloneURL:                   fmt.Sprintf("git@%s:%s/%s.git", sshHost, trimmedOwner, repo.Name),
		MirrorStatus:               mirrorStatus,
		BehindRefs:                 repo.MirrorBehindRefs,
		FailedRefs:                 repo.MirrorFailedRefs,
		CreatedAt:                  repo.CreatedAt.Truncate(time.Second),
		UpdatedAt:                  repo.UpdatedAt.Truncate(time.Second),
	}
	if repo.ForkID.Valid {
		resp.ForkID = &repo.ForkID.Int64
	}
	if repo.ArchivedAt.Valid {
		t := repo.ArchivedAt.Time.Truncate(time.Second)
		resp.ArchivedAt = &t
	}
	if repo.LastMirrorAt.Valid {
		t := repo.LastMirrorAt.Time.Truncate(time.Second)
		resp.LastMirrorAt = &t
	}
	if repo.LastMirrorError.Valid {
		errorMessage := repo.LastMirrorError.String
		resp.LastMirrorError = &errorMessage
	}
	if repo.LastMirrorGithubHead.Valid {
		head := repo.LastMirrorGithubHead.String
		resp.LastMirrorGitHubHead = &head
	}
	return resp
}
