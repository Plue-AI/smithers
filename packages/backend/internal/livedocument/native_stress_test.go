//go:build cgo

package livedocument

import (
	"bytes"
	"errors"
	"sync"
	"testing"
)

// Real Yjs v1: one insertion by client 42 into content, with 1 MiB of text.
func largeDocumentState() []byte {
	var b bytes.Buffer
	varUint := func(v int) {
		for v >= 128 {
			b.WriteByte(byte(v) | 128)
			v >>= 7
		}
		b.WriteByte(byte(v))
	}
	varUint(1)
	varUint(1)
	varUint(42)
	varUint(0)
	b.WriteByte(4)
	varUint(1)
	varUint(7)
	b.WriteString("content")
	varUint(1 << 20)
	b.Write(bytes.Repeat([]byte{'x'}, 1<<20))
	varUint(0)
	return b.Bytes()
}

// W12 proof: 1,000 real native open/close cycles, with concurrent readers.
func TestNativeThousandLargeDocumentCycles(t *testing.T) {
	l := library(t)
	state := largeDocumentState()
	expected := string(bytes.Repeat([]byte{'x'}, 1<<20))
	for i := 0; i < 1000; i++ {
		d, e := l.Open(Code, state)
		if e != nil {
			t.Fatalf("cycle %d: %v", i, e)
		}
		text, e := d.Text("content")
		if e != nil || text != expected {
			t.Fatalf("cycle %d text=%d err=%v", i, len(text), e)
		}
		var wg sync.WaitGroup
		for j := 0; j < 4; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				sv, e := d.Sync1()
				if e != nil || len(sv) == 0 {
					t.Errorf("sync1: %v", e)
				}
			}()
		}
		wg.Wait()
		if e = d.Close(); e != nil {
			t.Fatal(e)
		}
		if e = d.Close(); e != nil {
			t.Fatal(e)
		}
		if _, e = d.State(); !errors.Is(e, ErrClosed) {
			t.Fatalf("closed handle: %v", e)
		}
	}
}
