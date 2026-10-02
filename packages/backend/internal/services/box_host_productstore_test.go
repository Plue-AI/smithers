package services

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/productstore"
)

// Deployment stores embed the exported interface, not *db.Queries. Losing
// token listing here silently skips PrepareBoxHost's native source binding,
// then the coding host dies because import-source/v1 is unavailable.
func TestProductStoreWrapperPreservesBoxHostCapabilities(t *testing.T) {
	wrapped := struct{ productstore.Product }{Product: productstore.New(nil)}
	if _, ok := any(wrapped).(boxHostQuerier); !ok {
		t.Fatal("product store wrapper cannot prepare the coding host")
	}
	if _, ok := any(wrapped).(workspaceHeadStore); !ok {
		t.Fatal("product store wrapper cannot install the native source binding")
	}
	// Without the swap, a runtime workspace never starts its publisher: no
	// repository credential and no head reports (smithers#3112).
	if _, ok := any(wrapped).(workspaceHeadSwapStore); !ok {
		t.Fatal("product store wrapper cannot install the runtime workspace publisher")
	}
}
