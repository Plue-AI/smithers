package machined

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// K4 host-ingest qualification only. The peer supplies fixed burst bytes rather
// than a real guest watcher; this does not claim the complete C-DUR-04 matrix.
func TestFaultK4HostCommitBeforeAck(t *testing.T) {
	for run := 1; run <= 10; run++ {
		t.Run(fmt.Sprint(run), func(t *testing.T) {
			pool, database := postgresfixture.NewProductDatabase(t)
			ctx := t.Context()
			var user, repository int64
			var branch string
			require.NoError(t, pool.QueryRow(ctx, "INSERT INTO users(username,lower_username) VALUES('fault','fault') RETURNING id").Scan(&user))
			require.NoError(t, pool.QueryRow(ctx, "INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'fault','fault') RETURNING id", user).Scan(&repository))
			require.NoError(t, pool.QueryRow(ctx, "INSERT INTO workspaces(repository_id,user_id,name) VALUES($1,$2,'fault') RETURNING id", repository, user).Scan(&branch))
			store := filepath.Join(t.TempDir(), "store.git")
			git := func(input string, args ...string) string {
				cmd := hostexec.Git(ctx, append([]string{"-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-C", store}, args...)...)
				cmd.Stdin = strings.NewReader(input)
				out, err := cmd.CombinedOutput()
				require.NoError(t, err, "%s", out)
				return strings.TrimSpace(string(out))
			}
			out, err := hostexec.Git(ctx, "init", "--bare", store).CombinedOutput()
			require.NoError(t, err, "%s", out)
			before := git("before\n", "hash-object", "-w", "--stdin")
			after := git("acknowledged bytes\n", "hash-object", "-w", "--stdin")
			decode := func(s string) []byte { b, e := hex.DecodeString(s); require.NoError(t, e); return b }
			digest := sha256.Sum256([]byte("acknowledged bytes\n"))
			files := wire.U16(20)
			var a, b strings.Builder
			for i := 0; i < 20; i++ {
				path := fmt.Sprintf("file-%02d.ts", i)
				fmt.Fprintf(&a, "100644 blob %s\t%s\n", before, path)
				fmt.Fprintf(&b, "100644 blob %s\t%s\n", after, path)
				files = append(files, wire.Struct(wire.Field(1, wire.String(path)), wire.Field(2, []byte{2}), wire.Field(4, decode(before)), wire.Field(5, decode(after)), wire.Field(6, digest[:]))...)
			}
			at := git(a.String(), "mktree")
			bt := git(b.String(), "mktree")
			tree := git("040000 tree "+at+"\ta\n040000 tree "+bt+"\tb\n", "mktree")
			versions := git("versions\n", "commit-tree", tree)
			burst, eventID := uuid.New(), uuid.New()
			payload := wire.Union(1, wire.Field(1, burst[:]), wire.Field(2, wire.Union(4)), wire.Field(3, files), wire.Field(4, decode(versions)))
			event := Event{Seq: 1, EventID: eventID, Payload: payload}
			childCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			child := exec.CommandContext(childCtx, os.Args[0], "-test.run=^TestFaultK4HostChild$", "-test.v")
			child.Env = append(os.Environ(), "SMITHERS_K4_DATABASE="+database, "SMITHERS_K4_BRANCH="+branch, "SMITHERS_K4_STORE="+store, "SMITHERS_K4_EVENT="+eventID.String(), "SMITHERS_K4_PAYLOAD="+base64.StdEncoding.EncodeToString(payload))
			output, err := child.CombinedOutput()
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit, "%s", output)
			require.Equal(t, 73, exit.ExitCode(), "%s", output)
			// Inspect before replay: process exit must have left a complete transaction.
			counts := func() {
				for table, want := range map[string]int{"product_job_events": 1, "burst_files": 20, "machine_event_receipts": 1} {
					var count int
					require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
					require.Equal(t, want, count, table)
				}
			}
			counts()
			runK4Dispatch(t, pool, branch, store, event, false)
			runK4Dispatch(t, pool, branch, store, event, false)
			counts()
			rows, err := pool.Query(ctx, "SELECT path,before_blob,after_blob,post_digest FROM burst_files ORDER BY path")
			require.NoError(t, err)
			defer rows.Close()
			n := 0
			for rows.Next() {
				var path, old, new, d string
				require.NoError(t, rows.Scan(&path, &old, &new, &d))
				require.Equal(t, fmt.Sprintf("file-%02d.ts", n), path)
				require.Equal(t, before, old)
				require.Equal(t, after, new)
				require.Equal(t, hex.EncodeToString(digest[:]), d)
				n++
			}
			require.NoError(t, rows.Err())
			require.Equal(t, 20, n)
			ref := "refs/smithers/branches/" + branch + "/bursts/" + burst.String()
			git("", "gc", "--prune=now")
			require.Equal(t, versions, git("", "rev-parse", ref))
			t.Logf("K4 run=%d branch=%s burst=%s event=%s versions=%s after_sha256=%s rows=1 files=20 receipts=1 replay=duplicate twice", run, branch, burst, eventID, versions, hex.EncodeToString(digest[:]))
			for i := 0; i < 20; i++ {
				path := fmt.Sprintf("file-%02d.ts", i)
				require.Equal(t, "before", git("", "show", ref+":a/"+path))
				require.Equal(t, "acknowledged bytes", git("", "show", ref+":b/"+path))
			}
		})
	}
}

func runK4Dispatch(t *testing.T, pool *pgxpool.Pool, branch, store string, event Event, kill bool) {
	t.Helper()
	registry := new(Registry)
	authority, err := registry.MintBoot(branch, "vm")
	require.NoError(t, err)
	link, peer := connectTest(t, registry, branch, authority)
	require.NoError(t, link.Reconciled())
	ingest := &BurstIngest{Pool: pool, Objects: GitBurstObjects{Resolve: func(_ context.Context, b string) (string, error) {
		if b != branch {
			return "", ErrUnauthorized
		}
		return store, nil
	}}, ResolveActor: func(context.Context, string, wire.Actor) (json.RawMessage, error) {
		return json.RawMessage(`{"id":"outside","kind":"outside"}`), nil
	}}
	if kill {
		ingest.ObserveCommitted = func() { os.Exit(73) }
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- (&Ingestor{Pool: pool, Bursts: ingest}).Dispatch(ctx, link, branch) }()
	defer func() { cancel(); require.ErrorIs(t, <-done, context.Canceled) }()
	sendConsumerEvent(t, peer, event)
	readConsumerAck(t, peer, event.Seq, AckDuplicate)
}

func TestFaultK4HostChild(t *testing.T) {
	database := os.Getenv("SMITHERS_K4_DATABASE")
	if database == "" {
		return
	}
	pool, err := postgresfixture.Open(t.Context(), database, 2)
	require.NoError(t, err)
	defer pool.Close()
	id, err := uuid.Parse(os.Getenv("SMITHERS_K4_EVENT"))
	require.NoError(t, err)
	payload, err := base64.StdEncoding.DecodeString(os.Getenv("SMITHERS_K4_PAYLOAD"))
	require.NoError(t, err)
	runK4Dispatch(t, pool, os.Getenv("SMITHERS_K4_BRANCH"), os.Getenv("SMITHERS_K4_STORE"), Event{Seq: 1, EventID: id, Payload: payload}, true)
	t.Fatal("K4 failed to exit before acknowledgement")
}
