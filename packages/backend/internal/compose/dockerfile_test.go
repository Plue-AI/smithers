package compose

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDistributionPackagesCanonicalFlowHosts(t *testing.T) {
	t.Parallel()
	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok)
	root := filepath.Join(filepath.Dir(thisFile), "../../../..")
	contentBytes, err := os.ReadFile(filepath.Join(root, "distribution", "Dockerfile"))
	require.NoError(t, err)
	content := string(contentBytes)
	assert.Contains(t, content, "node flows/coding/build.mjs /out/flow-hosts/smithers-coding-host")
	assert.NotContains(t, content, "librarian")
	assert.Contains(t, content, "node distribution/flow-host-manifest.mjs")
	assert.Contains(t, content, "COPY --from=web /out/flow-hosts/ /opt/smithers/bin/")
	assert.Contains(t, content, "SMITHERS_FLOW_HOST_MANIFEST=/opt/smithers/bin/flow-hosts.json")
	assert.NotContains(t, content, "workflow-evaluator.ts")
}
