package email

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RateLimitConfig controls how many emails can be sent within a window.
type RateLimitConfig struct {
	// MaxPerSecond is the maximum number of emails per second (0 = unlimited).
	MaxPerSecond int
	// MaxPerRecipientPerHour limits emails to a single recipient per hour (0 = unlimited).
	MaxPerRecipientPerHour int
	// RecipientPool is the shared PostgreSQL store, required when the recipient limit is enabled.
	RecipientPool *pgxpool.Pool
}

// RateLimitedTransport wraps a Transport and enforces rate limits on email sends.
// The per-second limit is local; the per-recipient hourly budget is shared
// by every replica connected to the same PostgreSQL database.
type RateLimitedTransport struct {
	inner Transport
	cfg   RateLimitConfig
	mu    sync.Mutex
	// Per-process one-second admission window.
	tokens    int
	lastReset time.Time
}

// NewRateLimitedTransport wraps a transport with rate limiting.
// If cfg has all zero values, the inner transport is returned directly.
func NewRateLimitedTransport(inner Transport, cfg RateLimitConfig) Transport {
	if cfg.MaxPerSecond == 0 && cfg.MaxPerRecipientPerHour == 0 {
		return inner
	}
	return &RateLimitedTransport{
		inner:     inner,
		cfg:       cfg,
		tokens:    cfg.MaxPerSecond,
		lastReset: time.Now(),
	}
}

// Available delegates provider availability through the rate-limit wrapper.
// Rate limiting changes admission to Send; it does not make a disabled inner
// transport capable of delivery.
func (t *RateLimitedTransport) Available() bool {
	return t != nil && DeliveryConfigured(t.inner)
}

// Send reserves a local token without holding the mutex during PostgreSQL I/O.
func (t *RateLimitedTransport) Send(ctx context.Context, msg Message) error {
	window, err := t.reserveLocalToken()
	if err != nil {
		return err
	}
	if t.cfg.MaxPerRecipientPerHour > 0 {
		admissionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = t.reserveRecipients(admissionCtx, msg.To)
		cancel()
		if err != nil {
			t.refundLocalToken(window)
			return err
		}
	}
	return t.inner.Send(ctx, msg)
}

func (t *RateLimitedTransport) reserveLocalToken() (time.Time, error) {
	if t.cfg.MaxPerSecond <= 0 {
		return time.Time{}, nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	if now.Sub(t.lastReset) >= time.Second {
		t.tokens = t.cfg.MaxPerSecond
		t.lastReset = now
	}
	if t.tokens <= 0 {
		return time.Time{}, fmt.Errorf("email: global rate limit exceeded (%d/sec)", t.cfg.MaxPerSecond)
	}
	t.tokens--
	return t.lastReset, nil
}

func (t *RateLimitedTransport) refundLocalToken(window time.Time) {
	if t.cfg.MaxPerSecond <= 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	// A delayed refusal must not add capacity to a newer one-second window.
	if t.lastReset.Equal(window) {
		t.tokens++
	}
}

func (t *RateLimitedTransport) reserveRecipients(ctx context.Context, addresses []string) error {
	if t.cfg.RecipientPool == nil {
		return fmt.Errorf("email: per-recipient rate limit requires PostgreSQL")
	}
	seen := make(map[string]struct{}, len(addresses))
	recipients := make([]string, 0, len(addresses))
	for _, address := range addresses {
		recipient := strings.ToLower(strings.TrimSpace(address))
		if recipient == "" {
			return fmt.Errorf("email: recipient must not be blank")
		}
		if _, exists := seen[recipient]; exists {
			continue
		}
		seen[recipient] = struct{}{}
		recipients = append(recipients, recipient)
	}
	// All replicas acquire overlapping recipient rows in the same order.
	sort.Strings(recipients)
	// Bound retained addresses without a separate maintenance worker. Skip rows
	// being reserved by other replicas. Finish cleanup before acquiring any
	// admission locks, preserving the sorted admission lock order.
	_, err := t.cfg.RecipientPool.Exec(ctx, `
  WITH expired AS (
   SELECT recipient FROM email_recipient_rate_limits
   WHERE reset_at <= statement_timestamp()
   ORDER BY reset_at LIMIT 100 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM email_recipient_rate_limits r USING expired e
  WHERE r.recipient = e.recipient`)
	if err != nil {
		return fmt.Errorf("email: prune recipient quota: %w", err)
	}
	tx, err := t.cfg.RecipientPool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("email: reserve recipient quota: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
	}()
	for _, recipient := range recipients {
		var count int64
		err = tx.QueryRow(ctx, `
   INSERT INTO email_recipient_rate_limits AS r (recipient, count, reset_at)
   VALUES ($1, 1, statement_timestamp() + interval '1 hour')
   ON CONFLICT (recipient) DO UPDATE SET
    count = CASE WHEN r.reset_at <= statement_timestamp() THEN 1 ELSE r.count + 1 END,
    reset_at = CASE WHEN r.reset_at <= statement_timestamp()
     THEN statement_timestamp() + interval '1 hour' ELSE r.reset_at END
   WHERE r.reset_at <= statement_timestamp() OR r.count < $2
   RETURNING count`, recipient, t.cfg.MaxPerRecipientPerHour).Scan(&count)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("email: per-recipient rate limit exceeded for %s (%d/hour)", recipient, t.cfg.MaxPerRecipientPerHour)
		}
		if err != nil {
			return fmt.Errorf("email: reserve recipient quota: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("email: commit recipient quota: %w", err)
	}
	return nil
}
