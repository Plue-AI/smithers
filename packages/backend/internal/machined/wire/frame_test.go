package wire

import (
	"bytes"
	"encoding/hex"
	"io"
	"os/exec"
	"strings"
	"testing"
)

func TestStdlibOnly(t *testing.T) {
	out, e := exec.Command("go", "list", "-deps", "-f", "{{if not .Standard}}{{.ImportPath}}{{end}}", ".").CombinedOutput()
	if e != nil {
		t.Fatal(e, string(out))
	}
	for _, line := range strings.Fields(string(out)) {
		if line != "github.com/smithersai/smithers/packages/backend/internal/machined/wire" {
			t.Fatalf("non-stdlib dependency %s", line)
		}
	}
}
func TestIndependentAck(t *testing.T) {
	want, _ := hex.DecodeString("000000100200000000030000000b0100000000000000070201")
	f := Frame{Kind: Events, Payload: Union(3, Field(1, U64(7)), Field(2, []byte{1}))}
	got, e := Encode(f)
	if e != nil || !bytes.Equal(got, want) {
		t.Fatal(e, hex.EncodeToString(got))
	}
}
func TestMAC(t *testing.T) {
	secret := []byte("secret")
	boot := bytes.Repeat([]byte{0x44}, 16)
	nonce := bytes.Repeat([]byte{0x33}, 32)
	want, _ := hex.DecodeString("9aa6c9a2700eaf0ab0273ca2e43138f0733aaca5d40ced66734236de8f1e8173")
	got := HostMAC(secret, boot, nonce)
	if !bytes.Equal(want, got[:]) {
		t.Fatalf("%x", got)
	}
	if !VerifyHostMAC(secret, boot, nonce, want) || VerifyHostMAC([]byte("other"), boot, nonce, want) {
		t.Fatal("proof identity")
	}
}

type headerOnly struct{ *bytes.Reader }

