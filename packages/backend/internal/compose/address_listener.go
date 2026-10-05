package compose

import (
	"net"
	"sync"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// networkListener serves the install's network bind (M-28) beside the
// loopback listener, which never closes (spec §16.3.1). A new bind listens
// before the previous one closes, so a change needs no restart.
type networkListener struct {
	// serve is the HTTP server's Serve; it returns when its listener closes.
	serve  func(net.Listener) error
	listen func(network, address string) (net.Listener, error)

	mu sync.Mutex
	ln net.Listener
}

// Listen serves address, or closes the network listener for an empty one.
func (l *networkListener) Listen(address string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	var next net.Listener
	if address != "" {
		ln, err := l.listen("tcp", address)
		if err != nil {
			return &services.InstallReadinessError{Code: "address_unavailable", Class: "user", Message: "Can't listen on " + address}
		}
		next = ln
		go func() { _ = l.serve(ln) }()
	}
	if l.ln != nil {
		_ = l.ln.Close()
	}
	l.ln = next
	return nil
}
