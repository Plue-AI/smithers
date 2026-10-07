package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// Disposable owner-only relay fault injection. Member SSH requests cannot
// reach it. It closes actual DialWorkspacePort transports, never a test shim.
type relayFaults struct {
	mu          sync.Mutex
	deniedUntil time.Time
	connections map[*faultConnection]struct{}
	next        string
}
type faultConnection struct {
	net.Conn
	owner         *relayFaults
	once          sync.Once
	mode          string
	readBuffer    []byte
	writeBuffer   []byte
	initialWindow bool
}

func (c *faultConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.owner.mu.Lock(); delete(c.owner.connections, c); c.owner.mu.Unlock() })
	return err
}
func (f *relayFaults) admit(connection net.Conn) (net.Conn, error) {
	if f == nil {
		return connection, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if time.Now().Before(f.deniedUntil) {
		connection.Close()
		return nil, errors.New("reference relay cut active")
	}
	if f.connections == nil {
		f.connections = make(map[*faultConnection]struct{})
	}
	owned := &faultConnection{Conn: connection, owner: f, mode: f.next}
	f.next = ""
	f.connections[owned] = struct{}{}
	return owned, nil
}
func (f *relayFaults) cut(duration time.Duration) {
	f.mu.Lock()
	f.deniedUntil = time.Now().Add(duration)
	owned := make([]*faultConnection, 0, len(f.connections))
	for connection := range f.connections {
		owned = append(owned, connection)
	}
	f.mu.Unlock()
	for _, connection := range owned {
		connection.Close()
	}
}

// Arm exactly one subsequent authenticated relay. Only protected owner control
// can select a fault; attach transports are never faulted again automatically.
func (f *relayFaults) arm(mode string) error {
	if mode != "lost-window" && mode != "delivered-eof" {
		return errors.New("unknown relay fault")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.next != "" {
		return errors.New("relay fault already armed")
	}
	f.next = mode
	return nil
}
func (c *faultConnection) Read(p []byte) (int, error) {
	if c.mode != "lost-window" || len(p) == 0 {
		return c.Conn.Read(p)
	}
	if len(c.readBuffer) == 0 {
		var header [4]byte
		if _, err := io.ReadFull(c.Conn, header[:]); err != nil {
			return 0, err
		}
		length := binary.BigEndian.Uint32(header[:])
		if length == 0 || length > 65536 {
			c.Close()
			return 0, errors.New("invalid fault transport frame")
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(c.Conn, body); err != nil {
			return 0, err
		}
		var frame struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(body, &frame) == nil && frame.Type == "window" {
			if c.initialWindow {
				c.Close()
				return 0, io.EOF
			}
			c.initialWindow = true
		}
		c.readBuffer = append(header[:], body...)
	}
	n := copy(p, c.readBuffer)
	c.readBuffer = c.readBuffer[n:]
	return n, nil
}
func (c *faultConnection) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if c.mode != "delivered-eof" || err != nil {
		return n, err
	}
	c.writeBuffer = append(c.writeBuffer, p[:n]...)
	for len(c.writeBuffer) >= 4 {
		length := int(binary.BigEndian.Uint32(c.writeBuffer[:4]))
		if length == 0 || length > 65536 {
			c.Close()
			return n, errors.New("invalid fault transport frame")
		}
		if len(c.writeBuffer) < length+4 {
			break
		}
		var frame struct {
			Type   string `json:"type"`
			Stream *uint8 `json:"stream"`
		}
		body := c.writeBuffer[4 : length+4]
		if json.Unmarshal(body, &frame) == nil && frame.Type == "eof" && frame.Stream != nil && *frame.Stream == 0 {
			// The bytes reached the relay, but the caller sees failure. Guest delivery
			// is intentionally ambiguous; only the attach snapshot can resolve it.
			c.Close()
			return n, io.ErrUnexpectedEOF
		}
		c.writeBuffer = c.writeBuffer[length+4:]
	}
	return n, nil
}
