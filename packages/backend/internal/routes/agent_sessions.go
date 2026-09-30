package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

var validAgentMessageRoles = map[string]struct{}{
	"user":      {},
	"assistant": {},
	"system":    {},
	"tool":      {},
}

var validAgentMessagePartTypes = map[string]struct{}{
	"text":        {},
	"tool_call":   {},
	"tool_result": {},
}

// AgentSessionRouteService defines the service interface required by the public
// agent session API routes.
type AgentSessionRouteService interface {
	CreateSession(ctx context.Context, input services.CreateAgentSessionInput) (services.AgentSessionResponse, error)
	GetSession(ctx context.Context, sessionID string) (services.AgentSessionResponse, error)
	GetSessionForRepo(ctx context.Context, sessionID string, repoID int64) error
	ListSessions(ctx context.Context, repositoryID int64, page, perPage int) ([]services.AgentSessionResponse, int64, error)
	DeleteSession(ctx context.Context, sessionID string, userID int64) error
	AppendMessage(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error)
	ListMessages(ctx context.Context, sessionID string, page, perPage int) ([]services.AgentMessageResponse, error)
	EnsureSessionDispatchable(ctx context.Context, sessionID string) error
	AppendMessageAndDispatch(ctx context.Context, input services.DispatchAgentRunInput, parts []db.CreateAgentPartParams) (services.AgentMessageResponse, error)
}

// AgentSessionHandler handles the public repository-scoped agent session API.
type AgentSessionHandler struct {
	Service     AgentSessionRouteService
	EgressAudit SandboxEgressAuditRouteService
}

// ListEgressAudit handles GET /api/repos/{owner}/{repo}/agent-sessions/{id}/egress.
func (h *AgentSessionHandler) ListEgressAudit(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}
	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}
	if svcErr := h.Service.GetSessionForRepo(r.Context(), sessionID, repoCtx.Repository.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	serveSandboxEgressAudit(w, r, h.EgressAudit, "agent_session", sessionID)
}

type createAgentSessionRequest struct {
	Title string `json:"title"`
}

type createAgentMessageRequest struct {
	Role           string                          `json:"role"`
	Parts          []createAgentMessagePartRequest `json:"parts"`
	Text           string                          `json:"text"`
	AgentProvider  string                          `json:"agent_provider"`
	AgentTransport string                          `json:"agent_transport"`
	// ChangesetID materializes a cross-repository changeset's members into the
	// agent VM at their pinned commits.
	ChangesetID  int64    `json:"changeset_id,omitempty"`
	AllowedPaths []string `json:"allowed_paths,omitempty"`
}

type createAgentMessagePartRequest struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
}

