package ssh

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	stdErrors "errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gliderlabs/ssh"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Server is the Smithers SSH server for git operations.
type Server struct {
	Queries                  SSHPrincipalQuerier
	Authorizer               services.SSHAuthorizer
	RepoHostClient           RepoHostGitProxy
	LFSAuthBridge            *lfsauth.Bridge
	AuditService             *services.AuditService
	AuthLimiter              *AuthLimiter
	Metrics                  *Metrics
	HostKeyDir               string
	Addr                     string
	MaxConnections           int
	MaxConnectionsPerIP      int
	MaxReceivePackSize       int64
	MaxUploadPackRequestSize int64
	ReceivePackTimeout       time.Duration
	UploadPackTimeout        time.Duration
	// IdleTimeout bounds how long a connection may sit without any SSH
	// read/write activity (including the pre-auth handshake) before it is
	// closed. Zero means "derive from the pack timeouts"; it is never
	// unlimited, because connection slots are counted before authentication
	// and an idle client would otherwise hold one forever.
	IdleTimeout time.Duration
	// MaxTimeout is the absolute lifetime cap for a connection, bounding
	// slow-trickle clients that defeat IdleTimeout by sending a byte at a
	// time. Zero means the package default; it is never unlimited.
	MaxTimeout time.Duration
	// WorkspaceMaxTimeout is the absolute lifetime cap for an authenticated
	// workspace session connection, which replaces MaxTimeout once workspace
	// auth succeeds: a workspace command may run for hours, and the idle
	// deadline (kept alive by server keepalives) still reaps dead clients.
	// Zero means the package default; UnlimitedWorkspaceLifetime disables it.
	WorkspaceMaxTimeout time.Duration
	// MaxSessionsPerConn caps concurrent session channels multiplexed over a
	// single SSH connection, so one authenticated connection cannot fan out
	// unbounded git operations while only counting once against
	// MaxConnections. Zero means the package default.
	MaxSessionsPerConn int
	// WorkspaceBridge terminates public workspace SSH at this gateway and
	// establishes a second, authenticated SSH connection through the private
	// workspace control plane. Nil preserves the repository-only server.
	WorkspaceBridge WorkspaceBridge

	// drainTimeout overrides defaultReceivePackDrainTimeout in tests.
	drainTimeout time.Duration

	connMu                sync.Mutex
	activeConns           int
	activeConnsPerIP      map[string]int
	activeSessionsPerConn map[string]int

	runtimeMu  sync.Mutex
	runtimeSrv *ssh.Server
}

// SSHPrincipalQuerier defines the lookup used to resolve SSH principals and
// to enforce protected-bookmark policy on receive-pack.
type SSHPrincipalQuerier interface {
	GetUserBySSHFingerprint(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error)
	GetAnyDeployKeyByFingerprint(ctx context.Context, fingerprint string) (db.DeployKey, error)
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetDeployKeyByFingerprint(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error)
	TouchDeployKeyLastUsed(ctx context.Context, id int64) error
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
} // RepoHostGitProxy proxies git RPC streams to repo-host.
type RepoHostGitProxy interface {
	ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error
	ProxyUploadPack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error
	ProxyUploadPackBody(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error
	InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error)
	InfoRefsReceivePack(ctx context.Context, owner, repo string) ([]byte, error)
}

type sshPrincipal struct {
	UserID      int64
	Username    string
	Fingerprint string
	IsDeployKey bool
}

type contextKey string

const principalKey contextKey = "principal"

// workspaceErrorKey holds why an authenticated workspace login cannot be
// served (ErrWorkspaceAccessDenied or ErrWorkspaceUnavailable), or nil.
const workspaceErrorKey contextKey = "workspace-error"

const (
	defaultMaxReceivePackSize       int64 = 500 * 1024 * 1024
	defaultMaxUploadPackRequestSize int64 = 10 * 1024 * 1024
	defaultReceivePackTimeout             = 10 * time.Minute
	defaultUploadPackTimeout              = 10 * time.Minute
	// defaultMaxConnTimeout must stay generous: it caps legitimate slow
	// transfers too, and a 500MB push over a slow link can take well over an
	// hour.
	defaultMaxConnTimeout = 2 * time.Hour
	// defaultWorkspaceMaxTimeout caps one workspace SSH connection. Agent runs
	// and benchmark commands legitimately last hours; a day bounds a leaked
	// client without cutting real work.
	defaultWorkspaceMaxTimeout = 24 * time.Hour
	// UnlimitedWorkspaceLifetime as WorkspaceMaxTimeout removes the workspace
	// lifetime cap entirely; the idle deadline still applies.
	UnlimitedWorkspaceLifetime = time.Duration(-1)
	// workspaceKeepaliveInterval paces server-side keepalive requests on
	// workspace sessions so a silent long command never trips the idle
	// deadline, whatever the client's ServerAliveInterval.
	workspaceKeepaliveInterval = 30 * time.Second
	// idleTimeoutSlack is added on top of the pack timeouts when deriving the
	// idle timeout, so the proxy deadline (which starts at the proxy call)
	// always fires before the connection idle deadline (which resets on the
	// last client I/O) during silent repo-host processing.
	idleTimeoutSlack          = 1 * time.Minute
	defaultMaxSessionsPerConn = 10
	// auditLogTimeout bounds detached audit writes issued after an operation
	// has already succeeded.
	auditLogTimeout = 5 * time.Second
	// defaultReceivePackDrainTimeout is how long proxyReceivePack waits for
	// the client-copy goroutine after the repo-host proxy call has returned
	// before closing the session to unblock a read from a stalled client.
	defaultReceivePackDrainTimeout = 10 * time.Second
)

var (
	errGitRequestTooLarge = stdErrors.New("git request exceeds maximum allowed size")
	errUnknownPublicKey   = stdErrors.New("unknown ssh public key")
)

var (
	hostKeyGenerateKey            = ed25519.GenerateKey
	hostKeyMarshalPKCS8PrivateKey = x509.MarshalPKCS8PrivateKey
	hostKeyParsePrivateKey        = gossh.ParsePrivateKey
	hostKeyWriteFile              = os.WriteFile
)

// ListenAndServe starts the SSH server.
func (s *Server) ListenAndServe() error {
	s.connMu.Lock()
	if s.activeConnsPerIP == nil {
		s.activeConnsPerIP = make(map[string]int)
	}
	s.connMu.Unlock()

	srv := &ssh.Server{
		Addr:             s.Addr,
		PublicKeyHandler: s.publicKeyHandler,
		PasswordHandler:  s.passwordHandler,
		Handler:          s.sessionHandler,
		// sftp is accepted only for workspace sessions (sessionHandler refuses
		// it for git principals); the bridge relays it to the guest's server.
		SubsystemHandlers: map[string]ssh.SubsystemHandler{"sftp": s.sessionHandler},
		ConnCallback:      s.connCallback,
		PtyCallback: func(ctx ssh.Context, _ ssh.Pty) bool {
			_, workspace := ctx.Value(workspaceAccessKey).(WorkspaceAccess)
			return workspace
		},
		// Without these, gliderlabs sets no deadline at all on accepted
		// connections: a client that opens a TCP connection and never
		// completes the handshake (or stalls mid git request) holds a
		// connection slot and its goroutines forever. IdleTimeout applies a
		// rolling read/write deadline; MaxTimeout is the absolute cap.
		IdleTimeout: s.idleTimeout(),
		MaxTimeout:  s.maxConnTimeout(),
	}

	// Load host key
	hostKeyPath := filepath.Join(s.HostKeyDir, "ssh_host_ed25519_key")
	signer, err := ensureHostKey(hostKeyPath)
	if err != nil {
		return fmt.Errorf("ensure host key: %w", err)
	}
	srv.AddHostKey(signer)

	s.runtimeMu.Lock()
	s.runtimeSrv = srv
	s.runtimeMu.Unlock()

	slog.Info("ssh server listening", "addr", s.Addr)
	return srv.ListenAndServe()
}

