package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type MythicalRouteService interface {
	Snapshot(ctx context.Context, repositoryID int64, slug, mainCommit string, viewer services.MythicalViewer) (services.MythicalStackView, error)
	RequestBootstrap(ctx context.Context, repositoryID, actorUserID int64, depth int32, reset bool) (db.MythicalStack, error)
	Backfill(ctx context.Context, repositoryID int64) (services.MythicalBackfillCounts, error)
	SubmitLane(ctx context.Context, repositoryID, userID int64, input services.MythicalLaneSubmission) (services.MythicalLaneReceipt, error)
	SetMaxParallel(ctx context.Context, repositoryID int64, maxParallel int32) error
	Item(ctx context.Context, repositoryID int64, ref string) (services.MythicalItemView, error)
	RetryItem(ctx context.Context, repositoryID int64, itemID string) (services.MythicalItemView, error)
	FileTodo(ctx context.Context, repositoryID, userID int64, input services.MythicalTodoInput) (services.MythicalItemView, error)
	LandTodo(ctx context.Context, repositoryID, userID int64, itemID string, input services.MythicalLandInput) (services.MythicalItemView, error)
	RequestWiki(ctx context.Context, repositoryID int64) error
}

// MythicalHandler serves /api/repos/{owner}/{repo}/mythical: the stack
// snapshot (@smthrs/rpc/Mythical MythicalStackSchema), its event hints, and
// the bootstrap request. Writes answer 202 at once; the stack worker works.
type MythicalHandler struct {
	Service  MythicalRouteService
	Broker   *sse.Broker
	MainHead func(ctx context.Context, owner, repo, bookmark string) (string, error)
}

func (h *MythicalHandler) repository(w http.ResponseWriter, r *http.Request) (*middleware.RepoContext, bool) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("the mythical stack is not configured"))
		return nil, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return nil, false
	}
	return repoCtx, true
}

func (h *MythicalHandler) snapshot(r *http.Request, repoCtx *middleware.RepoContext) (services.MythicalStackView, error) {
	repository := repoCtx.Repository
	slug := repoCtx.Owner + "/" + repository.Name
	main := ""
	if h.MainHead != nil {
		bookmark := repository.DefaultBookmark
		if bookmark == "" {
			bookmark = "main"
		}
		// The behind flag is best effort: a slow bookmark read never fails the snapshot.
		if head, err := h.MainHead(r.Context(), repoCtx.Owner, repository.Name, bookmark); err == nil {
			main = head
		}
	}
	// Which account a lane runs on is its owner's business: every reader sees
	// the provider and seat, the account's owner also its name.
	viewer := services.MythicalViewer{Admin: middleware.RepoPermissionFromContext(r.Context()).Satisfies(middleware.PermissionAdmin)}
	if user := middleware.UserFromContext(r.Context()); user != nil {
		viewer.UserID = user.ID
	}
	return h.Service.Snapshot(r.Context(), repository.ID, slug, main, viewer)
}

// GetStack answers the snapshot.
func (h *MythicalHandler) GetStack(w http.ResponseWriter, r *http.Request) {
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	// A box that ran outsider-started work reads the stack's state for its
	// delivery, never other items' issue text.
	if middleware.ConversationWithheldFromContext(r.Context()) {
		view.Items = []services.MythicalItemView{}
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, view)
}

// GetItem answers one item, named by its id or its issue's number, however
// many items the stack holds. Its route refuses a box that ran
// outsider-started work, which reads no live issue text.
func (h *MythicalHandler) GetItem(w http.ResponseWriter, r *http.Request) {
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	item, err := h.Service.Item(r.Context(), repoCtx.Repository.ID, chi.URLParam(r, "ref"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, item)
}

type mythicalBootstrapRequest struct {
	Depth int32 `json:"depth"`
	Reset bool  `json:"reset"`
}

// Bootstrap requests the stack's creation from main's history (or, with
// reset, its rebuild) and answers the snapshot showing the request.
func (h *MythicalHandler) Bootstrap(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body mythicalBootstrapRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &body); err != nil && err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid bootstrap request"))
		return
	}
	if body.Depth < 0 || body.Depth > 500 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("depth must be between 1 and 500"))
		return
	}
	if _, err := h.Service.RequestBootstrap(r.Context(), repoCtx.Repository.ID, user.ID, body.Depth, body.Reset); err != nil {
		writeRouteError(w, r, err)
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, view)
}

