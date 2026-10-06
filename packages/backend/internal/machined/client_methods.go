package machined

import (
	"context"
	"crypto/sha256"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

type File struct {
	Content []byte
	Digest  [32]byte
	Mode    uint32
}
type Snapshot struct {
	Head, Tree [20]byte
	Flushed    uint16
}

func (c *Client) ReadFile(ctx context.Context, path string, at *[20]byte) (File, error) {
	fields := [][]byte{wire.Field(1, wire.String(path))}
	if at != nil {
		fields = append(fields, wire.Field(2, at[:]))
	}
	v, err := c.Call(ctx, wire.ReadFile, fields...)
	if err != nil {
		return File{}, err
	}
	f := File{Content: v.Fields[1].Data, Mode: uint32(v.Fields[3].Number)}
	copy(f.Digest[:], v.Fields[2].Data)
	if sha256.Sum256(f.Content) != f.Digest {
		c.fail(wire.BadValue)
		return File{}, wire.BadValue
	}
	return f, nil
}

// WriteFile's participant is the opaque authorizer-resolved principal. A nil
// base means absent; it never means an unconditional overwrite.
func (c *Client) WriteFile(ctx context.Context, path string, base *[32]byte, content, participant []byte) ([32]byte, error) {
	var digest [32]byte
	if len(participant) == 0 || len(participant) > 1024 {
		return digest, ErrUnauthorized
	}
	b := wire.Union(2)
	if base != nil {
		b = wire.Union(1, wire.Field(1, base[:]))
	}
	v, err := c.Call(ctx, wire.WriteFile, wire.Field(1, wire.String(path)), wire.Field(2, b), wire.Field(3, wire.Bytes(content)), wire.Field(4, wire.Union(1, wire.Field(1, wire.Bytes(participant)))))
	if err != nil {
		return digest, err
	}
	copy(digest[:], v.Fields[1].Data)
	if digest != sha256.Sum256(content) {
		c.fail(wire.BadValue)
		return [32]byte{}, wire.BadValue
	}
	return digest, nil
}
func (c *Client) Capture(ctx context.Context) (Snapshot, error) {
	v, err := c.Call(ctx, wire.Capture)
	if err != nil {
		return Snapshot{}, err
	}
	s := Snapshot{Flushed: uint16(v.Fields[3].Number)}
	copy(s.Head[:], v.Fields[1].Data)
	copy(s.Tree[:], v.Fields[2].Data)
	return s, nil
}
func (c *Client) CallSession(ctx context.Context, call SessionCall) (SessionResult, error) {
	var method wire.Method
	var fields [][]byte
	user := func(u *SessionUser) ([]byte, error) {
		if u == nil || !validUser(*u) {
			return nil, ErrUnauthorized
		}
		return wire.Struct(wire.Field(1, wire.String(u.Login)), wire.Field(2, wire.U32(u.UID))), nil
	}
	switch call.Method {
	case "open_session":
		method = wire.OpenSession
		u, err := user(call.User)
		if err != nil {
			return SessionResult{}, err
		}
		fields = [][]byte{wire.Field(1, u), wire.Field(2, []byte{byte(call.Kind)})}
		if len(call.Argv) > 65535 {
			return SessionResult{}, wire.BadValue
		}
		argv := wire.U16(uint16(len(call.Argv)))
		for _, a := range call.Argv {
			if !validString(a) {
				return SessionResult{}, wire.BadValue
			}
			argv = append(argv, wire.String(a)...)
		}
		fields = append(fields, wire.Field(3, argv))
		if call.Size != nil {
			fields = append(fields, wire.Field(4, wire.Struct(wire.Field(1, wire.U16(call.Size.Cols)), wire.Field(2, wire.U16(call.Size.Rows)))))
		}
	case "tcp_connect":
		method = wire.TCPConnect
		fields = [][]byte{wire.Field(1, wire.U16(call.Port))}
	case "close_session":
		method = wire.CloseSession
		fields = [][]byte{wire.Field(1, wire.U32(call.Session))}
	case "kill_sessions":
		method = wire.KillSessions
		if call.User != nil {
			u, err := user(call.User)
			if err != nil {
				return SessionResult{}, err
			}
			fields = [][]byte{wire.Field(1, wire.Union(1, wire.Field(1, u)))}
		} else {
			fields = [][]byte{wire.Field(1, wire.Union(2, wire.Field(1, wire.String(call.Run))))}
		}
	case "register_run":
		method = wire.RegisterRun
		fields = [][]byte{wire.Field(1, wire.String(call.Run)), wire.Field(2, wire.U32(call.Session))}
	case "attach_session":
		method = wire.AttachSession
		fields = [][]byte{wire.Field(1, wire.U32(call.Session)), wire.Field(2, wire.U64(call.Received))}
	default:
		return SessionResult{}, refused("unsupported", "unknown session method")
	}
	v, err := c.Call(ctx, method, fields...)
	if err != nil {
		return SessionResult{}, err
	}
	var result SessionResult
	switch method {
	case wire.OpenSession, wire.TCPConnect:
		result.Session = uint32(v.Fields[1].Number)
	case wire.KillSessions:
		result.Killed = uint16(v.Fields[1].Number)
	case wire.AttachSession:
		result.Received = v.Fields[1].Number
	}
	return result, nil
}

var _ SessionRPC = (*Client)(nil)
