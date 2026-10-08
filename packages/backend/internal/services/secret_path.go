package services

import (
	stdErrors "errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// A secret's declared file path (spec §8.8.1a, M-42). `~/…` resolves in each
// home on a branch machine; an absolute path must be under
// SecretFilesRoot. The machine's guest helper validates the same grammar
// again before it writes (put-env in microsandbox/guest/smithers-guest.py)
// and refuses a symlink on any component there.
const (
	SecretFilesRoot      = "/run/smithers/files/"
	secretHomePrefix     = "~/"
	maxSecretPathBytes   = 512
	maxSecretPathParts   = 16
	maxSecretPathElement = 255
	secretWorkingCopy    = "/workspace"
)

// secretHomeLinks are the home entries the guest helper plants as symlinks
// (HOME_LINKS in smithers-guest.py). A path through one is refused when
// declared even before a machine exists. Composition also asks the broker
// to inspect arbitrary member-created links before persisting a declaration.
var secretHomeLinks = []string{
	".cache/ms-playwright",
	".cache/dprint",
	".cargo",
	".rustup",
	".local/share/pnpm/store",
	".cache/pnpm",
}

// secretPathRefusal is a declared path's refusal: class `user`, so the card
// shows it beside the field.
func secretPathRefusal(code, message string) *AccessError {
	return &AccessError{Status: http.StatusBadRequest, Class: "user", Code: code, Message: message}
}

// NormalizeSecretPath validates a declared secret file path and returns it
// in stored form. Empty means no file.
func NormalizeSecretPath(raw string) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return "", nil
	}
	if len(path) > maxSecretPathBytes {
		return "", secretPathRefusal("path_invalid", "Path is too long")
	}
	var relative string
	switch {
	case path == secretWorkingCopy || strings.HasPrefix(path, secretWorkingCopy+"/"):
		return "", secretPathRefusal("path_working_copy", "Path is inside the working copy")
	case strings.HasPrefix(path, secretHomePrefix):
		relative = path[len(secretHomePrefix):]
	case strings.HasPrefix(path, SecretFilesRoot):
		relative = path[len(SecretFilesRoot):]
	case strings.HasPrefix(path, "/"):
		return "", secretPathRefusal("path_not_allowed", "Use ~/… or "+SecretFilesRoot+"…")
	default:
		return "", secretPathRefusal("path_invalid", "Use ~/… or "+SecretFilesRoot+"…")
	}
	parts := strings.Split(relative, "/")
	if len(parts) > maxSecretPathParts {
		return "", secretPathRefusal("path_invalid", "Path is too deep")
	}
	for _, part := range parts {
		if part == ".." {
			return "", secretPathRefusal("path_escapes_home", "Path leaves its folder")
		}
		if !validSecretPathElement(part) {
			return "", secretPathRefusal("path_invalid", "Use letters, digits and . _ - @ + = in each part")
		}
	}
	if strings.HasPrefix(path, secretHomePrefix) {
		for _, link := range secretHomeLinks {
			if relative == link || strings.HasPrefix(relative, link+"/") {
				return "", secretPathRefusal("path_symlink", "Path goes through a link")
			}
		}
	}
	return path, nil
}

func validSecretPathElement(part string) bool {
	if part == "" || part == "." || len(part) > maxSecretPathElement {
		return false
	}
	for i := 0; i < len(part); i++ {
		c := part[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == '-', c == '@', c == '+', c == '=':
		default:
			return false
		}
	}
	return true
}

func secretPathTaken() *AccessError {
	return secretPathRefusal("path_taken", "Another secret uses this path")
}

// isSecretPathTaken reports the unique index refusing a second secret at one
// path, for writers that raced the pre-check.
func isSecretPathTaken(err error) bool {
	var pgErr *pgconn.PgError
	return stdErrors.As(err, &pgErr) && pgErr.ConstraintName == "repository_secrets_repo_path"
}
