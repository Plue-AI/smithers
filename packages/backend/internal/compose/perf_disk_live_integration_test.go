package compose

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPerfDiskWriteProductionSubscriptions(t *testing.T) {
	f := presenceInstall(t)
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	command := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `
import { createRequire } from 'node:module'
import { subscribeFiles } from './scripts/perf/disk-write.mjs'
const require = createRequire(new URL('./packages/smithers/package.json', import.meta.url))
const Socket = require('ws')
globalThis.window = {}
globalThis.WebSocket = class extends Socket {
 constructor(url, protocol) {
  super(url, protocol, { headers: { Origin: process.env.PERF_ORIGIN, Cookie: process.env.PERF_COOKIE } })
 }
}
try {
 await subscribeFiles({ origin: process.env.PERF_ORIGIN, branch: process.env.PERF_BRANCH })
 const frames = window.__diskFrames
 if (![801, 802].every(id => frames.some(frame => frame.id === id && frame.t === 'snap'))) throw new Error('missing production snapshot')
 console.log(window.__diskSocket.protocol)
} finally { window.__diskSocket?.close() }
`)
	command.Dir = root
	command.Env = append(os.Environ(), "PERF_ORIGIN="+f.origin, "PERF_COOKIE=session="+f.cookie, "PERF_BRANCH="+f.row.ID)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Equal(t, "smithers.live.v1\n", string(output))
}
