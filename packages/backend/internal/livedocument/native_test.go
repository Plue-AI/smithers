//go:build cgo

package livedocument

import (
	"bytes"
	"errors"
	"os"
	"sync"
	"testing"
)

func library(t *testing.T) *Library {
	t.Helper()
	path := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if path == "" {
		if os.Getenv("SMITHERS_REQUIRE_FFI_TESTS") == "1" {
			t.Fatal("SMITHERS_FFI_LIBRARY_PATH required")
		}
		t.Skip("SMITHERS_FFI_LIBRARY_PATH required for native ABI proof")
	}
	l, e := Load(path)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := l.Close(); e != nil {
			t.Error(e)
		}
	})
	return l
}
func TestNativeDocumentLifecycleRace(t *testing.T) {
	l := library(t)
	for _, kind := range []Kind{Code, Wiki} {
		d, e := l.Open(kind, nil)
		if e != nil {
			t.Fatal(e)
		}
		root := "content"
		if kind == Wiki {
			root = "markdown"
		}
		if _, e = d.SetAuthor(11, "alice"); e != nil {
			t.Fatal(e)
		}
		before, e := d.State()
		if e != nil {
			t.Fatal(e)
		}
		if _, e = d.Apply(22, []byte{0, 0}); !errors.Is(e, ErrRefused) {
			t.Fatalf("foreign: %v", e)
		}
		if _, e = d.Apply(11, []byte{255}); e == nil {
			t.Fatal("malformed accepted")
		}
		if _, e = d.SetAuthor(11, "mallory"); !errors.Is(e, ErrRefused) {
			t.Fatalf("reassign: %v", e)
		}
		after, _ := d.State()
		if !bytes.Equal(before, after) {
			t.Fatal("refusal mutated state")
		}
		if e = l.Close(); e == nil {
			t.Fatal("unloaded library with open document")
		}
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 50; j++ {
					if _, e := d.State(); e != nil && !errors.Is(e, ErrClosed) {
						t.Error(e)
					}
					if _, e := d.Text(root); e != nil && !errors.Is(e, ErrClosed) {
						t.Error(e)
					}
					if _, e := d.Apply(11, []byte{0, 0}); e != nil && !errors.Is(e, ErrClosed) {
						t.Error(e)
					}
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := d.Close(); e != nil {
				t.Error(e)
			}
		}()
		wg.Wait()
		if _, e = d.State(); !errors.Is(e, ErrClosed) {
			t.Fatalf("closed: %v", e)
		}
		reopened, e := l.Open(kind, before)
		if e != nil {
			t.Fatal(e)
		}
		if text, e := reopened.Text(root); e != nil || text != "" {
			t.Fatalf("restored %q %v", text, e)
		}
		reopened.Close()
	}
}
func TestNativeParallelDocuments(t *testing.T) {
	l := library(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 125; j++ {
				d, e := l.Open(Code, nil)
				if e != nil {
					t.Error(e)
					return
				}
				if _, e = d.SetAuthor(11, "alice"); e != nil {
					t.Error(e)
				}
				sv, e := d.Sync1()
				if e != nil {
					t.Error(e)
				}
				if _, e = d.Sync2(sv); e != nil {
					t.Error(e)
				}
				if _, e = d.Awareness([]byte{0}); e != nil {
					t.Error(e)
				}
				if e = d.Close(); e != nil {
					t.Error(e)
				}
			}
		}()
	}
	wg.Wait()
}
func TestNativeMissingLibrary(t *testing.T) {
	if _, e := Load("/no/such/library"); e == nil {
		t.Fatal("missing library accepted")
	}
}

// Run with the real library and -fuzz=FuzzNativeBoundary; each mutation crosses C.
func FuzzNativeBoundary(f *testing.F) {
	path := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if path == "" {
		f.Skip("native library required")
	}
	l, e := Load(path)
	if e != nil {
		f.Fatal(e)
	}
	defer l.Close()
	for _, b := range [][]byte{{0, 0}, {255}, {1, 1, 11, 0, 4, 1, 7, 'c', 'o', 'n', 't', 'e', 'n', 't', 1, 'a', 0}, {0}} {
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 4096 {
			t.Skip()
		}
		d, e := l.Open(Code, nil)
		if e != nil {
			t.Fatal(e)
		}
		defer d.Close()
		if _, e = d.SetAuthor(11, "alice"); e != nil {
			t.Fatal(e)
		}
		before, e := d.State()
		if e != nil {
			t.Fatal(e)
		}
		_, applyErr := d.Apply(11, b)
		if applyErr != nil {
			after, e := d.State()
			if e != nil {
				t.Fatal(e)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("refused update mutated state")
			}
		}
		d.Sync2(b)
		d.Awareness(b)
	})
}

func TestNativePeerAdmission(t *testing.T) {
	l := library(t)
	source, e := l.Open(Code, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer source.Close()
	target, e := l.Open(Code, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	update, e := source.SetAuthor(42, "alice")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = target.Apply(42, update); !errors.Is(e, ErrRefused) {
		t.Fatalf("browser changed authors: %v", e)
	}
	if _, e = target.Peer(update); e != nil {
		t.Fatal(e)
	}
	if _, e = target.Apply(42, []byte{0, 0}); e != nil {
		t.Fatalf("peer author missing: %v", e)
	}
	before, _ := target.State()
	if _, e = target.Peer([]byte{255}); e == nil {
		t.Fatal("malformed peer accepted")
	}
	after, _ := target.State()
	if !bytes.Equal(before, after) {
		t.Fatal("invalid peer mutated state")
	}
}
