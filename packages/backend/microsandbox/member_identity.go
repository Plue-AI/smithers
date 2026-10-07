package microsandbox

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
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

// EnsureMember provisions a private home under the current authoritative roster
// lock. Bundle provenance is checked before roster access or any guest effect;
// session admission separately requires the authenticated machined connection.
func (r *Runtime) EnsureMember(ctx context.Context, workspaceID string, member MemberIdentity) (SessionIdentity, error) {
	if err := ctx.Err(); err != nil {
		return SessionIdentity{}, err
	}
	identity, err := member.SessionIdentity()
	if err != nil {
		return SessionIdentity{}, err
	}
	if r.config.Bundle == nil || r.cli == nil {
		return SessionIdentity{}, fmt.Errorf("%w: member provisioning requires an approved installed bundle", ErrUnavailable)
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return SessionIdentity{}, err
	}
	if err := r.prepareMembers(ctx, ws, &member); err != nil {
		return SessionIdentity{}, err
	}
	return identity, nil
}

// MemberRoster holds the authoritative roster lock while visiting current
// allocations. Implementations must scope the roster to the workspace repository.
// Nothing is persisted in runtime metadata or copied from a previous boot.
type MemberRoster func(context.Context, string, func([]MemberIdentity) error) error

// BindMemberRoster is called by single-owner composition before serving work.
func (r *Runtime) BindMemberRoster(roster MemberRoster) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.memberRoster = roster
}

func (r *Runtime) prepareMembers(ctx context.Context, ws *workspace, requested *MemberIdentity) error {
	r.mu.Lock()
	roster := r.memberRoster
	r.mu.Unlock()
	if roster == nil {
		if requested == nil {
			return nil
		}
		return fmt.Errorf("%w: current member roster unavailable", ErrUnavailable)
	}
	// Member provisioning must never plant branch-built privileged helper bytes.
	if r.config.Bundle == nil {
		return fmt.Errorf("%w: member provisioning requires an approved installed bundle", ErrUnavailable)
	}
	return roster(ctx, ws.ID, func(members []MemberIdentity) error {
		return r.provisionMembers(ctx, ws.Machine, members, requested)
	})
}

// provisionMembers validates the entire snapshot before the first VM effect.
// Boot creates accounts only; the first-session path creates one private home.
func (r *Runtime) provisionMembers(ctx context.Context, machine string, members []MemberIdentity, requested *MemberIdentity) error {
	logins, uids := map[string]bool{}, map[int]bool{}
	found := requested == nil
	for _, member := range members {
		if _, err := member.SessionIdentity(); err != nil {
			return err
		}
		if logins[member.Login] || uids[member.UID] {
			return fmt.Errorf("%w: duplicate member allocation", ErrUnavailable)
		}
		logins[member.Login], uids[member.UID] = true, true
		if requested != nil && member == *requested {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("%w: member is no longer active in the current roster", ErrUnavailable)
	}
	for _, member := range members {
		mode := "account"
		if requested != nil {
			if member != *requested {
				continue
			}
			mode = "home"
		}
		if _, err := r.guest(ctx, machine, nil, "setup-member", member.Login, strconv.Itoa(member.UID), mode); err != nil {
			return err
		}
	}
	return nil
}
