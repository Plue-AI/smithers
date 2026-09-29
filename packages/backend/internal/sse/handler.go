package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// defaultKeepAlive is the keep-alive interval used when a config leaves
// KeepAlive unset or non-positive.
const defaultKeepAlive = 15 * time.Second

// keepAliveInterval returns d, or defaultKeepAlive when d is not positive.
// time.NewTicker panics on a non-positive duration after the stream is
// already committed, so every non-positive value takes the default.
func keepAliveInterval(d time.Duration) time.Duration {
	if d <= 0 {
		return defaultKeepAlive
	}
	return d
}

// BrokerStreamConfig configures a single SSE stream served by ServeBrokerSSE.
type BrokerStreamConfig struct {
	// Broker is the shared multiplexed LISTEN/NOTIFY broker.
	// Must not be nil.
	Broker *Broker

	// Channel is the single PostgreSQL NOTIFY channel to subscribe to.
	// Ignored when Channels is non-empty.
	Channel string

	// Channels lists multiple PostgreSQL NOTIFY channels to fan in over one
	// subscription (and one per-user cap slot). When non-empty it takes
	// precedence over Channel; the originating channel name is used as the
	// event type unless EventType overrides it.
	Channels []string

	// UserID is the authenticated user's ID, used to enforce per-user stream caps.
	UserID int64

	// KeepAlive is the interval between keep-alive comments. Non-positive
	// values default to 15s.
	KeepAlive time.Duration

	// EventType overrides the SSE event type written in "event:" fields.
	// If empty, the channel name from the NOTIFY is used.
	EventType string

	// OnConnect is called after SSE headers are sent, before the event loop.
	OnConnect func(w http.ResponseWriter, r *http.Request, flusher http.Flusher)

	// FormatEventID extracts an SSE event ID from the raw NOTIFY payload.
	FormatEventID func(payload string) string

	// Durable replaces raw NOTIFY forwarding with ordered database catch-up.
	Durable *DurableStream

	// ActiveConnections is an optional Prometheus gauge incremented on open
	// and decremented on close.
	ActiveConnections prometheus.Gauge
	// Revocations, when set, ends the stream the moment an event revokes the
	// stream's principal: a final "revoked" event is written and the handler
	// returns. Principal describes what this stream is authorized as; fill in
	// every field the handler knows (user, token hash, repository, workspace,
	// agent session).
	Revocations revocation.Watcher
	Principal   revocation.Principal
}

// RevokedEventType is the SSE event type written before a stream is closed
// because its authorization was revoked. The data is the revocation event.
const RevokedEventType = "revoked"

