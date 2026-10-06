package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Composed /api/live consumes verified host-store versions while the branch sleeps.
// This fixture supplies the remote burst; it does not claim a real watcher run.
func TestBranchChangesProductionLiveBoundary(t *testing.T) {
	f := presenceInstall(t)
	registry := &machined.Registry{}
	boot := [16]byte{1}
	secret := []byte("changes-boot")
	require.NoError(t, registry.BindBoot(f.row.ID, "vm", boot, secret))
	c, err := registry.Admit(boot, secret, io.NopCloser(strings.NewReader("")))
	require.NoError(t, err)
	defer c.Close()
	store := filepath.Join(t.TempDir(), "store.git")
	cmd := hostexec.Git(t.Context(), "init", "--bare", store)
	output, initErr := cmd.CombinedOutput()
	require.NoError(t, initErr, "%s", output)
	git := func(input string, args ...string) string {
		cmd := hostexec.Git(t.Context(), append([]string{"-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-C", store}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	before := git("before\n", "hash-object", "-w", "--stdin")
	after := git("after\n", "hash-object", "-w", "--stdin")
	var a, b strings.Builder
	for i := 0; i < 12; i++ {
		fmt.Fprintf(&a, "100644 blob %s\tf%d.ts\n", before, i)
		fmt.Fprintf(&b, "100644 blob %s\tf%d.ts\n", after, i)
	}
	aSrc := git(a.String(), "mktree")
	bSrc := git(b.String(), "mktree")
	aTree := git("040000 tree "+aSrc+"\tsrc\n", "mktree")
	bTree := git("040000 tree "+bSrc+"\tsrc\n", "mktree")
	tree := git("040000 tree "+aTree+"\ta\n040000 tree "+bTree+"\tb\n", "mktree")
	versions := git("versions\n", "commit-tree", tree)
	bytesOf := func(s string) []byte { b, e := hex.DecodeString(s); require.NoError(t, e); return b }
	post := sha256.Sum256([]byte("after\n"))
	ingest := &machined.BurstIngest{Pool: f.pool, Objects: machined.GitBurstObjects{Resolve: func(_ context.Context, branch string) (string, error) {
		if branch != f.row.ID {
			return "", machined.ErrUnauthorized
		}
		return store, nil
	}}, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
		return json.RawMessage(`{"id":"member:1","kind":"person","member_id":"1","via":"ssh"}`), nil
	}}
	list := wire.U16(12)
	for i := 0; i < 12; i++ {
		list = append(list, wire.Struct(wire.Field(1, wire.String(fmt.Sprintf("src/f%d.ts", i))), wire.Field(2, []byte{2}), wire.Field(4, bytesOf(before)), wire.Field(5, bytesOf(after)), wire.Field(6, post[:]))...)
	}
	id := [16]byte{2}
	payload := wire.Union(1, wire.Field(1, id[:]), wire.Field(2, wire.Union(2, wire.Field(1, wire.U32(1)))), wire.Field(3, list), wire.Field(4, bytesOf(versions)))
	event := machined.Event{Seq: 1, EventID: [16]byte{3}, Payload: payload}
	scope := jobs.Scope{TenantID: fmt.Sprint(f.row.RepositoryID), PrincipalID: "branch:" + f.row.ID}
	ack, err := ingest.Apply(t.Context(), c, scope, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckApplied, ack.Outcome)
	ack, err = ingest.Apply(t.Context(), c, scope, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckDuplicate, ack.Outcome)
	// A sleeping branch still serves its retained file versions and authors.
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET status='suspended' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	git("", "gc", "--prune=now")
	require.Equal(t, "before", git("", "show", "refs/smithers/branches/"+f.row.ID+"/bursts/02000000-0000-0000-0000-000000000000:a/src/f0.ts"))
	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity"}`, f.row.ID))
	activity := readPresenceFrame(t, socket)
	require.Equal(t, "snap", activity.T)
	var entries []struct {
		ID, Kind, Versions string
		Actor              map[string]any
		Files              []map[string]any
	}
	require.NoError(t, json.Unmarshal(activity.Data, &entries))
	require.Len(t, entries, 1)
	require.Equal(t, "burst", entries[0].Kind)
	require.Equal(t, "member:1", entries[0].Actor["id"])
	require.Len(t, entries[0].Files, 12)
	require.Equal(t, before, entries[0].Files[0]["before_blob"])
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":2,"topic":"branch:%s:files"}`, f.row.ID))
	files := readPresenceFrame(t, socket)
	require.Equal(t, "snap", files.T)
	var snapshot struct {
		Changed []struct {
			Path, Change string
			Writer       map[string]any `json:"last_writer"`
		}
		Open []any
	}
	require.NoError(t, json.Unmarshal(files.Data, &snapshot))
	require.Len(t, snapshot.Changed, 12)
	require.Empty(t, snapshot.Open)
	require.Equal(t, "modified", snapshot.Changed[0].Change)
	require.Equal(t, "member:1", snapshot.Changed[0].Writer["id"])
	require.NotNil(t, activity.Cursor)
	require.Equal(t, int64(1), *activity.Cursor)
	nextID := [16]byte{5}
	next := event
	next.Seq = 2
	next.EventID = [16]byte{4}
	next.Payload = wire.Union(1, wire.Field(1, nextID[:]), wire.Field(2, wire.Union(2, wire.Field(1, wire.U32(1)))), wire.Field(3, list), wire.Field(4, bytesOf(versions)))
	_, err = ingest.Apply(t.Context(), c, scope, next)
	require.NoError(t, err)
	resumed := f.dial(t)
	sendPresenceFrame(t, resumed, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity","cursor":1}`, f.row.ID))
	delta := readPresenceFrame(t, resumed)
	require.Equal(t, "delta", delta.T)
	require.Equal(t, int64(2), *delta.Cursor)
	require.NoError(t, json.Unmarshal(delta.Data, &entries))
	require.Len(t, entries, 1)
	require.Equal(t, "05000000-0000-0000-0000-000000000000", entries[0].ID)
	resumed.CloseNow()
	// Cross-repository IDs cannot leak retained versions through the live door.
	sendPresenceFrame(t, socket, `{"t":"sub","id":3,"topic":"branch:11111111-1111-4111-8111-111111111111:activity"}`)
	refused := readPresenceFrame(t, socket)
	require.Equal(t, "err", refused.T)
	socket.CloseNow()
	// A committed replay window of 201 entries must force resubscription.
	for i := 1; i <= 201; i++ {
		id := [16]byte{8, byte(i)}
		next.Seq = uint64(i + 2)
		next.EventID = [16]byte{9, byte(i)}
		next.Payload = wire.Union(1, wire.Field(1, id[:]), wire.Field(2, wire.Union(2, wire.Field(1, wire.U32(1)))), wire.Field(3, list), wire.Field(4, bytesOf(versions)))
		_, err = ingest.Apply(t.Context(), c, scope, next)
		require.NoError(t, err)
	}
	gapSocket := f.dial(t)
	sendPresenceFrame(t, gapSocket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity","cursor":2}`, f.row.ID))
	require.Equal(t, "gap", readPresenceFrame(t, gapSocket).T)
	sendPresenceFrame(t, gapSocket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity"}`, f.row.ID))
	latest := readPresenceFrame(t, gapSocket)
	require.Equal(t, "snap", latest.T)
	require.Equal(t, int64(203), *latest.Cursor)
	require.NoError(t, json.Unmarshal(latest.Data, &entries))
	require.Len(t, entries, 200)
	sendPresenceFrame(t, gapSocket, fmt.Sprintf(`{"t":"sub","id":2,"topic":"branch:%s:activity","cursor":999999}`, f.row.ID))
	require.Equal(t, "gap", readPresenceFrame(t, gapSocket).T)
}
