package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// serveIssueStateBrokerSSE is the broker seam route tests replace.
var serveIssueStateBrokerSSE = sse.ServeBrokerSSE

type issueStateRouteService interface {
	AuthorizeIssueState(context.Context, *db.User, string, string) (db.Repository, error)
	ListIssueStateFacts(context.Context, *db.User, string, string, int64, int64, int) (services.IssueStateFactPage, error)
}

func (h *IssueEventHandler) ListIssueStateFacts(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	after, err := issueStateCursor(r.URL.Query().Get("after"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	limit := 1000
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 1000 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("issue fact limit must be between 1 and 1000"))
			return
		}
	}
	service, ok := h.Service.(issueStateRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("issue journal unavailable"))
		return
	}
	page, err := service.ListIssueStateFacts(r.Context(), user, owner, repo, 0, after, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, page)
}
func issueStateCursor(raw string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, pkgerrors.BadRequest("invalid issue journal cursor")
	}
	return value, nil
}
func (h *IssueEventHandler) IssueStateFactsStream(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	owner, name, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	raw := r.Header.Get("Last-Event-ID")
	if raw == "" {
		raw = r.URL.Query().Get("after")
	}
	after, err := issueStateCursor(raw)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	service, ok := h.Service.(issueStateRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("issue journal unavailable"))
		return
	}
	repo, err := service.AuthorizeIssueState(r.Context(), user, owner, name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	req := r.Clone(r.Context())
	req.Header.Set("Last-Event-ID", strconv.FormatInt(after, 10))
	stream := &sse.DurableStream{
		Head: func(ctx context.Context) (int64, error) {
			current, err := service.AuthorizeIssueState(ctx, user, owner, name)
			if err != nil {
				return 0, err
			}
			if current.ID != repo.ID {
				return 0, pkgerrors.Conflict("issue stream repository changed")
			}
			return 0, nil
		},
		Validate: func(ctx context.Context, cursor int64) error {
			_, err := service.ListIssueStateFacts(ctx, user, owner, name, repo.ID, cursor, 1)
			return err
		},
		Load: func(ctx context.Context, cursor int64, limit int) (sse.DurablePage, error) {
			page, err := service.ListIssueStateFacts(ctx, user, owner, name, repo.ID, cursor, limit)
			if err != nil {
				return sse.DurablePage{}, err
			}
			result := sse.DurablePage{Cursor: page.Cursor, More: page.HasMore}
			for _, fact := range page.Events {
				data, err := json.Marshal(fact)
				if err != nil {
					return sse.DurablePage{}, err
				}
				result.Events = append(result.Events, sse.Event{ID: strconv.FormatInt(fact.Sequence, 10), Type: "issue.fact", Data: string(data)})
			}
			return result, nil
		},
	}
	cfg := sse.BrokerStreamConfig{Broker: h.Broker, Channel: fmt.Sprintf("issue_state_facts_%d", repo.ID), UserID: user.ID, Durable: stream, OnConnect: stream.OnConnect}
	principal := revocation.Principal{RepositoryID: repo.ID}
	if repo.OrgID.Valid {
		principal.OrganizationID = repo.OrgID.Int64
	}
	attachRevocation(&cfg, req, principal)
	serveIssueStateBrokerSSE(w, req, cfg)
}
