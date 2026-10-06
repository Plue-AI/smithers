package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Workspace session kinds (#505). A terminal session relays a PTY; an LSP
// session relays one language server's stdio as JSON-RPC over a WebSocket.
const (
	WorkspaceSessionKindTerminal = "terminal"
	WorkspaceSessionKindLSP      = "lsp"

	// workspaceLSPIdleTimeoutSecs is the LSP session's idle budget: the relay
	// closes the socket and the sweeper stops the row after this long without
	// a JSON-RPC message in either direction.
	workspaceLSPIdleTimeoutSecs int32 = 600

	// CodeLanguageServerMissing is the 409 code answered before the WebSocket
	// upgrade when the guest has no binary for the session's language. The
	// message is the install line, verbatim, so a client can show it as-is.
	// It lives in the registry with its status and fault; this is the name
	// this package and internal/routes already import it by.
	CodeLanguageServerMissing = pkgerrors.CodeLanguageServerMissing
	// CodeWorkspaceSessionKindMismatch is answered when a session of one kind
	// is opened on the other kind's stream route.
	CodeWorkspaceSessionKindMismatch = pkgerrors.CodeWorkspaceSessionKindMismatch
)

// LanguageServerSpec is one row of the guest language-server registry. The
// registry is static: the client never names a binary, an argv, or a cwd.
type LanguageServerSpec struct {
	// Language is the wire id (`language` on the session row and the query).
	Language string
	// Extensions are the file extensions the server serves; informational.
	Extensions []string
	// Bin is the executable resolved from `<checkout>/node_modules/.bin`, then
	// the developer user's PATH inside the guest.
	Bin string
	// Args is the argv after Bin.
	Args []string
	// Install is the install line answered verbatim on 409 language_server_missing.
	Install string
	// InitializationOptions are what the client should send in `initialize`;
	// the relay never rewrites JSON-RPC, so this is advertised, not enforced.
	InitializationOptions map[string]any
}

// languageServers is the v1 registry: TypeScript only. Rows for
// rust-analyzer, gopls, and pyright drop in as `{Language, Bin, Args, Install}`
// once the guest image ships them; nothing else changes.
var languageServers = []LanguageServerSpec{
	{
		Language:   "typescript",
		Extensions: []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"},
		Bin:        "typescript-language-server",
		Args:       []string{"--stdio"},
		Install:    "npm i -g typescript-language-server typescript",
		InitializationOptions: map[string]any{
			"disableAutomaticTypingAcquisition": true,
		},
	},
}

// LanguageServerFor returns the registry row for a language id.
func LanguageServerFor(language string) (LanguageServerSpec, bool) {
	language = strings.ToLower(strings.TrimSpace(language))
	for _, spec := range languageServers {
		if spec.Language == language {
			return spec, true
		}
	}
	return LanguageServerSpec{}, false
}

// LSPLanguages lists the languages every workspace guest can serve, in
// registry order. It is what the workspace DTO advertises as lsp.languages.
func LSPLanguages() []string {
	out := make([]string, 0, len(languageServers))
	for _, spec := range languageServers {
		out = append(out, spec.Language)
	}
	return out
}

// WorkspaceLSP is the workspace DTO's language-server facet.
type WorkspaceLSP struct {
	Languages []string `json:"languages"`
}

// LanguageServerLaunch is what the relay needs to start one server over the
// workspace's SSH gateway: the exact command, run as the developer user with
// the checkout as the working directory.
type LanguageServerLaunch struct {
	SessionID   string
	WorkspaceID string
	Language    string
	Spec        LanguageServerSpec
	// Command is the SSH exec command. Its script resolves Bin from
	// `<checkout>/node_modules/.bin` then PATH, exits 127 when nothing
	// resolves, prints one `ready` line, then execs the server on stdio.
	Command string
}

// LanguageServerReadyLine is the single line the launch script prints on
// stdout before the server owns the stream. The relay reads it before the
// WebSocket upgrade so a missing binary is an HTTP 409, never a 101.
const LanguageServerReadyLine = "ready"

// LanguageServerMissingLine prefixes the line the launch script prints when
// no binary resolves, followed by the binary name. It is followed by exit
// status 127; an exit 127 WITHOUT this line means the shell itself did not
// resolve (a NixOS guest before activation), which is a retry, not a 409.
const LanguageServerMissingLine = "missing"

// LanguageServerMissingExitCode is the launch script's exit status when no
// binary resolves; POSIX `command not found`.
const LanguageServerMissingExitCode = 127

// languageServerGuestPath is the PATH the launch script exports, in
// resolution order: the checkout's own binaries, the developer user's
// bootstrap installs, the NixOS system profile, the container profile, then
// whatever the guest's SSH session inherited.
const languageServerGuestPath = `$PWD/node_modules/.bin:$HOME/.local/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin:$PATH`

// LaunchCommand builds the SSH command for spec with checkout as the
// workspace folder: `bash -c` over LaunchScript.
func (spec LanguageServerSpec) LaunchCommand(checkout string) string {
	return "bash -c " + shellQuote(spec.LaunchScript(checkout))
}

// LaunchScript is the guest-side launch, one line of POSIX shell. Profile
// scripts are deliberately not sourced, because anything they print to
// stdout would corrupt the Content-Length stream; PATH is set explicitly
// instead.
func (spec LanguageServerSpec) LaunchScript(checkout string) string {
	argv := make([]string, 0, 1+len(spec.Args))
	argv = append(argv, shellQuote(spec.Bin))
	for _, arg := range spec.Args {
		argv = append(argv, shellQuote(arg))
	}
	script := strings.Join([]string{
		fmt.Sprintf("cd %s 2>/dev/null || cd \"$HOME\"", shellQuote(checkout)),
		fmt.Sprintf("export PATH=%q", languageServerGuestPath),
		fmt.Sprintf("if ! command -v %s >/dev/null 2>&1; then printf '%s %%s\\n' %s; exit %d; fi",
			shellQuote(spec.Bin), LanguageServerMissingLine, shellQuote(spec.Bin), LanguageServerMissingExitCode),
		fmt.Sprintf("printf '%s\\n'", LanguageServerReadyLine),
		"exec " + strings.Join(argv, " "),
	}, "; ")
	return script
}

// LanguageServerMissing is the pre-upgrade 409 for a guest with no binary for
// spec. The message is the install line verbatim; Details names the language
// and where the relay looked so a client can explain without parsing prose.
func LanguageServerMissing(spec LanguageServerSpec) *pkgerrors.APIError {
	return &pkgerrors.APIError{
		Status:  http.StatusConflict,
		Code:    CodeLanguageServerMissing,
		Message: spec.Install,
		Details: map[string]any{
			"language": spec.Language,
			"bin":      spec.Bin,
			"install":  spec.Install,
			"searched": []string{defaultWorkspaceClonePath + "/node_modules/.bin", "PATH"},
		},
	}
}

// normalizeWorkspaceSessionKind maps the request's kind to a stored kind:
// empty means terminal, which keeps every existing caller unchanged.
func normalizeWorkspaceSessionKind(kind string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", WorkspaceSessionKindTerminal:
		return WorkspaceSessionKindTerminal, nil
	case WorkspaceSessionKindLSP:
		return WorkspaceSessionKindLSP, nil
	default:
		return "", pkgerrors.BadRequest("kind must be terminal or lsp")
	}
}

