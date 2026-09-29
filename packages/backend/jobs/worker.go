package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

type Handler func(context.Context, *Lease) error

type WorkerConfig struct {
	WorkerID     string
	Capacity     int
	Lease        time.Duration
	PollInterval time.Duration
	// HeartbeatInterval also bounds cancellation observation independently of lease length.
	HeartbeatInterval time.Duration
	// RetryDelay is the first retry delay after a handler returns without a
	// terminal receipt. Each later attempt doubles it, up to MaxRetryDelay.
	RetryDelay    time.Duration
	MaxRetryDelay time.Duration
	// SettlementTimeout bounds receipt writes and cleanup after handler cancellation.
	SettlementTimeout time.Duration
	// Operations is an exact allowlist. Empty means every product operation.
	Operations       []string
	RecoveryInterval time.Duration
	RecoveryLimit    int
	OnError          func(error)
}

// Lease exposes only fenced mutations to a handler. StartExternal must be
// called immediately before a provider call, not after it returns.
type Lease struct {
	store             *Store
	claim             Claim
	released          atomic.Bool
	settlementTimeout time.Duration
}

func (lease *Lease) Claim() Claim { return lease.claim }

func (lease *Lease) StartExternal(ctx context.Context, observation json.RawMessage) error {
	attempt, err := lease.store.BeginExternal(ctx, lease.claim, observation)
	if err == nil {
		lease.claim.ExternalAttempt = attempt
	}
	return err
}

// DeliveryAttempt returns the stable external attempt after StartExternal.
func (lease *Lease) DeliveryAttempt() int { return lease.claim.DeliveryAttempt() }

// Waiting persists the external system's acceptance receipt separately from
// both the original request receipt and the eventual terminal receipt.
func (lease *Lease) Waiting(ctx context.Context, reason json.RawMessage) error {
	_, err := lease.store.Checkpoint(ctx, lease.claim, reason)
	return err
}

func (lease *Lease) Checkpoint(ctx context.Context, receipt json.RawMessage) (bool, error) {
	return lease.store.Checkpoint(ctx, lease.claim, receipt)
}

// Park saves a non-terminal checkpoint and releases this claim so another
// process can reconcile the external operation after retryAfter.
func (lease *Lease) Park(ctx context.Context, receipt json.RawMessage, retryAfter time.Duration) error {
	if err := lease.store.Park(ctx, lease.claim, receipt, retryAfter); err != nil {
		return err
	}
	lease.released.Store(true)
	return nil
}

// Defer durably parks an external operation and returns ErrDeferred so a
// handler can directly return the result. RunWorker consumes the sentinel.
func (lease *Lease) Defer(ctx context.Context, receipt json.RawMessage, retryAfter time.Duration) error {
	ctx, cancel := settlementContext(ctx, lease.settlementTimeout)
	defer cancel()
	if err := lease.Park(ctx, receipt, retryAfter); err != nil {
		return err
	}
	return ErrDeferred
}

func (lease *Lease) Complete(ctx context.Context, receipt json.RawMessage) error {
	return lease.release(lease.store.Complete(ctx, lease.claim, receipt))
}

func (lease *Lease) Fail(ctx context.Context, receipt json.RawMessage) error {
	return lease.release(lease.store.Fail(ctx, lease.claim, receipt))
}

func (lease *Lease) Cancelled(ctx context.Context, receipt json.RawMessage) error {
	// The handler learns about cancellation through ctx, so the receipt write
	// itself must remain usable after ctx becomes done.
	ctx, cancel := settlementContext(ctx, lease.settlementTimeout)
	defer cancel()
	return lease.release(lease.store.AcknowledgeCancellation(ctx, lease.claim, receipt))
}

// ExternalCancelled records cancellation reported by the external authority.
// Unlike Cancelled, it does not require a preceding product cancel request.
func (lease *Lease) ExternalCancelled(ctx context.Context, receipt json.RawMessage) error {
	ctx, cancel := settlementContext(ctx, lease.settlementTimeout)
	defer cancel()
	return lease.release(lease.store.RecordExternalCancellation(ctx, lease.claim, receipt))
}