// ServeBrokerSSE handles the full SSE lifecycle using the shared Broker instead
// of acquiring a dedicated pgx connection per client.
//
// If the user has reached the per-user stream cap, ServeBrokerSSE writes a 429
// response and returns immediately.
func ServeBrokerSSE(w http.ResponseWriter, r *http.Request, cfg BrokerStreamConfig) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeSSEError(w, pkgerrors.CodeInternal, "streaming not supported")
		return
	}

	if cfg.Broker == nil {
		writeSSEError(w, pkgerrors.CodeInternal, "SSE not configured: broker is nil")
		return
	}

	// Register revocation before the potentially blocking baseline read. A
	// separate context cancels that read without consuming the final event
	// needed by an already-established stream.
	streamCtx, cancelStream := context.WithCancel(r.Context())
	defer cancelStream()
	r = r.WithContext(streamCtx)
	baselineCtx, cancelBaseline := context.WithCancel(streamCtx)
	defer cancelBaseline()
	var revoked <-chan revocation.Event
	if cfg.Revocations != nil {
		principal := cfg.Principal
		if principal.UserID == 0 {
			principal.UserID = cfg.UserID
		}
		rawRevoked := cfg.Revocations.Watch(streamCtx, principal)
		// Check the credential/user cache after subscribing to refuse admission
		// before opening the stream, even when Watch already queued an event.
		// Repository/organization authorization remains the route gate's
		// responsibility; this cache does not retain their current permissions.
		checker, _ := cfg.Revocations.(revocation.Checker)
		if _, denied := revocation.Revoked(checker, principal); denied {
			pkgerrors.WriteError(w, pkgerrors.Forbidden("stream authorization revoked"))
			return
		}
		forwarded := make(chan revocation.Event, 1)
		revoked = forwarded
		go func() {
			select {
			case event, ok := <-rawRevoked:
				if ok {
					forwarded <- event
					cancelBaseline()
				}
			case <-streamCtx.Done():
			}
		}()
	}
	refuseRevoked := func() bool {
		select {
		case <-revoked:
			pkgerrors.WriteError(w, pkgerrors.Forbidden("stream authorization revoked"))
			return true
		default:
			return false
		}
	}

	var sub *Subscription
	var err error
	if len(cfg.Channels) > 0 {
		sub, err = cfg.Broker.SubscribeMulti(r.Context(), cfg.Channels, cfg.UserID)
	} else {
		sub, err = cfg.Broker.Subscribe(r.Context(), cfg.Channel, cfg.UserID)
	}
	if err != nil {
		var tooMany *ErrTooManyStreams
		if isTooManyStreams(err, &tooMany) {
			pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeRateLimitExceeded, "too many SSE streams"))
			return
		}
		writeSSEError(w, pkgerrors.CodeSSEUnavailable, "failed to subscribe to SSE channel")
		return
	}
	defer cfg.Broker.Unsubscribe(sub)

	if cfg.ActiveConnections != nil {
		cfg.ActiveConnections.Inc()
		defer cfg.ActiveConnections.Dec()
	}

	keepAlive := keepAliveInterval(cfg.KeepAlive)

	// Establish the live-only baseline before advertising readiness. Otherwise
	// a client could append after receiving : connected and have that row
	// incorrectly swallowed by a later head read. Subscribe first to retain
	// every wakeup after this baseline; polling repairs any missing wakeups.
	if cfg.Durable != nil {
		if err := cfg.Durable.initialize(r.WithContext(baselineCtx)); err != nil {
			if refuseRevoked() {
				return
			}
			writeSSEError(w, pkgerrors.CodeSSEUnavailable, "failed to initialize durable SSE stream")
			return
		}
	}

	if refuseRevoked() {
		return
	}

	// Write SSE response headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	// Send a body frame immediately. Some Fetch implementations do not resolve
	// the response from headers alone, even after Flush, which can deadlock a
	// client that waits for the stream before triggering the state transition.
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	if cfg.Durable != nil {
		serveDurableBroker(w, r, flusher, cfg, sub.Events(), revoked, keepAlive)
		return
	}
	if cfg.OnConnect != nil {
		cfg.OnConnect(w, r, flusher)
	}
	ticker := time.NewTicker(keepAlive)
	defer ticker.Stop()
	for {
		select {
		case ev := <-revoked:
			// The authorization behind this stream is gone: tell the client
			// why and end the stream. The client must not reconnect with the
			// same credential.
			data, _ := json.Marshal(ev)
			_, _ = fmt.Fprint(w, FormatEvent(Event{Type: RevokedEventType, Data: string(data)}))
			flusher.Flush()
			return
		case event, ok := <-sub.Events():
			if !ok {
				return
			}
			var eventID string
			if cfg.FormatEventID != nil {
				eventID = cfg.FormatEventID(event.Data)
			}
			eventType := cfg.EventType
			if eventType == "" {
				eventType = event.Type
			}
			evt := Event{
				ID:   eventID,
				Type: eventType,
				Data: event.Data,
			}
			_, _ = fmt.Fprint(w, FormatEvent(evt))
			flusher.Flush()
		case <-ticker.C:
			_, _ = fmt.Fprintf(w, ": keep-alive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

// isTooManyStreams reports whether err is an *ErrTooManyStreams and sets *out.
func isTooManyStreams(err error, out **ErrTooManyStreams) bool {
	if e, ok := err.(*ErrTooManyStreams); ok {
		*out = e
		return true
	}
	return false
}

// writeSSEError writes a refused stream as the ONE error envelope plue
// answers with.
//
// It used to hand-roll `{"message":…,"errors":[…]}` with `errors` as an array
// of strings. APIError also has an `errors` key, and there it is an array of
// {resource, field, code} objects — so the two shapes disagreed about the type
// of a field with the same name on the same API, and a generated client could
// only be right about one of them. Nothing needed the duplicate sentence, so
// the key is gone rather than retyped.
func writeSSEError(w http.ResponseWriter, code pkgerrors.Code, message string) {
	pkgerrors.WriteError(w, pkgerrors.New(code, message))
}
