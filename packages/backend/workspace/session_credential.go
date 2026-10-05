package workspace

import (
	"context"
	"errors"
	"regexp"
)

// SessionCredentialWriter is an optional runtime facet: it places one
// terminal session's delegated credential where only the session's user can
// read it (spec §5.3.2, T-TRM-02), and removes it when the session closes.
// PutSessionToken atomically creates or replaces the session's own file,
// mode 0600 in a 0700 directory, and answers its path as the session's
// processes see it (SMITHERS_TOKEN_FILE). A runtime without the facet opens
// terminals that are not signed in to Smithers.
type SessionCredentialWriter interface {
	PutSessionToken(ctx context.Context, workspaceID, sessionID string, token []byte) (string, error)
	DeleteSessionToken(ctx context.Context, workspaceID, sessionID string) error
}

// SessionTokenRoot is the guest directory that holds stage 1's terminal
// credentials: SessionTokenRoot/<session id>/token.
const SessionTokenRoot = "/run/smithers/sessions"

var sessionIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ValidateSessionCredential refuses a session id that is not one path
// segment of lower-case letters, digits and dashes, and a token that is empty,
// longer than 512 bytes or holds anything but printable ASCII.
func ValidateSessionCredential(sessionID string, token []byte) error {
	if !sessionIDPattern.MatchString(sessionID) {
		return errors.New("session credential: invalid session id")
	}
	if token == nil {
		return nil
	}
	if len(token) == 0 || len(token) > 512 {
		return errors.New("session credential: invalid token")
	}
	for _, b := range token {
		if b <= ' ' || b > '~' {
			return errors.New("session credential: invalid token")
		}
	}
	return nil
}
