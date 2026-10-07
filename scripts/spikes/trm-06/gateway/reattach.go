package main

import (
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

type retainedInput struct {
	start uint64
	bytes frameBytes
}

// Frame-aware relay transport. This disposable attach snapshot adds written
// and input_eof: byte counts alone cannot recover a lost WINDOW or stdin EOF.
// The protocol amendment must be reviewed with the measured spike result.
type attachedStream struct {
	mu                         sync.Mutex
	send                       sync.Mutex
	reconnect                  sync.Mutex
	connection                 net.Conn
	dial                       func() (net.Conn, error)
	id                         string
	journal                    []retainedInput
	captured, credited, output uint64
	eof                        bool
	outputEOF                  [3]bool
	pending                    uint32
	closed                     bool
}

func newAttachedStream(connection net.Conn, id string, dial func() (net.Conn, error)) *attachedStream {
	return &attachedStream{connection: connection, id: id, dial: dial}
}
func (s *attachedStream) Read([]byte) (int, error)  { return 0, errors.New("use frame transport") }
func (s *attachedStream) Write([]byte) (int, error) { return 0, errors.New("use frame transport") }
func (s *attachedStream) Close() error {
	s.mu.Lock()
	s.closed = true
	connection := s.connection
	s.mu.Unlock()
	return connection.Close()
}
func (s *attachedStream) trim(received uint64) {
	for len(s.journal) > 0 && s.journal[0].start+uint64(len(s.journal[0].bytes)) <= received {
		s.journal = s.journal[1:]
	}
	if len(s.journal) > 0 && s.journal[0].start < received {
		n := received - s.journal[0].start
		s.journal[0].bytes = s.journal[0].bytes[n:]
		s.journal[0].start = received
	}
}
func (s *attachedStream) writeSessionFrame(value any) error {
	s.send.Lock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.send.Unlock()
		return io.ErrClosedPipe
	}
	connection := s.connection
	replayable := true
	if f, ok := value.(frame); ok {
		switch f.Type {
		case "data":
			if f.Stream == nil || *f.Stream != 0 || len(f.Data) == 0 || s.captured-s.credited+uint64(len(f.Data)) > 262144 {
				s.mu.Unlock()
				s.send.Unlock()
				return errors.New("invalid retained input")
			}
			s.journal = append(s.journal, retainedInput{s.captured, append(frameBytes(nil), f.Data...)})
			s.captured += uint64(len(f.Data))
		case "eof":
			s.eof = true
		case "close":
			replayable = false
		default:
			replayable = false
		}
	} else {
		// Relative output WINDOW is replaced by the attach output offset. Signals
		// and resizes have no acknowledgment offset and cannot safely be retried.
		if window, ok := value.(map[string]any); !ok || window["type"] != "window" {
			replayable = false
		}
	}
	s.mu.Unlock()
	err := (&frameWriter{w: connection}).write(value)
	s.send.Unlock()
	if err != nil && replayable {
		return s.restore(connection)
	}
	return err
}
func (s *attachedStream) readSessionFrame() (frame, error) {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return frame{}, io.ErrClosedPipe
		}
		if s.pending > 0 {
			credit := s.pending
			s.pending = 0
			s.mu.Unlock()
			return frame{Type: "window", Credit: ptr(credit)}, nil
		}
		connection := s.connection
		s.mu.Unlock()
		f, err := readFrame(connection)
		if err != nil {
			var networkError *net.OpError
			if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.As(err, &networkError) {
				return frame{}, err
			}
			if err = s.restore(connection); err != nil {
				return frame{}, err
			}
			continue
		}
		s.mu.Lock()
		if connection != s.connection {
			s.mu.Unlock()
			continue
		}
		switch f.Type {
		case "data":
			s.output += uint64(len(f.Data))
		case "window":
			if *f.Credit > 262144 || s.credited+uint64(*f.Credit) > s.captured {
				s.mu.Unlock()
				return frame{}, errors.New("invalid replay input credit")
			}
			s.credited += uint64(*f.Credit)
			s.trim(s.credited)
		case "eof":
			if s.outputEOF[*f.Stream] {
				s.mu.Unlock()
				continue
			}
			s.outputEOF[*f.Stream] = true
		}
		s.mu.Unlock()
		return f, nil
	}
}
func (s *attachedStream) restore(old net.Conn) error {
	s.reconnect.Lock()
	defer s.reconnect.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return io.ErrClosedPipe
	}
	if old != s.connection {
		s.mu.Unlock()
		return nil
	}
	output := s.output
	id := s.id
	s.mu.Unlock()
	old.Close()
	s.send.Lock()
	defer s.send.Unlock()
	until := time.Now().Add(25 * time.Second)
	backoff := 250 * time.Millisecond
	for {
		s.mu.Lock()
		closed := s.closed
		s.mu.Unlock()
		if closed {
			return io.ErrClosedPipe
		}
		connection, err := s.dial()
		if err == nil {
			reply, err := controlExchangeUntil(connection, map[string]any{"type": "attach_session", "id": id, "received": output}, minTime(until, time.Now().Add(10*time.Second)))
			if err != nil {
				connection.Close()
				return err
			}
			if reply.Session != id || reply.Received == nil || reply.Written == nil || reply.InputEOF == nil {
				connection.Close()
				return errors.New("missing attach snapshot")
			}
			s.mu.Lock()
			received, written := *reply.Received, *reply.Written
			if received > s.captured || written < s.credited || written > received || s.captured-received > 262144 || (len(s.journal) > 0 && received < s.journal[0].start) || (len(s.journal) == 0 && received < s.captured) {
				s.mu.Unlock()
				connection.Close()
				return errors.New("impossible attach counters")
			}
			pending := written - s.credited
			if pending > 262144 {
				s.mu.Unlock()
				connection.Close()
				return errors.New("excess attach credit")
			}
			s.credited = written
			s.pending += uint32(pending)
			s.trim(received)
			journal := append([]retainedInput(nil), s.journal...)
			eof := s.eof
			s.mu.Unlock()
			writer := &frameWriter{w: connection}
			for _, retained := range journal {
				if err = writer.write(frame{Type: "data", Stream: ptr(uint8(0)), Data: retained.bytes}); err != nil {
					break
				}
			}
			if err == nil && eof && !*reply.InputEOF {
				err = writer.write(frame{Type: "eof", Stream: ptr(uint8(0))})
			}
			if err != nil {
				connection.Close()
				return err
			}
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				connection.Close()
				return io.ErrClosedPipe
			}
			s.connection = connection
			s.mu.Unlock()
			return nil
		}
		if time.Now().Add(backoff).After(until) {
			return err
		}
		time.Sleep(backoff)
		backoff = min(backoff*2, 5*time.Second)
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
