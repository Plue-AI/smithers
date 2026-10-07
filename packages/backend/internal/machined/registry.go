// Package machined owns host-side boot and connection admission. It is not
// mounted until the ADR 0004 codec and production daemon are available.
package machined

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"sync"
)

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrNotReady     = errors.New("not_ready")
)

// Registry replaces the reporter's connectionless admission model. The reporter
// cannot authenticate a boot or fence an old connection's reconciliation.
// The zero value is usable; host restart requires fresh boot registration.
type Registry struct {
	identities     SessionIdentities
	mu             sync.Mutex
	closed         bool
	branches       map[string]*boot
	boots          map[[16]byte]*boot
	rosterSync     func(context.Context, string) error
	objects        ObjectImporter
	objectExporter ObjectExporter
	// Consumer cancellation cannot wait for mu: an in-flight writer holds
	// that fence until its cancelled transaction rolls back.
	eventsMu      sync.Mutex
	eventsClosing bool
	events        *eventConsumer
}

type boot struct {
	branch, machine string
	id              [16]byte
	credential      [32]byte
	secret          [32]byte
	link            *Link
	connection      *Connection
	nextObject      uint32
	wakeGate        chan struct{}
}

// Connection is an authenticated lease, not a wire frame. Only the ADR 0004
// adapter may admit a stream, after verifying the nonce proof. Closing a
// superseded stream never requires waiting for its reader or silence timeout.
type Connection struct {
	registry  *Registry
	boot      *boot
	stream    io.Closer
	ready     bool // protected by registry.mu
	closeOnce sync.Once
	closeErr  error
}

// BindBoot consumes host-authoritative branch/machine bindings and the newly
// minted machine credential. It must run before planting; it never mints a
// person token. Reusing a boot id is refused, including after revocation.
// The old credential is revoked atomically before the new one is admitted.
func (r *Registry) BindBoot(branch, machine string, id [16]byte, credential []byte) error {
	if branch == "" || machine == "" || id == ([16]byte{}) || len(credential) == 0 || len(credential) > 1024 {
		return ErrUnauthorized
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return ErrNotReady
	}
	if r.branches == nil {
		r.branches = make(map[string]*boot)
		r.boots = make(map[[16]byte]*boot)
	}
	if _, exists := r.boots[id]; exists {
		r.mu.Unlock()
		return ErrUnauthorized
	}
	var old *Connection
	if previous := r.branches[branch]; previous != nil {
		old = previous.connection
		previous.connection = nil
	}
	b := &boot{branch: branch, machine: machine, id: id, credential: sha256.Sum256(credential), wakeGate: make(chan struct{}, 1)}
	r.branches[branch], r.boots[id] = b, b
	r.mu.Unlock()
	if old != nil {
		_ = old.closeStream()
	}
	return nil
}

// Close fences every boot before closing transport streams. A reader exiting
// during shutdown cannot restore authority or evict a replacement registry.
func (r *Registry) Close() error {
	r.eventsMu.Lock()
	r.eventsClosing = true
	consumer := r.events
	r.eventsMu.Unlock()
	if consumer != nil {
		consumer.cancel()
	}
	r.mu.Lock()
	r.closed = true
	var connections []*Connection
	for _, b := range r.branches {
		if b.connection != nil {
			connections = append(connections, b.connection)
			b.connection = nil
		}
	}
	clear(r.branches)
	r.mu.Unlock()
	var errs []error
	for _, c := range connections {
		errs = append(errs, c.closeStream())
	}
	if consumer != nil {
		consumer.stop()
	}
	return errors.Join(errs...)
}

// Admit is called only after the wire handshake verifies the host nonce proof.
// It compares the credential against the boot's host binding; no branch or
// machine identity supplied by a frame is accepted. On refusal only the
// newcomer closes. Every successful admission requires wake reconciliation.
func (r *Registry) Admit(id [16]byte, credential []byte, stream io.Closer) (*Connection, error) {
	if stream == nil {
		return nil, ErrUnauthorized
	}
	digest := sha256.Sum256(credential)
	r.mu.Lock()
	b := r.boots[id]
	if b == nil || r.branches[b.branch] != b || len(credential) == 0 || len(credential) > 1024 || subtle.ConstantTimeCompare(digest[:], b.credential[:]) != 1 {
		r.mu.Unlock()
		_ = stream.Close()
		return nil, ErrUnauthorized
	}
	old := b.connection
	c := &Connection{registry: r, boot: b, stream: stream}
	b.connection = c
	r.mu.Unlock()
	if old != nil {
		_ = old.closeStream()
	}
	return c, nil
}

// Reconciled is called only after object-stream close, successful
// wake_reconcile and status.ready. An old reply cannot admit a new connection.
func (c *Connection) Reconciled() error {
	r := c.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if !c.current() {
		return ErrUnauthorized
	}
	c.ready = true
	return nil
}

// RequireReady fences reads, writes, captures and sessions to the authenticated
// branch. Request authorization remains the production authorizer's job.
func (c *Connection) RequireReady(branch string) error {
	if c == nil || c.registry == nil || c.boot == nil {
		return ErrUnauthorized
	}
	r := c.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if branch != c.boot.branch || !c.current() {
		return ErrUnauthorized
	}
	if !c.ready {
		return ErrNotReady
	}
	return nil
}

func (c *Connection) current() bool {
	return c.registry.branches[c.boot.branch] == c.boot && c.boot.connection == c
}

// Close removes only this lease, so an old reader exiting cannot evict its
// replacement. Network cleanup is outside the registry lock.
func (c *Connection) Close() error {
	r := c.registry
	r.mu.Lock()
	if c.boot.connection == c {
		c.boot.connection = nil
	}
	r.mu.Unlock()
	return c.closeStream()
}

func (c *Connection) closeStream() error {
	c.closeOnce.Do(func() { c.closeErr = c.stream.Close() })
	return c.closeErr
}

// PresenceScope is a host-minted boot identity for session lease fencing.
// It exposes no credential and refuses stale or unreconciled connections.
func (c *Connection) PresenceScope(branch string) (string, error) {
	if err := c.RequireReady(branch); err != nil {
		return "", err
	}
	return hex.EncodeToString(c.boot.id[:]), nil
}

// BindRosterSync installs the host's authoritative roster reconciliation. It
// runs on every handshake, even when the boot and its processes survived.
func (r *Registry) BindRosterSync(syncRoster func(context.Context, string) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rosterSync = syncRoster
}

// ConnectedBranches includes connections still reconciling. A disconnected
// branch receives its current roster at its next admission instead.
func (r *Registry) ConnectedBranches() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	branches := make([]string, 0, len(r.branches))
	for branch, boot := range r.branches {
		if boot.connection != nil {
			branches = append(branches, branch)
		}
	}
	return branches
}

// RequireMachine fences a precommitted attribution reference to the machine
// lineage that will receive it. Boot identity is immutable after registration.
func (c *Connection) RequireMachine(branch, machine string) error {
	if err := c.RequireReady(branch); err != nil {
		return err
	}
	if c.boot.machine != machine {
		return ErrUnauthorized
	}
	return nil
}

// Machine returns the immutable host-admitted machine scope.
func (c *Connection) Machine() string { return c.boot.machine }