// Shutdown gracefully shuts down the SSH server without interrupting active
// sessions. If the server has not been started, Shutdown is a no-op and returns
// nil. The provided context controls the maximum time to wait for in-flight
// connections to drain.
func (s *Server) Shutdown(ctx context.Context) error {
	s.runtimeMu.Lock()
	srv := s.runtimeSrv
	s.runtimeMu.Unlock()

	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

func (s *Server) connCallback(ctx ssh.Context, conn net.Conn) net.Conn {
	ip := remoteAddrIP(conn.RemoteAddr())

	s.connMu.Lock()
	if s.activeConnsPerIP == nil {
		s.activeConnsPerIP = make(map[string]int)
	}

	if s.MaxConnections > 0 && s.activeConns >= s.MaxConnections {
		s.connMu.Unlock()
		return nil
	}

	if s.MaxConnectionsPerIP > 0 && s.activeConnsPerIP[ip] >= s.MaxConnectionsPerIP {
		s.connMu.Unlock()
		return nil
	}

	s.activeConns++
	s.activeConnsPerIP[ip]++
	s.connMu.Unlock()

	if s.Metrics != nil {
		s.Metrics.ActiveConns.Inc()
	}

	conn = &workspaceDeadlineConn{
		Conn:        conn,
		ctx:         ctx,
		idleTimeout: s.idleTimeout(),
		maxDeadline: s.workspaceMaxDeadline(time.Now()),
	}

	go func() {
		<-ctx.Done()

		if s.Metrics != nil {
			s.Metrics.ActiveConns.Dec()
		}

		s.connMu.Lock()
		defer s.connMu.Unlock()

		if s.activeConns > 0 {
			s.activeConns--
		}

		switch count := s.activeConnsPerIP[ip]; {
		case count <= 1:
			delete(s.activeConnsPerIP, ip)
		default:
			s.activeConnsPerIP[ip] = count - 1
		}
	}()

	return conn
}

// acquireSessionSlot reserves a session slot for the given connection ID and
// reports whether the session may proceed.
func (s *Server) acquireSessionSlot(connID string) bool {
	limit := s.maxSessionsPerConn()

	s.connMu.Lock()
	defer s.connMu.Unlock()

	if s.activeSessionsPerConn == nil {
		s.activeSessionsPerConn = make(map[string]int)
	}
	if s.activeSessionsPerConn[connID] >= limit {
		return false
	}
	s.activeSessionsPerConn[connID]++
	return true
}

// releaseSessionSlot returns a session slot previously acquired for connID.
func (s *Server) releaseSessionSlot(connID string) {
	s.connMu.Lock()
	defer s.connMu.Unlock()

	switch count := s.activeSessionsPerConn[connID]; {
	case count <= 1:
		delete(s.activeSessionsPerConn, connID)
	default:
		s.activeSessionsPerConn[connID] = count - 1
	}
}

func remoteAddrIP(addr net.Addr) string {
	if addr == nil {
		return ""
	}

	if tcpAddr, ok := addr.(*net.TCPAddr); ok && tcpAddr.IP != nil {
		return tcpAddr.IP.String()
	}

	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

// publicKeyHandler authenticates incoming SSH connections by looking up the
// public key fingerprint in the database.
func (s *Server) publicKeyHandler(ctx ssh.Context, key ssh.PublicKey) bool {
	remoteIP := remoteAddrIP(ctx.RemoteAddr())
	hash := sha256.Sum256(key.Marshal())
	fingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(hash[:])
	credential := "key:" + fingerprint
	if !s.admitAuthAttempt(remoteIP, credential) {
		return false
	}

	workspace, workspaceLogin := parseWorkspacePublicKeyLogin(ctx.User())

	// Server faults below (no querier, lookup errors) are never recorded as
	// credential failures: a ban must mean the client presented a bad credential.
	if s.Queries == nil {
		slog.Warn("ssh auth failed: principal querier is not configured",
			"fingerprint", fingerprint,
			"remote_ip", remoteIP,
		)
		if s.Metrics != nil {
			s.Metrics.AuthAttempts.WithLabelValues("failed").Inc()
		}
		s.auditAuthFailure(ctx, fingerprint, remoteIP)
		return false
	}

	principal, err := s.lookupPrincipal(ctx, fingerprint)
	if err != nil {
		if stdErrors.Is(err, errUnknownPublicKey) {
			slog.Debug("ssh auth rejected unknown public key",
				"fingerprint", fingerprint,
				"remote_ip", remoteIP,
			)
		} else {
			slog.Warn("ssh auth lookup failed",
				"fingerprint", fingerprint,
				"remote_ip", remoteIP,
				"error", err,
			)
		}
		if s.Metrics != nil {
			s.Metrics.AuthAttempts.WithLabelValues("failed").Inc()
		}
		return false
	}
	if workspaceLogin {
		// Repository deploy keys are deliberately not user credentials and must
		// never open an interactive workspace shell.
		if principal.IsDeployKey {
			if s.AuthLimiter != nil {
				s.AuthLimiter.RecordFailure(remoteIP, credential)
			}
			if s.Metrics != nil {
				s.Metrics.AuthAttempts.WithLabelValues("failed").Inc()
			}
			s.auditAuthFailure(ctx, fingerprint, remoteIP)
			return false
		}
		// The key already proved who the user is. Any workspace refusal is
		// reported in the session instead of as an auth denial, and never
		// counts toward a ban: the controller answers 403 for a deleted or
		// re-placed VM too, so it cannot tell a stale grant from a bad one.
		ctx.SetValue(workspaceAccessKey, workspace)
		ctx.SetValue(workspaceErrorKey, s.validateWorkspace(ctx, workspace, remoteIP))
	}

	ctx.SetValue(principalKey, principal)
	if s.AuthLimiter != nil {
		s.AuthLimiter.RecordSuccess(remoteIP, credential)
	}
	if s.Metrics != nil {
		s.Metrics.AuthAttempts.WithLabelValues("success").Inc()
	}
	logFields := []any{
		"username", principal.Username,
		"fingerprint", fingerprint,
		"remote_ip", remoteIP,
	}
	if !principal.IsDeployKey {
		logFields = append(logFields, "user_id", principal.UserID)
	}
	slog.Info("ssh auth succeeded", logFields...)

	// Audit: successful SSH auth
	if s.AuditService != nil {
		auditEvent := services.AuditEvent{
			EventType: "ssh.auth",
			Action:    "success",
			Metadata: map[string]any{
				"fingerprint":     fingerprint,
				"principal_type":  principal.auditPrincipalType(),
				"principal_login": principal.Username,
			},
			IPAddress: remoteIP,
		}
		if !principal.IsDeployKey {
			auditEvent.ActorID = &principal.UserID
			auditEvent.ActorName = principal.Username
		}
		s.AuditService.Log(ctx, auditEvent)
	}

	return true
}

// passwordHandler authenticates browser terminals. The short-lived workspace
// access grant is the password and is validated by the private controller; the
// gateway never persists it or writes it to logs.
func (s *Server) passwordHandler(ctx ssh.Context, password string) bool {
	workspace, ok := parseWorkspacePasswordLogin(ctx.User(), password)
	if !ok || s.WorkspaceBridge == nil {
		return false
	}
	remoteIP := remoteAddrIP(ctx.RemoteAddr())
	credential := "workspace:" + workspace.SandboxID + "+" + workspace.User
	if !s.admitAuthAttempt(remoteIP, credential) {
		return false
	}
	// Grants are 256-bit random tokens, so the attempt throttle is the brute
	// force bound. A controller refusal is not recorded as a failure because
	// it also covers deleted and re-placed VMs.
	err := s.validateWorkspace(ctx, workspace, remoteIP)
	if stdErrors.Is(err, ErrWorkspaceAccessDenied) {
		if s.Metrics != nil {
			s.Metrics.AuthAttempts.WithLabelValues("failed").Inc()
		}
		return false
	}
	// An unavailable workspace is admitted so the session can tell the client
	// to retry; sessionHandler serves nothing while workspaceErrorKey is set.
	ctx.SetValue(workspaceAccessKey, workspace)
	ctx.SetValue(workspaceErrorKey, err)
	if s.AuthLimiter != nil {
		s.AuthLimiter.RecordSuccess(remoteIP, credential)
	}
	if s.Metrics != nil {
		s.Metrics.AuthAttempts.WithLabelValues("success").Inc()
	}
	slog.Info("workspace ssh auth succeeded", "sandbox_id", workspace.SandboxID, "guest_user", workspace.User, "remote_ip", remoteIP, "workspace_available", err == nil)
	return true
}

// admitAuthAttempt applies the limiter before any credential lookup.
func (s *Server) admitAuthAttempt(remoteIP, credential string) bool {
	if s.AuthLimiter == nil {
		return true
	}
	switch s.AuthLimiter.Check(remoteIP, credential) {
	case AuthLimitBanned:
		slog.Warn("ssh auth denied: ip banned", "remote_ip", remoteIP, "credential", credential)
		if s.Metrics != nil {
			s.Metrics.AuthAttempts.WithLabelValues("banned").Inc()
		}
		return false
	case AuthLimitThrottled:
		slog.Warn("ssh auth denied: ip throttled", "remote_ip", remoteIP, "credential", credential)
		if s.Metrics != nil {
			s.Metrics.AuthAttempts.WithLabelValues("throttled").Inc()
		}
		return false
	}
	return true
}

// validateWorkspace returns nil, ErrWorkspaceAccessDenied, or an error wrapping
// ErrWorkspaceUnavailable. It never touches the auth limiter.
func (s *Server) validateWorkspace(ctx context.Context, workspace WorkspaceAccess, remoteIP string) error {
	if s.WorkspaceBridge == nil {
		return ErrWorkspaceUnavailable
	}
	err := s.WorkspaceBridge.Validate(ctx, workspace)
	if err == nil {
		return nil
	}
	if !stdErrors.Is(err, ErrWorkspaceAccessDenied) && !stdErrors.Is(err, ErrWorkspaceUnavailable) {
		err = fmt.Errorf("%w: %v", ErrWorkspaceUnavailable, err)
	}
	slog.Warn("workspace ssh validation failed", "sandbox_id", workspace.SandboxID, "guest_user", workspace.User, "remote_ip", remoteIP, "error", err)
	if s.Metrics != nil && stdErrors.Is(err, ErrWorkspaceUnavailable) {
		s.Metrics.AuthAttempts.WithLabelValues("workspace_unavailable").Inc()
	}
	return err
}

func (s *Server) lookupPrincipal(ctx context.Context, fingerprint string) (sshPrincipal, error) {
	principal, err := s.Queries.GetUserBySSHFingerprint(ctx, fingerprint)
	if err == nil {
		return sshPrincipal{
			UserID:      principal.UserID,
			Username:    principal.Username,
			Fingerprint: fingerprint,
		}, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return sshPrincipal{}, err
	}

	if _, err := s.Queries.GetAnyDeployKeyByFingerprint(ctx, fingerprint); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return sshPrincipal{}, errUnknownPublicKey
		}
		return sshPrincipal{}, err
	}

	return sshPrincipal{
		Username:    "deploy-key",
		Fingerprint: fingerprint,
		IsDeployKey: true,
	}, nil
}

