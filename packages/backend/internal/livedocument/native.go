//go:build cgo

// Package livedocument owns persistent native Yrs handles for the host document
// service. It never claims a disk/database save; the caller owns durability.
package livedocument

/*
#cgo linux LDFLAGS: -ldl
#include <dlfcn.h>
#include <stdlib.h>
#include "../../../../crates/smithers-ffi/live_document.h"
typedef struct { void *lib; void *fn[10]; } ld_library;
static ld_library *ld_load(const char *path) {
 const char *names[] = {"ld_open", "ld_apply", "ld_sync1", "ld_sync2", "ld_awareness", "ld_set_author", "ld_state", "ld_text", "ld_close", "ld_free"};
 ld_library *l = calloc(1, sizeof(*l));
 if (!l) return NULL;
 l->lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
 if (!l->lib) { free(l); return NULL; }
 for (int i=0; i<10; i++) { l->fn[i] = dlsym(l->lib, names[i]); if (!l->fn[i]) { dlclose(l->lib); free(l); return NULL; } }
 return l;
}
static void ld_unload(ld_library *l) { dlclose(l->lib); free(l); }
static uint64_t ld_new(ld_library *l, uint32_t kind, const uint8_t *p, size_t n) { return ((uint64_t (*)(uint32_t,const uint8_t*,size_t))l->fn[0])(kind,p,n); }
static LdResult ld_call(ld_library *l, int op, uint64_t h, uint64_t client, const uint8_t *p, size_t n) {
 if (op==1 || op==5) return ((LdResult (*)(uint64_t,uint64_t,const uint8_t*,size_t))l->fn[op])(h,client,p,n);
 if (op==2 || op==6 || op==8) return ((LdResult (*)(uint64_t))l->fn[op])(h);
 return ((LdResult (*)(uint64_t,const uint8_t*,size_t))l->fn[op])(h,p,n);
}
static void ld_release(ld_library *l, LdResult r) { ((void (*)(LdResult))l->fn[9])(r); }
*/
import "C"
import (
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

var ErrRefused = errors.New("live document update refused")
var ErrClosed = errors.New("live document closed")

type Kind uint32

const (
	Code Kind = iota
	Wiki
)

// Library must outlive every Document. Load fails closed on missing I5 symbols.
type Library struct {
	mu        sync.Mutex
	native    *C.ld_library
	documents int
}
type Document struct {
	mu      sync.Mutex
	library *Library
	handle  uint64
}

func Load(path string) (*Library, error) {
	p := C.CString(path)
	defer C.free(unsafe.Pointer(p))
	native := C.ld_load(p)
	if native == nil {
		return nil, fmt.Errorf("load live document ABI: %s", path)
	}
	return &Library{native: native}, nil
}
func (l *Library) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.documents != 0 {
		return errors.New("live documents remain open")
	}
	if l.native != nil {
		C.ld_unload(l.native)
		l.native = nil
	}
	return nil
}
func data(bytes []byte) *C.uint8_t { return (*C.uint8_t)(unsafe.Pointer(unsafe.SliceData(bytes))) }
func (l *Library) Open(kind Kind, state []byte) (*Document, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.native == nil {
		return nil, ErrClosed
	}
	if kind != Code && kind != Wiki {
		return nil, errors.New("invalid document kind")
	}
	h := C.ld_new(l.native, C.uint32_t(kind), data(state), C.size_t(len(state)))
	if h == 0 {
		return nil, errors.New("open live document failed")
	}
	l.documents++
	return &Document{library: l, handle: uint64(h)}, nil
}
func (d *Document) call(op int, client uint64, bytes []byte) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.handle == 0 {
		return nil, ErrClosed
	}
	result := C.ld_call(d.library.native, C.int(op), C.uint64_t(d.handle), C.uint64_t(client), data(bytes), C.size_t(len(bytes)))
	defer C.ld_release(d.library.native, result)
	switch result.status {
	case 0:
		return C.GoBytes(unsafe.Pointer(result.data), C.int(result.len)), nil
	case 1:
		return nil, ErrRefused
	default:
		return nil, fmt.Errorf("live document ABI status %d", result.status)
	}
}

// Apply returns the bytes to fan out. An error means no update was admitted.
func (d *Document) Apply(client uint64, update []byte) ([]byte, error) {
	return d.call(1, client, update)
}
func (d *Document) Sync1() ([]byte, error)          { return d.call(2, 0, nil) }
func (d *Document) Sync2(sv []byte) ([]byte, error) { return d.call(3, 0, sv) }

// Awareness takes host-stamped identity/colour; it is never persisted.
func (d *Document) Awareness(bytes []byte) ([]byte, error) { return d.call(4, 0, bytes) }
func (d *Document) SetAuthor(client uint64, actor string) ([]byte, error) {
	return d.call(5, client, []byte(actor))
}
func (d *Document) State() ([]byte, error) { return d.call(6, 0, nil) }
func (d *Document) Text(root string) (string, error) {
	b, e := d.call(7, 0, []byte(root))
	return string(b), e
}
func (d *Document) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.handle == 0 {
		return nil
	}
	result := C.ld_call(d.library.native, 8, C.uint64_t(d.handle), 0, nil, 0)
	C.ld_release(d.library.native, result)
	d.handle = 0
	d.library.mu.Lock()
	d.library.documents--
	d.library.mu.Unlock()
	if result.status != 0 {
		return fmt.Errorf("close live document: status %d", result.status)
	}
	return nil
}
