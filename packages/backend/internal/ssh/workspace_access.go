package ssh

import (
	"context"
	"errors"
	gliderssh "github.com/gliderlabs/ssh"
	"slices"
	"strings"
	"unicode"
)

const workspaceAccessKey contextKey = "workspace-access"

var ErrWorkspaceAccessDenied = errors.New("workspace access denied")

// ErrWorkspaceUnavailable means the controller could not answer: the VM is
// missing or moving, or the controller failed. It is never a credential failure.
var ErrWorkspaceUnavailable = errors.New("workspace unavailable")

// WorkspaceAccess is the non-persisted credential material for one public SSH
// connection. Token must never be logged or included in an error.
type WorkspaceAccess struct {
	SandboxID string
	User      string
	Token     string
}

// WorkspaceBridge validates an access grant and proxies an authenticated
// public session into the workspace's private SSH server.
type WorkspaceBridge interface {
	Validate(context.Context, WorkspaceAccess) error
	Serve(gliderssh.Session, WorkspaceAccess) (int, error)
}

func parseWorkspacePublicKeyLogin(login string) (WorkspaceAccess, bool) {
	separator := strings.LastIndexByte(login, ':')
	if separator < 0 {
		return WorkspaceAccess{}, false
	}
	return parseWorkspaceLogin(login[:separator], login[separator+1:])
}

func parseWorkspacePasswordLogin(login, password string) (WorkspaceAccess, bool) {
	if strings.Contains(login, ":") {
		return WorkspaceAccess{}, false
	}
	return parseWorkspaceLogin(login, password)
}

func parseWorkspaceLogin(login, token string) (WorkspaceAccess, bool) {
	separator := strings.IndexByte(login, '+')
	if separator <= 0 || separator == len(login)-1 {
		return WorkspaceAccess{}, false
	}
	sandboxID, user := login[:separator], login[separator+1:]
	if len(sandboxID) > 128 || !safeSSHIdentifier(sandboxID) || !safeSSHIdentifier(user) {
		return WorkspaceAccess{}, false
	}
	token = strings.TrimSpace(token)
	if len(token) < 20 || len(token) > 1024 || strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return WorkspaceAccess{}, false
	}
	return WorkspaceAccess{SandboxID: sandboxID, User: user, Token: token}, true
}

func safeSSHIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(unicode.IsLetter(character) || unicode.IsDigit(character) || character == '_' || character == '-') {
			return false
		}
	}
	return true
}

// BranchResolver checks active roster membership, branch authorization and the
// member's provisioned identity without waking or executing anything. The
// install must supply this and a daemon-backed WorkspaceBridge together; a
// Plue grant bridge is not a branch execution provider.
type BranchResolver interface {
	ResolveBranch(context.Context, int64, string) (WorkspaceAccess, error)
}

// ResolveBranchName selects from an already-authorized repository branch list.
// It replaces grant-login parsing for the install; no branch name is a path.
func ResolveBranchName(login string, branches []string) (string, error) {
	if login == "main" || !validBranchLogin(login) {
		return "", ErrWorkspaceAccessDenied
	}
	for _, branch := range branches {
		if branch == login {
			return branch, nil
		}
	}
	if strings.Contains(login, "/") {
		return "", ErrWorkspaceAccessDenied
	}
	for _, branch := range branches {
		if branch == "smithers/"+login {
			return branch, nil
		}
	}
	candidates := make([]string, 0)
	for _, branch := range branches {
		parts := strings.Split(branch, "/")
		if len(parts) == 3 && parts[0] == "scratch" && parts[2] == login && validBranchLogin(branch) {
			candidates = append(candidates, branch)
		}
	}
	slices.Sort(candidates)
	candidates = slices.Compact(candidates)
	switch len(candidates) {
	case 0:
		return "", ErrWorkspaceAccessDenied
	case 1:
		return candidates[0], nil
	default:
		return "", &AmbiguousBranchError{Candidates: candidates}
	}
}

// AmbiguousBranchError contains only validated, authorized branch names.
type AmbiguousBranchError struct{ Candidates []string }

func (e *AmbiguousBranchError) Error() string {
	return "ambiguous branch: " + strings.Join(e.Candidates, ", ")
}

func validBranchLogin(login string) bool {
	if len(login) == 0 || len(login) > 128 {
		return false
	}
	parts := strings.Split(login, "/")
	if len(parts) != 1 && !(len(parts) == 2 && parts[0] == "smithers") && !(len(parts) == 3 && parts[0] == "scratch") {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 48 {
			return false
		}
		for _, c := range part {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
				return false
			}
		}
	}
	return true
}

func validMemberLogin(login string) bool {
	switch login {
	case "root", "developer", "agent", "machined":
		return false
	}
	return len(login) <= 32 && !strings.Contains(login, "/") && validBranchLogin(login)
}