// auditAuthFailure records a failed SSH authentication attempt.
func (s *Server) auditAuthFailure(ctx context.Context, fingerprint, remoteIP string) {
	if s.AuditService != nil {
		s.AuditService.Log(ctx, services.AuditEvent{
			EventType: "ssh.auth",
			Action:    "failure",
			Metadata:  map[string]any{"fingerprint": fingerprint},
			IPAddress: remoteIP,
		})
	}
}

// sessionHandler processes git commands over SSH.
func (s *Server) sessionHandler(sess ssh.Session) {
	sessionID := uuid.New().String()
	sessionStart := time.Now()
	remoteIP := remoteAddrIP(sess.RemoteAddr())

	// SSH multiplexes session channels over one connection, and connection
	// limits are enforced per TCP connection only. Cap concurrent sessions per
	// connection so one authenticated connection cannot fan out unbounded git
	// operations.
	connID := sess.Context().SessionID()
	if !s.acquireSessionSlot(connID) {
		slog.Warn("ssh session rejected: too many concurrent sessions on connection",
			"session_id", sessionID,
			"remote_ip", remoteIP,
		)
		_, _ = fmt.Fprintln(sess.Stderr(), "ERROR: too many concurrent sessions on this connection")
		_ = sess.Exit(1)
		return
	}
	defer s.releaseSessionSlot(connID)
	// Register for revocation-driven termination for the life of the session.
	liveSessions.add(sess, sessionPrincipal(sess))
	defer liveSessions.remove(sess)

	if workspace, ok := sess.Context().Value(workspaceAccessKey).(WorkspaceAccess); ok {
		if message := workspaceErrorMessage(sess.Context(), s.WorkspaceBridge == nil); message != "" {
			_, _ = fmt.Fprintln(sess.Stderr(), message)
			_ = sess.Exit(1)
			return
		}
		if sender, ok := sess.Context().Value(ssh.ContextKeyConn).(KeepaliveSender); ok {
			stop := startWorkspaceKeepalive(sess.Context(), sender, workspaceKeepaliveInterval)
			defer stop()
		}
		exitCode, err := s.WorkspaceBridge.Serve(sess, workspace)
		if err != nil {
			slog.Warn("workspace ssh session failed", "sandbox_id", workspace.SandboxID, "guest_user", workspace.User, "remote_ip", remoteIP, "error", err)
			_, _ = fmt.Fprintln(sess.Stderr(), "ERROR: workspace SSH session failed")
		}
		_ = sess.Exit(exitCode)
		return
	}

	if subsystem := sess.Subsystem(); subsystem != "" {
		_, _ = fmt.Fprintf(sess.Stderr(), "subsystem %q is only available on workspace sessions\n", subsystem)
		_ = sess.Exit(1)
		return
	}

	rawCmd := sess.RawCommand()
	if rawCmd == "" {
		_, _ = fmt.Fprintln(sess.Stderr(), "interactive shell not supported")
		_ = sess.Exit(1)
		return
	}

	// Parse a Git pack command or the standard hybrid-transport discovery
	// command: git-lfs-authenticate 'owner/repo.git' upload|download.
	parts := strings.SplitN(rawCmd, " ", 2)
	if len(parts) != 2 {
		_, _ = fmt.Fprintln(sess.Stderr(), "invalid command")
		_ = sess.Exit(1)
		return
	}

	gitCmd := parts[0]
	repoPath := ""
	var mode services.AccessMode
	var lfsOperation lfsauth.Operation
	if gitCmd == "git-lfs-authenticate" {
		lfsArgs := strings.Fields(parts[1])
		if len(lfsArgs) != 2 {
			_, _ = fmt.Fprintln(sess.Stderr(), "invalid git-lfs-authenticate command")
			_ = sess.Exit(1)
			return
		}
		repoPath = strings.Trim(lfsArgs[0], "'\"")
		lfsOperation = lfsauth.Operation(strings.ToLower(strings.Trim(lfsArgs[1], "'\"")))
		switch lfsOperation {
		case lfsauth.OperationUpload:
			mode = services.AccessModeWrite
		case lfsauth.OperationDownload:
			mode = services.AccessModeRead
		default:
			_, _ = fmt.Fprintln(sess.Stderr(), "invalid Git LFS operation")
			_ = sess.Exit(1)
			return
		}
	} else {
		repoPath = strings.Trim(parts[1], "'\"")
		var err error
		mode, err = services.AccessModeFromGitCommand(gitCmd)
		if err != nil {
			_, _ = fmt.Fprintf(sess.Stderr(), "%v\n", err)
			_ = sess.Exit(1)
			return
		}
	}

	// Parse owner/repo from path
	owner, repo := parseRepoPath(repoPath)
	if owner == "" || repo == "" {
		_, _ = fmt.Fprintln(sess.Stderr(), "invalid repository path")
		_ = sess.Exit(1)
		return
	}

	principal, ok := sess.Context().Value(principalKey).(sshPrincipal)
	if !ok {
		slog.Warn("ssh session: missing principal in context",
			"session_id", sessionID,
			"remote_ip", remoteIP,
		)
		s.writeGitPermissionDenied(sess, owner, repo)
		_ = sess.Exit(1)
		return
	}

	var resolvedPrincipal sshPrincipal
	var lfsRepositoryID int64
	var err error
	if gitCmd == "git-lfs-authenticate" {
		resolvedPrincipal, lfsRepositoryID, err = s.authorizeLFSPrincipal(sess.Context(), principal, owner, repo, mode)
	} else {
		resolvedPrincipal, err = s.authorizePrincipal(sess.Context(), principal, owner, repo, mode)
	}
	if err != nil {
		if apiErr, ok := err.(*apierrors.APIError); ok {
			if apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusNotFound {
				slog.Warn("ssh authorization denied",
					"session_id", sessionID,
					"user_id", principal.UserID,
					"username", principal.Username,
					"owner", owner,
					"repo", repo,
					"mode", mode,
					"status", apiErr.Status,
					"remote_ip", remoteIP,
				)
				s.writeGitPermissionDenied(sess, owner, repo)
				_ = sess.Exit(1)
				return
			}
		}

		slog.Error("ssh authorization error",
			"session_id", sessionID,
			"user_id", principal.UserID,
			"username", principal.Username,
			"owner", owner,
			"repo", repo,
			"mode", mode,
			"error", err,
			"remote_ip", remoteIP,
		)
		s.writeGitPermissionDenied(sess, owner, repo)
		_ = sess.Exit(1)
		return
	}

	slog.Info("ssh session start",
		"session_id", sessionID,
		"username", resolvedPrincipal.Username,
		"user_id", resolvedPrincipal.UserID,
		"git_command", gitCmd,
		"owner", owner,
		"repo", repo,
		"remote_ip", remoteIP,
	)

	if gitCmd == "git-lfs-authenticate" {
		if err := s.writeLFSAuthenticate(sess, owner, repo, lfsRepositoryID, lfsOperation, resolvedPrincipal); err != nil {
			slog.Error("ssh lfs authentication failed",
				"session_id", sessionID,
				"username", resolvedPrincipal.Username,
				"user_id", resolvedPrincipal.UserID,
				"owner", owner,
				"repo", repo,
				"operation", lfsOperation,
				"error", err,
				"remote_ip", remoteIP,
			)
			_, _ = fmt.Fprintln(sess.Stderr(), "ERROR: unable to issue Git LFS credential")
			_ = sess.Exit(1)
			return
		}
		slog.Info("ssh lfs authentication issued",
			"session_id", sessionID,
			"principal_type", resolvedPrincipal.auditPrincipalType(),
			"owner", owner,
			"repo", repo,
			"operation", lfsOperation,
			"duration_ms", time.Since(sessionStart).Milliseconds(),
		)
		if s.AuditService != nil {
			durationMs := time.Since(sessionStart).Milliseconds()
			auditEvent := services.AuditEvent{
				EventType:  "ssh.lfs_credential",
				ActorName:  resolvedPrincipal.Username,
				TargetType: "repository",
				TargetID:   &lfsRepositoryID,
				TargetName: owner + "/" + repo,
				Action:     "issue",
				Metadata: map[string]any{
					"session_id":     sessionID,
					"operation":      string(lfsOperation),
					"duration_ms":    durationMs,
					"principal_type": resolvedPrincipal.auditPrincipalType(),
				},
				IPAddress: remoteIP,
			}
			if !resolvedPrincipal.IsDeployKey {
				auditEvent.ActorID = &resolvedPrincipal.UserID
			}
			auditCtx, cancelAudit := context.WithTimeout(context.WithoutCancel(sess.Context()), auditLogTimeout)
			s.AuditService.Log(auditCtx, auditEvent)
			cancelAudit()
		}
		_ = sess.Exit(0)
		return
	}

	if s.RepoHostClient == nil {
		slog.Error("ssh repo-host client is not configured",
			"session_id", sessionID,
		)
		_, _ = fmt.Fprintln(sess.Stderr(), "ERROR: internal server error")
		_ = sess.Exit(1)
		return
	}

	slog.Info("ssh proxying git command",
		"session_id", sessionID,
		"git_command", gitCmd,
		"username", resolvedPrincipal.Username,
		"user_id", resolvedPrincipal.UserID,
		"owner", owner,
		"repo", repo,
		"remote_ip", remoteIP,
	)

	if err := s.proxyGitCommand(sess.Context(), sess, gitCmd, owner, repo, resolvedPrincipal); err != nil {
		duration := time.Since(sessionStart)
		durationMs := duration.Milliseconds()

		if s.Metrics != nil {
			s.Metrics.GitOpDuration.WithLabelValues(gitCmd).Observe(duration.Seconds())
			s.Metrics.GitOperations.WithLabelValues(gitCmd, "error").Inc()
		}

		if stdErrors.Is(err, errGitRequestTooLarge) {
			slog.Warn("ssh git request exceeded configured size limit",
				"session_id", sessionID,
				"git_command", gitCmd,
				"owner", owner,
				"repo", repo,
				"duration_ms", durationMs,
			)
			s.writeGitSizeLimitExceeded(sess)
			_ = sess.Exit(1)
			return
		}

		if status, ok := repohost.IsStatusError(err); ok && status.Held() {
			slog.Warn("ssh git write refused: repository held",
				"session_id", sessionID, "git_command", gitCmd, "owner", owner, "repo", repo)
			_, _ = fmt.Fprintf(sess.Stderr(), "ERROR: %s\n", status.Message)
			_ = sess.Exit(1)
			return
		}

		slog.Error("ssh git proxy failed",
			"session_id", sessionID,
			"git_command", gitCmd,
			"username", resolvedPrincipal.Username,
			"user_id", resolvedPrincipal.UserID,
			"owner", owner,
			"repo", repo,
			"error", err,
			"duration_ms", durationMs,
		)
		_, _ = fmt.Fprintln(sess.Stderr(), "ERROR: repository operation failed")
		_ = sess.Exit(1)
		return
	}

	duration := time.Since(sessionStart)
	durationMs := duration.Milliseconds()

	if s.Metrics != nil {
		s.Metrics.GitOpDuration.WithLabelValues(gitCmd).Observe(duration.Seconds())
		s.Metrics.GitOperations.WithLabelValues(gitCmd, "success").Inc()
	}

	slog.Info("ssh session end",
		"session_id", sessionID,
		"username", resolvedPrincipal.Username,
		"user_id", resolvedPrincipal.UserID,
		"git_command", gitCmd,
		"owner", owner,
		"repo", repo,
		"duration_ms", durationMs,
		"remote_ip", remoteIP,
	)

	// Audit: SSH git operation completed
	if s.AuditService != nil {
		auditEventType := "ssh.fetch"
		if gitCmd == "git-receive-pack" {
			auditEventType = "ssh.push"
		}
		auditEvent := services.AuditEvent{
			EventType:  auditEventType,
			ActorName:  resolvedPrincipal.Username,
			TargetType: "repository",
			TargetName: owner + "/" + repo,
			Action:     "success",
			Metadata: map[string]any{
				"session_id":     sessionID,
				"git_command":    gitCmd,
				"duration_ms":    durationMs,
				"principal_type": resolvedPrincipal.auditPrincipalType(),
			},
			IPAddress: remoteIP,
		}
		if !resolvedPrincipal.IsDeployKey {
			auditEvent.ActorID = &resolvedPrincipal.UserID
		}
		// gliderlabs may cancel the session context as soon as the client
		// disconnects after a completed push; write the audit record with a
		// detached bounded context so it is never dropped.
		auditCtx, cancelAudit := context.WithTimeout(context.WithoutCancel(sess.Context()), auditLogTimeout)
		s.AuditService.Log(auditCtx, auditEvent)
		cancelAudit()
	}

	_ = sess.Exit(0)
}