func (lease *Lease) release(err error) error {
	if err == nil {
		lease.released.Store(true)
	}
	return err
}

// RunWorker runs a bounded worker pool. It is intended to be attached to the
// shared app lifecycle; HTTP admission never waits on this loop or a handler.
func (store *Store) RunWorker(ctx context.Context, config WorkerConfig, handler Handler) error {
	if config.WorkerID == "" {
		return errors.New("jobs: worker ID is required")
	}
	if config.Capacity <= 0 {
		return errors.New("jobs: worker capacity must be positive")
	}
	if config.Lease <= 0 {
		return errors.New("jobs: worker lease must be positive")
	}
	if config.SettlementTimeout < 0 {
		return errors.New("jobs: settlement timeout cannot be negative")
	}
	if handler == nil {
		return errors.New("jobs: worker handler is required")
	}
	if config.PollInterval <= 0 {
		config.PollInterval = 250 * time.Millisecond
	}
	if config.MaxRetryDelay <= 0 {
		config.MaxRetryDelay = time.Minute
	}
	if config.MaxRetryDelay < config.RetryDelay {
		config.MaxRetryDelay = config.RetryDelay
	}
	if config.Operations != nil && len(config.Operations) == 0 {
		return errors.New("jobs: worker operations cannot be empty")
	}
	operations, err := normalizeOperationFilter(config.Operations)
	if err != nil {
		return err
	}
	config.Operations = operations
	if config.RecoveryInterval <= 0 {
		config.RecoveryInterval = config.Lease / 2
		if config.RecoveryInterval <= 0 {
			config.RecoveryInterval = time.Millisecond
		}
	}
	if config.RecoveryLimit <= 0 {
		config.RecoveryLimit = config.Capacity * 4
	}
	heartbeatInterval := config.HeartbeatInterval
	if heartbeatInterval < 0 || heartbeatInterval >= config.Lease {
		return errors.New("jobs: heartbeat interval must be nonnegative and shorter than lease")
	}
	if heartbeatInterval == 0 {
		heartbeatInterval = config.Lease / 3
	}
	if heartbeatInterval <= 0 {
		heartbeatInterval = time.Millisecond
	}
	capacity := make(chan struct{}, config.Capacity)
	var workers sync.WaitGroup
	report := func(err error) {
		if err != nil && config.OnError != nil {
			config.OnError(err)
		}
	}

	nextRecovery := time.Time{}
	for ctx.Err() == nil {
		if !time.Now().Before(nextRecovery) {
			if _, err := store.RecoverExpiredForOperations(ctx, config.Operations, config.RecoveryLimit); err != nil && ctx.Err() == nil {
				report(err)
			}
			nextRecovery = time.Now().Add(config.RecoveryInterval)
		}
		select {
		case capacity <- struct{}{}:
		case <-ctx.Done():
			break
		}
		if ctx.Err() != nil {
			break
		}
		claimStarted := time.Now()
		claim, err := store.ClaimForOperations(ctx, config.WorkerID, config.Lease, config.Operations)
		if errors.Is(err, ErrNoWork) {
			<-capacity
			timer := time.NewTimer(config.PollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
			continue
		}
		if err != nil {
			<-capacity
			if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
				break
			}
			report(err)
			timer := time.NewTimer(config.PollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-capacity }()
			retryDelay := RetryBackoff(config.RetryDelay, config.MaxRetryDelay, claim.Attempt)
			if err := store.runClaim(ctx, claim, claimStarted.Add(config.Lease), config.Lease, heartbeatInterval, retryDelay, config.SettlementTimeout, handler); err != nil {
				report(&ClaimError{OperationID: claim.OperationID, Operation: claim.Operation, Attempt: claim.Attempt, RetryDelay: retryDelay, Err: err})
			}
		}()
	}
	workers.Wait()
	return nil
}