// Events streams `mythical` hints; each carries the new generation.
func (h *MythicalHandler) Events(w http.ResponseWriter, r *http.Request) {
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	if h.Broker == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("event streaming is not configured"))
		return
	}
	var userID int64
	if user := middleware.UserFromContext(r.Context()); user != nil {
		userID = user.ID
	}
	cfg := sse.BrokerStreamConfig{
		Broker:        h.Broker,
		Channel:       fmt.Sprintf("mythical_%d", repoCtx.Repository.ID),
		UserID:        userID,
		EventType:     "mythical",
		FormatEventID: extractChangeEventID,
	}
	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repoCtx.Repository.ID})
	serveChangeBrokerSSE(w, r, cfg)
}

func decodeMythicalBody(w http.ResponseWriter, r *http.Request, limit int64, out any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, out); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid request body"))
		return false
	}
	return true
}

// Backfill admits every open GitHub issue now instead of waiting for the sweep.
// It answers when the issues are admitted; the lanes start in the background.
// Only a person asks for it (a run credential cannot); the stack's own sweep
// runs in-process.
func (h *MythicalHandler) Backfill(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if err := middleware.RequirePerson(r.Context(), "backfill the stack"); err != nil {
		writeRouteError(w, r, err)
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if _, err := h.Service.Backfill(ctx, repoCtx.Repository.ID); err != nil {
		writeRouteError(w, r, err)
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, view)
}

// Lanes takes a coding host's validated, cleaned result (coding/vibe).
func (h *MythicalHandler) Lanes(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body services.MythicalLaneSubmission
	if !decodeMythicalBody(w, r, 32<<10, &body) {
		return
	}
	receipt, err := h.Service.SubmitLane(r.Context(), repoCtx.Repository.ID, user.ID, body)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, receipt)
}

// Config sets how many lanes work at once.
func (h *MythicalHandler) Config(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body struct {
		MaxParallel int32 `json:"maxParallel"`
	}
	if !decodeMythicalBody(w, r, 1024, &body) {
		return
	}
	if err := h.Service.SetMaxParallel(r.Context(), repoCtx.Repository.ID, body.MaxParallel); err != nil {
		writeRouteError(w, r, err)
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, view)
}

// Retry gives a blocked, rejected or skipped item a fresh set of attempts.
func (h *MythicalHandler) Retry(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	item, err := h.Service.RetryItem(r.Context(), repoCtx.Repository.ID, chi.URLParam(r, "id"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, item)
}

// Todos files a TODO on the repository's GitHub issues for a maintainer
// person and answers its item, queued on the stack.
func (h *MythicalHandler) Todos(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body services.MythicalTodoInput
	if !decodeMythicalBody(w, r, 64<<10, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	item, err := h.Service.FileTodo(ctx, repoCtx.Repository.ID, user.ID, body)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, item)
}

// Land asks the stack to merge a proposed TODO's pull request for a
// maintainer person: it applies the automerge label for them and answers the
// item. The stack merges as for a maintainer's own label, at the reviewed
// head once CI is green; nothing is merged here.
func (h *MythicalHandler) Land(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body services.MythicalLandInput
	if !decodeMythicalBody(w, r, 4<<10, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	item, err := h.Service.LandTodo(ctx, repoCtx.Repository.ID, user.ID, chi.URLParam(r, "id"), body)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, item)
}

// Wiki requests a wiki refresh now, or a retry of a failed one, and answers
// the snapshot showing the request. The stack worker does the work.
func (h *MythicalHandler) Wiki(w http.ResponseWriter, r *http.Request) {
	if _, err := requireRouteUser(r); err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	if err := h.Service.RequestWiki(r.Context(), repoCtx.Repository.ID); err != nil {
		writeRouteError(w, r, err)
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, view)
}