func (s *Server) writeLFSAuthenticate(sess ssh.Session, owner, repo string, repositoryID int64, operation lfsauth.Operation, principal sshPrincipal) error {
	if s.LFSAuthBridge == nil {
		return fmt.Errorf("lfs auth bridge is not configured")
	}
	principalType := lfsauth.PrincipalUser
	if principal.IsDeployKey {
		principalType = lfsauth.PrincipalDeployKey
	}
	response, _, err := s.LFSAuthBridge.Issue(lfsauth.Grant{
		RepositoryID: repositoryID,
		Owner:        owner,
		Repository:   repo,
		Operation:    operation,
		Principal:    principalType,
	})
	if err != nil {
		return fmt.Errorf("issue lfs credential: %w", err)
	}
	if err := json.NewEncoder(sess).Encode(response); err != nil {
		return fmt.Errorf("write lfs authentication response: %w", err)
	}
	return nil
}

// authorizeLFSPrincipal binds an SSH authorization decision to one stable
// repository ID before turning it into a replayable HTTP credential. A
// repository can be deleted and its name reused while the SSH request is in
// flight, so a second name lookup must still identify the repository that was
// checked. Deploy keys are looked up directly against that same ID.
func (s *Server) authorizeLFSPrincipal(ctx context.Context, principal sshPrincipal, owner, repo string, mode services.AccessMode) (sshPrincipal, int64, error) {
	repository, err := s.resolveRepositoryByName(ctx, owner, repo)
	if err != nil {
		return sshPrincipal{}, 0, err
	}

	var resolvedPrincipal sshPrincipal
	if principal.IsDeployKey {
		resolvedPrincipal, err = s.authorizeDeployKeyForRepository(ctx, principal, repository, mode)
	} else {
		resolvedPrincipal, err = s.authorizePrincipal(ctx, principal, owner, repo, mode)
	}
	if err != nil {
		return sshPrincipal{}, 0, err
	}

	after, err := s.resolveRepositoryByName(ctx, owner, repo)
	if err != nil {
		return sshPrincipal{}, 0, err
	}
	if after.ID != repository.ID {
		return sshPrincipal{}, 0, apierrors.Internal("repository changed during LFS authorization")
	}
	return resolvedPrincipal, repository.ID, nil
}

