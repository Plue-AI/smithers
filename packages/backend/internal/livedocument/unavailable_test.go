//go:build !cgo

package livedocument

import (
	"errors"
	"testing"
)

// Without cgo the package still builds, and Load refuses instead of handing
// out a document that cannot hold state (#3753).
func TestLoadRefusesWithoutCgo(t *testing.T) {
	library, err := Load("/nonexistent/libsmithers_ffi.so")
	if !errors.Is(err, ErrUnavailable) || library != nil {
		t.Fatalf("Load() = %v, %v; want nil, ErrUnavailable", library, err)
	}
}
