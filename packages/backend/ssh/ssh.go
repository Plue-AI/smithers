// Package ssh assembles the canonical product Git/SSH endpoint. Deployments
// supply a repository transport and, optionally, a workspace access bridge.
package ssh

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	transport "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/smithersai/smithers/packages/backend/repository"
)

type WorkspaceAccess = transport.WorkspaceAccess
type WorkspaceBridge = transport.WorkspaceBridge

var ErrWorkspaceAccessDenied = transport.ErrWorkspaceAccessDenied
var ErrWorkspaceUnavailable = transport.ErrWorkspaceUnavailable

const UnlimitedWorkspaceLifetime = transport.UnlimitedWorkspaceLifetime

type Config struct {
	// Database remains caller-owned and must outlive Shutdown.
	Database        *pgxpool.Pool
	Repository      *repository.Client
	WorkspaceBridge WorkspaceBridge
	// Admission caps each push at its owner's remaining storage.
	Admission                admission.Policy
	Metrics                  prometheus.Registerer
	LFSSigningSecret         string
	PublicAPIOrigin          string
	HostKeyDir               string
	Addr                     string
	AuthAttemptsPerMinute    int
	MaxConnections           int
	MaxConnectionsPerIP      int
	MaxReceivePackSize       int64
	MaxUploadPackRequestSize int64
	ReceivePackTimeout       time.Duration
	UploadPackTimeout        time.Duration
	IdleTimeout              time.Duration
	MaxTimeout               time.Duration
	WorkspaceMaxTimeout      time.Duration
	MaxSessionsPerConn       int
}

type Server struct {
	server *transport.Server
	cancel context.CancelFunc
	bus    *revocation.Bus
}

// New uses the same product queries, authorization, audit and revocation
// implementation as the HTTP app. It never creates a deployment query model.
func New(ctx context.Context, cfg Config) (*Server, error) {
	if cfg.Database == nil {
		return nil, errors.New("ssh: product database is required")
	}
	if cfg.Repository == nil {
		return nil, errors.New("ssh: repository transport is required")
	}
	if cfg.Admission == nil {
		return nil, errors.New("ssh: admission policy is required")
	}
	bridge, err := lfsauth.NewBridge(lfsauth.BridgeConfig{Secret: cfg.LFSSigningSecret, PublicBaseURL: cfg.PublicAPIOrigin})
	if err != nil {
		return nil, fmt.Errorf("ssh: LFS authentication: %w", err)
	}
	queries := db.New(cfg.Database)
	cfg.Repository.SetPushMeter(services.NewGitStorageMeter(cfg.Admission, queries))
	metrics := cfg.Metrics
	if metrics == nil {
		metrics = prometheus.NewRegistry()
	}
	server := &transport.Server{
		Queries: queries, Authorizer: services.NewSSHAuthorizationService(queries),
		RepoHostClient: cfg.Repository, LFSAuthBridge: bridge,
		AuditService: services.NewAuditService(queries), Metrics: transport.NewMetrics(metrics),
		AuthLimiter: transport.NewAuthLimiter(transport.AuthLimiterConfig{AttemptsPerMinute: cfg.AuthAttemptsPerMinute}),
		HostKeyDir:  cfg.HostKeyDir, Addr: cfg.Addr, MaxConnections: cfg.MaxConnections,
		MaxConnectionsPerIP: cfg.MaxConnectionsPerIP, MaxReceivePackSize: cfg.MaxReceivePackSize,
		MaxUploadPackRequestSize: cfg.MaxUploadPackRequestSize, ReceivePackTimeout: cfg.ReceivePackTimeout,
		UploadPackTimeout: cfg.UploadPackTimeout, IdleTimeout: cfg.IdleTimeout,
		MaxTimeout: cfg.MaxTimeout, WorkspaceMaxTimeout: cfg.WorkspaceMaxTimeout,
		MaxSessionsPerConn: cfg.MaxSessionsPerConn, WorkspaceBridge: cfg.WorkspaceBridge,
	}
	busCtx, cancel := context.WithCancel(ctx)
	bus := revocation.NewBus(cfg.Database, queries)
	if err := bus.Start(busCtx); err != nil {
		cancel()
		return nil, fmt.Errorf("ssh: revocation listener: %w", err)
	}
	transport.SetRevocationSource(bus)
	return &Server{server: server, cancel: cancel, bus: bus}, nil
}

func (s *Server) ListenAndServe() error { return s.server.ListenAndServe() }

func (s *Server) Shutdown(ctx context.Context) error {
	err := s.server.Shutdown(ctx)
	s.cancel()
	select {
	case <-s.bus.Done():
		return err
	case <-ctx.Done():
		return errors.Join(err, ctx.Err())
	}
}

// KeepaliveSender is the SSH connection surface needed by forwarded hops.
type KeepaliveSender = transport.KeepaliveSender

// StartKeepalive keeps a silent forwarded workspace session alive until stopped.
func StartKeepalive(ctx context.Context, sender KeepaliveSender) func() {
	return transport.StartKeepalive(ctx, sender)
}
