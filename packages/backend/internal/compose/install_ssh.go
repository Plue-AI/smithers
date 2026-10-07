package compose

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	productssh "github.com/smithersai/smithers/packages/backend/ssh"
)

// startInstallSSH owns the loopback door. Member execution remains refused
// until the runtime supplies the authenticated daemon-session bridge; Git uses
// the existing repository transport and authorization on this same gateway.
func startInstallSSH(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, repo *repohost.Client, policy admission.Policy, bridge productssh.WorkspaceBridge, publicOrigin string) (*productssh.Server, string, func(), error) {
	_, port, err := net.SplitHostPort(cfg.SSH.Addr)
	if err != nil || port == "" {
		port = "2222"
	}
	durations := make([]time.Duration, 4)
	for i, raw := range []string{cfg.SSH.ReceivePackTimeout, cfg.SSH.UploadPackTimeout, cfg.SSH.IdleTimeout, cfg.SSH.MaxTimeout} {
		if raw != "" {
			value, e := time.ParseDuration(raw)
			if e != nil || value < 0 {
				return nil, "", nil, fmt.Errorf("invalid SSH timeout %q", raw)
			}
			durations[i] = value
		}
	}
	if policy == nil {
		policy = services.NewUnlimitedBillingPolicy()
	}
	server, err := productssh.New(ctx, productssh.Config{
		Database: pool, Repository: repo, Admission: policy,
		Addr: net.JoinHostPort("127.0.0.1", port), HostKeyDir: cfg.SSH.HostKeyDir,
		LFSSigningSecret: cfg.Auth.LFSSigningSecret, PublicAPIOrigin: publicOrigin,
		BranchLogins: true, WorkspaceBridge: bridge,
		MaxConnections: cfg.SSH.MaxConnections, MaxConnectionsPerIP: cfg.SSH.MaxConnectionsPerIP,
		MaxReceivePackSize: cfg.SSH.MaxReceivePackSize, MaxUploadPackRequestSize: cfg.SSH.MaxUploadPackRequestSize,
		AuthAttemptsPerMinute: cfg.SSH.AuthAttemptsPerMinute, MaxSessionsPerConn: cfg.SSH.MaxSessionsPerConn,
		ReceivePackTimeout: durations[0],
		UploadPackTimeout:  durations[1],
		IdleTimeout:        durations[2], MaxTimeout: durations[3],
	})
	if err != nil {
		return nil, "", nil, err
	}
	stop := func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}
	if err := server.Prepare(); err != nil {
		stop()
		return nil, "", nil, err
	}
	listener, err := netListen("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		stop()
		return nil, "", nil, err
	}
	_, port, _ = net.SplitHostPort(listener.Addr().String())
	go func() { _ = server.Serve(listener) }()
	return server, port, func() { _ = listener.Close(); stop() }, nil
}
