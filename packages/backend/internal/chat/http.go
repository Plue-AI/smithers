package chat

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

const (
	ReplayPath          = "/api/agent/turn/replay"
	HistoryPath         = "/api/agent/conversations"
	AccountReplayPath   = "/api/agent/conversations/replay"
	ErasePath           = "/api/agent/turn/erase"
	CommitPath          = "/internal/chat/commit"
	ProviderStartedPath = "/internal/chat/provider-started"
)

type Handler struct {
	ContextRepository ContextRepository
	// ResolveBranch authorizes and resolves branch aliases at the install boundary.
	ResolveBranch func(context.Context, Scope, string) (string, error)
	Store         *Store
	Dispatcher    *Dispatcher
	// Sources serves the source read and list callbacks; nil refuses them.
	Sources SourceReader
	// credentials keeps the credential that admitted each turn here.
	credentials *turnCredentials
	logger      *slog.Logger
}

type replayRequest struct {
	RunID   string         `json:"runId"`
	Journal JournalRequest `json:"journal"`
	After   *Cursor        `json:"after,omitempty"`
}

type eraseRequest struct {
	RunID           string `json:"runId"`
	LegID           string `json:"legId"`
	RetirementProof string `json:"retirementProof"`
}

type producerRequest struct {
	TurnID     string            `json:"turnId"`
	Generation int64             `json:"generation"`
	Expected   Cursor            `json:"expected"`
	Frames     []json.RawMessage `json:"frames"`
}

func decodeBounded(w http.ResponseWriter, r *http.Request, target any) bool {
	return decodeBoundedWithProblem(w, r, target, writeProblem)
}

func decodeBoundedWithProblem(w http.ResponseWriter, r *http.Request, target any, problem func(http.ResponseWriter, int, string)) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxPayloadBytes+maxBatchBytes+4097))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if middleware.IsMaxBytesError(err) {
			problem(w, http.StatusRequestEntityTooLarge, "request_too_large")
			return false
		}
		problem(w, http.StatusBadRequest, "request_invalid")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		problem(w, http.StatusBadRequest, "request_invalid")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeProblem(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"status": "error", "code": code})
}

func publicError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, ErrInvalidFrame):
		writeProblem(w, http.StatusBadRequest, "request_invalid")
	case errors.Is(err, ErrForbidden):
		writeProblem(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ErrNotFound):
		writeProblem(w, http.StatusNotFound, "not-found")
	case errors.Is(err, ErrRetired):
		writeProblem(w, http.StatusGone, "retired")
	case errors.Is(err, ErrCursorConflict):
		writeProblem(w, http.StatusConflict, "cursor")
	case errors.Is(err, ErrConflict):
		writeProblem(w, http.StatusConflict, "conflict")
	case errors.Is(err, ErrTerminal):
		writeProblem(w, http.StatusConflict, "terminal")
	case errors.Is(err, ErrLimit):
		writeProblem(w, http.StatusConflict, "limit")
	case errors.Is(err, ErrCorrupt):
		writeProblem(w, http.StatusInternalServerError, "corrupt")
	default:
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
	}
}

func producerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProducerFenced), errors.Is(err, ErrNotFound), errors.Is(err, ErrForbidden):
		writeProblem(w, http.StatusUnauthorized, "producer_fenced")
	case errors.Is(err, ErrInvalidRequest), errors.Is(err, ErrInvalidFrame):
		writeProblem(w, http.StatusBadRequest, "frame_invalid")
	case errors.Is(err, ErrLimit):
		writeProblem(w, http.StatusConflict, "limit")
	case errors.Is(err, ErrConflict), errors.Is(err, ErrCursorConflict), errors.Is(err, ErrTerminal),
		errors.Is(err, ErrProducerBusy), errors.Is(err, ErrUncertain):
		writeProblem(w, http.StatusConflict, "producer_conflict")
	case errors.Is(err, ErrRetired):
		// The user retired the leg while its producer ran. That is not an
		// infrastructure failure.
		writeProblem(w, http.StatusGone, "retired")
	case errors.Is(err, ErrCorrupt):
		writeProblem(w, http.StatusInternalServerError, "corrupt")
	default:
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
	}
}

func requestScope(r *http.Request) (Scope, error) {
	user := middleware.UserFromContext(r.Context())
	if user == nil || user.ID <= 0 || !validIdentity(user.Username) {
		return Scope{}, ErrForbidden
	}
	scope := Scope{UserID: user.ID, Owner: user.Username}
	if repository := middleware.RepoFromContext(r.Context()); repository != nil {
		scope.RepositoryID = repository.ID
	}
	return scope, nil
}

