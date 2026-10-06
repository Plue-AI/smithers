package microsandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestFileOperationPreservesOnlyValidCompareWriteStaleResponses(t *testing.T) {
	digest := strings.Repeat("a1", 32)
	for _, tc := range []struct {
		name, operation, message, want string
	}{
		{"digest", "compare-write", "smithers-guest: stale:" + digest + "\n", digest},
		{"absent", "compare-write", "smithers-guest: stale:absent\n", "absent"},
		{"no-newline", "compare-write", "smithers-guest: stale:" + digest, digest},
		{"empty", "compare-write", "smithers-guest: stale:\n", ""},
		{"uppercase", "compare-write", "smithers-guest: stale:" + strings.ToUpper(digest) + "\n", ""},
		{"short", "compare-write", "smithers-guest: stale:" + digest[:63] + "\n", ""},
		{"extra-diagnostic", "compare-write", "smithers-guest: stale:" + digest + "\nerror\n", ""},
		{"extra-prefix", "compare-write", "error\nsmithers-guest: stale:" + digest + "\n", ""},
		{"missing-prefix", "compare-write", "stale:" + digest + "\n", ""},
		{"whitespace", "compare-write", "smithers-guest: stale: " + digest + "\n", ""},
		{"other-operation", "write", "smithers-guest: stale:" + digest + "\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "msb")
			// This executable substitutes the transport peer, not the parser or
			// CLI exit handling; production qualification is separately gated.
			require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s' "+shellQuote(tc.message)+" >&2\nexit 6\n"), 0700))
			r := &Runtime{cli: &cli{binary: binary, home: dir}, workspaces: map[string]*workspace{
				"fixture": newWorkspace(metadata{ID: "fixture", Machine: "machine", State: "running"}, ""),
			}}
			output, err := r.fileOperation(t.Context(), "fixture", guestRoot, []byte("new"), tc.operation, "a", "644", digest, "4096")
			require.Nil(t, output)
			var stale *workspaceapi.StaleFileError
			if tc.want == "" {
				require.ErrorIs(t, err, ErrUnavailable)
				require.NotErrorAs(t, err, &stale)
			} else {
				require.ErrorAs(t, err, &stale)
				require.Equal(t, tc.want, stale.CurrentDigest)
			}
			// Adding transport decoding must not advertise an unqualified
			// production write capability through the optional interface.
			_, enabled := any(r).(workspaceapi.WorkspaceCompareWriter)
			require.False(t, enabled)
		})
	}
}
