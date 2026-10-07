package compose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/ports"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// Hosted replicas wait on remote model hosts, so a turn costs little local
// CPU. The launcher, not this process, bounds how many can run.
const (
	hostedChatConcurrency = 32
	hostedChatQueueSize   = 1024
)

// chatRuntimeOptions sizes the dispatcher from configuration, falling back to
// the default for the deployment role.
func chatRuntimeOptions(cfg config.ChatConfig, hosted bool, logger *slog.Logger) (chat.RuntimeOptions, error) {
	if cfg.Concurrency < 0 || cfg.QueueSize < 0 || cfg.LeaseSeconds < 0 {
		return chat.RuntimeOptions{}, errors.New("chat concurrency, queue size and lease must not be negative")
	}
	options := chat.RuntimeOptions{Concurrency: cfg.Concurrency, QueueSize: cfg.QueueSize, Lease: time.Duration(cfg.LeaseSeconds) * time.Second, Logger: logger}
	if hosted {
		if options.Concurrency == 0 {
			options.Concurrency = hostedChatConcurrency
		}
		if options.QueueSize == 0 {
			options.QueueSize = hostedChatQueueSize
		}
	}
	return options, nil
}

type chatComposition struct {
	runtime  *chat.Runtime
	listener net.Listener
	server   *http.Server
}

func newChatComposition(options runOptions, pool *pgxpool.Pool, sizing chat.RuntimeOptions, presence ...*branchPresence) (*chatComposition, error) {
	if options.ChatHost == nil {
		if options.ChatCallbackListener != nil || strings.TrimSpace(options.ChatProducerBaseURL) != "" {
			if options.ChatCallbackListener != nil {
				_ = options.ChatCallbackListener.Close()
			}
			return nil, errors.New("chat callback configuration requires a chat host")
		}
		return nil, nil
	}
	listener := options.ChatCallbackListener
	callbackURL := strings.TrimSpace(options.ChatProducerBaseURL)
	if !options.topology.hosted() && listener == nil {
		var err error
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, fmt.Errorf("listen for local chat callbacks: %w", err)
		}
	}
	if !options.topology.hosted() && listener != nil {
		address, ok := listener.Addr().(*net.TCPAddr)
		if !ok || !address.IP.IsLoopback() {
			_ = listener.Close()
			return nil, errors.New("single-owner chat callbacks must bind loopback")
		}
	}
	if !options.topology.hosted() && listener != nil {
		actualURL := "http://" + listener.Addr().String()
		if callbackURL != "" && callbackURL != actualURL {
			if listener != nil {
				_ = listener.Close()
			}
			return nil, errors.New("single-owner chat callback URL must match its private listener")
		}
		callbackURL = actualURL
	}
	if callbackURL == "" {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, errors.New("hosted chat requires an internal producer callback URL")
	}
	// Hosted workers dispatch into the shared journal through the hosted API's
	// callback URL. Only API replicas need to serve those capability-authenticated
	// routes, so workers require no listener of their own.
	host := options.ChatHost
	if len(presence) > 0 && presence[0] != nil {
		host = presenceChatHost{ChatHost: host, presence: presence[0], pool: pool}
	}
	runtime, err := chat.NewRuntime(pool, host, callbackURL, sizing)
	if err != nil {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, err
	}
	result := &chatComposition{runtime: runtime, listener: listener}
	if listener != nil {
		result.server = &http.Server{Handler: chatCallbackHandler(runtime)}
	}
	return result, nil
}

func (composition *chatComposition) close() {
	if composition != nil && composition.listener != nil {
		_ = composition.listener.Close()
	}
}

type presenceChatHost struct {
	ports.ChatHost
	presence *branchPresence
	pool     *pgxpool.Pool
}

func (h presenceChatHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	var branch string
	err := h.pool.QueryRow(ctx, `SELECT coalesce(conversation_id,'') FROM chat_turns WHERE id=$1 AND repository_id=$2 AND user_id=$3 AND producer_generation=$4 AND state='running'`, grant.TurnID, grant.RepositoryID, grant.OwnerID, grant.Generation).Scan(&branch)
	if err != nil || branch == "" {
		return h.ChatHost.RunChatTurn(ctx, grant)
	}
	return h.presence.duringTurn(ctx, grant.RepositoryID, grant.OwnerID, branch, grant.RunID, func() error { return h.ChatHost.RunChatTurn(ctx, grant) })
}
