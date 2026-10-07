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
	// Optional SSH listener follows the same owner-selected host, on SSH's port.
	sshServe   func(net.Listener) error
	sshPort    string
	sshLN      net.Listener
	sshAddress string

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
	}
	sshAddress := ""
	if address != "" && l.sshServe != nil {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			if next != nil {
				_ = next.Close()
			}
			return err
		}
		sshAddress = net.JoinHostPort(host, l.sshPort)
	}
	sshNext := l.sshLN
	if sshAddress != l.sshAddress {
		sshNext = nil
		if sshAddress != "" {
			ln, err := l.listen("tcp", sshAddress)
			if err != nil {
				if next != nil {
					_ = next.Close()
				}
				return &services.InstallReadinessError{Code: "address_unavailable", Class: "user", Message: "Can't listen on " + sshAddress}
			}
			sshNext = ln
			go func() { _ = l.sshServe(ln) }()
		}
		if l.sshLN != nil {
			_ = l.sshLN.Close()
		}
		l.sshLN, l.sshAddress = sshNext, sshAddress
	}
	if next != nil {
		go func() { _ = l.serve(next) }()
	}
	if l.ln != nil {
		_ = l.ln.Close()
	}
	l.ln = next
	return nil
}
