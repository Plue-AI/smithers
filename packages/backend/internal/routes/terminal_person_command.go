package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type terminalPersonCommands interface {
	TerminalPersonCommand(context.Context, string, int64, int64, func(context.Context) error) error
}

// PersonCommand is the typed UI command channel. It forwards only the result
// of the ordinary catalog TODO handler; no host bearer enters the browser or
// guest. Raw terminal bytes always remain guest commands with delegation.
func (h *WorkspaceTerminalHandler) PersonCommand(w http.ResponseWriter, r *http.Request) {
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil || info.IsTokenAuth || info.SessionHash == "" || info.CredentialKind() != middleware.CredentialPerson {
		terminalError(w, 403, "permission", "permission", "Not available")
		return
	}
	service, ok := h.Service.(terminalPersonCommands)
	if !ok || h.PersonAppend == nil || h.AuthorizeTerminal == nil {
		terminalUnavailable(w)
		return
	}
	repository, member, err := h.AuthorizeTerminal(r, "terminal")
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	id, err := routeParam(r, "id", "terminal required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	var input struct {
		Command string          `json:"command"`
		Payload json.RawMessage `json:"payload"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if decodeSingleJSONDocument(decoder, &input) != nil || input.Command != "todo.new" {
		terminalError(w, 400, "invalid_request", "user", "Invalid terminal request")
		return
	}
	var payload struct {
		Place struct {
			Mode string `json:"mode"`
		} `json:"place"`
	}
	if json.Unmarshal(input.Payload, &payload) != nil || payload.Place.Mode != "append" {
		terminalError(w, 403, "permission", "permission", "Not available")
		return
	}
	err = service.TerminalPersonCommand(r.Context(), id, repository, member, func(ctx context.Context) error {
		request := r.Clone(ctx)
		request.Method = http.MethodPost
		request.URL = &url.URL{Path: "/api/todos"}
		request.RequestURI = "/api/todos"
		request.Body = io.NopCloser(bytes.NewReader(input.Payload))
		request.ContentLength = int64(len(input.Payload))
		request.Header = r.Header.Clone()
		// Attribution/actor assertions from the caller never accompany the stored
		// person identity. The ordinary TODO decoder validates the complete payload.
		for _, header := range []string{"Authorization", "Smithers-Via", "Smithers-Actor-Kind", "Smithers-Agent-Session", "Smithers-Profile"} {
			request.Header.Del(header)
		}
		h.PersonAppend.ServeHTTP(w, request)
		return nil
	})
	if err != nil {
		writeBranchError(w, r, err)
	}
}