func (store *Store) runClaim(parent context.Context, claim Claim, leaseDeadline time.Time, leaseDuration, heartbeatInterval, retryDelay, settlementTimeout time.Duration, handler Handler) error {
	// Use elapsed local time from before the claim query, not the database
	// wall clock. Query latency only shortens the trusted initial lease.
	if !time.Now().Before(leaseDeadline) {
		return ErrClaimLost
	}
	handlerContext, cancel := context.WithCancel(parent)
	defer cancel()
	result := make(chan error, 1)
	lease := &Lease{store: store, claim: claim, settlementTimeout: settlementTimeout}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				result <- fmt.Errorf("job handler panic: %v", recovered)
			}
		}()
		result <- handler(handlerContext, lease)
	}()
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	cancellationRequested := false
	claimLost := false
	var handlerErr error
	for {
		select {
		case handlerErr = <-result:
			goto settled
		case <-ticker.C:
			if lease.released.Load() {
				continue
			}
			heartbeatStarted := time.Now()
			heartbeatCtx, stopHeartbeat := context.WithDeadline(parent, leaseDeadline)
			requested, err := store.Heartbeat(heartbeatCtx, claim, leaseDuration)
			stopHeartbeat()
			if errors.Is(err, ErrClaimLost) {
				if lease.released.Load() {
					continue
				}
				claimLost = true
				cancel()
				continue
			}
			if err != nil {
				if parent.Err() == nil && time.Now().Before(leaseDeadline) {
					// A query failure is not proof of a lost lease. Retry
					// within the last confirmed lease, never beyond it.
					continue
				}
				cancel()
				handlerErr = <-result
				if parent.Err() != nil {
					goto settled
				}
				return err
			}
			// Use the request start, earlier than the server renewal, so a
			// slow response cannot extend our locally trusted lease.
			leaseDeadline = heartbeatStarted.Add(leaseDuration)
			if requested {
				cancellationRequested = true
				cancel()
			}
		case <-parent.Done():
			cancel()
			handlerErr = <-result
			goto settled
		}
	}

settled:
	if lease.released.Load() {
		if errors.Is(handlerErr, ErrDeferred) {
			return nil
		}
		return handlerErr
	}
	if claimLost {
		return ErrClaimLost
	}
	settlement, stopSettlement := settlementContext(parent, settlementTimeout)
	defer stopSettlement()
	operation, err := store.Get(settlement, claim.Scope, claim.OperationID)
	if err != nil {
		return err
	}
	if operation.State.Terminal() {
		return handlerErr
	}
	if operation.CancellationRequested || cancellationRequested {
		if handlerErr == nil {
			handlerErr = errors.New("job handler returned without a cancellation receipt")
		}
		return store.Abandon(settlement, claim, handlerErr, retryDelay)
	}
	if handlerErr == nil {
		handlerErr = errors.New("job handler returned without a terminal receipt")
	}
	return store.Abandon(settlement, claim, handlerErr, retryDelay)
}

// ClaimError identifies the operation whose handler or settlement failed.
type ClaimError struct {
	OperationID string
	Operation   string
	Attempt     int
	RetryDelay  time.Duration
	Err         error
}

func (err *ClaimError) Error() string {
	return fmt.Sprintf("jobs: operation %s (%s) attempt %d: %v", err.OperationID, err.Operation, err.Attempt, err.Err)
}

func (err *ClaimError) Unwrap() error { return err.Err }

// RetryBackoff returns base doubled once per attempt after the first, capped
// at limit, with up to 20% jitter removed so retries from one burst spread out.
func RetryBackoff(base, limit time.Duration, attempt int) time.Duration {
	if base <= 0 {
		return 0
	}
	delay := base
	for step := 1; step < attempt && delay < limit; step++ {
		delay *= 2
	}
	if delay > limit {
		delay = limit
	}
	return delay - time.Duration(rand.Int64N(int64(delay)/5+1))
}
