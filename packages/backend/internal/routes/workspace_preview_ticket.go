package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

// WorkspacePreviewAuthorizer rechecks, now, whether a user may still read a
// workspace preview: the account is active, the repository is readable, and
// the workspace is theirs or shared with them.
type WorkspacePreviewAuthorizer interface {
	AuthorizeWorkspacePreview(ctx context.Context, workspaceID string, repositoryID, userID int64) error
}

// WorkspacePreviewTicketHandler answers the preview gateway's grant check,
// POST /internal/workspace-previews/authorize, behind the shared relay token.
// 204 keeps serving the preview; 403 ends it (a removed share, a suspended
// user, lost repository access).
type WorkspacePreviewTicketHandler struct {
	Service WorkspacePreviewAuthorizer
	Tickets *previewgateway.Tickets
}

func (h *WorkspacePreviewTicketHandler) Authorize(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil || h.Tickets == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "preview authorization unavailable"))
		return
	}
	var body previewgateway.AuthorizeRequest
	if err := decodeSingleJSONDocument(json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)), &body); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	if body.Ticket == "" {
		public, ok := h.Service.(interface {
			AuthorizePublicPreview(context.Context, string) error
		})
		if !ok || body.Domain == "" {
			pkgerrors.WriteError(w, pkgerrors.Forbidden("preview is private"))
			return
		}
		if err := public.AuthorizePublicPreview(r.Context(), body.Domain); err != nil {
			var e *pkgerrors.APIError
			if errors.As(err, &e) && e.Status >= 500 {
				writeRouteError(w, r, e)
				return
			}
			pkgerrors.WriteError(w, pkgerrors.Forbidden("preview is private"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	grant, err := h.Tickets.VerifySession(body.Ticket)
	if err != nil || !previewDomainNamesWorkspace(grant.Domain, grant.WorkspaceID) {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("preview grant invalid"))
		return
	}
	if err := h.Service.AuthorizeWorkspacePreview(r.Context(), grant.WorkspaceID, grant.RepositoryID, grant.UserID); err != nil {
		var apiErr *pkgerrors.APIError
		if errors.As(err, &apiErr) && apiErr.Status >= 500 {
			writeRouteError(w, r, apiErr)
			return
		}
		// Every other refusal (not found, forbidden, suspended) is the same
		// answer to the gateway: this grant no longer holds.
		pkgerrors.WriteError(w, pkgerrors.Forbidden("preview grant revoked"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// previewDomainNamesWorkspace reports whether domain is one of workspaceID's
// preview hosts (<port>-<workspace-id>.<suffix>), so a grant for one
// workspace can never name another's host.
func previewDomainNamesWorkspace(domain, workspaceID string) bool {
	label, _, ok := strings.Cut(strings.ToLower(domain), ".")
	workspaceID = strings.ToLower(strings.TrimSpace(workspaceID))
	if !ok || workspaceID == "" {
		return false
	}
	port, rest, ok := strings.Cut(label, "-")
	return ok && port != "" && strings.Trim(port, "0123456789") == "" && rest == workspaceID
}

// withPreviewTicket adds a freshly minted exchange ticket for the viewer to a
// hosted preview redirect. The gateway swaps it for a host-only cookie.
func withPreviewTicket(tickets *previewgateway.Tickets, target *url.URL, grant previewgateway.Grant) (*url.URL, error) {
	grant.Domain = target.Hostname()
	ticket, err := tickets.Issue(grant, previewgateway.PurposeExchange, previewgateway.ExchangeTicketTTL)
	if err != nil {
		return nil, err
	}
	ticketed := *target
	if ticketed.RawQuery != "" {
		ticketed.RawQuery += "&"
	}
	ticketed.RawQuery += previewgateway.TicketQueryParameter + "=" + url.QueryEscape(ticket)
	ticketed.ForceQuery = false
	return &ticketed, nil
}
