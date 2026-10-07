package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"golang.org/x/crypto/ssh"
)

// frameBytes encodes numeric arrays, matching Rust Vec<u8>, rather than Go's
// default base64 encoding. Decode refuses non-byte values before dispatch.
type frameBytes []uint16

func (b *frameBytes) UnmarshalJSON(body []byte) error {
	// A null element must never become a zero byte (encoding/json's default
	// for numeric slices). Decode the same non-null integer domain as Rust.
	var values []*uint16
	if err := json.Unmarshal(body, &values); err != nil {
		return err
	}
	if len(values) == 0 || len(values) > 8192 {
		return errors.New("invalid data size")
	}
	data := make(frameBytes, len(values))
	for i, value := range values {
		if value == nil || *value > 255 {
			return errors.New("invalid byte")
		}
		data[i] = *value
	}
	*b = data
	return nil
}

type frame struct {
	Type   string     `json:"type"`
	Stream *uint8     `json:"stream,omitempty"`
	Data   frameBytes `json:"bytes,omitempty"`
	Credit *uint32    `json:"-"`
	Code   *uint8     `json:"code,omitempty"`
	Name   string     `json:"name,omitempty"`
	Core   *bool      `json:"core,omitempty"`
	Cols   *uint16    `json:"cols,omitempty"`
	Rows   *uint16    `json:"rows,omitempty"`
}

