package productstore_test

import (
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/productstore"
)

// Hosted workspace stores embed the public product contract and add private
// operations. This must remain enough to supply the runtime workspace port.
type hostedWorkspaceStore struct{ productstore.Product }

var _ = ports.RuntimeStores{Workspaces: hostedWorkspaceStore{}}
