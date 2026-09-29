package routes

import (
	"context"
	"errors"
	"io"
	"sync"

	gossh "golang.org/x/crypto/ssh"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// runtimeTerminalBackend adapts the shared PTY stream to the existing durable
// terminal manager. This keeps replay buffering, reconnects, fanout, limits,
// activity refresh, and revocation identical to the hosted SSH path.
type runtimeTerminalBackend struct {
	terminal  workspaceapi.Terminal
	cancel    context.CancelFunc
	done      chan error
	once      sync.Once
	closeOnce sync.Once
	closeErr  error
	stderrR   *io.PipeReader
	stderrW   *io.PipeWriter
}

func newRuntimeTerminalBackend(terminal workspaceapi.Terminal, cancel context.CancelFunc) (terminalSSHClient, terminalSSHSession, error) {
	if terminal == nil {
		cancel()
		return nil, nil, errors.New("workspace runtime returned a nil terminal")
	}
	stderrR, stderrW := io.Pipe()
	backend := &runtimeTerminalBackend{terminal: terminal, cancel: cancel, done: make(chan error, 1), stderrR: stderrR, stderrW: stderrW}
	return backend, backend, nil
}

func (b *runtimeTerminalBackend) NewSession() (*gossh.Session, error) {
	return nil, errors.New("runtime terminal does not create SSH sessions")
}

func (b *runtimeTerminalBackend) SendRequest(string, bool, []byte) (bool, []byte, error) {
	return true, nil, nil
}

func (b *runtimeTerminalBackend) StdinPipe() (io.WriteCloser, error) {
	return runtimeTerminalWriter{Writer: b.terminal}, nil
}

func (b *runtimeTerminalBackend) StdoutPipe() (io.Reader, error) {
	return &runtimeTerminalReader{backend: b}, nil
}

func (b *runtimeTerminalBackend) StderrPipe() (io.Reader, error) { return b.stderrR, nil }

func (b *runtimeTerminalBackend) RequestPty(_ string, height, width int, _ gossh.TerminalModes) error {
	return b.terminal.Resize(context.Background(), terminalDimension(width), terminalDimension(height))
}

func (b *runtimeTerminalBackend) Shell() error { return nil }

func (b *runtimeTerminalBackend) Start(string) error {
	return errors.New("runtime terminal does not start a second command")
}

func (b *runtimeTerminalBackend) WindowChange(height, width int) error {
	return b.terminal.Resize(context.Background(), terminalDimension(width), terminalDimension(height))
}

func (b *runtimeTerminalBackend) Wait() error { return <-b.done }

func (b *runtimeTerminalBackend) Close() error {
	b.closeOnce.Do(func() {
		b.cancel()
		b.closeErr = b.terminal.Close()
		b.finish(b.closeErr)
	})
	return b.closeErr
}

func (b *runtimeTerminalBackend) finish(err error) {
	b.once.Do(func() {
		_ = b.stderrW.Close()
		b.done <- err
		close(b.done)
	})
}

type runtimeTerminalReader struct{ backend *runtimeTerminalBackend }

func (r *runtimeTerminalReader) Read(buffer []byte) (int, error) {
	n, err := r.backend.terminal.Read(buffer)
	if err != nil {
		r.backend.finish(err)
	}
	return n, err
}

type runtimeTerminalWriter struct{ io.Writer }

func (runtimeTerminalWriter) Close() error { return nil }

func terminalDimension(value int) uint16 {
	if value <= 0 {
		return 1
	}
	if value > int(^uint16(0)) {
		return ^uint16(0)
	}
	return uint16(value)
}

var _ terminalSSHClient = (*runtimeTerminalBackend)(nil)
var _ terminalSSHSession = (*runtimeTerminalBackend)(nil)
