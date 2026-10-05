package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Round 4 admission at the HTTP door: a command naming HEAD, another
// pseudoref or a bare name is refused before repo-host, for every
// credential, the sync's included, on an install and hosted. Git resolves
// such a name through HEAD, so no later write of it may happen.
func TestGitHTTPProxyService_ReceivePack_RefusesPseudorefsForEveryCredential(t *testing.T) {
	t.Parallel()
	sync := "write:repository," + middleware.SyncCredentialScope()
	for _, install := range []bool{true, false} {
		for _, credential := range []struct {
			name, scopes string
			system       bool
		}{
			{"person", "write:repository", false},
			{"agent-run", "write:repository,repo:314,agent-session:s1", true},
			{"sync", sync, true},
		} {
			for _, name := range []string{"HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "main"} {
				svc, host := receivePackProxy(credential.scopes, credential.system, install, "main")
				err := pushThroughProxy(svc, "refs/tags/v1", name)
				require.Error(t, err, "install=%v %s %s", install, credential.name, name)
				assert.Equal(t, 400, apiStatus(t, err), "install=%v %s %s", install, credential.name, name)
				assert.Zero(t, host.receivePackCall, "install=%v %s %s reached repo-host", install, credential.name, name)
			}
		}
	}
}