func (s *Server) authorizePrincipal(ctx context.Context, principal sshPrincipal, owner, repo string, mode services.AccessMode) (sshPrincipal, error) {
	if principal.IsDeployKey {
		key, repository, err := s.resolveDeployKeyForRepo(ctx, owner, repo, principal.Fingerprint)
		if err != nil {
			return sshPrincipal{}, err
		}
		return s.authorizeResolvedDeployKey(ctx, principal, key, repository, mode)
	}

	if s.Authorizer == nil {
		return sshPrincipal{}, apierrors.Internal("ssh authorization service is not configured")
	}

	if err := s.Authorizer.Authorize(ctx, principal.UserID, owner, repo, mode); err != nil {
		return sshPrincipal{}, err
	}

	return principal, nil
}

func (s *Server) authorizeDeployKeyForRepository(ctx context.Context, principal sshPrincipal, repository db.Repository, mode services.AccessMode) (sshPrincipal, error) {
	key, err := s.Queries.GetDeployKeyByFingerprint(ctx, db.GetDeployKeyByFingerprintParams{
		RepositoryID:   repository.ID,
		KeyFingerprint: principal.Fingerprint,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return sshPrincipal{}, apierrors.Forbidden("permission denied")
		}
		return sshPrincipal{}, apierrors.Internal("failed to resolve deploy key").WithCause(err)
	}
	return s.authorizeResolvedDeployKey(ctx, principal, key, repository, mode)
}

func (s *Server) authorizeResolvedDeployKey(ctx context.Context, principal sshPrincipal, key db.DeployKey, repository db.Repository, mode services.AccessMode) (sshPrincipal, error) {
	if mode == services.AccessModeWrite && repository.IsArchived {
		return sshPrincipal{}, apierrors.Forbidden("repository is archived")
	}
	if mode == services.AccessModeWrite && key.ReadOnly {
		return sshPrincipal{}, apierrors.Forbidden("deploy key is read only")
	}
	if err := s.Queries.TouchDeployKeyLastUsed(ctx, key.ID); err != nil {
		slog.Warn("failed to update deploy key last-used timestamp", "deploy_key_id", key.ID, "error", err)
	}
	return sshPrincipal{
		Username:    fmt.Sprintf("deploy-key:%s", key.Title),
		Fingerprint: principal.Fingerprint,
		IsDeployKey: true,
	}, nil
}

