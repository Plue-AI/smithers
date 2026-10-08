package machined

import (
	"context"
	"encoding/hex"
	"sync"
	"time"

	"github.com/google/uuid"
)

// AckDelayReceipt is diagnostic evidence, never lifecycle qualification. The
// window is one-shot, expires after thirty seconds, and belongs to one ready
// authenticated connection. Restart/reconnect cannot carry it to another boot.
type AckDelayReceipt struct {
	ID         string    `json:"id"`
	Branch     string    `json:"branch"`
	Boot       string    `json:"boot"`
	Event      string    `json:"event,omitempty"`
	Sequence   uint64    `json:"sequence,omitempty"`
	State      string    `json:"state"`
	WithheldMS float64   `json:"withheld_ms"`
	ExpiresAt  time.Time `json:"expires_at"`
}
type ackDelay struct {
	receipt AckDelayReceipt
	link    *Link
	release chan struct{}
	once    sync.Once
}

func (r *Registry) AckDelay(branch string, delayMS int, id, boot string) (AckDelayReceipt, error) {
	if r == nil || (delayMS != 0 && delayMS != 10000) || (delayMS == 10000 && (id != "" || boot != "")) {
		return AckDelayReceipt{}, ErrNotReady
	}
	link, err := r.Current(branch)
	if err != nil {
		return AckDelayReceipt{}, err
	}
	if err = link.RequireReady(branch); err != nil {
		return AckDelayReceipt{}, err
	}
	r.ackDelayMu.Lock()
	defer r.ackDelayMu.Unlock()
	previous := r.ackDelays[branch]
	// Restoration is a compare-and-release under the same mutex as arming.
	// A stale client cannot release a replacement window or connection.
	if delayMS == 0 && (previous == nil || previous.link != link || id == "" || boot == "" || previous.receipt.ID != id || previous.receipt.Boot != boot) {
		return AckDelayReceipt{}, ErrUnauthorized
	}
	if previous != nil && previous.link != link {
		previous.once.Do(func() { close(previous.release) })
		previous = nil
		delete(r.ackDelays, branch)
	}
	if delayMS == 0 {
		previous.once.Do(func() { close(previous.release) })
		if previous.receipt.State == "armed" {
			previous.receipt.State = "cancelled"
		}
		return previous.receipt, nil
	}
	if previous != nil && (previous.receipt.State == "withheld" || previous.receipt.State == "armed" && time.Now().Before(previous.receipt.ExpiresAt)) {
		return AckDelayReceipt{}, ErrNotReady
	}
	if r.ackDelays == nil {
		r.ackDelays = make(map[string]*ackDelay)
	}
	receipt := AckDelayReceipt{ID: uuid.NewString(), Branch: branch, Boot: hex.EncodeToString(link.boot.id[:]), State: "armed", ExpiresAt: time.Now().UTC().Add(30 * time.Second)}
	r.ackDelays[branch] = &ackDelay{receipt: receipt, link: link, release: make(chan struct{})}
	return receipt, nil
}

func (r *Registry) ReadAckDelay(branch string) (AckDelayReceipt, error) {
	link, err := r.Current(branch)
	if err != nil {
		return AckDelayReceipt{}, err
	}
	if err = link.RequireReady(branch); err != nil {
		return AckDelayReceipt{}, err
	}
	r.ackDelayMu.Lock()
	defer r.ackDelayMu.Unlock()
	d := r.ackDelays[branch]
	if d == nil {
		return AckDelayReceipt{Branch: branch, Boot: hex.EncodeToString(link.boot.id[:]), State: "idle"}, nil
	}
	if d.link != link {
		return AckDelayReceipt{}, ErrUnauthorized
	}
	receipt := d.receipt
	if receipt.State == "armed" && !time.Now().Before(receipt.ExpiresAt) {
		receipt.State = "expired"
	}
	return receipt, nil
}

// Called only after the real event transaction commits, before its wire ACK.
// No mutation lock, SQL transaction, or registry fence spans the delay.
func (r *Registry) delayAcknowledgement(ctx context.Context, link *Link, branch string, event Event) func(error) {
	if len(event.Payload) == 0 || (event.Payload[0] != 2 && event.Payload[0] != 3) {
		return func(error) {}
	}
	r.ackDelayMu.Lock()
	d := r.ackDelays[branch]
	if d == nil || d.link != link || d.receipt.State != "armed" || !time.Now().Before(d.receipt.ExpiresAt) {
		r.ackDelayMu.Unlock()
		return func(error) {}
	}
	d.receipt.Event = hex.EncodeToString(event.EventID[:])
	d.receipt.Sequence = event.Seq
	d.receipt.State = "withheld"
	r.ackDelayMu.Unlock()
	start := time.Now()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-d.release:
	case <-ctx.Done():
	case <-link.Done():
	}
	return func(err error) {
		r.ackDelayMu.Lock()
		defer r.ackDelayMu.Unlock()
		d.receipt.WithheldMS = float64(time.Since(start)) / float64(time.Millisecond)
		d.receipt.State = "acknowledged"
		if err != nil {
			d.receipt.State = "failed"
		}
	}
}
