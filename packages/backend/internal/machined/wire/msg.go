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
