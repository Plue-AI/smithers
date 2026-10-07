package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BranchReadService is the workspace service's branch projection.
type BranchReadService interface {
	ListBranches(context.Context, int64, int64, int, int) ([]services.BranchMachineResponse, int64, error)
	GetBranch(context.Context, string, int64, int64) (services.BranchMachineResponse, error)
}

// BranchForkService is the stack service's Fork.
type BranchForkService interface {
	ForkBranch(context.Context, int64, int64, services.BranchForkInput) (services.BranchMachineResponse, error)
}

type BranchAddService interface {
	AddBranchToStack(context.Context, int64, int64, string, services.BranchAddInput) (services.MythicalItemView, error)
}

type BranchAnswerService interface {
	AnswerBranch(context.Context, string, services.TodoControlInput) (services.TodoControlReceipt, error)
}

type BranchMachineControl interface {
	RequestBranchMachine(context.Context, string, int64, int64, string, string) (jobs.RequestReceipt, error)
}

// BranchHandler serves the install's branches (spec §6.3 /api/branches):
// reads of the workspace projection and Fork, which the stack service
// performs. Authorize decides the command for the request's person and
// resolves the install's repository; a caller never names either.
type BranchHandler struct {
	Authorize func(r *http.Request, command string) (repositoryID, userID int64, err error)
	Reads     BranchReadService
	Forks     BranchForkService
	Files     BranchFileReadService
	Answers   BranchAnswerService
	Adds      BranchAddService
	Machines  BranchMachineControl
}

// RegisterBranchRoutes mounts /branches under the install's /api router;
// the legacy hosted composition never calls it. A route whose service the
// composition lacks answers 503.
func RegisterBranchRoutes(r chi.Router, h *BranchHandler) {
	if h == nil {
		return
	}
	r.Get("/branches", h.ListBranches)
	r.Get("/branches/{b}", h.GetBranch)
	r.Post("/branches", h.Fork)
	r.Post("/branches/{b}/add-to-stack", h.AddToStack)
	r.Post("/branches/{b}", h.Answer)
	r.Get("/branches/{b}/files", h.ListFiles)
}