func (r headerOnly) Read(p []byte) (int, error) {
	if r.Len() == 0 {
		panic("payload read before bounds")
	}
	return r.Reader.Read(p)
}
func TestRefusalOrder(t *testing.T) {
	for _, tc := range []struct {
		kind           byte
		stream, length uint32
		err            error
	}{{99, 1, 9999999, UnknownKind}, {Control, 1, 9999999, BadStream}, {Control, 0, 1114113, FrameTooLarge}} {
		h := append(U32(tc.length), tc.kind)
		h = append(h, U32(tc.stream)...)
		if _, e := Read(headerOnly{bytes.NewReader(h)}); e != tc.err {
			t.Fatal(e)
		}
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(b []byte) (int, error) {
	if len(b) > 2 {
		b = b[:2]
	}
	return w.Buffer.Write(b)
}
func TestReadWrite(t *testing.T) {
	f := Unsupported(42)
	var w shortWriter
	if e := Write(&w, f); e != nil {
		t.Fatal(e)
	}
	got, e := Read(&w)
	if e != nil || !bytes.Equal(got.Payload, f.Payload) {
		t.Fatal(e)
	}
	if _, e = Read(bytes.NewReader(nil)); e != Truncated {
		t.Fatal(e)
	}
	if e = Write(io.Discard, Frame{Kind: 99}); e != UnknownKind {
		t.Fatal(e)
	}
}
func TestMessageBuilders(t *testing.T) {
	f, e := RequestFrame(42, Status)
	if e != nil {
		t.Fatal(e)
	}
	id, method, args, e := f.Request()
	if e != nil || id != 42 || method != 1 || !bytes.Equal(args, []byte{0, 0, 0, 0}) {
		t.Fatal(id, method, args, e)
	}
	if _, e = RequestFrame(42, Method(99)); e != UnknownMethod {
		t.Fatal(e)
	}
	if _, _, _, e = (Frame{Kind: Documents}).Request(); e != BadValue {
		t.Fatal(e)
	}
	f, e = MalformedResponse(42, UnknownField)
	if e != nil {
		t.Fatal(e)
	}
	b, e := Encode(f)
	if e != nil {
		t.Fatal(e)
	}
	decoded, e := Decode(b)
	if e != nil || !bytes.Equal(decoded.Payload, f.Payload) {
		t.Fatal(e)
	}
	if _, e = MalformedResponse(42, Truncated); e != BadValue {
		t.Fatal(e)
	}
}
func TestTaggedValueRefusals(t *testing.T) {
	cases := []struct {
		typ   string
		value []byte
		err   error
	}{
		{"host_actor", Union(4), BadValue}, {"call", Union(99), UnknownMethod}, {"actor", Union(99), UnknownMessage},
		{"empty", Struct(Field(9, []byte{1})), UnknownField}, {"user", Struct(Field(1, String("a")), Field(1, String("b"))), UnorderedField},
		{"user", Struct(Field(1, String("a"))), MissingField}, {"str", append(U16(1), 0), BadUTF8},
		{"str", U16(4097), BadValue}, {"bytes1024", U32(1025), BadValue}, {"str1024", U16(1025), BadValue}, {"sessions", U16(513), BadValue},
		{"version", U16(2), VersionMismatch}, {"magic", U32(0), BadValue}, {"error_code", []byte{0}, BadValue},
		{"str", append(U16(2), 1), Truncated}, {"digest", []byte{1}, Truncated}, {"user", U32(20), Truncated},
	}
	for _, tc := range cases {
		c := cursor{tc.value}
		if e := c.value(tc.typ); e != tc.err {
			t.Fatalf("%s: got %v want %v", tc.typ, e, tc.err)
		}
	}
}
func TestFixedStreamRefusals(t *testing.T) {
	cases := []struct {
		kind    byte
		payload []byte
		err     error
	}{
		{Documents, nil, Truncated}, {Documents, []byte{0}, BadValue}, {Sessions, []byte{99}, UnknownMessage},
		{Sessions, []byte{1, 3}, BadValue}, {Objects, []byte{1, 1}, BadValue}, {Sessions, []byte{1}, Truncated},
		{Objects, []byte{3, 0, 1, 0, 1}, BadValue}, {Objects, []byte{2, 1}, BadValue},
		{Sessions, []byte{2, 3}, BadValue}, {Sessions, []byte{2}, Truncated}, {Sessions, []byte{3, 0}, Truncated},
		{Sessions, []byte{4, 8}, BadValue}, {Sessions, []byte{4}, Truncated},
		{Sessions, []byte{5, 2}, BadValue}, {Sessions, []byte{5, 0, 0}, Truncated}, {Sessions, []byte{5, 1, 8, 0}, BadValue}, {Sessions, []byte{5, 1, 1, 2}, BadValue},
		{Sessions, []byte{6, 0, 0, 0, 0}, BadValue}, {Sessions, []byte{6, 0, 4, 0, 1}, BadValue}, {Sessions, []byte{6, 0}, Truncated},
		{Sessions, []byte{7, 0}, TrailingBytes},
	}
	for _, tc := range cases {
		f := Frame{Kind: tc.kind, Stream: 1, Payload: tc.payload}
		if _, e := Encode(f); e != tc.err {
			t.Fatalf("kind %d %x: %v want %v", tc.kind, tc.payload, e, tc.err)
		}
	}
}
func FuzzFrame(f *testing.F) {
	f.Add([]byte{0, 0, 0, 5, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0})
	f.Add([]byte{0})
	f.Fuzz(func(t *testing.T, b []byte) {
		frame, e := Decode(b)
		if e == nil {
			out, e := Encode(frame)
			if e != nil || !bytes.Equal(out, b) {
				t.Fatalf("noncanonical acceptance %v", e)
			}
		}
	})
}

type failedWriter struct{ err error }

func (w failedWriter) Write([]byte) (int, error) { return 0, w.err }
func TestStreamIOFailures(t *testing.T) {
	if e := Write(failedWriter{io.ErrClosedPipe}, Unsupported(1)); e != io.ErrClosedPipe {
		t.Fatal(e)
	}
	if e := Write(failedWriter{}, Unsupported(1)); e != io.ErrShortWrite {
		t.Fatal(e)
	}
	b := append(U32(3), Control)
	b = append(b, U32(0)...)
	b = append(b, 1)
	if _, e := Read(bytes.NewReader(b)); e != Truncated {
		t.Fatal(e)
	}
	bad := Frame{Kind: Control, Payload: Union(1, Field(1, U32(1)), Field(2, Union(99)))}
	b = append(U32(uint32(len(bad.Payload))), Control)
	b = append(b, U32(0)...)
	b = append(b, bad.Payload...)
	if _, e := Read(bytes.NewReader(b)); e != UnknownMethod {
		t.Fatal(e)
	}
}
func TestPrimitiveFailures(t *testing.T) {
	for _, typ := range []string{"actor", "user", "list:str", "sessions", "str", "u16", "u64"} {
		c := cursor{}
		if e := c.value(typ); e != Truncated {
			t.Fatalf("%s %v", typ, e)
		}
	}
	c := cursor{append(U16(1), U16(5)...)}
	if e := c.value("list:str"); e != Truncated {
		t.Fatal(e)
	}
	c = cursor{Struct(Field(1, []byte{0}))}
	if e := c.value("user"); e != Truncated {
		t.Fatal(e)
	}
	c = cursor{}
	if e := c.value("nonexistent_schema"); e == nil || e.Error() != "unknown schema type nonexistent_schema" {
		t.Fatal(e)
	}
}
func TestStreamTruncationAndDataBoundaries(t *testing.T) {
	for _, p := range [][]byte{{2}, {4}, {5}, {5, 1}, {5, 1, 1}, {6}, {255, 0, 0, 0, 2, 1}} {
		if _, e := Encode(Frame{Kind: Sessions, Stream: 1, Payload: p}); e != Truncated {
			t.Fatalf("%x: %v", p, e)
		}
	}
	p := append([]byte{1, 1}, make([]byte, 65536)...)
	if _, e := Encode(Frame{Kind: Sessions, Stream: 1, Payload: p}); e != nil {
		t.Fatal(e)
	}
	p = append(p, 0)
	if _, e := Encode(Frame{Kind: Sessions, Stream: 1, Payload: p}); e != BadValue {
		t.Fatal(e)
	}
}
