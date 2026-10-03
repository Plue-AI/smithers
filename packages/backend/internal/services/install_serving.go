package services

import (
	"context"
	"encoding/json"
	"errors"
	"golang.org/x/net/idna"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// InstallAddress is the shared Setup/Settings address (§14.3).
type InstallAddress struct {
	Listen  string   `json:"listen"`
	Bind    string   `json:"bind"`
	Origins []string `json:"origins"`
}

func addressError(field string) error {
	err := pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "install", Field: field, Code: "invalid"})
	err.Class = "user"
	err.Message = "invalid " + field
	return err
}

// NewInstallAddress rejects origins a browser cannot distinguish by Host.
func NewInstallAddress(bind string, origins []string) (InstallAddress, error) {
	a := InstallAddress{Listen: "mac", Bind: bind, Origins: []string{}}
	if bind != "" {
		if net.ParseIP(bind) == nil {
			return InstallAddress{}, addressError("bind")
		}
		a.Listen = "network"
	}
	hosts := map[string]bool{}
	for _, raw := range origins {
		u, err := url.Parse(raw)
		if err == nil {
			u.Scheme = strings.ToLower(u.Scheme)
		}
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
			return InstallAddress{}, addressError("origins")
		}

		host := u.Hostname()
		if strings.ContainsAny(u.Host, " \\%") {
			return InstallAddress{}, addressError("origins")
		}
		if strings.HasPrefix(u.Host, "[") && net.ParseIP(host) == nil {
			return InstallAddress{}, addressError("origins")
		}
		if net.ParseIP(host) == nil {
			host, err = idna.Lookup.ToASCII(host)
			if err != nil {
				return InstallAddress{}, addressError("origins")
			}
		}
		host = strings.ToLower(host)
		port := u.Port()
		if port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				return InstallAddress{}, addressError("origins")
			}
			port = strconv.Itoa(n)
			if (u.Scheme == "http" && n == 80) || (u.Scheme == "https" && n == 443) {
				port = ""
			}
		}
		if port != "" {
			host = net.JoinHostPort(host, port)
		} else if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		u.Host = host

		if hosts[u.Host] {
			return InstallAddress{}, addressError("origins")
		}
		hosts[u.Host] = true
		a.Origins = append(a.Origins, u.Scheme+"://"+u.Host)
	}
	return a, nil
}
func (a InstallAddress) SSHLine(branch string) string {
	host := "localhost"
	if len(a.Origins) > 0 {
		u, _ := url.Parse(a.Origins[0])
		host = u.Hostname()
	}
	return "ssh -p 2222 " + branch + "@" + host
}

// InstallPublication is T-STK-01's atomic install source-cursor/broker seam.
// A provider must append the install source event in this very transaction.
// No shadow projection or best-effort post-commit event is permitted.
type InstallPublication interface {
	PublishInstall(context.Context, pgx.Tx, InstallAddress) error
}
type ServingTransition interface {
	Commit()
	Abort()
}
type InstallListenerChanges interface {
	Prepare(context.Context, string) (ServingTransition, error)
}

// InstallServing stays dark without every execution/publication provider.
// Isolation validates T-INS-02's microVM-only launcher before any side effect.
type InstallServing struct {
	Pool        *pgxpool.Pool
	Isolation   func(context.Context) error
	Publication InstallPublication
	Listeners   InstallListenerChanges
	mu          sync.Mutex
}

func (s *InstallServing) Read(ctx context.Context) (InstallAddress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(ctx)
}
func (s *InstallServing) read(ctx context.Context) (InstallAddress, error) {
	if s.Pool == nil {
		return InstallAddress{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install settings unavailable")
	}
	var raw []byte
	err := s.Pool.QueryRow(ctx, "SELECT value FROM install_settings WHERE key='address'").Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return NewInstallAddress("", nil)
	}
	if err != nil {
		return InstallAddress{}, err
	}
	var a InstallAddress
	if err = json.Unmarshal(raw, &a); err != nil {
		return InstallAddress{}, err
	}
	return NewInstallAddress(a.Bind, a.Origins)
}
func (s *InstallServing) PublicOrigins(ctx context.Context) ([]string, error) {
	a, err := s.Read(ctx)
	return a.Origins, err
}
func (s *InstallServing) Set(ctx context.Context, address InstallAddress) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Isolation == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "microVM launcher unavailable")
	}
	if err := s.Isolation(ctx); err != nil {
		return err
	}
	if s.Publication == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install publication unavailable")
	}
	if s.Listeners == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install listener provider unavailable")
	}
	a, err := NewInstallAddress(address.Bind, address.Origins)
	if err != nil {
		return err
	}
	if s.Pool == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install settings unavailable")
	}
	// New sockets are accepting before the committed address replaces the old
	// one. Abort closes only prepared sockets; Commit closes only old network
	// sockets. The permanent loopback/control listener is never part of either.
	change, err := s.Listeners.Prepare(ctx, a.Bind)
	if err != nil {
		return err
	}
	defer change.Abort()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(731604)"); err != nil {
		return err
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO install_settings(key,value) VALUES('address',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", raw); err != nil {
		return err
	}
	if err = s.Publication.PublishInstall(ctx, tx, a); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	change.Commit()
	return nil
}
