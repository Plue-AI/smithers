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
}
