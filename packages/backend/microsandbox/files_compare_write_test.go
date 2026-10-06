package microsandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestFileOperationPreservesOnlyValidCompareWriteStaleResponses(t *testing.T) {
	digest := strings.Repeat("a1", 32)
	valid := `{"path":"a:line\nnext","current_digest":"` + digest + `"}`
	for _, tc := range []struct {
		name, operation, message, want string
	}{
		{"digest", "compare-write", "smithers-guest: stale:" + valid + "\n", digest},
		{"absent", "compare-write", `smithers-guest: stale:{"path":"a:line\nnext","current_digest":"absent"}`, "absent"},
		{"no-newline", "compare-write", "smithers-guest: stale:" + valid, digest},
		{"empty", "compare-write", "smithers-guest: stale:\n", ""},
		{"legacy-no-path", "compare-write", "smithers-guest: stale:" + digest, ""},
		{"uppercase", "compare-write", "smithers-guest: stale:" + strings.Replace(valid, digest, strings.ToUpper(digest), 1), ""},
		{"short", "compare-write", "smithers-guest: stale:" + strings.Replace(valid, digest, digest[:63], 1), ""},
		{"extra-diagnostic", "compare-write", "smithers-guest: stale:" + valid + "\nerror\n", ""},
		{"extra-prefix", "compare-write", "error\nsmithers-guest: stale:" + valid, ""},
		{"missing-prefix", "compare-write", "stale:" + valid, ""},
		{"other-operation", "write", "smithers-guest: stale:" + valid, ""},
		{"duplicate", "compare-write", `smithers-guest: stale:{"path":"a","path":"b","current_digest":"absent"}`, ""},
		{"unknown", "compare-write", `smithers-guest: stale:{"path":"a","uid":0,"current_digest":"absent"}`, ""},
		{"missing", "compare-write", `smithers-guest: stale:{"current_digest":"absent"}`, ""},
		{"numeric", "compare-write", `smithers-guest: stale:{"path":1,"current_digest":"absent"}`, ""},
		{"null", "compare-write", `smithers-guest: stale:{"path":null,"current_digest":"absent"}`, ""},
		{"traversal", "compare-write", `smithers-guest: stale:{"path":"../a","current_digest":"absent"}`, ""},
		{"absolute", "compare-write", `smithers-guest: stale:{"path":"/a","current_digest":"absent"}`, ""},
		{"unnormalized", "compare-write", `smithers-guest: stale:{"path":"a/../b","current_digest":"absent"}`, ""},
		{"nul", "compare-write", `smithers-guest: stale:{"path":"a\u0000b","current_digest":"absent"}`, ""},
		{"oversize", "compare-write", "smithers-guest: stale:" + strings.Repeat(" ", 16<<10), ""},
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
			output, err := r.fileOperation(t.Context(), "fixture", guestRoot, []byte("new"), tc.operation, "4096")
			require.Nil(t, output)
			var stale *workspaceapi.StaleFileError
			if tc.want == "" {
				require.ErrorIs(t, err, ErrUnavailable)
				require.NotErrorAs(t, err, &stale)
			} else {
				require.ErrorAs(t, err, &stale)
				require.Equal(t, tc.want, stale.CurrentDigest)
				require.Equal(t, "a:line\nnext", stale.Path)
			}
			// Adding transport decoding must not advertise an unqualified
			// production write capability through the optional interface.
			_, enabled := any(r).(workspaceapi.WorkspaceCompareWriter)
			require.False(t, enabled)
		})
	}
}

