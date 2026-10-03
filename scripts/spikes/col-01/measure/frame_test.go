package measure

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestFrameWireFormatAndLimits(t *testing.T) {
	if MaxFrame != 1<<20 {
		t.Fatalf("MaxFrame = %d", MaxFrame)
	}
	for _, payload := range [][]byte{{0}, []byte("hello"), bytes.Repeat([]byte{0xff}, MaxFrame)} {
		var b bytes.Buffer
		if err := WriteFrame(&b, payload); err != nil {
			t.Fatal(err)
		}
		wire := append([]byte(nil), b.Bytes()...)
		if binary.BigEndian.Uint32(wire[:4]) != uint32(len(payload)) || !bytes.Equal(wire[4:], payload) {
			t.Fatal("wire format differs")
		}
		got, err := ReadFrame(&b)
		if err != nil || !bytes.Equal(got, payload) {
			t.Fatalf("round trip length %d: %v", len(payload), err)
		}
		if b.Len() != 0 {
			t.Fatal("frame left unread bytes")
		}
	}
	for _, payload := range [][]byte{nil, {}, make([]byte, MaxFrame+1)} {
		var b bytes.Buffer
		if err := WriteFrame(&b, payload); err == nil {
			t.Fatalf("accepted payload length %d", len(payload))
		}
		if b.Len() != 0 {
			t.Fatal("invalid frame wrote bytes")
		}
	}
}

func TestReadFrameRejectsInvalidAndTruncatedFrames(t *testing.T) {
	for _, tc := range []struct {
		name string
		wire []byte
		want error
	}{
		{"empty_stream", nil, io.EOF},
		{"one_byte_header", []byte{0}, io.ErrUnexpectedEOF},
		{"three_byte_header", []byte{0, 0, 0}, io.ErrUnexpectedEOF},
		{"missing_payload", []byte{0, 0, 0, 1}, io.EOF},
		{"truncated_payload", []byte{0, 0, 0, 2, 1}, io.ErrUnexpectedEOF},
		{"empty_frame", []byte{0, 0, 0, 0}, nil},
		{"oversize", []byte{0, 16, 0, 1}, nil},
		{"maximum_header", []byte{255, 255, 255, 255}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ReadFrame(bytes.NewReader(tc.wire))
			if got != nil || err == nil {
				t.Fatalf("ReadFrame = %v, %v", got, err)
			}
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("error %v; want %v", err, tc.want)
			}
		})
	}
}

func TestReadFrameRejectsLengthBeforeReadingBody(t *testing.T) {
	for _, n := range []uint32{0, MaxFrame + 1, ^uint32(0)} {
		var prefix [4]byte
		binary.BigEndian.PutUint32(prefix[:], n)
		r := &headerOnlyReader{header: bytes.NewReader(prefix[:])}
		if _, err := ReadFrame(r); err == nil {
			t.Fatalf("accepted length %d", n)
		}
		if r.bodyRead {
			t.Fatal("invalid length caused body read")
		}
	}
}

func TestFramesAcrossFragmentedPipe(t *testing.T) {
	reader, writer := net.Pipe()
	defer reader.Close()
	defer writer.Close()
	if err := reader.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := writer.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	values := [][]byte{[]byte("first"), {0, 1, 2, 3}, bytes.Repeat([]byte("last"), 1024)}
	done := make(chan error, 1)
	go func() {
		defer writer.Close()
		for _, value := range values {
			if err := WriteFrame(fragmentWriter{writer, 3}, value); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for _, want := range values {
		got, err := ReadFrame(reader)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("fragmented stream = %d bytes, %v; want %d", len(got), err, len(want))
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFrame(reader); !errors.Is(err, io.EOF) {
		t.Fatalf("end stream = %v", err)
	}
}

func TestWriteFrameHandlesShortWrites(t *testing.T) {
	var b bytes.Buffer
	if err := WriteFrame(fragmentWriter{&b, 1}, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b.Bytes(), []byte{0, 0, 0, 3, 'a', 'b', 'c'}) {
		t.Fatalf("wire = %v", b.Bytes())
	}
	for _, n := range []int{0, -1, 5} {
		if err := WriteFrame(resultWriter{n: n}, []byte("abc")); !errors.Is(err, io.ErrShortWrite) {
			t.Fatalf("invalid write n=%d = %v", n, err)
		}
	}
}

func TestWriteFrameWritesHeaderAndPayloadTogether(t *testing.T) {
	w := &countingWriter{}
	if err := WriteFrame(w, []byte("payload")); err != nil {
		t.Fatal(err)
	}
	if w.calls != 1 {
		t.Fatalf("frame used %d writes; header and payload must share one write", w.calls)
	}
	if !bytes.Equal(w.Bytes(), []byte{0, 0, 0, 7, 'p', 'a', 'y', 'l', 'o', 'a', 'd'}) {
		t.Fatalf("combined frame = %v", w.Bytes())
	}
}

type countingWriter struct {
	bytes.Buffer
	calls int
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.calls++
	return w.Buffer.Write(p)
}

func TestFramePropagatesIOErrors(t *testing.T) {
	want := errors.New("transport failed")
	for _, after := range []int{0, 4, 5} {
		w := &failAfterWriter{remaining: after, err: want}
		if err := WriteFrame(w, []byte("abc")); !errors.Is(err, want) {
			t.Fatalf("write failure after %d = %v", after, err)
		}
	}
	for _, wire := range [][]byte{nil, {0, 0, 0, 2, 1}} {
		r := io.MultiReader(bytes.NewReader(wire), errorReader{want})
		if _, err := ReadFrame(r); !errors.Is(err, want) {
			t.Fatalf("read failure = %v", err)
		}
	}
}

type fragmentWriter struct {
	io.Writer
	max int
}

func (w fragmentWriter) Write(p []byte) (int, error) {
	if len(p) > w.max {
		p = p[:w.max]
	}
	return w.Writer.Write(p)
}

type resultWriter struct{ n int }

func (w resultWriter) Write([]byte) (int, error) { return w.n, nil }

type failAfterWriter struct {
	remaining int
	err       error
}

func (w *failAfterWriter) Write(p []byte) (int, error) {
	if w.remaining < len(p) {
		n := w.remaining
		w.remaining = 0
		return n, w.err
	}
	w.remaining -= len(p)
	return len(p), nil
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

type headerOnlyReader struct {
	header   *bytes.Reader
	bodyRead bool
}

func (r *headerOnlyReader) Read(p []byte) (int, error) {
	if r.header.Len() == 0 {
		r.bodyRead = true
		return 0, errors.New("unexpected body read")
	}
	return r.header.Read(p)
}