func (s *Server) resolveRepositoryByName(ctx context.Context, owner, repo string) (db.Repository, error) {
	if s.Queries == nil {
		return db.Repository{}, apierrors.Internal("principal querier is not configured")
	}
	repository, err := s.Queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     strings.ToLower(strings.TrimSpace(owner)),
		LowerName: strings.ToLower(strings.TrimSpace(repo)),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, apierrors.NotFound("repository not found")
		}
		return db.Repository{}, apierrors.Internal("failed to resolve repository").WithCause(err)
	}
	return repository, nil
}

func (s *Server) resolveDeployKeyForRepo(ctx context.Context, owner, repo, fingerprint string) (db.DeployKey, db.Repository, error) {
	repository, err := s.resolveRepositoryByName(ctx, owner, repo)
	if err != nil {
		return db.DeployKey{}, db.Repository{}, err
	}

	key, err := s.Queries.GetDeployKeyByFingerprint(ctx, db.GetDeployKeyByFingerprintParams{
		RepositoryID:   repository.ID,
		KeyFingerprint: fingerprint,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.DeployKey{}, db.Repository{}, apierrors.Forbidden("permission denied")
		}
		return db.DeployKey{}, db.Repository{}, apierrors.Internal("failed to resolve deploy key").WithCause(err)
	}

	return key, repository, nil
}

func (p sshPrincipal) auditPrincipalType() string {
	if p.IsDeployKey {
		return "deploy_key"
	}
	return "user"
}

func (s *Server) proxyGitCommand(ctx context.Context, sess ssh.Session, gitCmd, owner, repo string, pusher sshPrincipal) error {
	// A person's key sees its user's own refs/smithers/users/<id>/ refs; a
	// deploy key sees none (#2253).
	viewer := pusher.UserID
	if pusher.IsDeployKey {
		viewer = 0
	}
	ctx = repohost.WithRefViewer(ctx, viewer)
	switch gitCmd {
	case "git-upload-pack":
		return s.proxyUploadPack(ctx, sess, owner, repo)
	case "git-receive-pack":
		return s.proxyReceivePack(ctx, sess, owner, repo, pusher)
	default:
		return fmt.Errorf("unsupported git command: %s", gitCmd)
	}
}

// proxyUploadPack implements the two-step SSH upload-pack protocol:
// 1. Fetch ref advertisement from repo-host and send to SSH client
// 2. Read client's wants, proxy to repo-host upload-pack, stream response back
func (s *Server) proxyUploadPack(ctx context.Context, sess ssh.Session, owner, repo string) error {
	// Step 1: Get ref advertisement and send to client
	refs, err := s.RepoHostClient.InfoRefsUploadPack(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("fetch ref advertisement: %w", err)
	}

	if _, err := sess.Write(refs); err != nil {
		return fmt.Errorf("write ref advertisement: %w", err)
	}

	// Step 2: Read client's wants/haves into a buffer, then proxy to upload-pack.
	// The git client sends pkt-lines: want lines, flush (0000), optional have lines, done.
	// We read until we see "done\n" or the client closes stdin (empty repo, nothing to fetch).
	//
	// repo-host runs `git upload-pack --stateless-rpc`, but the SSH client speaks
	// the stateful protocol: after every flushed batch of have lines (16, then
	// 32, ...) it blocks until upload-pack answers with ACK/NAK. Answer each
	// batch with one stateless round over everything seen so far, exactly as a
	// smart-HTTP client would, or the fetch deadlocks until the idle deadline.
	maxRequestSize := s.maxUploadPackRequestSize()
	limitedReader := &countingReader{
		r: io.LimitReader(sess, maxRequestSize+1),
	}
	postUploadPack := func(body []byte, out io.Writer) error {
		// Detach from the SSH session context so its cancellation doesn't abort
		// the HTTP request while repo-host is still processing; the ref viewer
		// stays. The timeout
		// must be generous: it bounds the whole clone/fetch response, and a hardcoded
		// 60s truncated large or slow clones. Mirror the receive-pack default.
		bgCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.uploadPackTimeout())
		defer cancel()
		return s.RepoHostClient.ProxyUploadPackBody(bgCtx, owner, repo, bytes.NewReader(body), out)
	}
	ackedCommon := map[string]bool{}
	negotiate := func(sofar []byte) error {
		round := append(append(make([]byte, 0, len(sofar)+4), sofar...), "0000"...)
		var reply bytes.Buffer
		if err := postUploadPack(round, &reply); err != nil {
			return fmt.Errorf("negotiation round: %w", err)
		}
		_, err := sess.Write(dropRepeatedCommonAcks(reply.Bytes(), ackedCommon))
		return err
	}

	wants, err := readGitUploadPackRequest(limitedReader, negotiate)
	if err != nil {
		if limitedReader.n > maxRequestSize {
			return errGitRequestTooLarge
		}
		return fmt.Errorf("read upload-pack request: %w", err)
	}
	if int64(len(wants)) > maxRequestSize || limitedReader.n > maxRequestSize {
		return errGitRequestTooLarge
	}

	// Empty wants means client has nothing to fetch (empty repo or up-to-date)
	if len(wants) == 0 {
		return nil
	}

	// Step 3: POST wants + every have + done to upload-pack and stream the pack.
	return postUploadPack(wants, sess)
}

// dropRepeatedCommonAcks removes "ACK <oid> common" pkt-lines whose oid was
// already relayed in an earlier negotiation round. Every stateless round
// replays all haves, so repo-host re-acknowledges commits the client already
// knows are common; a stateful upload-pack never repeats one, and git resets
// its in-vain counter on each ACK it reads, so repeats would keep it
// negotiating past the point where it should give up. Everything else,
// including anything that fails to parse, is passed through unchanged.
func dropRepeatedCommonAcks(reply []byte, acked map[string]bool) []byte {
	out := make([]byte, 0, len(reply))
	rest := reply
	for len(rest) >= 4 {
		pktLen, err := strconv.ParseUint(string(rest[:4]), 16, 32)
		if err != nil || (pktLen != 0 && (pktLen < 4 || int(pktLen) > len(rest))) {
			break
		}
		if pktLen == 0 {
			out = append(out, rest[:4]...)
			rest = rest[4:]
			continue
		}
		pkt := rest[:pktLen]
		rest = rest[pktLen:]
		fields := strings.Fields(string(pkt[4:]))
		if len(fields) == 3 && fields[0] == "ACK" && fields[2] == "common" {
			if acked[fields[1]] {
				continue
			}
			acked[fields[1]] = true
		}
		out = append(out, pkt...)
	}
	return append(out, rest...)
}

