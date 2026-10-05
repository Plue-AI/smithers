package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
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
	SubmitLane(ctx context.Context, repositoryID, userID int64, input services.MythicalLaneSubmission) (services.MythicalLaneReceipt, error)
	Item(ctx context.Context, repositoryID int64, ref string) (services.MythicalItemView, error)
	Merge(ctx context.Context, repositoryID, userID int64, itemID string, input services.MythicalMergeInput) (services.MythicalItemView, error)
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

// mythicalMergePath is the repository door's merge request.
var mythicalMergePath = regexp.MustCompile(`^/api/repos/[^/]+/[^/]+/mythical/items/[^/]+/merge$`)

// MergeCredentialFirst refuses a repository-door merge from every
// credential but a person's own browser session before the repository is
// resolved, as the numbered door refuses one before the TODO is read: both
// doors answer every credential alike (services.MergeCredential).
func MergeCredentialFirst(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && mythicalMergePath.MatchString(r.URL.Path) {
			if err := services.MergeCredential(r.Context(), r.Header.Get("Smithers-Via")); err != nil {
				refusal := err.(*services.TodoControlError)
				pkgerrors.WriteJSON(w, refusal.Status, refusal)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Merge acknowledges the person's persisted, head-bound request. Only the
// claimed stack worker can dispatch and reconcile a GitHub merge.
func (h *MythicalHandler) Merge(w http.ResponseWriter, r *http.Request) {
	if err := services.MergeCredential(r.Context(), r.Header.Get("Smithers-Via")); err != nil {
		refusal := err.(*services.TodoControlError)
		pkgerrors.WriteJSON(w, refusal.Status, refusal)
		return
	}
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if err := services.RequireMergeSession(r.Context(), user.ID); err != nil {
		refusal := err.(*services.TodoControlError)
		pkgerrors.WriteJSON(w, refusal.Status, refusal)
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body services.MythicalMergeInput
	if !decodeMythicalBody(w, r, 4<<10, &body) {
		return
	}
	body.Request = r.Header.Get("Idempotency-Key")
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	item, err := h.Service.Merge(ctx, repoCtx.Repository.ID, user.ID, chi.URLParam(r, "id"), body)
	if err != nil {
		if stale, ok := err.(*services.MythicalStaleHeadError); ok {
			pkgerrors.WriteJSON(w, stale.Status, stale)
		} else if refusal, ok := err.(*services.TodoControlError); ok {
			pkgerrors.WriteJSON(w, refusal.Status, refusal)
		} else {
			writeRouteError(w, r, err)
		}
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
