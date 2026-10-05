package services

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// NetworkBind is the address the install listens on beside loopback for a
// saved bind (M-28): empty for "This Mac only", which is no bind, an
// unparsable one, or a loopback host. HTTP keeps its loopback listener in
// every case (spec §16.3.1), so the owner is never locked out on the Mac.
func NetworkBind(bind string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(bind))
	if err != nil || port == "" || strings.EqualFold(host, "localhost") {
		return ""
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLoopback() {
		return ""
	}
	return net.JoinHostPort(host, port)
}

// loopbackOrigin reports whether a public origin names this Mac only.
func loopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	return strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())
}

// InstallAddress is the install's Address (M-28, spec §16.3): the bind the
// HTTP server listens on beside loopback and the public origins a request may
// resolve to. Setup step 0 saves both; they apply to the next request and
// connection without a restart.
type InstallAddress struct {
	// Configured are the origins the process configuration names
	// (SMITHERS_PUBLIC_URL or server.allowed_origins); the owner's saved
	// origins join them.
	Configured []string
	// Listen serves a network bind beside loopback, opening the new listener
	// before it closes the previous one; an empty bind closes the network
	// listener. Nil when the composition's host owns its listener.
	Listen func(bind string) error

	mu     sync.RWMutex
	bind   string
	saved  []string
	served string
}

// Origins are the configured origins, then the saved ones, without repeats.
func (a *InstallAddress) Origins() []string {
	if a == nil {
		return nil
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	result := make([]string, 0, len(a.Configured)+len(a.saved))
	seen := map[string]bool{}
	for _, origin := range append(append([]string(nil), a.Configured...), a.saved...) {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin != "" && !seen[strings.ToLower(origin)] {
			seen[strings.ToLower(origin)] = true
			result = append(result, origin)
		}
	}
	return result
}

// Load reads the saved Address into memory; Serve applies its bind once the
// loopback listener is up.
func (a *InstallAddress) Load(ctx context.Context, q *db.Queries) error {
	if a == nil {
		return nil
	}
	var bind string
	var origins []string
	if row, err := q.GetInstallSetting(ctx, "bind"); err == nil {
		if err = json.Unmarshal(row.Value, &bind); err != nil {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if row, err := q.GetInstallSetting(ctx, "public_origins"); err == nil {
		if err = json.Unmarshal(row.Value, &origins); err != nil {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	a.mu.Lock()
	a.bind, a.saved = bind, origins
	a.mu.Unlock()
	return nil
}

// Serve listens on the saved bind. A bind that no longer listens, such as an
// interface address the Mac lost, leaves loopback serving and is logged: the
// owner can still reach the install on this Mac and choose another address.
func (a *InstallAddress) Serve() {
	if a == nil {
		return
	}
	a.mu.RLock()
	bind := a.bind
	a.mu.RUnlock()
	if err := a.listen(bind); err != nil {
		slog.Warn("install address: serving loopback only", "bind", NetworkBind(bind), "error", err)
	}
}

// listen serves bind's network address, or none for This Mac only.
func (a *InstallAddress) listen(bind string) error {
	if a == nil || a.Listen == nil {
		return nil
	}
	target := NetworkBind(bind)
	a.mu.Lock()
	defer a.mu.Unlock()
	if target == a.served {
		return nil
	}
	if err := a.Listen(target); err != nil {
		return err
	}
	a.served = target
	return nil
}

// apply listens on a new bind before step 0 commits it, so a bind that
// cannot listen fails the step and the settings keep their old value.
func (a *InstallAddress) apply(bind string) error {
	if err := a.listen(bind); err != nil {
		var typed *InstallReadinessError
		if errors.As(err, &typed) {
			return err
		}
		return &InstallReadinessError{Code: "address_unavailable", Class: "user", Message: "Can't listen on " + NetworkBind(bind)}
	}
	return nil
}

// commit publishes a committed Address; revert restores the listener for the
// Address still in effect when the step did not commit.
func (a *InstallAddress) commit(bind string, origins []string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.bind, a.saved = bind, append([]string(nil), origins...)
	a.mu.Unlock()
}

func (a *InstallAddress) revert() {
	if a == nil {
		return
	}
	a.mu.RLock()
	bind := a.bind
	a.mu.RUnlock()
	if err := a.listen(bind); err != nil {
		slog.Warn("install address: restore the previous bind", "bind", NetworkBind(bind), "error", err)
	}
}