func (h *BranchHandler) Answer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Op       string `json:"op"`
		ID       string `json:"id"`
		Revision string `json:"revision"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &body); err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("Invalid branch answer"))
		return
	}
	if body.Op == "sleep" || body.Op == "wake" {
		repository, user, err := h.authorize(r, "branch."+body.Op, h.Machines != nil)
		if err != nil {
			writeBranchError(w, r, err)
			return
		}
		branch, err := url.PathUnescape(chi.URLParam(r, "b"))
		if err != nil || body.ID != "" || body.Revision != "" {
			writeBranchError(w, r, pkgerrors.BadRequest("Invalid branch request"))
			return
		}
		receipt, err := h.Machines.RequestBranchMachine(r.Context(), branch, repository, user, body.Op, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeBranchError(w, r, err)
			return
		}
		pkgerrors.WriteJSON(w, http.StatusAccepted, receipt)
		return
	}
	if body.Op != "bring-in" && body.Op != "discard-foreign" {
		writeBranchError(w, r, pkgerrors.BadRequest("Invalid branch answer"))
		return
	}
	repository, user, err := h.authorize(r, "branch."+body.Op, h.Answers != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("Invalid branch"))
		return
	}
	receipt, err := h.Answers.AnswerBranch(r.Context(), branch, services.TodoControlInput{
		Op: body.Op, Wait: body.ID, Revision: body.Revision,
		Repository: repository, Actor: user, Request: r.Header.Get("Idempotency-Key"),
	})
	if err != nil {
		todoRouteError(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, receipt)
}

// authorize decides command once the route's service is composed.
func (h *BranchHandler) authorize(r *http.Request, command string, composed bool) (int64, int64, error) {
	if h.Authorize == nil || !composed {
		return 0, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branches unavailable")
	}
	return h.Authorize(r, command)
}

// InstallBranchAuthorizer decides a branch command for the request's person
// (services.Authorize, by roster role) and resolves the install's repository.
func InstallBranchAuthorizer(queries *db.Queries) func(*http.Request, string) (int64, int64, error) {
	return func(r *http.Request, command string) (int64, int64, error) {
		if queries == nil {
			return 0, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branches unavailable")
		}
		subject := services.InstallSubject{}
		if command == "branch.fork" && services.InstallExecutionCredential(r.Context()) {
			raw, err := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
			if err != nil || len(raw) > 64<<10 {
				return 0, 0, pkgerrors.BadRequest("Invalid fork request")
			}
			input, err := DecodeBranchFork(bytes.NewReader(raw))
			if err != nil {
				return 0, 0, err
			}
			r.Body = io.NopCloser(bytes.NewReader(raw))
			repository, err := services.InstallRepositoryID(r.Context(), queries)
			if err != nil {
				return 0, 0, err
			}
			subject = services.InstallBranchForkSubject(r.Context(), repository, input)
		}
		if command == "branch.read" && services.InstallExecutionCredential(r.Context()) {
			var err error
			subject, err = InstallBranchReadSubject(r, queries)
			if err != nil {
				return 0, 0, err
			}
		}

		decision, err := services.Authorize(r.Context(), queries, command, subject)
		if err != nil {
			return 0, 0, err
		}
		repository, err := services.InstallRepositoryID(r.Context(), queries)
		if err != nil {
			return 0, 0, err
		}
		return repository, decision.UserID, nil
	}
}

func (h *BranchHandler) ListBranches(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branches.read", h.Reads != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	rows, total, err := h.Reads.ListBranches(r.Context(), repository, user, page, limit)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	setOffsetCursorPaginationHeaders(w, r, page, limit, len(rows), total)
	pkgerrors.WriteJSON(w, http.StatusOK, rows)
}

func (h *BranchHandler) GetBranch(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branch.read", h.Reads != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("invalid branch name"))
		return
	}
	row, err := h.Reads.GetBranch(r.Context(), branch, repository, user)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, row)
}

// Fork is POST /api/branches fork{from, name?}: 201 with the new scratch
// branch, forked_from and its head.
func (h *BranchHandler) Fork(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branch.fork", h.Forks != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	input, err := DecodeBranchFork(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	input.Request = r.Header.Get("Idempotency-Key")
	if len(input.Request) > 256 {
		writeBranchError(w, r, pkgerrors.BadRequest("invalid fork request"))
		return
	}
	branch, err := h.Forks.ForkBranch(r.Context(), repository, user, input)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, branch)
}

// writeBranchError keeps the resource's errors on the §6.2.3 wire contract
// while the legacy workspace endpoints retain their existing error decoder.
func writeBranchError(w http.ResponseWriter, r *http.Request, err error) {
	var refused *services.BranchError
	if errors.As(err, &refused) {
		pkgerrors.WriteJSON(w, refused.Status, refused)
		return
	}
	var control *services.TodoControlError
	if errors.As(err, &control) {
		pkgerrors.WriteJSON(w, control.Status, control)
		return
	}
	var access *services.AccessError
	if errors.As(err, &access) {
		pkgerrors.WriteJSON(w, access.Status, access)
		return
	}
	status, code, class, message := 503, "branch_machine_unavailable", "infra", "Branch unavailable"
	var e *pkgerrors.APIError
	if errors.As(err, &e) {
		switch e.Status {
		case 401:
			status, code, class, message = 401, "unauthenticated", "permission", middleware.UnauthenticatedMessage(r.Context())
		case 403:
			status, code, class, message = 403, "permission", "permission", "Access denied"
		case 400, 404:
			status, code, class, message = e.Status, string(e.Code), "user", e.Message
		case 409:
			status, code, class, message = 409, string(e.Code), "conflict", e.Message
		}
	}
	pkgerrors.WriteJSON(w, status, map[string]string{"code": code, "class": class, "message": message})
}

// DecodeBranchFork shares the body contract between admission and dispatch.
func DecodeBranchFork(reader io.Reader) (services.BranchForkInput, error) {
	var input services.BranchForkInput
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || strings.TrimSpace(input.From) == "" {
		return input, pkgerrors.BadRequest("invalid fork request")
	}
	return input, nil
}

func (h *BranchHandler) AddToStack(w http.ResponseWriter, r *http.Request) {
	var input services.BranchAddInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("Invalid Add to stack request"))
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("Invalid branch"))
		return
	}
	input.Request = r.Header.Get("Idempotency-Key")
	repository, user, err := h.authorize(r, "branch.add-to-stack", h.Adds != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	item, err := h.Adds.AddBranchToStack(r.Context(), repository, user, branch, input)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, 202, map[string]any{"state": "accepted", "n": item.Number, "rev": 1})
}

// InstallBranchReadSubject binds both file-route spellings to the same stored
// execution workspace. Other branch reads and historical selectors have no
// execution grant. Resolve it before the one command decision in either entry.
func InstallBranchReadSubject(r *http.Request, q *db.Queries) (services.InstallSubject, error) {
	if q == nil {
		return services.InstallSubject{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branches unavailable")
	}
	if !services.InstallExecutionCredential(r.Context()) {
		return services.InstallSubject{}, nil
	}
	parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
	if (len(parts) == 7 || len(parts) == 8 && parts[7] == "content") && parts[1] == "repos" && parts[4] == "workspaces" && parts[6] == "files" {
		owner, ownerErr := url.PathUnescape(parts[2])
		repo, repoErr := url.PathUnescape(parts[3])
		workspace, workspaceErr := url.PathUnescape(parts[5])
		if ownerErr != nil || repoErr != nil || workspaceErr != nil {
			return services.InstallSubject{}, nil
		}
		row, err := q.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(owner), LowerName: strings.ToLower(repo)})
		if errors.Is(err, pgx.ErrNoRows) {
			return services.InstallSubject{}, nil
		}
		if err != nil {
			return services.InstallSubject{}, err
		}
		return services.InstallExecutionFileSubject(r.Context(), q, row.ID, workspace)
	}
	if len(parts) < 4 || parts[1] != "branches" || parts[3] != "files" {
		return services.InstallSubject{}, nil
	}
	query := r.URL.Query()
	if query.Has("at") || query.Has("digest") || query.Has("compare") {
		return services.InstallSubject{}, nil
	}
	branch, err := url.PathUnescape(parts[2])
	if err != nil || branch == "main" {
		return services.InstallSubject{}, nil
	}
	repository, err := services.InstallRepositoryID(r.Context(), q)
	if err != nil {
		return services.InstallSubject{}, err
	}
	workspace := branch
	if _, err := uuid.Parse(branch); err != nil {
		row, err := q.GetBranchWorkspace(r.Context(), db.GetBranchWorkspaceParams{RepositoryID: repository, TargetBookmark: branch})
		if errors.Is(err, pgx.ErrNoRows) {
			return services.InstallSubject{}, nil
		}
		if err != nil {
			return services.InstallSubject{}, err
		}
		workspace = row.ID
	}
	return services.InstallExecutionFileSubject(r.Context(), q, repository, workspace)
}
