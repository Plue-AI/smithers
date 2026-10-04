package microsandbox

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

var memberLogin = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// MemberIdentity is the allocated collaborators binding, read afresh for each
// boot/session. It contains no home contents or tool credentials.
// There was no member identity contract in the single-agent adapter.
type MemberIdentity struct {
	Login  string
	UID    int
	Active bool
}

// SessionIdentity supplies the broker's credentials and sealed environment.
// A caller cannot select a home, supplementary group, or root identity.
type SessionIdentity struct {
	Login       string
	UID         int
	GID         int
	Groups      []int
	Umask       uint32
	Environment map[string]string
}

func (member MemberIdentity) SessionIdentity() (SessionIdentity, error) {
	if !member.Active || member.UID < 20000 || member.UID > 2147483647 || !memberLogin.MatchString(member.Login) || reservedMemberLogin(member.Login) {
		return SessionIdentity{}, fmt.Errorf("%w: missing, inactive or unallocated member identity", ErrUnavailable)
	}
	return SessionIdentity{Login: member.Login, UID: member.UID, GID: member.UID, Groups: []int{20000}, Umask: 0002,
		Environment: map[string]string{"HOME": "/home/" + member.Login, "USER": member.Login, "LOGNAME": member.Login}}, nil
}

func reservedMemberLogin(login string) bool {
	return login == "root" || login == "agent" || login == "machined"
}

// AllocateMemberLogin is used only at first allocation. The roster transaction
// must reserve this result against all historical assignments, including removed
// members; subsequent boots consume the stored login without reallocating it.
func AllocateMemberLogin(githubLogin string, used map[string]bool) (string, error) {
	var sanitized strings.Builder
	for _, c := range strings.ToLower(githubLogin) {
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
			sanitized.WriteRune(c)
		}
	}
	base := sanitized.String()
	if base == "" {
		return "", fmt.Errorf("invalid GitHub login")
	}
	if len(base) > 32 {
		base = base[:32]
	}
	for suffix := 1; ; suffix++ {
		candidate := base
		if suffix > 1 {
			tail := fmt.Sprint(suffix)
			prefix := base
			if len(prefix)+len(tail) > 32 {
				prefix = prefix[:32-len(tail)]
			}
			candidate = prefix + tail
		}
		if !reservedMemberLogin(candidate) && !used[candidate] {
			return candidate, nil
		}
	}
}

// EnsureMember refuses before any VM effect. Activation requires the current
// roster, approved helper/image C-SEC-02 provenance, and the production broker's
// C-COL-04 receipt. None is inferred from a caller-provided uid or a boolean.
func (r *Runtime) EnsureMember(ctx context.Context, workspaceID string, member MemberIdentity) (SessionIdentity, error) {
	if err := ctx.Err(); err != nil {
		return SessionIdentity{}, err
	}
	if _, err := member.SessionIdentity(); err != nil {
		return SessionIdentity{}, err
	}
	return SessionIdentity{}, fmt.Errorf("%w: member provisioning requires approved roster, image and broker receipts", ErrUnavailable)
}