func (h *Handler) publicScope(w http.ResponseWriter, r *http.Request) (Scope, bool) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return Scope{}, false
	}
	scope, err := requestScope(r)
	if err != nil {
		writeProblem(w, http.StatusForbidden, "forbidden")
		return Scope{}, false
	}
	// Public install routes have no /repos prefix and therefore no RepoContext.
	// Bind their durable queue to the installed repository, never a body field.
	if scope.RepositoryID == 0 {
		scope.RepositoryID, err = db.New(h.Store.pool).InstallRepositoryID(r.Context())
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			publicError(w, err)
			return Scope{}, false
		}
	}
	return scope, true
}

func (h *Handler) Replay(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var request replayRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	page, err := h.Store.Replay(r.Context(), ReplayInput{Scope: scope, RunID: request.RunID, Journal: request.Journal, After: request.After, Limit: 8})
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) History(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	limit := maxHistoryPage
	if raw := r.URL.Query().Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil {
			publicError(w, ErrInvalidRequest)
			return
		}
	}
	page, err := h.Store.History(r.Context(), scope, r.URL.Query().Get("after"), limit)
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) ReplayAccount(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var input AccountReplayInput
	if !decodeBounded(w, r, &input) {
		return
	}
	input.Scope = scope
	page, err := h.Store.ReplayAccount(r.Context(), input)
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// Erase accepts only the deletion proof. It has no session dependency because
// the privacy outbox must remain usable after the account has signed out.
func (h *Handler) Erase(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request eraseRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	if err := h.Store.Erase(r.Context(), request.RunID, request.LegID, request.RetirementProof); err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "retired"})
}

func bearerToken(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("authorization"))
	if len(value) <= 7 || !strings.EqualFold(value[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(value[7:])
}

func (h *Handler) Commit(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request producerRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	token := bearerToken(r)
	if token == "" {
		writeProblem(w, http.StatusUnauthorized, "producer_fenced")
		return
	}
	result, err := h.Store.Commit(r.Context(), CommitInput{TurnID: request.TurnID, Generation: request.Generation, Token: token, Expected: request.Expected, Frames: request.Frames})
	if err != nil {
		producerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) ProviderStarted(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	turnID := strings.TrimSpace(r.URL.Query().Get("turnId"))
	generation, err := strconv.ParseInt(r.URL.Query().Get("generation"), 10, 64)
	if err != nil || turnID == "" || generation <= 0 || bearerToken(r) == "" {
		writeProblem(w, http.StatusBadRequest, "request_invalid")
		return
	}
	if err = h.Store.MarkProviderStarted(r.Context(), ProducerGrant{TurnID: turnID, Generation: generation, Token: bearerToken(r)}); err != nil {
		producerError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MountAuthenticated contains the routes that need an active account scope.
func (h *Handler) MountAuthenticated(router chi.Router) {
	router.Get("/api/conversations/{b}", h.Conversation)
	router.Post("/api/conversations/{b}/prompt", h.Prompt)
	router.Post(ReplayPath, h.Replay)
	router.Post("/api/conversations/{b}/turns/{id}/stop", h.QueueTurn)
	router.Patch("/api/conversations/{b}/turns/{id}", h.QueueTurn)
	router.Delete("/api/conversations/{b}/turns/{id}", h.QueueTurn)
	router.Get("/api/conversations/{b}/view-state", h.ViewState)
	router.Put("/api/conversations/{b}/view-state", h.ViewState)
	router.Get(HistoryPath, h.History)
	router.Post(AccountReplayPath, h.ReplayAccount)
}

func (h *Handler) MountErasure(router chi.Router) { router.Post(ErasePath, h.Erase) }

// MountPublic declares the full renderer contract for direct hosts. The shared
// composition mounts its authenticated and proof-only groups separately.
func (h *Handler) MountPublic(router chi.Router) {
	h.MountAuthenticated(router)
	h.MountErasure(router)
}

// MountProducerCallbacks is for the private loopback or isolated host network.
func (h *Handler) MountProducerCallbacks(router chi.Router) {
	router.Post(CommitPath, h.Commit)
	router.Post(ProviderStartedPath, h.ProviderStarted)
	router.Post(SourceReadPath, h.SourceRead)
	router.Post(SourceListPath, h.SourceList)
	router.Post(ContextPath, h.Context)
}
