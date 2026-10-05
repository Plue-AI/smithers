package chat

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
)

// releaseTimeout bounds the lease hand-back a shutting down process makes.
const releaseTimeout = 5 * time.Second

// quarantineDelay keeps a turn Claim cannot take out of recovery. Such a turn
// needs an operator, so a slow recheck costs nothing.
const quarantineDelay = time.Hour

// retryDelay backs off reruns of a turn whose host failed before its provider
// started: 1 s, 2 s, 4 s, ... up to a minute.
func retryDelay(generation int64) time.Duration {
	if generation < 1 {
		generation = 1
	}
	return min(time.Second<<min(generation-1, 6), time.Minute)
}

type Host interface {
	RunTurn(context.Context, ProducerGrant) error
}

type runningTurn struct {
	generation int64
	cancel     context.CancelFunc
}

type Dispatcher struct {
	store   *Store
	host    Host
	lease   time.Duration
	queue   chan Candidate
	logger  *slog.Logger
	metrics *metrics
	// backoff is the rerun delay for a generation. Tests shorten it.
	backoff func(generation int64) time.Duration
	// scan is the recovery and interruption poll interval.
	scan    time.Duration
	mu      sync.Mutex
	running map[string]runningTurn
}

func NewDispatcher(store *Store, host Host, queueSize int, lease time.Duration) (*Dispatcher, error) {
	if store == nil || host == nil || queueSize <= 0 || lease <= 0 {
		return nil, errors.New("invalid chat dispatcher configuration")
	}
	d := &Dispatcher{store: store, host: host, lease: lease, queue: make(chan Candidate, queueSize), logger: slog.Default(), backoff: retryDelay, scan: time.Second, running: map[string]runningTurn{}}
	d.metrics = newMetrics(func() float64 { return float64(len(d.queue)) })
	return d, nil
}

// Enqueue never waits for host launch. PostgreSQL recovery picks up a full queue.
func (d *Dispatcher) Enqueue(candidate Candidate) bool {
	select {
	case d.queue <- candidate:
		return true
	default:
		return false
	}
}

func (d *Dispatcher) CancelRunning(turnID string) {
	d.mu.Lock()
	running, ok := d.running[turnID]
	d.mu.Unlock()
	if ok {
		running.cancel()
	}
}

func (d *Dispatcher) claim(ctx context.Context, candidate Candidate) (ProducerGrant, bool) {
	grant, err := d.store.Claim(ctx, candidate.Scope, candidate.TurnID, d.lease)
	switch {
	case err == nil:
		d.metrics.claims.Inc()
		return grant, true
	case ctx.Err() != nil, errors.Is(err, ErrProducerBusy), errors.Is(err, ErrTerminal), errors.Is(err, ErrRetired), errors.Is(err, ErrNotFound):
		// Another producer owns the turn, or it has already ended.
	case errors.Is(err, ErrUncertain):
		d.metrics.failures.WithLabelValues("uncertain").Inc()
		d.logger.Warn("chat turn sealed uncertain after its producer stopped", "turn_id", candidate.TurnID)
	case errors.Is(err, ErrCorrupt), errors.Is(err, ErrLimit), errors.Is(err, ErrInvalidRequest):
		// Claim fails the same way every time. Keep the turn out of the
		// oldest-first recovery scan so it cannot starve live turns.
		d.metrics.failures.WithLabelValues("quarantined_" + errorCode(err)).Inc()
		d.logger.Error("chat turn quarantined because it cannot be claimed", "turn_id", candidate.TurnID, "code", errorCode(err), "error", err)
		if quarantineErr := d.store.Quarantine(context.WithoutCancel(ctx), candidate, quarantineDelay); quarantineErr != nil {
			d.logger.Error("chat turn quarantine was not recorded", "turn_id", candidate.TurnID, "code", errorCode(quarantineErr), "error", quarantineErr)
		}
	default:
		d.metrics.failures.WithLabelValues("claim_" + errorCode(err)).Inc()
		d.logger.Error("chat turn claim failed", "turn_id", candidate.TurnID, "code", errorCode(err), "error", err)
	}
	return ProducerGrant{}, false
}

// renew keeps the lease ahead of a healthy host. It cancels the turn when the
// lease is fenced, because another producer may now own it.
func (d *Dispatcher) renew(ctx context.Context, grant ProducerGrant, lost context.CancelFunc) {
	ticker := time.NewTicker(max(d.lease/4, time.Millisecond))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if _, err := d.store.RenewProducer(ctx, grant, d.lease); err != nil {
			if ctx.Err() != nil {
				return
			}
			d.logger.Warn("chat producer lease renewal failed", "turn_id", grant.TurnID, "generation", grant.Generation, "code", errorCode(err), "error", err)
			if errors.Is(err, ErrProducerFenced) {
				lost()
				return
			}
		}
	}
}

func (d *Dispatcher) fail(ctx context.Context, grant ProducerGrant, code string, cause error) {
	d.metrics.failures.WithLabelValues(code).Inc()
	d.logger.Error("chat turn failed", "turn_id", grant.TurnID, "generation", grant.Generation, "code", code, "error", cause)
	// A provider's refusal ends the turn with the provider's reason.
	var err error
	if refusal := (*ProviderRefusal)(nil); errors.As(cause, &refusal) {
		err = d.store.RefuseProducer(ctx, grant, refusal)
	} else {
		err = d.store.FailProducer(ctx, grant, code)
	}
	if err != nil && !errors.Is(err, ErrProducerFenced) {
		d.logger.Error("chat turn failure was not recorded", "turn_id", grant.TurnID, "generation", grant.Generation, "code", errorCode(err), "error", err)
	}
}

