package postgres

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestMaintenanceRequiresOwnedLiveInstance(t *testing.T) {
	for _, p := range []*Instance{nil, {}, {binDir: "relative", done: make(chan struct{})}} {
		if _, err := p.DatabaseSize(t.Context()); err == nil {
			t.Fatal("size accepted absent authority")
		}
		if err := p.Dump(t.Context(), io.Discard); err == nil {
			t.Fatal("dump accepted absent authority")
		}
		if err := p.RestoreDump(t.Context(), strings.NewReader("dump")); err == nil {
			t.Fatal("restore accepted absent authority")
		}
	}
	done := make(chan struct{})
	close(done)
	p := &Instance{binDir: "/owned/tools", done: done}
	if err := p.Dump(t.Context(), io.Discard); err == nil || err.Error() != "owned postgres is stopped" {
		t.Fatal(err)
	}
	p.done = make(chan struct{})
	if err := p.Dump(t.Context(), nil); err == nil {
		t.Fatal("nil writer accepted")
	}
	if err := p.RestoreDump(t.Context(), nil); err == nil {
		t.Fatal("nil reader accepted")
	}
	for _, connection := range []string{"postgres://127.0.0.1:123/postgres", "postgres://smithers:password@outside:123/postgres", "postgres://smithers:password@127.0.0.1:123/other", "postgres://smithers@127.0.0.1:123/postgres", "://"} {
		p.ConnectionString = connection
		if err := p.Dump(context.Background(), io.Discard); err == nil {
			t.Fatal("invalid connection accepted")
		}
	}
}
