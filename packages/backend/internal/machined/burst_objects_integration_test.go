package machined

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestBurstIngestProductionBoundaryRealObjects(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var user, repoID int64
	var branch string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('w6objects','w6objects') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'objects','objects') RETURNING id`, user).Scan(&repoID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name) VALUES($1,$2,'watch') RETURNING id`, repoID, user).Scan(&branch))
	repo := filepath.Join(t.TempDir(), "store.git")
	git := func(input string, args ...string) string {
		cmd := hostexec.Git(ctx, append([]string{"-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-C", repo}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	cmd := hostexec.Git(ctx, "init", "--bare", repo)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", out)
	before := git("before\n", "hash-object", "-w", "--stdin")
	after := git("after\n", "hash-object", "-w", "--stdin")
	aTree := git("100644 blob "+before+"\ta.ts\n", "mktree")
	bTree := git("100644 blob "+after+"\ta.ts\n", "mktree")
	tree := git("040000 tree "+aTree+"\ta\n040000 tree "+bTree+"\tb\n", "mktree")
	versions := git("versions\n", "commit-tree", tree)
	digest := sha256.Sum256([]byte("after\n"))
	decode := func(s string) []byte { b, e := hex.DecodeString(s); require.NoError(t, e); return b }
	burstID := uuid.New()
	eventID := uuid.New()
	payload := wire.Union(1, wire.Field(1, burstID[:]), wire.Field(2, wire.Union(4)), wire.Field(3, append(wire.U16(1), wire.Struct(wire.Field(1, wire.String("a.ts")), wire.Field(2, []byte{2}), wire.Field(4, decode(before)), wire.Field(5, decode(after)), wire.Field(6, digest[:]))...)), wire.Field(4, decode(versions)))
	registry := &Registry{}
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, daemon := connectTest(t, registry, branch, authority)
	objects := GitBurstObjects{Resolve: func(_ context.Context, id string) (string, error) {
		if id != branch {
			return "", ErrUnauthorized
		}
		return repo, nil
	}}
	ingest := &BurstIngest{Pool: pool, Objects: objects, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
		return json.RawMessage(`{"id":"outside","kind":"outside","via":"tool"}`), nil
	}}
	scope := jobs.Scope{TenantID: fmt.Sprint(repoID), PrincipalID: "branch:" + branch}
	event := Event{Seq: 1, EventID: eventID, Payload: payload}
	// Traverse the real authenticated transport and dispatcher, then inspect the
	// database and retained object independently of the acknowledgement.
	done := make(chan error, 1)
	go func() {
		if e := wire.Write(daemon, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(1)), wire.Field(2, eventID[:]), wire.Field(3, payload))}); e != nil {
			done <- e
			return
		}
		frame, e := wire.Read(daemon)
		if e == nil {
			if frame.Kind != wire.Events || len(frame.Payload) == 0 || frame.Payload[0] != 3 {
				e = fmt.Errorf("unexpected acknowledgement")
			} else {
				fields, decodeErr := wire.Fields("ack", frame.Payload[1:])
				e = decodeErr
				if e == nil && (len(fields[2]) != 1 || fields[2][0] != byte(AckApplied)) {
					e = fmt.Errorf("burst was not acknowledged as applied")
				}
			}
		}
		done <- e
	}()
	// The same production event pump handles bursts and capture/reconcile
	// events. It must not route a burst through the generic receipt writer.
	pump := &Ingestor{Pool: pool, Bursts: ingest}
	dispatchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	dispatched := make(chan error, 1)
	go func() { dispatched <- pump.Dispatch(dispatchCtx, link, branch) }()
	require.NoError(t, <-done)
	ack, err := ingest.Apply(ctx, link.Connection, scope, event)
	require.NoError(t, err)
	require.Equal(t, AckDuplicate, ack.Outcome)
	t.Cleanup(func() {
		cancel()
		require.ErrorIs(t, <-dispatched, context.Canceled)
	})
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&count))
	require.Equal(t, 1, count)
	ref := "refs/smithers/branches/" + branch + "/bursts/" + burstID.String()
	git("", "gc", "--prune=now")
	require.Equal(t, "before", git("", "show", ref+":a/a.ts"))
	require.Equal(t, "after", git("", "show", ref+":b/a.ts"))

	for name, mutate := range map[string]func(*wire.Burst){
		"traversal":           func(b *wire.Burst) { b.Files[0].Path = "../a.ts" },
		"duplicate":           func(b *wire.Burst) { b.Files = append(b.Files, b.Files[0]) },
		"missing_tree_entry":  func(b *wire.Burst) { b.Files[0].Path = "other.ts" },
		"unlisted_tree_entry": func(b *wire.Burst) { b.Files[0].BeforeBlob = "" },
		"non_object":          func(b *wire.Burst) { b.Versions = "--help" },
		"wrong_object_type":   func(b *wire.Burst) { b.Versions = after },
	} {
		t.Run(name, func(t *testing.T) {
			b, e := wire.DecodeBurst(payload)
			require.NoError(t, e)
			mutate(&b)
			_, e = objects.VerifyBurst(ctx, branch, b)
			require.ErrorIs(t, e, wire.BadValue)
		})
	}
	require.ErrorIs(t, objects.PublishBurst(ctx, "foreign", burstID.String(), versions), ErrUnauthorized)
	require.ErrorIs(t, objects.PublishBurst(ctx, branch, "../escape", versions), wire.BadValue)
	b, err := wire.DecodeBurst(payload)
	require.NoError(t, err)
	b.Files[0].PostDigest = strings.Repeat("0", 64)
	_, err = objects.VerifyBurst(ctx, branch, b)
	require.ErrorIs(t, err, wire.BadValue)
	b, _ = wire.DecodeBurst(payload)
	b.Versions = strings.Repeat("0", 40)
	missing, err := objects.VerifyBurst(ctx, branch, b)
	require.NoError(t, err)
	require.Equal(t, []string{b.Versions}, missing)
	b, _ = wire.DecodeBurst(payload)
	b.Versions = git("child\n", "commit-tree", tree, "-p", versions)
	_, err = objects.VerifyBurst(ctx, branch, b)
	require.ErrorIs(t, err, wire.BadValue)
	require.Error(t, objects.PublishBurst(ctx, branch, burstID.String(), b.Versions))
	require.Equal(t, versions, git("", "rev-parse", ref))
	b, _ = wire.DecodeBurst(payload)
	b.Files[0].BeforeBlob = after
	_, err = objects.VerifyBurst(ctx, branch, b)
	require.ErrorIs(t, err, wire.BadValue)
}

func TestBurstObjectOutputBound(t *testing.T) {
	out := &boundedObjectOutput{remaining: 3}
	n, err := out.Write([]byte("abc"))
	require.NoError(t, err)
	require.Equal(t, 3, n)
	n, err = out.Write([]byte("d"))
	require.Error(t, err)
	require.Zero(t, n)
	require.Equal(t, "abc", out.String())
}