// proxyReceivePack implements the two-step SSH receive-pack protocol:
// 1. Fetch ref advertisement from repo-host and send to SSH client
// 2. Buffer client's pack data, then POST to repo-host receive-pack and stream response back
//
// The session's context ends with the connection, not with the client's
// stdin EOF, so it may stop a push that is still waiting for the repository;
// once repo-host starts the push, it runs to its own end.
func (s *Server) proxyReceivePack(ctx context.Context, sess ssh.Session, owner, repo string, pusher sshPrincipal) error {
	// Step 1: Get ref advertisement and send to client
	refs, err := s.RepoHostClient.InfoRefsReceivePack(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("fetch ref advertisement: %w", err)
	}

	if _, err := sess.Write(refs); err != nil {
		return fmt.Errorf("write ref advertisement: %w", err)
	}

	// Step 2: Stream client's ref-update lines + pack data through a pipe.
	// Probe for an empty request to preserve existing behavior.
	sessionReader := bufio.NewReader(sess)
	if _, err := sessionReader.Peek(1); err != nil {
		if err == io.EOF {
			return nil
		}
		return fmt.Errorf("read receive-pack data: %w", err)
	}

	// Protected-bookmark policy: parse the ref-update commands before the pack
	// reaches git, and reject any direct update or delete of a protected
	// bookmark. This must fail closed — a parse failure aborts the push.
	commands, packReader, err := repohost.PeekReceivePackCommands(sessionReader)
	if err != nil {
		return fmt.Errorf("parse receive-pack commands: %w", err)
	}
	if err := s.rejectProtectedBookmarkPush(ctx, sess, owner, repo, commands); err != nil {
		return err
	}
	// RFD-004: SSH sessions are user keys, never workspace credentials, so an
	// SSH push may write under refs/smithers/ only its user's own
	// refs/smithers/users/<id>/ namespace; a deploy key has none.
	userID := pusher.UserID
	if pusher.IsDeployKey {
		userID = 0
	}
	if msg := repohost.ReservedRefViolation(commands, "", userID); msg != "" {
		_, _ = fmt.Fprintf(sess.Stderr(), "ERROR: %s\n", msg)
		return fmt.Errorf("reserved ref rejected direct push: %s", msg)
	}

	pipeReader, pipeWriter := io.Pipe()
	copyErrCh := make(chan error, 1)
	maxPackSize := s.maxReceivePackSize()
	go func() {
		limitedReader := io.LimitReader(packReader, maxPackSize+1)
		n, copyErr := io.Copy(pipeWriter, limitedReader)
		if copyErr != nil {
			_ = pipeWriter.CloseWithError(copyErr)
			copyErrCh <- fmt.Errorf("read receive-pack data: %w", copyErr)
			return
		}
		if n > maxPackSize {
			_ = pipeWriter.CloseWithError(errGitRequestTooLarge)
			copyErrCh <- errGitRequestTooLarge
			return
		}
		_ = pipeWriter.Close()
		copyErrCh <- nil
	}()

	// Step 3: POST streamed data to receive-pack on a detached context, so a
	// push repo-host has started finishes (or is rolled back) whatever the
	// connection does. Until repo-host holds the repository's lock for it
	// (repohost.WithPushStarted), nothing is written, and a client that went
	// away while the push waited stops the wait instead of pinning this
	// handler. The time limit counts twice: once for the wait, and afresh
	// from the start of the push, as repo-host's own limit does.
	proxyCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	limit := time.AfterFunc(s.receivePackTimeout(), cancel)
	defer limit.Stop()
	var started atomic.Bool
	proxyCtx = repohost.WithPushStarted(proxyCtx, func() {
		started.Store(true)
		limit.Reset(s.receivePackTimeout() + repohost.PushStartedSlack)
	})
	waiting := make(chan struct{})
	defer close(waiting)
	go func() {
		select {
		case <-sess.Context().Done():
			if !started.Load() {
				cancel()
			}
		case <-waiting:
		}
	}()
	// SSH authenticates a person's key or a deploy key an administrator
	// added; the platform issues neither to a run.
	meta := repohost.ReceivePackMetadata{
		PusherID:         userID,
		PusherLogin:      pusher.Username,
		PusherCredential: middleware.CredentialPerson,
	}
	proxyErr := s.RepoHostClient.ProxyReceivePack(proxyCtx, owner, repo, pipeReader, sess, meta)
	if proxyErr != nil {
		_ = pipeReader.CloseWithError(proxyErr)
	}

	// The proxy call has finished, so no more client data is needed. The copy
	// goroutine normally finishes promptly (pipe writes fail once the pipe is
	// closed), but it may be blocked reading from a stalled client — closing
	// the pipe cannot unblock that read. Close the session so the read returns
	// instead of pinning this handler until the client disconnects.
	var copyErr error
	select {
	case copyErr = <-copyErrCh:
	case <-time.After(s.receivePackDrainTimeout()):
		_ = sess.Close()
		copyErr = <-copyErrCh
	}
	if stdErrors.Is(copyErr, errGitRequestTooLarge) || stdErrors.Is(proxyErr, errGitRequestTooLarge) {
		return errGitRequestTooLarge
	}
	if proxyErr != nil {
		return proxyErr
	}

	return copyErr
}

// rejectProtectedBookmarkPush fails a receive-pack request when any of its
// ref-update commands targets a bookmark matching a protected-bookmark
// pattern. Protected bookmarks may only move through the landing queue, which
// uses repo-host's land endpoint rather than receive-pack.
func (s *Server) rejectProtectedBookmarkPush(ctx context.Context, sess ssh.Session, owner, repo string, commands []repohost.ReceivePackCommand) error {
	if len(commands) == 0 {
		return nil
	}

	var repository db.Repository
	repoResolved := false
	for _, command := range commands {
		bookmark, ok := services.BookmarkNameFromRef(command.RefName)
		if !ok {
			continue
		}
		if !repoResolved {
			var err error
			repository, err = s.Queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
				Owner:     strings.ToLower(owner),
				LowerName: strings.ToLower(repo),
			})
			if err != nil {
				return fmt.Errorf("resolve repository for protected-bookmark check: %w", err)
			}
			repoResolved = true
		}
		if err := services.RequireBookmarkNotProtected(ctx, s.Queries, repository.ID, bookmark); err != nil {
			_, _ = fmt.Fprintf(sess.Stderr(), "ERROR: bookmark %q is protected; changes must go through a landing request\n", bookmark)
			return fmt.Errorf("protected bookmark %q rejected direct push: %w", bookmark, err)
		}
	}
	return nil
}