func ptr[T any](v T) *T { return &v }
func readFrame(r io.Reader) (frame, error) {
	var f frame
	var length uint32
	if err := binary.Read(r, binary.BigEndian, &length); err != nil {
		return f, err
	}
	if length == 0 || length > 65536 {
		return f, errors.New("invalid frame length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return f, err
	}
	// Decode keys individually: encoding/json's map decoding silently keeps
	// the last duplicate, unlike the Rust tagged-frame decoder.
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return f, errors.New("invalid frame object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return f, err
		}
		key, ok := token.(string)
		if !ok {
			return f, errors.New("invalid frame key")
		}
		if _, duplicate := fields[key]; duplicate {
			return f, errors.New("duplicate frame field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return f, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return f, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return f, errors.New("trailing frame data")
	}
	if err := json.Unmarshal(fields["type"], &f.Type); err != nil {
		return f, err
	}
	allowed := map[string]bool{"type": true}
	var required []string
	switch f.Type {
	case "data":
		required = []string{"stream", "bytes"}
	case "eof":
		required = []string{"stream"}
	case "window":
		required = []string{"bytes"}
	case "exit":
		required = []string{"code"}
	case "exit_signal":
		required = []string{"name", "core"}
	case "close":
	default:
		return f, errors.New("unexpected guest frame")
	}
	for _, key := range required {
		allowed[key] = true
		if _, ok := fields[key]; !ok {
			return f, errors.New("missing frame field")
		}
	}
	for key := range fields {
		if !allowed[key] {
			return f, errors.New("unknown frame field")
		}
	}
	if f.Type == "window" {
		var credit uint32
		if err := json.Unmarshal(fields["bytes"], &credit); err != nil || credit == 0 || credit > 262144 {
			return f, errors.New("invalid credit")
		}
		f.Credit = &credit
		return f, nil
	}
	if err := json.Unmarshal(body, &f); err != nil {
		return f, err
	}
	if (f.Type == "data" || f.Type == "eof") && f.Stream == nil {
		return f, errors.New("missing stream")
	}
	if f.Stream != nil && *f.Stream > 2 {
		return f, errors.New("invalid stream")
	}
	if f.Type == "data" {
		if len(f.Data) == 0 || len(f.Data) > 8192 {
			return f, errors.New("invalid data size")
		}
		for _, b := range f.Data {
			if b > 255 {
				return f, errors.New("invalid byte")
			}
		}
	}
	if f.Type == "exit" && f.Code == nil {
		return f, errors.New("missing exit code")
	}
	if f.Type == "exit_signal" && (f.Core == nil || !validSignal(f.Name)) {
		return f, errors.New("invalid signal")
	}
	return f, nil
}

type frameWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (w *frameWriter) write(value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := binary.Write(w.w, binary.BigEndian, uint32(len(body))); err != nil {
		return err
	}
	_, err = io.Copy(w.w, bytes.NewReader(body))
	return err
}

// The installed provider opens an authenticated guest session over the real
// relay and returns its stream. This seam cannot select a host executable.
type sessionOpener func(*open) (io.ReadWriteCloser, error)

func serveSession(ch ssh.Channel, requests <-chan *ssh.Request, openGuest sessionOpener) error {
	defer ch.Close()
	if openGuest == nil {
		return errAuthority
	}
	var mapper requestMapper
	for request := range requests {
		spec, _, err := mapper.request(request.Type, request.Payload)
		if err != nil {
			request.Reply(false, nil)
			continue
		}
		if spec == nil {
			request.Reply(true, nil)
			continue
		}
		stream, err := openGuest(spec)
		if err != nil {
			request.Reply(false, nil)
			return err
		}
		request.Reply(true, nil)
		return pumpSession(ch, requests, stream, &mapper)
	}
	return nil
}

func pumpSession(ch ssh.Channel, requests <-chan *ssh.Request, stream io.ReadWriteCloser, mapper *requestMapper) error {
	writer := &frameWriter{w: stream}
	var mu sync.Mutex
	condition := sync.NewCond(&mu)
	credit, stopped := uint32(262144), false
	done := make(chan struct{})
	defer func() {
		mu.Lock()
		stopped = true
		condition.Broadcast()
		mu.Unlock()
		close(done)
		stream.Close()
		ch.Close() // releases a blocked SSH input read or output write
	}()
	inputErrors := make(chan error, 1)
	go func() {
		buffer := make([]byte, 8192)
		for {
			mu.Lock()
			for credit == 0 && !stopped {
				condition.Wait()
			}
			if stopped {
				mu.Unlock()
				return
			}
			size := min(uint32(len(buffer)), credit)
			mu.Unlock()
			n, err := ch.Read(buffer[:size])
			if n > 0 {
				mu.Lock()
				credit -= uint32(n)
				mu.Unlock()
				data := make(frameBytes, n)
				for i, b := range buffer[:n] {
					data[i] = uint16(b)
				}
				if writeErr := writer.write(frame{Type: "data", Stream: ptr(uint8(0)), Data: data}); writeErr != nil {
					inputErrors <- writeErr
					stream.Close()
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					err = writer.write(frame{Type: "eof", Stream: ptr(uint8(0))})
				}
				if err != nil {
					inputErrors <- err
					stream.Close()
				}
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case <-done:
				return
			case request, ok := <-requests:
				if !ok {
					// SSH CLOSE (unlike EOF) ends the transport even when the
					// guest produces no output. Leave lingering children to the
					// broker; closing this stream must not mean kill_sessions.
					stream.Close()
					return
				}
				_, raw, err := mapper.request(request.Type, request.Payload)
				if err == nil && len(raw) > 0 {
					err = writer.write(json.RawMessage(raw))
				}
				request.Reply(err == nil, nil)
				if err != nil && len(raw) > 0 {
					stream.Close()
					return
				}
			}
		}
	}()
	outputCredit := uint32(262144)
	eof := [3]bool{}
	for {
		f, err := readFrame(stream)
		if err != nil {
			select {
			case inputErr := <-inputErrors:
				return inputErr
			default:
				return err
			}
		}
		switch f.Type {
		case "window":
			mu.Lock()
			if *f.Credit > 262144-credit {
				mu.Unlock()
				return errors.New("excess input credit")
			}
			credit += *f.Credit
			condition.Broadcast()
			mu.Unlock()
		case "data":
			if *f.Stream == 0 || eof[*f.Stream] || uint32(len(f.Data)) > outputCredit {
				return errors.New("invalid output sequence or credit")
			}
			outputCredit -= uint32(len(f.Data))
			data := make([]byte, len(f.Data))
			for i, b := range f.Data {
				data[i] = byte(b)
			}
			var destination io.Writer = ch
			if *f.Stream == 2 {
				destination = ch.Stderr()
			}
			// SSH's bounded channel window blocks this write when its peer stalls.
			if _, err := io.Copy(destination, bytes.NewReader(data)); err != nil {
				return err
			}
			if err := writer.write(map[string]any{"type": "window", "bytes": len(data)}); err != nil {
				return err
			}
			outputCredit += uint32(len(data))
		case "eof":
			if *f.Stream == 0 || eof[*f.Stream] {
				return errors.New("invalid output EOF")
			}
			eof[*f.Stream] = true
			if eof[1] && (mapper.kind == "pty" || mapper.kind == "tcp" || eof[2]) {
				if err := ch.CloseWrite(); err != nil {
					return err
				}
			}
		case "exit", "exit_signal":
			code, signal, core := uint8(0), "", false
			if f.Code != nil {
				code = *f.Code
			}
			if f.Core != nil {
				signal, core = f.Name, *f.Core
			}
			kind, payload, err := exitRequest(code, signal, core)
			if err != nil {
				return err
			}
			if _, err := ch.SendRequest(kind, false, payload); err != nil {
				return err
			}
			return writer.write(frame{Type: "close"})
		case "close":
			return nil
		}
	}
}

// Called only after the installed authority authenticates the fixed Ben key.
// Global requests (including tcpip-forward) and agent channels are refused.
func serveChannels(channels <-chan ssh.NewChannel, requests <-chan *ssh.Request, openGuest sessionOpener) {
	go func() {
		for request := range requests {
			request.Reply(false, nil)
		}
	}()
	for incoming := range channels {
		if openGuest == nil {
			incoming.Reject(ssh.ConnectionFailed, "guest unavailable")
			continue
		}
		switch incoming.ChannelType() {
		case "session":
			if len(incoming.ExtraData()) != 0 {
				incoming.Reject(ssh.Prohibited, "invalid session")
				continue
			}
			ch, requests, err := incoming.Accept()
			if err != nil {
				continue
			}
			go serveSession(ch, requests, openGuest)
		case "direct-tcpip":
			spec, err := directTCP(incoming.ExtraData())
			if err != nil {
				incoming.Reject(ssh.Prohibited, "invalid loopback target")
				continue
			}
			stream, err := openGuest(spec)
			if err != nil {
				incoming.Reject(ssh.ConnectionFailed, "guest unavailable")
				continue
			}
			ch, requests, err := incoming.Accept()
			if err != nil {
				stream.Close()
				continue
			}
			go func() {
				defer ch.Close()
				pumpSession(ch, requests, stream, &requestMapper{kind: "tcp", started: true})
			}()
		default:
			incoming.Reject(ssh.Prohibited, "unsupported channel")
		}
	}
}