// normalizeWorkspaceSessionLanguage validates the language for an LSP
// session against the registry; terminal sessions carry no language.
func normalizeWorkspaceSessionLanguage(kind, language string) (string, error) {
	language = strings.ToLower(strings.TrimSpace(language))
	if kind != WorkspaceSessionKindLSP {
		if language != "" {
			return "", pkgerrors.BadRequest("language is only accepted with kind lsp")
		}
		return "", nil
	}
	if language == "" {
		return "", pkgerrors.BadRequest("language is required for kind lsp; one of: " + strings.Join(LSPLanguages(), ", "))
	}
	if _, ok := LanguageServerFor(language); !ok {
		return "", pkgerrors.BadRequest("language must be one of: " + strings.Join(LSPLanguages(), ", "))
	}
	return language, nil
}

// ResolveLanguageServer answers the launch for an LSP session the caller may
// operate (write access on the owning workspace). A terminal session answers
// 409 workspace_session_kind_mismatch; an unknown language (a row written by a
// newer registry) answers 409 language_server_missing with no install line.
func (s *WorkspaceService) ResolveLanguageServer(ctx context.Context, sessionID string, repositoryID, userID int64) (LanguageServerLaunch, error) {
	if s.q == nil {
		return LanguageServerLaunch{}, pkgerrors.Internal("workspace store unavailable")
	}
	session, err := s.loadOwnedWorkspaceSession(ctx, sessionID, repositoryID, userID)
	if err != nil {
		return LanguageServerLaunch{}, err
	}
	if session.Kind != WorkspaceSessionKindLSP {
		return LanguageServerLaunch{}, &pkgerrors.APIError{
			Status:  http.StatusConflict,
			Code:    CodeWorkspaceSessionKindMismatch,
			Message: fmt.Sprintf("workspace session is a %s session; create one with kind lsp", session.Kind),
		}
	}
	spec, ok := LanguageServerFor(session.Language)
	if !ok {
		return LanguageServerLaunch{}, &pkgerrors.APIError{
			Status:  http.StatusConflict,
			Code:    CodeLanguageServerMissing,
			Message: "no language server is registered for " + session.Language,
		}
	}
	checkout := defaultWorkspaceClonePath
	if s.runtimeGuest() {
		workspace, err := s.loadOwnedWorkspace(ctx, session.WorkspaceID, session.RepositoryID, userID)
		if err != nil {
			return LanguageServerLaunch{}, err
		}
		layout, _, err := s.runtimeGuestPaths(ctx, workspace, userID)
		if err != nil {
			return LanguageServerLaunch{}, err
		}
		checkout = layout.Root
	}
	return LanguageServerLaunch{
		SessionID:   session.ID,
		WorkspaceID: session.WorkspaceID,
		Language:    spec.Language,
		Spec:        spec,
		Command:     spec.LaunchCommand(checkout),
	}, nil
}
