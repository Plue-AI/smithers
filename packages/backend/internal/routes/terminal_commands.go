package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// This channel carries a person's catalog request, never shell input. Only
// the authenticated input owner can send it. Guest output is binary and cannot
// enter this channel; guest processes receive only the delegated session file.
type terminalCommand struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Method  string          `json:"method"`
	Path    string          `json:"path"`
	Body    json.RawMessage `json:"body"`
	Key     string          `json:"idempotencyKey"`
}

func terminalBindingPath(template, path string) bool {
	expected, actual := strings.Split(template, "/"), strings.Split(path, "/")
	if len(expected) != len(actual) {
		return false
	}
	for i, part := range expected {
		if strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") {
			value, err := url.PathUnescape(actual[i])
			if err != nil || value == "" || value == "." || value == ".." || strings.ContainsAny(value, "/\\%") {
				return false
			}
		} else if part != actual[i] {
			return false
		}
	}
	return true
}

func (h *WorkspaceTerminalHandler) personTerminalCommand(ctx context.Context, ws *websocket.Conn, source *http.Request, frame []byte) {
	var input terminalCommand
	if err := json.Unmarshal(frame, &input); err != nil {
		return
	}
	result := terminalCommandResponse{Type: "command", ID: input.ID, Status: 403,
		Body: json.RawMessage(`{"class":"permission","code":"permission","message":"Permission denied"}`)}
	send := func() {
		encoded, _ := json.Marshal(result)
		_ = ws.Write(ctx, websocket.MessageText, encoded)
	}
	info := middleware.AuthInfoFromContext(source.Context())
	// A delegated bearer beside a browser cookie is still delegated. Tickets,
	// token attachments and agent accounts never acquire the broker's cookie.
	if ctx.Err() != nil {
		return
	}
	if info == nil || info.IsTokenAuth || info.CredentialKind() != middleware.CredentialPerson || !h.hasSessionCookie(source) {
		send()
		return
	}
	row, ok := services.OperationPolicy(input.Command)
	uri, err := url.ParseRequestURI(input.Path)
	if !ok || row.HTTP == nil || row.Visibility == "hidden" || !slices.Contains(row.Actors, "person") ||
		err != nil || uri.Host != "" || uri.Scheme != "" || !strings.HasPrefix(uri.Path, "/api/") ||
		input.Method != row.HTTP.Method || !terminalBindingPath(row.HTTP.Path, uri.EscapedPath()) ||
		input.ID == "" || len(input.ID) > 128 || (input.Method != http.MethodGet && (input.Key == "" || len(input.Key) > 128)) {
		send()
		return
	}
	if h.CommandRouter == nil {
		result.Status = 503
		result.Body = json.RawMessage(`{"class":"infra","code":"terminal_unavailable","message":"Terminal is unavailable"}`)
		send()
		return
	}
	// Re-enter the real HTTP boundary with only this attachment's immutable
	// cookie. No frame supplies a credential, actor, profile, URL origin or header.
	// Use a fresh context so neither cached command authorization nor routing
	// parameters from the socket admission can authorize this new request.
	commandCtx, cancel := context.WithCancel(context.Background())
	stop := context.AfterFunc(ctx, cancel)
	defer func() { stop(); cancel() }()
	request, err := http.NewRequestWithContext(commandCtx, input.Method,
		input.Path, bytes.NewReader(input.Body))
	if err != nil {
		send()
		return
	}
	request.URL.Scheme = source.URL.Scheme
	request.Host, request.RemoteAddr = source.Host, source.RemoteAddr
	cookieName := strings.TrimSpace(h.SessionCookieName)
	if cookieName == "" {
		cookieName = "smithers_session"
	}
	cookie, _ := source.Cookie(cookieName)
	request.AddCookie(cookie)
	request.Header.Set("Origin", source.Header.Get("Origin"))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Smithers-Via", "terminal")
	request.Header.Set("Idempotency-Key", input.Key)
	// The same-origin socket has already authenticated the person. CSRF is
	// supplied by this host broker rather than accepted from a guest or frame.
	request.AddCookie(&http.Cookie{Name: "__csrf", Value: "terminal-command"})
	request.Header.Set("X-CSRF-Token", "terminal-command")
	output := &terminalCommandWriter{header: make(http.Header)}
	h.CommandRouter.ServeHTTP(output, request)
	result.Status = output.status
	if result.Status == 0 {
		result.Status = 200
	}
	result.Body = output.body.Bytes()
	if len(result.Body) == 0 && result.Status < 400 {
		result.Body = json.RawMessage(`null`)
	}
	if output.overflow || !json.Valid(result.Body) {
		result.Status = 502
		result.Body = json.RawMessage(`{"class":"infra","code":"backend_protocol","message":"Invalid command response"}`)
	}
	send()
}

type terminalCommandResponse struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// Only bounded JSON results cross the socket. Set-Cookie and other HTTP
// headers remain on the host; the broker never forwards credential bytes.
type terminalCommandWriter struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	overflow bool
}

func (w *terminalCommandWriter) Header() http.Header { return w.header }
func (w *terminalCommandWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *terminalCommandWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	if w.body.Len()+len(p) > 1<<20 {
		w.overflow = true
	} else {
		_, _ = w.body.Write(p)
	}
	return len(p), nil
}
