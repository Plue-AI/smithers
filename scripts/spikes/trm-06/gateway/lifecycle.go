package main

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// revocationRequest is an install-owned operation, never an SSH request. Its
// reply reports the actual guest drain, rather than listener cancellation.
type revocationRequest struct{ reply chan error }

// serveGateway composes the existing SSH listener with the provider's real
// relay revocation. The provider owns this channel and supplies r.revoke; no
// credential, path or caller-selected user comes from the member connection.
// First revocation permanently stops this prototype's admission and closes all
// SSH sockets. A new run requires fresh installed-provider authorization.
func serveGateway(ctx context.Context, listener net.Listener, authorityFor func(context.Context) listenerAuthority,
	revoke func(context.Context) error, requests <-chan revocationRequest) error {
	if revoke == nil || requests == nil || authorityFor == nil {
		listener.Close()
		return errAuthority
	}
	serving, cancel := context.WithCancel(ctx)
	defer cancel()
	authority := authorityFor(serving)
	if authority.hostKey == nil || authority.benKey == nil || authority.openGuest == nil {
		listener.Close()
		return errAuthority
	}
	var admission sync.Mutex
	var opening sync.WaitGroup
	accepting := true
	openGuest := authority.openGuest
	authority.openGuest = func(spec *open) (io.ReadWriteCloser, error) {
		admission.Lock()
		if !accepting {
			admission.Unlock()
			return nil, errAuthority
		}
		opening.Add(1)
		admission.Unlock()
		defer opening.Done()
		return openGuest(spec)
	}
	served := make(chan error, 1)
	go func() { served <- serveListener(serving, listener, authority) }()
	select {
	case err := <-served:
		return err
	case request, ok := <-requests:
		if !ok {
			cancel()
			<-served
			return errors.New("installed revocation control closed")
		}
		// Close admission before issuing kill_sessions so channels cannot
		// race a successful drain and create a new member process afterward.
		draining, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		admission.Lock()
		accepting = false
		admission.Unlock()
		cancel()
		// Context cancellation owns every accepted socket. Wait until those
		// channel workers stop before beginning the final guest drain.
		stopped := make(chan struct{})
		go func() { <-served; opening.Wait(); close(stopped) }()
		var err error
		select {
		case <-stopped:
			err = revoke(draining)
		case <-draining.Done():
			err = draining.Err()
		}
		// A caller disappearing cannot stall completion or shutdown.
		if request.reply != nil {
			select {
			case request.reply <- err:
			default:
			}
		}
		return err
	}
}