// CreateSession handles POST /api/repos/{owner}/{repo}/agent/sessions.
func (h *AgentSessionHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

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

	var req createAgentSessionRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	session, svcErr := h.Service.CreateSession(r.Context(), services.CreateAgentSessionInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		Title:        strings.TrimSpace(req.Title),
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	middleware.LoggerWithAgentSession(r.Context(), session.ID).Info("agent session created",
		"repo_id", repoCtx.Repository.ID,
		"user_id", user.ID,
	)

	pkgerrors.WriteJSON(w, http.StatusCreated, session)
}

// ListSessions handles GET /api/repos/{owner}/{repo}/agent/sessions.
func (h *AgentSessionHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

	_, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	sessions, total, svcErr := h.Service.ListSessions(r.Context(), repoCtx.Repository.ID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(sessions), total)
	pkgerrors.WriteJSON(w, http.StatusOK, sessions)
}

// GetSession handles GET /api/repos/{owner}/{repo}/agent/sessions/{id}.
func (h *AgentSessionHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

	_, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	if svcErr := h.Service.GetSessionForRepo(r.Context(), sessionID, repoCtx.Repository.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	session, svcErr := h.Service.GetSession(r.Context(), sessionID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, session)
}

// DeleteSession handles DELETE /api/repos/{owner}/{repo}/agent/sessions/{id}.
func (h *AgentSessionHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	if svcErr := h.Service.GetSessionForRepo(r.Context(), sessionID, repoCtx.Repository.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	if svcErr := h.Service.DeleteSession(r.Context(), sessionID, user.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	middleware.LoggerWithAgentSession(r.Context(), sessionID).Info("agent session deleted",
		"repo_id", repoCtx.Repository.ID,
		"user_id", user.ID,
	)

	w.WriteHeader(http.StatusNoContent)
}

// PostMessage handles POST /api/repos/{owner}/{repo}/agent/sessions/{id}/messages.
func (h *AgentSessionHandler) PostMessage(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	if svcErr := h.Service.GetSessionForRepo(r.Context(), sessionID, repoCtx.Repository.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// Only the session owner may post messages (matching DeleteSession).
	session, svcErr := h.Service.GetSession(r.Context(), sessionID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	if session.UserID != user.ID {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("you do not own this agent session"))
		return
	}

	var req createAgentMessageRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	role, parts, apiErr := normalizeCreateAgentMessageRequest(req)
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	var dispatchInput services.DispatchAgentRunInput
	if role == "user" {
		provider, transport, apiErr := normalizeAgentRuntimeRequest(req.AgentProvider, req.AgentTransport)
		if apiErr != nil {
			pkgerrors.WriteError(w, apiErr)
			return
		}
		// Reject up-front with 409 when the session already has an active run;
		// dispatching another run would orphan the running agent and leak its VM.
		if svcErr := h.Service.EnsureSessionDispatchable(r.Context(), sessionID); svcErr != nil {
			writeRouteError(w, r, svcErr)
			return
		}
		dispatchInput = services.DispatchAgentRunInput{
			SessionID:      sessionID,
			RepositoryID:   repoCtx.Repository.ID,
			UserID:         user.ID,
			MessageAuthor:  user.Username,
			RepoOwner:      repoCtx.Owner,
			RepoName:       repoCtx.Repository.Name,
			AgentProvider:  provider,
			AgentTransport: transport,
			ChangesetID:    req.ChangesetID,
			AllowedPaths:   req.AllowedPaths,
		}
	}

	appendStartedAt := time.Now()
	middleware.LoggerWithAgentSession(r.Context(), sessionID).Info("agent message append starting",
		"role", role,
		"repo_id", repoCtx.Repository.ID,
		"user_id", user.ID,
	)
	var msg services.AgentMessageResponse
	if role == "user" {
		msg, svcErr = h.Service.AppendMessageAndDispatch(r.Context(), dispatchInput, parts)
	} else {
		msg, svcErr = h.Service.AppendMessage(r.Context(), sessionID, role, parts)
	}
	if svcErr != nil {
		middleware.LoggerWithAgentSession(r.Context(), sessionID).Error("agent message append failed",
			"role", role,
			"repo_id", repoCtx.Repository.ID,
			"user_id", user.ID,
			"duration_ms", time.Since(appendStartedAt).Milliseconds(),
			"error", svcErr,
		)
		writeRouteError(w, r, svcErr)
		return
	}

	middleware.LoggerWithAgentSession(r.Context(), sessionID).Info("agent message appended",
		"role", role,
		"message_id", msg.ID,
		"repo_id", repoCtx.Repository.ID,
		"user_id", user.ID,
		"duration_ms", time.Since(appendStartedAt).Milliseconds(),
	)

	pkgerrors.WriteJSON(w, http.StatusCreated, msg)
}

func normalizeAgentRuntimeRequest(provider, transport string) (string, string, *pkgerrors.APIError) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	transport = strings.ToLower(strings.TrimSpace(transport))
	if provider == "" {
		provider = "smithers"
	}
	if transport == "" {
		transport = "workflow"
	}
	if provider != "smithers" && provider != "codex" {
		return "", "", pkgerrors.BadRequest("agent_provider must be 'smithers' or 'codex'")
	}
	if transport != "workflow" && transport != "http" {
		return "", "", pkgerrors.BadRequest("agent_transport must be 'workflow' or 'http'")
	}
	if provider == "smithers" && transport == "http" {
		return "", "", pkgerrors.BadRequest("agent_transport=http is only supported with agent_provider=codex")
	}
	return provider, transport, nil
}

// ListMessages handles GET /api/repos/{owner}/{repo}/agent/sessions/{id}/messages.
func (h *AgentSessionHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("agent service unavailable"))
		return
	}

	_, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	if svcErr := h.Service.GetSessionForRepo(r.Context(), sessionID, repoCtx.Repository.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	messages, svcErr := h.Service.ListMessages(r.Context(), sessionID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, messages)
}

const (
	// maxAgentMessageParts caps parts[] per message. Each part becomes one
	// agent_parts row inserted inside a single locked append transaction, and
	// every later REST list / SSE replay expands ALL parts of every message
	// (ListAgentMessageParts has no LIMIT) — so unbounded parts are an O(N)
	// write and read amplification vector for a body under the request size
	// limit (tens of thousands of minimal text parts in 1 MiB).
	maxAgentMessageParts = 128
	// maxAgentMessagePartsBytes caps the aggregate normalized part content per
	// message, bounding the stored transcript growth per request independently
	// of part count.
	maxAgentMessagePartsBytes = 512 * 1024
)

func normalizeAgentMessageParts(parts []createAgentMessagePartRequest) ([]db.CreateAgentPartParams, *pkgerrors.APIError) {
	if len(parts) == 0 {
		return nil, pkgerrors.BadRequest("parts are required")
	}
	if len(parts) > maxAgentMessageParts {
		return nil, pkgerrors.BadRequest(fmt.Sprintf("too many parts: at most %d per message", maxAgentMessageParts))
	}

	totalContentBytes := 0
	normalized := make([]db.CreateAgentPartParams, 0, len(parts))
	for _, part := range parts {
		partType := strings.TrimSpace(part.Type)
		if _, ok := validAgentMessagePartTypes[partType]; !ok {
			return nil, pkgerrors.BadRequest("invalid part type")
		}

		content, err := normalizeAgentMessagePartContent(partType, part.Content)
		if err != nil {
			return nil, pkgerrors.BadRequest(err.Error())
		}

		totalContentBytes += len(content)
		if totalContentBytes > maxAgentMessagePartsBytes {
			return nil, pkgerrors.BadRequest(fmt.Sprintf("message parts too large: at most %d content bytes per message", maxAgentMessagePartsBytes))
		}

		normalized = append(normalized, db.CreateAgentPartParams{
			PartType: partType,
			Content:  content,
		})
	}

	return normalized, nil
}

func normalizeCreateAgentMessageRequest(req createAgentMessageRequest) (string, []db.CreateAgentPartParams, *pkgerrors.APIError) {
	role := strings.TrimSpace(req.Role)
	if len(req.Parts) == 0 {
		text := strings.TrimSpace(req.Text)
		if text != "" {
			if role == "" {
				role = "assistant"
			}
			req.Parts = []createAgentMessagePartRequest{{
				Type:    "text",
				Content: mustMarshalAgentJSON(text),
			}}
		}
	}

	if _, ok := validAgentMessageRoles[role]; !ok {
		return "", nil, pkgerrors.BadRequest("invalid role")
	}

	parts, apiErr := normalizeAgentMessageParts(req.Parts)
	if apiErr != nil {
		return "", nil, apiErr
	}

	return role, parts, nil
}

func normalizeAgentMessagePartContent(partType string, raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("part content is required")
	}

	var decoded any
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return nil, fmt.Errorf("invalid part content")
	}
	if decoded == nil {
		return nil, fmt.Errorf("part content is required")
	}

	if textValue, ok := decoded.(string); ok {
		if partType != "text" {
			return nil, fmt.Errorf("part content must be an object for %s", partType)
		}
		return mustMarshalAgentJSON(map[string]string{"value": textValue}), nil
	}

	// Content must be a JSON object: the agent_parts.content column enforces
	// jsonb_typeof(content) = 'object'. Arrays/numbers/booleans previously passed
	// route validation and only failed at the DB CHECK, surfacing as a 500 for a
	// client-malformed (but well-formed-JSON) request instead of a 400.
	if _, ok := decoded.(map[string]any); !ok {
		return nil, fmt.Errorf("part content must be an object")
	}

	return mustMarshalAgentJSON(decoded), nil
}

// mustMarshalAgentJSON marshals a value that is guaranteed JSON-marshalable —
// a string, a map[string]string, or a value produced by json.Unmarshal. For
// those inputs json.Marshal cannot fail, so the error path is unreachable at
// runtime; a panic here signals a programming error, never a client-triggerable
// request failure.
func mustMarshalAgentJSON(v any) json.RawMessage {
	encoded, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("agent message content should be JSON-marshalable: %v", err))
	}
	return encoded
}

// Ensure AgentService satisfies the route interface at compile time.
var _ AgentSessionRouteService = (*services.AgentService)(nil)
