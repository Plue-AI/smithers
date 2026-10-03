package compose

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"sync"
	"syscall"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"golang.org/x/sys/unix"
)

// installHTTPListeners extends the existing server, not the process supervisor.
// It is composed only after the launcher/publication gates are available.
type installHTTPListeners struct {
	server   *http.Server
	loopback net.Listener
	network  net.Listener
	bind     string
	mu       sync.Mutex
}

// Both sockets opt into address sharing: wildcard binds otherwise conflict
// with the permanent loopback socket on macOS and Linux.
func listenInstall(ctx context.Context, address string) (net.Listener, error) {
	config := net.ListenConfig{Control: func(network, address string, raw syscall.RawConn) error {
		var optionErr error
		err := raw.Control(func(fd uintptr) {
			optionErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
			if optionErr == nil {
				optionErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
			}
		})
		if err != nil {
			return err
		}
		return optionErr
	}}
	return config.Listen(ctx, "tcp", address)
}
func newInstallHTTPListeners(server *http.Server, address string) (*installHTTPListeners, error) {
	loopback, err := listenInstall(context.Background(), address)
	if err != nil {
		return nil, err
	}
	listeners := &installHTTPListeners{server: server, loopback: loopback}
	go server.Serve(loopback)
	return listeners, nil
}

type installListenerTransition struct {
	owner    *installHTTPListeners
	prepared net.Listener
	bind     string
	done     bool
}

// Prepare serializes changes until Commit/Abort, preserving the old listener
// if opening a replacement fails or the settings transaction rolls back.
func (l *installHTTPListeners) Prepare(ctx context.Context, bind string) (services.ServingTransition, error) {
	l.mu.Lock()
	if err := ctx.Err(); err != nil {
		l.mu.Unlock()
		return nil, err
	}
	transition := &installListenerTransition{owner: l, bind: bind}
	if bind == l.bind {
		return transition, nil
	}
	if bind != "" {
		if net.ParseIP(bind) == nil {
			l.mu.Unlock()
			return nil, net.InvalidAddrError("invalid bind")
		}
		port := l.loopback.Addr().(*net.TCPAddr).Port
		listener, err := listenInstall(ctx, net.JoinHostPort(bind, strconv.Itoa(port)))
		if err != nil {
			l.mu.Unlock()
			return nil, err
		}
		transition.prepared = listener
		go l.server.Serve(listener)
	}
	return transition, nil
}
func (t *installListenerTransition) Commit() {
	if t.done {
		return
	}
	t.done = true
	defer t.owner.mu.Unlock()
	if t.bind == t.owner.bind {
		return
	}
	old := t.owner.network
	t.owner.network = t.prepared
	t.owner.bind = t.bind
	if old != nil {
		old.Close()
	}
}
func (t *installListenerTransition) Abort() {
	if t.done {
		return
	}
	t.done = true
	if t.prepared != nil {
		t.prepared.Close()
	}
	t.owner.mu.Unlock()
}
func (l *installHTTPListeners) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.network != nil {
		l.network.Close()
	}
	l.loopback.Close()
}
