package microsandbox

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The collector removes only leaked layer snapshots: an install whose state
// root is gone and that has no machine, or a snapshot its own install no
// longer records. It keeps what any root names, every snapshot of an install
// with a machine, anything younger than the minimum age, every snapshot a
// kept one was taken on top of, and every snapshot that is not a Smithers
// layer. A child goes before the snapshot it was taken on top of.
func TestCollectSnapshotsRemovesOnlyLeaks(t *testing.T) {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	old, young := now.Add(-3*time.Hour), now.Add(-10*time.Minute)
	layer := func(kind, owner, key string) string {
		return "smthrs-" + kind + "-" + owner + "-" + strings.Repeat(key, 20)
	}
	var (
		recorded   = layer("tc", "aaaaaaaa", "1")
		inUse      = layer("dp", "aaaaaaaa", "2")
		machine    = layer("tc", "bbbbbbbb", "3")
		leakParent = layer("tc", "cccccccc", "4")
		leakChild  = layer("dp", "cccccccc", "5")
		building   = layer("tc", "dddddddd", "6")
		base       = layer("tc", "eeeeeeee", "7")
		unrecorded = layer("tc", "aaaaaaaa", "9")
		other      = "smthrs-env-62079da5-9045cf9f7956-055b2dec5652acfe7e19"
	)
	dir := t.TempDir()
	root := filepath.Join(dir, "install", "microvm")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "layers"), 0o700))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "workspaces", "w1"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "layers", recorded+".json"), []byte(`{"kind":"toolchain"}`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(root, "workspaces", "w1", "metadata.json"), []byte(`{"snapshot":"`+inUse+`"}`), 0o600))
	type row struct {
		Name         string    `json:"name"`
		Digest       string    `json:"digest"`
		CreatedAt    time.Time `json:"created_at"`
		ParentDigest *string   `json:"parent_digest"`
	}
	parent := func(digest string) *string { return &digest }
	listing, err := json.Marshal([]row{
		{Name: recorded, Digest: "d1", CreatedAt: old, ParentDigest: parent("d7")},
		{Name: inUse, Digest: "d2", CreatedAt: old},
		{Name: machine, Digest: "d3", CreatedAt: old},
		{Name: leakParent, Digest: "d4", CreatedAt: old},
		{Name: leakChild, Digest: "d5", CreatedAt: old, ParentDigest: parent("d4")},
		{Name: building, Digest: "d6", CreatedAt: young},
		{Name: base, Digest: "d7", CreatedAt: old},
		{Name: unrecorded, Digest: "d9", CreatedAt: old},
		{Name: other, Digest: "d8", CreatedAt: old},
	})
	require.NoError(t, err)
	home := filepath.Join(dir, "home")
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".microsandbox"), 0o700))
	removed := filepath.Join(dir, "removed")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "snapshots.json"), listing, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "machines.json"), []byte(`[{"name":"smthrs-ws-bbbbbbbb-c18a0e698bbdb51ddcbe","status":"Stopped"}]`), 0o600))
	binary := filepath.Join(dir, "msb")
	script := "#!/bin/sh\ncase \"$*\" in\n" +
		"\"snapshot list --format json\") cat '" + filepath.Join(dir, "snapshots.json") + "' ;;\n" +
		"\"list --format json\") cat '" + filepath.Join(dir, "machines.json") + "' ;;\n" +
		"\"snapshot remove -q \"*) echo \"$4\" >> '" + removed + "' ;;\n" +
		"*) exit 3 ;;\nesac\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))

	report, err := collectSnapshots(t.Context(), &cli{binary: binary, home: home}, []string{root, filepath.Join(dir, "gone", "microvm")}, time.Hour, now)
	require.NoError(t, err)
	require.Equal(t, []string{leakChild, unrecorded, leakParent}, report.Removed, "sorted by name")
	order, err := os.ReadFile(removed)
	require.NoError(t, err)
	lines := strings.Fields(string(order))
	require.ElementsMatch(t, report.Removed, lines)
	require.Less(t, indexOf(lines, leakChild), indexOf(lines, leakParent), "a child goes first")
	require.Equal(t, map[string]string{
		recorded: "referenced",
		inUse:    "referenced",
		machine:  "its install has a machine",
		building: "younger than 1h0m0s",
		base:     "a kept snapshot is taken on top of it",
	}, report.Kept)
}

// An unreadable root may reference anything: nothing is removed.
func TestCollectSnapshotsRefusesAnUnreadableRoot(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "microvm")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "layers"), 0o700))
	record := filepath.Join(root, "layers", "x.json")
	require.NoError(t, os.WriteFile(record, []byte(`{}`), 0o000))
	if contents, err := os.ReadFile(record); err == nil {
		t.Skipf("running with permission to read %s (%d bytes)", record, len(contents))
	}
	binary := filepath.Join(dir, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexit 3\n"), 0o700))
	_, err := collectSnapshots(t.Context(), &cli{binary: binary, home: dir}, []string{root}, time.Hour, time.Now())
	require.Error(t, err)
}

func indexOf(values []string, value string) int {
	for i, candidate := range values {
		if candidate == value {
			return i
		}
	}
	return -1
}