func TestCompareWriteBatchTransportAndAcknowledgment(t *testing.T) {
	const binaryDigest = "06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8"
	const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	valid := `{"changes":[{"path":"a odd:\nname","digest":"` + binaryDigest + `"},{"path":"delete","digest":"absent"},{"path":"empty","digest":"` + emptyDigest + `"}]}`
	for _, tt := range []struct {
		name, output, diagnostic string
		code                     int
		success, stale           bool
	}{
		{"exact", valid, "", 0, true, false},
		{"missing", `{"changes":[]}`, "", 0, false, false},
		{"wrong digest", strings.Replace(valid, binaryDigest, emptyDigest, 1), "", 0, false, false},
		{"wrong path", strings.Replace(valid, `"delete"`, `"unknown"`, 1), "", 0, false, false},
		{"duplicate path", strings.Replace(valid, `"delete"`, `"empty"`, 1), "", 0, false, false},
		{"unknown field", strings.Replace(valid, `"changes":`, `"extra":0,"changes":`, 1), "", 0, false, false},
		{"trailing", valid + " {}", "", 0, false, false},
		{"oversized", strings.Repeat(" ", 2<<20) + valid, "", 0, false, false},
		{"stale", "", `smithers-guest: stale:{"path":"delete","current_digest":"absent"}`, 6, false, true},
		{"foreign stale", "", `smithers-guest: stale:{"path":"unknown","current_digest":"absent"}`, 6, false, false},
		{"gate", "", "smithers-guest: compare-write provider is not qualified", 125, false, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "msb")
			request := filepath.Join(dir, "request")
			argv := filepath.Join(dir, "argv")
			// The subprocess is a recording transport peer; all encoding, dispatch and
			// acknowledgment validation under test are the production candidate code.
			response := filepath.Join(dir, "response")
			require.NoError(t, os.WriteFile(response, []byte(tt.output), 0600))
			script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(argv) + "\ncat > " + shellQuote(request) + "\ncat " + shellQuote(response) + "\nprintf '%s' " + shellQuote(tt.diagnostic) + " >&2\nexit " + fmt.Sprint(tt.code) + "\n"
			require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
			r := &Runtime{cli: &cli{binary: binary, home: dir}, workspaces: map[string]*workspace{"fixture": newWorkspace(metadata{ID: "fixture", Machine: "machine", State: "running"}, "")}}
			err := r.compareWriteFiles(t.Context(), "fixture", []workspaceapi.FileMutation{{Path: "a odd:\nname", BaseDigest: "absent", Content: []byte{0, 255}}, {Path: "delete", BaseDigest: emptyDigest}, {Path: "empty", BaseDigest: "absent", Content: []byte{}}})
			var stale *workspaceapi.StaleFileError
			if tt.success {
				require.NoError(t, err)
			} else if tt.stale {
				require.ErrorAs(t, err, &stale)
				require.Equal(t, "delete", stale.Path)
			} else {
				require.ErrorIs(t, err, ErrUnavailable)
				require.NotErrorAs(t, err, &stale)
			}
			body, readErr := os.ReadFile(request)
			require.NoError(t, readErr)
			require.JSONEq(t, `{"changes":[{"path":"a odd:\nname","base_digest":"absent","content":"AP8=","encoding":"base64"},{"path":"delete","base_digest":"`+emptyDigest+`","content":null},{"path":"empty","base_digest":"absent","content":"","encoding":"base64"}]}`, string(body))
			args, readErr := os.ReadFile(argv)
			require.NoError(t, readErr)
			require.Contains(t, string(args), "compare-write")
			require.NotContains(t, string(args), "a odd:")
			_, enabled := any(r).(workspaceapi.WorkspaceCompareWriter)
			require.False(t, enabled)
		})
	}
}

func TestCompareWriteBatchRefusesInvalidInputBeforeTransport(t *testing.T) {
	for _, tt := range []struct {
		name    string
		changes []workspaceapi.FileMutation
	}{
		{"empty", nil}, {"too many", make([]workspaceapi.FileMutation, 257)},
		{"path", []workspaceapi.FileMutation{{Path: "../a", BaseDigest: "absent"}}},
		{"invalid utf8", []workspaceapi.FileMutation{{Path: string([]byte{255}), BaseDigest: "absent"}}},
		{"base", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "bad"}}},
		{"duplicate", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent"}, {Path: "a", BaseDigest: "absent"}}},
		{"overlap", []workspaceapi.FileMutation{{Path: "a/b", BaseDigest: "absent"}, {Path: "a", BaseDigest: "absent"}}},
		{"aggregate", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: make([]byte, guestMutationByteLimit)}, {Path: "b", BaseDigest: "absent", Content: []byte("x")}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			// With no workspace/CLI, a lookup error would expose missing validation.
			r := &Runtime{}
			require.ErrorContains(t, r.compareWriteFiles(t.Context(), "fixture", tt.changes), "workspace mutation")
		})
	}
}

func TestCompareWriteBatchPreservesCancellationBeforeDispatch(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	r := &Runtime{}
	require.ErrorIs(t, r.compareWriteFiles(ctx, "fixture", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte("x")}}), context.Canceled)
}