// retry hands a turn whose host failed before its provider started back to
// recovery. The store seals it instead once the provider started or the turn
// is out of attempts.
func (d *Dispatcher) retry(ctx context.Context, grant ProducerGrant, code string, cause error) {
	retrying, err := d.store.RetryProducer(ctx, grant, code, d.backoff(grant.Generation))
	if err != nil {
		if !errors.Is(err, ErrProducerFenced) {
			d.logger.Error("chat turn failure was not recorded", "turn_id", grant.TurnID, "generation", grant.Generation, "code", errorCode(err), "error", err)
		}
		return
	}
	d.metrics.failures.WithLabelValues(code).Inc()
	if retrying {
		d.logger.Warn("chat turn will rerun after its host failed before the provider started", "turn_id", grant.TurnID, "generation", grant.Generation, "code", code, "error", cause)
		return
	}
	d.logger.Error("chat turn failed", "turn_id", grant.TurnID, "generation", grant.Generation, "code", code, "error", cause)
}

// watchEnded polls for running turns that ended elsewhere. It has its own
// loop because the dispatch loop blocks while every worker is busy.
func (d *Dispatcher) watchEnded(ctx context.Context) {
	ticker := time.NewTicker(d.scan)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.interruptEnded(ctx)
		}
	}
}

// interruptEnded stops local hosts whose turns ended elsewhere, such as a
// cancel or retire that another replica served.
func (d *Dispatcher) interruptEnded(ctx context.Context) {
	d.mu.Lock()
	ids := make([]string, 0, len(d.running))
	for id := range d.running {
		ids = append(ids, id)
	}
	d.mu.Unlock()
	ended, err := d.store.EndedAmong(ctx, ids)
	if err != nil {
		if ctx.Err() == nil {
			d.logger.Warn("chat running turn check failed", "code", errorCode(err), "error", err)
		}
		return
	}
	for _, id := range ended {
		d.CancelRunning(id)
	}
}

func (d *Dispatcher) runOne(parent context.Context, candidate Candidate) {
	grant, ok := d.claim(parent, candidate)
	if !ok {
		return
	}
	d.metrics.running.Inc()
	defer d.metrics.running.Dec()
	ctx, cancel := context.WithCancel(parent)
	d.mu.Lock()
	d.running[candidate.TurnID] = runningTurn{generation: grant.Generation, cancel: cancel}
	d.mu.Unlock()
	var renewals sync.WaitGroup
	defer func() {
		cancel()
		renewals.Wait()
		d.mu.Lock()
		if current, ok := d.running[candidate.TurnID]; ok && current.generation == grant.Generation {
			delete(d.running, candidate.TurnID)
		}
		d.mu.Unlock()
	}()
	renewals.Go(func() { d.renew(ctx, grant, cancel) })
	err := d.host.RunTurn(ctx, grant)
	detached := context.WithoutCancel(parent)
	if parent.Err() != nil {
		// Lifecycle shutdown is not a user cancellation or a terminal provider
		// fact. The host died with this process, so hand the lease back and let
		// recovery decide at once whether the turn reruns or ends uncertain.
		release, stop := context.WithTimeout(detached, releaseTimeout)
		defer stop()
		if releaseErr := d.store.ReleaseProducer(release, grant); releaseErr != nil && !errors.Is(releaseErr, ErrProducerFenced) {
			d.logger.Error("chat producer lease was not released at shutdown", "turn_id", grant.TurnID, "generation", grant.Generation, "code", errorCode(releaseErr), "error", releaseErr)
		}
		return
	}
	if err != nil {
		// An explicit user cancel has already committed its terminal batch
		// before interrupting this host, so the store leaves it unchanged.
		if errors.Is(err, ports.ErrModelCredentialMissing) {
			d.fail(detached, grant, "credential_missing", err)
			return
		}
		// The provider answered with a refusal: a rerun meets the same one.
		if refusal := (*ProviderRefusal)(nil); errors.As(err, &refusal) {
			d.fail(detached, grant, refusal.Code, err)
			return
		}
		d.retry(detached, grant, "host_failed", err)
		return
	}
	_, terminal, getErr := d.store.GetState(detached, candidate.Scope, candidate.TurnID)
	if getErr != nil {
		d.logger.Error("chat turn state read failed", "turn_id", grant.TurnID, "generation", grant.Generation, "code", errorCode(getErr), "error", getErr)
		return
	}
	if !terminal {
		d.fail(detached, grant, "host_returned_without_receipt", errors.New("model host returned without a terminal batch"))
	}
}

func (d *Dispatcher) Run(ctx context.Context, concurrency int) error {
	if concurrency <= 0 {
		return errors.New("chat dispatcher concurrency must be positive")
	}
	work := make(chan Candidate)
	var workers sync.WaitGroup
	for range concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for candidate := range work {
				d.runOne(ctx, candidate)
			}
		}()
	}
	var watcher sync.WaitGroup
	watchCtx, stopWatching := context.WithCancel(ctx)
	watcher.Go(func() { d.watchEnded(watchCtx) })
	ticker := time.NewTicker(d.scan)
	defer ticker.Stop()
	defer func() {
		close(work)
		workers.Wait()
		stopWatching()
		watcher.Wait()
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case candidate := <-d.queue:
			select {
			case work <- candidate:
			case <-ctx.Done():
				return nil
			}
		case <-ticker.C:
			candidates, err := d.store.RecoveryCandidates(ctx, 100)
			if err != nil {
				if ctx.Err() == nil {
					d.metrics.recoveryErrors.Inc()
					d.logger.Error("chat recovery scan failed", "code", errorCode(err), "error", err)
				}
				continue
			}
			for _, candidate := range candidates {
				select {
				case work <- candidate:
				case <-ctx.Done():
					return nil
				}
			}
		}
	}
}
