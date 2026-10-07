package machined

import (
	"context"
	"sync"
)

// EventHandler commits one durable event and returns its acknowledgement. The
// caller selects the writer by event variant (burst, capture, transcript, ...).
// A handler must honor cancellation and must never acknowledge on its own.
// The authenticated Link, not the payload, determines branch and boot authority.
type EventHandler func(context.Context, *Link, string, Event) (Acknowledgement, error)

// HintHandler publishes transient events without a durable receipt or ACK.
type HintHandler func(context.Context, *Link, string, Event) error

type eventConsumer struct {
	registry *Registry
	ctx      context.Context
	cancel   context.CancelFunc
	apply    EventHandler
	hint     HintHandler
	mu       sync.Mutex
	stopped  bool
	links    map[*Link]struct{}
	workers  sync.WaitGroup
	once     sync.Once
}

// ConsumeEvents binds the install's durable-event writer to existing and future
// authenticated connections. It begins before wake reconciliation: capture and
// reconciliation RPCs can wait for their outbox to drain before becoming ready.
// Only one consumer may own a registry. Stop cancels, closes and joins exactly
// its connections; an event whose writer failed is left for guest outbox replay.
// An optional hint handler uses the same pump; absent it, transient hints drop.
func (r *Registry) ConsumeEvents(ctx context.Context, apply EventHandler, hints ...HintHandler) (func(), error) {
	if r == nil || apply == nil || len(hints) > 1 {
		return nil, ErrNotReady
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	child, cancel := context.WithCancel(ctx)
	consumer := &eventConsumer{registry: r, ctx: child, cancel: cancel, apply: apply, links: make(map[*Link]struct{})}
	if len(hints) == 1 {
		consumer.hint = hints[0]
	}
	r.mu.Lock()
	r.eventsMu.Lock()
	if r.closed || r.eventsClosing || r.events != nil {
		r.eventsMu.Unlock()
		r.mu.Unlock()
		cancel()
		return nil, ErrNotReady
	}
	r.events = consumer
	r.eventsMu.Unlock()
	var links []*Link
	for _, boot := range r.branches {
		if boot.link != nil && boot.connection == boot.link.Connection {
			links = append(links, boot.link)
		}
	}
	r.mu.Unlock()
	for _, link := range links {
		consumer.start(link)
	}
	go func() { <-child.Done(); consumer.stop() }()
	return consumer.stop, nil
}

func (c *eventConsumer) start(link *Link) bool {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return false
	}
	if _, exists := c.links[link]; exists {
		c.mu.Unlock()
		return true
	}
	c.links[link] = struct{}{}
	c.workers.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.workers.Done()
		defer func() { c.mu.Lock(); delete(c.links, link); c.mu.Unlock() }()
		defer link.Close()
		ctx, cancel := context.WithCancel(c.ctx)
		defer cancel()
		// Replacement and transport loss must cancel an in-flight database write,
		// not merely the next Receive. The writer still owns its commit fence.
		go func() {
			select {
			case <-link.done:
				cancel()
			case <-ctx.Done():
			}
		}()
		_ = dispatchEvents(ctx, link, link.boot.branch, c.apply, c.hint)
	}()
	return true
}

func (c *eventConsumer) stop() {
	c.once.Do(func() {
		c.cancel()
		c.mu.Lock()
		c.stopped = true
		var links []*Link
		for link := range c.links {
			links = append(links, link)
		}
		c.mu.Unlock()
		for _, link := range links {
			_ = link.Close()
		}
		c.workers.Wait()
		c.registry.eventsMu.Lock()
		if c.registry.events == c {
			c.registry.events = nil
		}
		c.registry.eventsMu.Unlock()
	})
}

func dispatchEvents(ctx context.Context, link *Link, branch string, apply EventHandler, hint HintHandler) error {
	for {
		event, err := link.Receive(ctx)
		if err != nil {
			return err
		}
		if event.Seq == 0 {
			if hint != nil {
				if err := hint(ctx, link, branch, event); err != nil {
					return err
				}
			}
			continue
		} // transient hints never acquire durable receipts
		ack, err := apply(ctx, link, branch, event)
		if err != nil {
			return err
		}
		if ack.Seq != event.Seq {
			return ErrUnauthorized
		}
		if err = link.Ack(ctx, branch, ack); err != nil {
			return err
		}
	}
}

// EventConsumerReady lets the installed launcher refuse before guest effects
// when no lifecycle-owned consumer can drain reconciliation's durable outbox.
func (r *Registry) EventConsumerReady() bool {
	if r == nil {
		return false
	}
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	return r.events != nil && !r.eventsClosing && r.events.ctx.Err() == nil
}
