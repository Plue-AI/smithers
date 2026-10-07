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

type eventConsumer struct {
	registry *Registry
	ctx      context.Context
	cancel   context.CancelFunc
	apply    EventHandler
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
func (r *Registry) ConsumeEvents(ctx context.Context, apply EventHandler) (func(), error) {
	if r == nil || apply == nil {
		return nil, ErrNotReady
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	child, cancel := context.WithCancel(ctx)
	consumer := &eventConsumer{registry: r, ctx: child, cancel: cancel, apply: apply, links: make(map[*Link]struct{})}
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
		_ = dispatchEvents(ctx, link, link.boot.branch, c.apply)
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

func dispatchEvents(ctx context.Context, link *Link, branch string, apply EventHandler) error {
	for {
		event, err := link.Receive(ctx)
		if err != nil {
			return err
		}
		if event.Seq == 0 {
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
