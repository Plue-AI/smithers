package chat

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/ports"
)

// Defaults for a process that serves one owner. Hosted composition passes its
// own sizes from configuration.
const (
	DefaultQueueSize   = 256
	DefaultConcurrency = 4
	// DefaultLease is short because the dispatcher renews it every quarter
	// lease while the host runs. It bounds how long a crashed process holds a
	// turn before recovery reclaims it.
	DefaultLease = 2 * time.Minute
)

type RuntimeOptions struct {
	QueueSize   int
	Concurrency int
	Lease       time.Duration
	Logger      *slog.Logger
	// Sources serves turns' reads of a mirrored main as the credential that
	// admitted each turn; nil offers none.
	Sources SourceReader
	// API serves turns' reads of the install's API as the credential that
	// admitted each turn; nil offers none.
	API CommandAPI
}

type Runtime struct {
	Handler     *Handler
	dispatcher  *Dispatcher
	store       *Store
	concurrency int
}

// NewRuntime composes the common PostgreSQL admission boundary with a
// deployment-provided location for the same TypeScript model host. Root only
// mounts the returned routes and attaches Run to its existing lifecycle.
func NewRuntime(pool *pgxpool.Pool, host ports.ChatHost, producerBaseURL string, options RuntimeOptions) (*Runtime, error) {
	if host == nil {
		return nil, errors.New("chat runtime requires a model host")
	}
	callback, err := url.Parse(strings.TrimSpace(producerBaseURL))
	if err != nil || (callback.Scheme != "http" && callback.Scheme != "https") || callback.Host == "" || callback.User != nil || callback.RawQuery != "" || callback.Fragment != "" {
		return nil, errors.New("chat producer callback URL is invalid")
	}
	if options.QueueSize == 0 {
		options.QueueSize = DefaultQueueSize
	}
	if options.Concurrency == 0 {
		options.Concurrency = DefaultConcurrency
	}
	if options.Lease == 0 {
		options.Lease = DefaultLease
	}
	if options.QueueSize < 1 || options.Concurrency < 1 || options.Lease <= 0 {
		return nil, errors.New("chat runtime options are invalid")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	store, err := NewStore(pool)
	if err != nil {
		return nil, err
	}
	credentials := newTurnCredentials()
	dispatcher, err := NewDispatcher(store, PortHost{Host: host, ProducerBaseURL: callback.String(), Sources: options.Sources, API: options.API, credentials: credentials, logger: options.Logger}, options.QueueSize, options.Lease)
	if err != nil {
		return nil, err
	}
	dispatcher.logger = options.Logger
	handler := &Handler{Store: store, Dispatcher: dispatcher, Sources: options.Sources, API: options.API, credentials: credentials, logger: options.Logger, metrics: dispatcher.metrics}
	return &Runtime{Handler: handler, dispatcher: dispatcher, store: store, concurrency: options.Concurrency}, nil
}

// Run dispatches turns and relays other replicas' commits to local streams
// until ctx ends.
func (r *Runtime) Run(ctx context.Context) error {
	if r == nil || r.dispatcher == nil {
		return errors.New("chat runtime is not configured")
	}
	var listener sync.WaitGroup
	defer listener.Wait()
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	listener.Go(func() {
		_ = r.store.Listen(ctx, func(err error) {
			r.dispatcher.logger.Warn("chat commit listener disconnected", "error", err)
		})
	})
	return r.dispatcher.Run(ctx, r.concurrency)
}

// Collectors returns the runtime's Prometheus metrics for the process registry.
func (r *Runtime) Collectors() []prometheus.Collector { return r.dispatcher.metrics.collectors() }

func (r *Runtime) MountPublic(router chi.Router)        { r.Handler.MountPublic(router) }
func (r *Runtime) MountAuthenticated(router chi.Router) { r.Handler.MountAuthenticated(router) }
func (r *Runtime) MountErasure(router chi.Router)       { r.Handler.MountErasure(router) }
func (r *Runtime) MountProducerCallbacks(router chi.Router) {
	r.Handler.MountProducerCallbacks(router)
}
