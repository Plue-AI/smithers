package workspace

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
)

// SessionCredentialWriter is an optional runtime facet: it places one
// terminal session's delegated credential where only the session's user can
// read it (spec §5.3.2, T-TRM-02), and removes it when the session closes.
// expectedIdentity is the SHA-256 of the previous bearer; empty means create
// only if absent. Deletion and rotation refuse a different retained identity.
// PutSessionToken atomically creates or replaces the session's own file,
// mode 0600 in a 0700 directory, and answers its path as the session's
// processes see it (SMITHERS_TOKEN_FILE). A runtime without the facet opens
// terminals that are not signed in to Smithers.
type SessionCredentialWriter interface {
	PutSessionToken(ctx context.Context, workspaceID, sessionID string, token []byte, expectedIdentity string) (string, error)
	DeleteSessionToken(ctx context.Context, workspaceID, sessionID, expectedIdentity string) error
}

// SessionTokenRoot is the guest directory that holds stage 1's terminal
// credentials: SessionTokenRoot/<session id>/token.
const SessionTokenRoot = "/run/smithers/sessions"

var credentialIdentityPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

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

// SessionCredentialIdentity identifies a bearer without transporting it in argv.
func SessionCredentialIdentity(token []byte) string { return fmt.Sprintf("%x", sha256.Sum256(token)) }

// ValidateSessionCredentialIdentity accepts only a digest, or the create-only marker.
func ValidateSessionCredentialIdentity(identity string, create bool) error {
	if create && identity == "" {
		return nil
	}
	if !credentialIdentityPattern.MatchString(identity) {
		return errors.New("session credential: invalid identity")
	}
	return nil
}
