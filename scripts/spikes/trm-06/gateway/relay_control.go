package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// The installed provider owns mutual boot authentication. SSH callers cannot
// supply its credentials, workspace selector or a direct supervisor address.
type bootAuthenticator func(context.Context, net.Conn) error

type relayControl struct {
	runtime      *microsandbox.Runtime
	workspaceID  string
	authenticate bootAuthenticator
}

func (r relayControl) connect(ctx context.Context) (net.Conn, error) {
	if r.authenticate == nil {
		return nil, errAuthority
	}
	connection, err := relay(ctx, r.runtime, r.workspaceID)
	if err != nil {
		return nil, err
	}
	if err = r.authenticate(ctx, connection); err != nil {
		connection.Close()
		return nil, err
	}
	return connection, nil
}
func (r relayControl) opener(ctx context.Context) sessionOpener {
	return func(spec *open) (io.ReadWriteCloser, error) {
		connection, err := r.connect(ctx)
		if err != nil {
			return nil, err
		}
		// Authentication completes before any member argv or channel bytes cross
		// the relay. No root/user/env/cwd selector exists in this control envelope.
		modes := make(frameBytes, len(spec.Modes))
		for i, b := range spec.Modes {
			modes[i] = uint16(b)
		}
		request := struct {
			Type  string     `json:"type"`
			Kind  string     `json:"kind"`
			Argv  []string   `json:"argv,omitempty"`
			Cols  uint16     `json:"cols,omitempty"`
			Rows  uint16     `json:"rows,omitempty"`
			Port  uint16     `json:"port,omitempty"`
			Term  string     `json:"term,omitempty"`
			Modes frameBytes `json:"modes,omitempty"`
		}{"open_session", spec.Kind, spec.Argv, spec.Cols, spec.Rows, spec.Port, spec.Term, modes}
		reply, err := controlExchange(connection, request)
		if err != nil || reply.Session == "" {
			connection.Close()
			if err == nil {
				err = errors.New("missing owned session")
			}
			return nil, err
		}
		return newAttachedStream(connection, reply.Session, func() (net.Conn, error) { return r.connect(ctx) }), nil
	}
}
func (r relayControl) revoke(ctx context.Context) error {
	connection, err := r.connect(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	reply, err := controlExchange(connection, map[string]string{"type": "kill_sessions"})
	if err == nil && !reply.OK {
		return errors.New("guest revocation not confirmed")
	}
	return err
}

type controlReply struct {
	Session  string  `json:"session"`
	Received *uint64 `json:"received,omitempty"`
	Written  *uint64 `json:"written,omitempty"`
	InputEOF *bool   `json:"input_eof,omitempty"`
	OK       bool    `json:"ok,omitempty"`
	Class    string  `json:"class,omitempty"`
	Code     string  `json:"code,omitempty"`
}

func controlExchange(connection net.Conn, request any) (controlReply, error) {
	var reply controlReply
	connection.SetDeadline(time.Now().Add(10 * time.Second))
	defer connection.SetDeadline(time.Time{})
	if err := (&frameWriter{w: connection}).write(request); err != nil {
		return reply, err
	}
	var length uint32
	if err := binary.Read(connection, binary.BigEndian, &length); err != nil {
		return reply, err
	}
	if length == 0 || length > 4096 {
		return reply, errors.New("invalid control reply length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(connection, body); err != nil {
		return reply, err
	}
	// Control replies have a small, unambiguous shape. Reuse the strict object
	// parser for duplicate, unknown and trailing fields rather than json maps.
	if err := strictControlReply(body, &reply); err != nil {
		return reply, err
	}
	if reply.Code != "" || reply.Class != "" {
		return reply, errors.New("guest session operation refused")
	}
	return reply, nil
}

func strictControlReply(body []byte, reply *controlReply) error {
	var fields map[string]json.RawMessage
	// First reject duplicates with the decoder token stream.
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("invalid control reply")
	}
	fields = make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errors.New("invalid control key")
		}
		if _, exists := fields[key]; exists {
			return errors.New("duplicate control field")
		}
		switch key {
		case "session", "received", "written", "input_eof", "ok", "class", "code":
		default:
			return errors.New("unknown control field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("null control field")
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing control reply")
	}
	if err := json.Unmarshal(body, reply); err != nil {
		return err
	}
	// Open, attach, drain and typed refusal are mutually exclusive shapes.
	if reply.Session != "" {
		if len(reply.Session) != 18 || !strings.HasPrefix(reply.Session, "s-") {
			return errors.New("invalid session identity")
		}
		for _, c := range reply.Session[2:] {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return errors.New("invalid session identity")
			}
		}
		if reply.OK || reply.Code != "" || reply.Class != "" || (len(fields) != 1 && len(fields) != 4) {
			return errors.New("ambiguous control reply")
		}
		if len(fields) == 4 && (reply.Received == nil || reply.Written == nil || reply.InputEOF == nil || *reply.Written > *reply.Received) {
			return errors.New("invalid attach counters")
		}
	} else if reply.OK {
		if len(fields) != 1 {
			return errors.New("ambiguous drain reply")
		}
	} else if reply.Code == "" || reply.Class == "" || len(fields) != 2 {
		return errors.New("invalid refusal reply")
	}
	return nil
}
