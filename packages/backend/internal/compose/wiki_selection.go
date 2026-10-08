package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// wikiSelection serves POST /api/repos/{owner}/{repo}/wiki/selection: a
// TODO plan step asks the shared context selector (spec §13.4, §15.1.2)
// which wiki pages its prompt needs (T-FLW-10). Only the run's own execution
// credential reaches it, bound by the member gate to its live TODO as
// wiki.read. The pages are host-read data; nothing here runs repository code.
type wikiSelection struct {
	queries  *db.Queries
	wiki     *services.WikiService
	selector ports.ContextSelector
	// The same TODO provider renders attempt evidence in the install. Refuse
	// before selecting context when that publication contract is not composed.
	evidence interface {
		Todo(context.Context, int64, int64) (map[string]any, error)
	}
}

// wikiSelectionPage is one selected page, most relevant first. Revision is
// the one the selector saw; the plan step still reads and digests the page.
type wikiSelectionPage struct {
	Slug     string `json:"slug"`
	Revision int64  `json:"revision"`
	Reason   string `json:"reason"`
}

func wikiSelectionUnavailable() error {
	return &services.AccessError{Status: http.StatusServiceUnavailable, Class: "infra", Code: "unavailable", Message: "Wiki selection is unavailable"}
}

func (h wikiSelection) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	info := middleware.AuthInfoFromContext(ctx)
	repository := middleware.RepoFromContext(ctx)
	if !services.InstallExecutionCredential(ctx) || info == nil || info.User == nil || repository == nil || h.queries == nil {
		writeConfirmationDispatchError(w, &services.AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only a TODO's run selects its plan's pages"})
		return
	}
	// The gate bound wiki.read to this lane's TODO; a lane that moved since
	// then is refused rather than authorized again.
	subject, err := services.InstallExecutionWikiSubject(ctx, h.queries, repository.ID, "wiki.public-selection", "")
	if err == nil {
		err = services.RevalidateInstallWikiRead(ctx, h.queries, subject)
	}
	if err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	var request struct {
		Prompt string `json:"prompt"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || strings.TrimSpace(request.Prompt) == "" {
		writeConfirmationDispatchError(w, &services.AccessError{Status: http.StatusBadRequest, Class: "user", Code: "invalid_request", Message: "A plan's wiki selection needs its prompt"})
		return
	}
	if h.wiki == nil || h.selector == nil || h.evidence == nil {
		writeConfirmationDispatchError(w, wikiSelectionUnavailable())
		return
	}
	candidates, err := services.WikiContextCandidates(ctx, h.wiki, info.User, chi.URLParam(r, "owner"), repository.Name)
	if err != nil {
		writeConfirmationDispatchError(w, wikiSelectionUnavailable())
		return
	}
	budget, err := services.ContextPreflightBudget(ctx, h.queries)
	if err != nil {
		writeConfirmationDispatchError(w, wikiSelectionUnavailable())
		return
	}
	offered := map[string]int64{}
	for _, candidate := range candidates {
		item := candidate["item"].(map[string]string)
		revision, _ := strconv.ParseInt(item["revision"], 10, 64)
		offered[item["ref"]] = revision
	}
	input, err := json.Marshal(map[string]any{
		"prompt": request.Prompt, "author": info.User.Username, "branch": fmt.Sprintf("todo:%d", subject.TodoNumber),
		"state": "plan", "recent": []any{}, "candidates": candidates, "tokenBudget": budget, "wikiOnly": true,
	})
	if err != nil {
		writeConfirmationDispatchError(w, wikiSelectionUnavailable())
		return
	}
	if err := services.RevalidateInstallWikiRead(ctx, h.queries, subject); err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	raw, err := h.selector.SelectContext(ctx, ports.ContextSelectionGrant{OwnerID: info.User.ID, RepositoryID: repository.ID, Input: input})
	if err != nil {
		writeConfirmationDispatchError(w, wikiSelectionUnavailable())
		return
	}
	if err := services.RevalidateInstallWikiRead(ctx, h.queries, subject); err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	var result struct {
		Context []struct {
			Kind     string `json:"kind"`
			Ref      string `json:"ref"`
			Revision string `json:"revision"`
			Reason   string `json:"reason"`
		} `json:"context"`
		Model      string  `json:"model"`
		DurationMs float64 `json:"durationMs"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Model == "" {
		writeConfirmationDispatchError(w, wikiSelectionUnavailable())
		return
	}
	pages := []wikiSelectionPage{}
	seen := map[string]bool{}
	for _, item := range result.Context {
		revision, known := offered[item.Ref]
		// The selector may only choose a page it was offered, at that revision.
		if item.Kind != "page" || !known || item.Revision != strconv.FormatInt(revision, 10) || seen[item.Ref] {
			writeConfirmationDispatchError(w, wikiSelectionUnavailable())
			return
		}
		seen[item.Ref] = true
		pages = append(pages, wikiSelectionPage{Slug: item.Ref, Revision: revision, Reason: item.Reason})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"pages": pages, "model": result.Model, "durationMs": result.DurationMs})
}
