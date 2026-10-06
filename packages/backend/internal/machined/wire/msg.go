package wire

// Method is the fixed ADR 0004 Call/Result discriminant.
type Method byte

const (
	Status Method = iota + 1
	ReadFile
	WriteFile
	Capture
	WakeReconcile
	OpenSession
	TCPConnect
	CloseSession
	KillSessions
	RegisterRun
	Rebase
	ReturnToItem
	OpenDoc
	CloseDoc
	AttachSession
	SetRoster
)

// ErrorCode is an RPC refusal, distinct from a framing ProtocolError.
type ErrorCode byte

const (
	Malformed ErrorCode = iota + 1
	UnsupportedMethod
	NotReady
	Stale
	NotFound
	InvalidPath
	NotRegular
	TooLarge
	Busy
	MovedOff
	Unauthorized
	Internal
)

// RequestFrame builds a host request and validates the method arguments before
// returning it. Arguments are ADR tagged fields, not a second envelope schema.
func RequestFrame(id uint32, method Method, arguments ...[]byte) (Frame, error) {
	f := Frame{Kind: Control, Payload: Union(1, Field(1, U32(id)), Field(2, Union(byte(method), arguments...)))}
	_, e := Encode(f)
	return f, e
}

// MalformedResponse preserves correlation when a well-framed request's body
// fails canonical decoding. Framing failures must still end the connection.
func MalformedResponse(id uint32, code ProtocolError) (Frame, error) {
	if code < UnknownMessage || code > BadValue {
		return Frame{}, BadValue
	}
	f := Frame{Kind: Control, Payload: Union(2, Field(1, U32(id)), Field(2, Union(255, Field(1, []byte{byte(Malformed)}), Field(6, []byte{byte(code)}))))}
	return f, nil
}

// Fields decodes a named ADR structure using the same schema as frame validation.
// Values retain their canonical primitive encoding and borrow data until the
// caller releases the frame. Unknown schemas and trailing bytes are refused.
func Fields(name string, data []byte) (map[byte][]byte, error) {
	schema, ok := structures[name]
	if !ok {
		return nil, BadValue
	}
	check := cursor{data}
	if err := check.value(name); err != nil {
		return nil, err
	}
	if len(check.b) != 0 {
		return nil, TrailingBytes
	}
	body := cursor{data[4:]}
	result := make(map[byte][]byte, len(schema))
	for len(body.b) > 0 {
		tag := body.b[0]
		body.b = body.b[1:]
		for _, field := range schema {
			if field.tag == tag {
				before := body.b
				if err := body.value(field.typ); err != nil {
					return nil, err
				}
				result[tag] = before[:len(before)-len(body.b)]
				break
			}
		}
	}
	return result, nil
}
