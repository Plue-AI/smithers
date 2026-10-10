package machined

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// Exec adapts one admitted broker exec session whose stdout and stderr stay
// separate (ADR 0004 data fd 1 and 2). Output credit returns only after the
// consumer read the bytes. Unlike Terminal it never reattaches: a lost link
// ends the stream, and the caller starts a fresh process.
//
// The broker sends the exit status only after both outputs end, and it never
// closes an owner's stream itself: the session and its cgroup stay until Kill
// or Close. The exit frame is therefore the last frame Exec reads.
type Exec struct {
	sessions  *Sessions
	id        uint32
	stream    *SessionStream
	ctx       context.Context
	cancel    context.CancelFunc
	stdoutR   *io.PipeReader
	stdoutW   *io.PipeWriter
	stderrR   *io.PipeReader
	stderrW   *io.PipeWriter
	writeMu   sync.Mutex
	done      chan struct{}
	exit      error
	closeOnce sync.Once
	closeErr  error
}

// OpenExec starts argv as user through the broker without a PTY.
func (s *Sessions) OpenExec(ctx context.Context, user SessionUser, argv []string) (*Exec, error) {
	id, err := s.OpenSession(ctx, user, SessionExec, argv, nil)
	if err != nil {
		return nil, err
	}
	stream, err := s.Stream(ctx, id)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.CloseSession(cleanup, id)
		return nil, err
	}
	execCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	e := &Exec{sessions: s, id: id, stream: stream, ctx: execCtx, cancel: cancel, stdoutR: stdoutR, stdoutW: stdoutW, stderrR: stderrR, stderrW: stderrW, done: make(chan struct{})}
	go e.receive()
	return e, nil
}

// ID is the broker session number, for kill and presence.
func (e *Exec) ID() uint32 { return e.id }

// Stdout yields fd 1 until the broker's eof or the session's end.
func (e *Exec) Stdout() io.Reader { return e.stdoutR }

// Stderr yields fd 2; a consumer must drain it or stdout stalls behind it.
func (e *Exec) Stderr() io.Reader { return e.stderrR }

func (e *Exec) receive() {
	exit := error(io.ErrUnexpectedEOF)
	defer func() {
		e.exit = exit
		_ = e.stdoutW.CloseWithError(io.EOF)
		_ = e.stderrW.CloseWithError(io.EOF)
		close(e.done)
	}()
	for {
		frame, err := e.stream.Receive(e.ctx)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				exit = err
			}
			return
		}
		switch frame[0] {
		case 1:
			out := e.stdoutW
			if frame[1] == 2 {
				out = e.stderrW
			}
			// A closed reader discards the bytes; the credit still returns so
			// the broker can deliver the exit that follows.
			_, _ = out.Write(frame[2:])
			if n := len(frame) - 2; n > 0 {
				credit := []byte{6, 0, 0, 0, 0}
				binary.BigEndian.PutUint32(credit[1:], uint32(n))
				if err := e.stream.Send(e.ctx, credit); err != nil {
					exit = err
					return
				}
			}
		case 2:
			if frame[1] == 1 {
				_ = e.stdoutW.CloseWithError(io.EOF)
			} else if frame[1] == 2 {
				_ = e.stderrW.CloseWithError(io.EOF)
			}
		case 5:
			if frame[1] == 0 {
				exit = nil
				if code := int32(binary.BigEndian.Uint32(frame[2:])); code != 0 {
					exit = &ExitError{Code: code}
				}
			} else {
				exit = &ExitError{Signal: frame[2], Core: frame[3] != 0}
			}
			// No close follows an exit (#3761): waiting for one hung Wait.
			return
		case 7:
			return
		case 255:
			fields, err := wire.Fields("error", frame[1:])
			if err != nil {
				exit = err
				return
			}
			exit = &SessionError{Code: fmt.Sprintf("broker_%d", fields[1][0]), Detail: "session refused"}
			return
		}
	}
}

// Write sends stdin in frames of at most 64 KiB, waiting for input credit.
func (e *Exec) Write(src []byte) (int, error) {
	e.writeMu.Lock()
	defer e.writeMu.Unlock()
	sent := 0
	for len(src) != 0 {
		n := min(len(src), 65536)
		if err := e.stream.Send(e.ctx, append([]byte{1, 0}, src[:n]...)); err != nil {
			return sent, err
		}
		sent += n
		src = src[n:]
	}
	return sent, nil
}

// CloseWrite sends stdin eof; a stdio server exits on it.
func (e *Exec) CloseWrite() error {
	e.writeMu.Lock()
	defer e.writeMu.Unlock()
	return e.stream.Send(e.ctx, []byte{2, 0})
}

// Wait returns nil for exit 0, *ExitError for another status or a signal,
// and the transport error when the session ended without an exit. It returns
// at the exit status; the session stays open until Kill or Close.
func (e *Exec) Wait() error {
	<-e.done
	return e.exit
}

// Kill empties the session's cgroup, detached descendants included, then
// closes the stream. Closing alone never proves the command stopped.
func (e *Exec) Kill(ctx context.Context) error {
	_, err := e.sessions.KillSession(ctx, e.id)
	return errors.Join(err, e.Close())
}

// Close ends the stream and both readers.
func (e *Exec) Close() error {
	e.closeOnce.Do(func() {
		e.cancel()
		e.closeErr = e.stream.Close()
		_ = e.stdoutR.Close()
		_ = e.stderrR.Close()
	})
	return e.closeErr
}