// readGitUploadPackRequest reads the git upload-pack request from the client.
// It reads pkt-lines until it encounters "done\n" or EOF (nothing to fetch).
//
// The returned body is one stateless-rpc request: the flush packets that end
// each batch of have lines are dropped, because `git upload-pack
// --stateless-rpc` stops negotiating at the first flush after a have. When
// onHaveFlush is set, it is called with the body read so far at each such
// flush; the stateful SSH client blocks for ACK/NAK there, so the callback
// must answer before this function reads on.
func readGitUploadPackRequest(r io.Reader, onHaveFlush func(sofar []byte) error) ([]byte, error) {
	var buf bytes.Buffer
	pktLenBuf := make([]byte, 4)
	haveInBatch := false

	for {
		// Read 4-byte pkt-line length
		_, err := io.ReadFull(r, pktLenBuf)
		if err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				// Client closed without sending wants (empty repo)
				return buf.Bytes(), nil
			}
			return nil, fmt.Errorf("read pkt-line length: %w", err)
		}

		// Parse hex length
		pktLen := 0
		for _, b := range pktLenBuf {
			pktLen <<= 4
			switch {
			case b >= '0' && b <= '9':
				pktLen |= int(b - '0')
			case b >= 'a' && b <= 'f':
				pktLen |= int(b-'a') + 10
			default:
				return nil, fmt.Errorf("invalid pkt-line hex: %q", pktLenBuf)
			}
		}

		// 0000 = flush packet. The one ending the want section stays in the
		// body; one ending a have batch is a negotiation round instead.
		if pktLen == 0 {
			if !haveInBatch {
				buf.Write(pktLenBuf)
				continue
			}
			haveInBatch = false
			if onHaveFlush != nil {
				if err := onHaveFlush(buf.Bytes()); err != nil {
					return nil, err
				}
			}
			continue
		}
		buf.Write(pktLenBuf)

		// Read payload (length includes the 4-byte header)
		payloadLen := pktLen - 4
		if payloadLen <= 0 {
			continue
		}

		payload := make([]byte, payloadLen)
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, fmt.Errorf("read pkt-line payload: %w", err)
		}
		buf.Write(payload)
		if bytes.HasPrefix(payload, []byte("have ")) {
			haveInBatch = true
		}

		// Check if this line is "done\n" — end of upload-pack request
		if string(payload) == "done\n" {
			return buf.Bytes(), nil
		}
	}
}

func (s *Server) writeGitPermissionDenied(sess ssh.Session, owner, repo string) {
	_, _ = fmt.Fprintf(sess.Stderr(), "ERROR: %s/%s: permission denied\n", owner, repo)
	_, _ = fmt.Fprintln(sess.Stderr(), "fatal: Could not read from remote repository.")
	_, _ = fmt.Fprintln(sess.Stderr())
	_, _ = fmt.Fprintln(sess.Stderr(), "Please make sure you have the correct access rights")
	_, _ = fmt.Fprintln(sess.Stderr(), "and the repository exists.")
}

func (s *Server) writeGitSizeLimitExceeded(sess ssh.Session) {
	_, _ = fmt.Fprintln(sess.Stderr(), "fatal: request exceeds maximum allowed size")
}

func (s *Server) maxReceivePackSize() int64 {
	if s.MaxReceivePackSize > 0 {
		return s.MaxReceivePackSize
	}
	return defaultMaxReceivePackSize
}

func (s *Server) maxUploadPackRequestSize() int64 {
	if s.MaxUploadPackRequestSize > 0 {
		return s.MaxUploadPackRequestSize
	}
	return defaultMaxUploadPackRequestSize
}

func (s *Server) receivePackTimeout() time.Duration {
	if s.ReceivePackTimeout > 0 {
		return s.ReceivePackTimeout
	}
	return defaultReceivePackTimeout
}

func (s *Server) uploadPackTimeout() time.Duration {
	if s.UploadPackTimeout > 0 {
		return s.UploadPackTimeout
	}
	return defaultUploadPackTimeout
}

// idleTimeout returns the per-connection idle deadline. When unset it is
// derived from the pack timeouts plus slack, so silent repo-host processing
// (bounded by the proxy timeouts) can never trip the idle deadline first.
func (s *Server) idleTimeout() time.Duration {
	if s.IdleTimeout > 0 {
		return s.IdleTimeout
	}
	idle := s.receivePackTimeout()
	if upload := s.uploadPackTimeout(); upload > idle {
		idle = upload
	}
	return idle + idleTimeoutSlack
}

// maxConnTimeout returns the absolute per-connection lifetime cap, never
// shorter than the idle timeout.
func (s *Server) maxConnTimeout() time.Duration {
	lifetime := s.MaxTimeout
	if lifetime <= 0 {
		lifetime = defaultMaxConnTimeout
	}
	if idle := s.idleTimeout(); lifetime < idle {
		lifetime = idle
	}
	return lifetime
}

// workspaceMaxTimeout returns the workspace connection lifetime cap, or
// UnlimitedWorkspaceLifetime.
func (s *Server) workspaceMaxTimeout() time.Duration {
	switch {
	case s.WorkspaceMaxTimeout < 0:
		return UnlimitedWorkspaceLifetime
	case s.WorkspaceMaxTimeout == 0:
		return defaultWorkspaceMaxTimeout
	}
	return s.WorkspaceMaxTimeout
}

// workspaceMaxDeadline is the absolute deadline a workspace connection
// accepted at now may live to; zero when unlimited.
func (s *Server) workspaceMaxDeadline(now time.Time) time.Time {
	lifetime := s.workspaceMaxTimeout()
	if lifetime == UnlimitedWorkspaceLifetime {
		return time.Time{}
	}
	return now.Add(lifetime)
}

func (s *Server) maxSessionsPerConn() int {
	if s.MaxSessionsPerConn > 0 {
		return s.MaxSessionsPerConn
	}
	return defaultMaxSessionsPerConn
}

func (s *Server) receivePackDrainTimeout() time.Duration {
	if s.drainTimeout > 0 {
		return s.drainTimeout
	}
	return defaultReceivePackDrainTimeout
}

type countingReader struct {
	r io.Reader
	n int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.n += int64(n)
	return n, err
}

func ensureHostKey(hostKeyPath string) (gossh.Signer, error) {
	keyBytes, err := os.ReadFile(hostKeyPath)
	if err == nil {
		signer, parseErr := hostKeyParsePrivateKey(keyBytes)
		if parseErr != nil {
			return nil, fmt.Errorf("parse host key: %w", parseErr)
		}
		return signer, nil
	}
	if !stdErrors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read host key: %w", err)
	}

	slog.Info("generating ssh host key", "path", hostKeyPath)
	if err := os.MkdirAll(filepath.Dir(hostKeyPath), 0700); err != nil {
		return nil, fmt.Errorf("create host key dir: %w", err)
	}

	_, privateKey, err := hostKeyGenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ed25519 key: %w", err)
	}

	der, err := hostKeyMarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}

	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	})
	if err := hostKeyWriteFile(hostKeyPath, pemBytes, 0600); err != nil {
		return nil, fmt.Errorf("write host key: %w", err)
	}

	signer, err := hostKeyParsePrivateKey(pemBytes)
	if err != nil {
		return nil, fmt.Errorf("parse generated host key: %w", err)
	}
	return signer, nil
}

// parseRepoPath extracts owner and repo from "owner/repo.git" or "owner/repo".
func parseRepoPath(path string) (string, string) {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	path = strings.TrimSuffix(path, ".git")

	parts := strings.Split(path, "/")
	if len(parts) != 2 {
		return "", ""
	}

	owner := parts[0]
	repo := parts[1]

	if !isSafeRepoComponent(owner) || !isSafeRepoComponent(repo) {
		return "", ""
	}

	return owner, repo
}

func isSafeRepoComponent(component string) bool {
	if component == "" || component == "." || component == ".." || strings.Contains(component, "..") {
		return false
	}
	for _, ch := range component {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' {
			continue
		}
		return false
	}
	return true
}

func workspaceErrorMessage(ctx context.Context, bridgeMissing bool) string {
	err, _ := ctx.Value(workspaceErrorKey).(error)
	switch {
	case stdErrors.Is(err, ErrWorkspaceAccessDenied):
		return "ERROR: workspace access denied or expired; request new access and retry"
	case err != nil || bridgeMissing:
		return "ERROR: workspace unavailable, retry"
	}
	return ""
}
