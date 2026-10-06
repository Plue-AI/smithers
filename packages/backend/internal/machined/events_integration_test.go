package machined

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type fixtureBurstActors struct{}

func (fixtureBurstActors) ResolveBurstActor(_ context.Context, _ string, a wire.Actor) (json.RawMessage, error) {
	if a.Kind != 4 {
		return nil, ErrUnauthorized
	}
	return json.RawMessage(`{"kind":"outside"}`), nil
}
func burstFrame(t *testing.T, b wire.Burst) wire.Frame {
	t.Helper()
	list := wire.U16(uint16(len(b.Files)))
	for _, f := range b.Files {
		change := map[string]byte{"added": 1, "modified": 2, "deleted": 3, "renamed": 4}[f.Change]
		fields := [][]byte{wire.Field(1, wire.String(f.Path)), wire.Field(2, []byte{change})}
		if f.RenamedTo != "" {
			fields = append(fields, wire.Field(3, wire.String(f.RenamedTo)))
		}
		for _, v := range []struct {
			tag   byte
			value string
		}{{4, f.BeforeBlob}, {5, f.AfterBlob}, {6, f.PostDigest}} {
			if v.value != "" {
				raw, e := hex.DecodeString(v.value)
				require.NoError(t, e)
				fields = append(fields, wire.Field(v.tag, raw))
			}
		}
		list = append(list, wire.Struct(fields...)...)
	}
	commit, e := hex.DecodeString(b.VersionsCommit)
	require.NoError(t, e)
	actor := wire.Union(4)
	switch b.Actor.Kind {
	case 1:
		actor = wire.Union(1, wire.Field(1, wire.Bytes(b.Actor.Principal)))
	case 2:
		actor = wire.Union(2, wire.Field(1, wire.U32(b.Actor.Session)))
	case 3:
		actor = wire.Union(3, wire.Field(1, wire.String(b.Actor.Run)))
	}
	f := wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(b.Sequence)), wire.Field(2, b.EventID[:]), wire.Field(3, wire.Union(1, wire.Field(1, b.ID[:]), wire.Field(2, actor), wire.Field(3, list), wire.Field(4, commit))))}
	encoded, e := wire.Encode(f)
	require.NoError(t, e)
	f, e = wire.Decode(encoded)
	require.NoError(t, e)
	return f
}
func fixtureVersions(t *testing.T) (GitBurstObjects, wire.Burst) {
	t.Helper()
	dir := t.TempDir()
	git := func(input string, args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir=" + dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.com", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.com")
		cmd.Stdin = strings.NewReader(input)
		out, e := cmd.CombinedOutput()
		require.NoError(t, e, string(out))
		return strings.TrimSpace(string(out))
	}
	git("", "init", "--bare")
	before := git("before\n", "hash-object", "-w", "--stdin")
	after := git("after\n", "hash-object", "-w", "--stdin")
	a := git("100644 blob "+before+"\ta.ts\n", "mktree")
	b := git("100644 blob "+after+"\ta.ts\n", "mktree")
	tree := git("040000 tree "+a+"\ta\n040000 tree "+b+"\tb\n", "mktree")
	commit := git("versions\n", "commit-tree", tree)
	digest := sha256.Sum256([]byte("after\n"))
	return GitBurstObjects{Directory: dir}, wire.Burst{Sequence: 1, EventID: [16]byte{1}, ID: [16]byte{2}, Actor: wire.Actor{Kind: 4}, VersionsCommit: commit, Files: []wire.BurstFile{{Path: "a.ts", Change: "modified", BeforeBlob: before, AfterBlob: after, PostDigest: hex.EncodeToString(digest[:])}}}
}
func eventPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL required")
	}
	ctx := context.Background()
	admin, e := pgx.Connect(ctx, url)
	require.NoError(t, e)
	name := "fr_t_col_04_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, e = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, e)
	cfg, e := pgxpool.ParseConfig(url)
	require.NoError(t, e)
	cfg.ConnConfig.Database = name
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, e)
	t.Cleanup(func() {
		pool.Close()
		_, e := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize())
		require.NoError(t, e)
		admin.Close(ctx)
	})
	_, e = pool.Exec(ctx, "CREATE TABLE workspaces(id uuid PRIMARY KEY)")
	require.NoError(t, e)
	paths, e := filepath.Glob("../../db/product/migrations/*.sql")
	require.NoError(t, e)
	installed := 0
	for _, file := range paths {
		sql, e := os.ReadFile(file)
		require.NoError(t, e)
		if !strings.Contains(string(sql), "CREATE TABLE product_job_streams (") && !strings.Contains(string(sql), "CREATE TABLE burst_files (") {
			continue
		}
		_, e = pool.Exec(ctx, string(sql))
		require.NoError(t, e)
		installed++
	}
	require.Equal(t, 2, installed)
	return pool
}
func TestBurstIngestPostgres(t *testing.T) {
	ctx := context.Background()
	pool := eventPool(t)
	store, b := fixtureVersions(t)
	branch := uuid.NewString()
	_, err := pool.Exec(ctx, "INSERT INTO workspaces VALUES($1)", branch)
	require.NoError(t, err)
	r := &Registry{}
	boot := [16]byte{9}
	require.NoError(t, r.BindBoot(branch, "machine", boot, []byte("secret")))
	c, err := r.Admit(boot, []byte("secret"), io.NopCloser(strings.NewReader("")))
	require.NoError(t, err)
	require.NoError(t, c.Reconciled())
	events := &Events{Pool: pool, Objects: store, Actors: fixtureBurstActors{}, Isolated: true, Scope: jobs.Scope{TenantID: "repo:1", PrincipalID: "todo:1"}}
	count := func(table string, n int) {
		t.Helper()
		var got int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&got))
		require.Equal(t, n, got)
	}
	frame := burstFrame(t, b)
	t.Run("unavailable and cross branch", func(t *testing.T) {
		events.Isolated = false
		_, err = events.Ingest(ctx, c, branch, frame)
		require.ErrorIs(t, err, ErrNotReady)
		events.Isolated = true
		_, err = events.Ingest(ctx, c, uuid.NewString(), frame)
		require.ErrorIs(t, err, ErrUnauthorized)
		count("machine_event_receipts", 0)
		count("product_job_events", 0)
	})
	t.Run("unregistered actor", func(t *testing.T) {
		spoof := b
		spoof.Actor = wire.Actor{Kind: 1, Principal: []byte("Maya")}
		_, err := events.Ingest(ctx, c, branch, burstFrame(t, spoof))
		require.ErrorIs(t, err, ErrUnauthorized)
		count("machine_event_receipts", 0)
		count("product_job_events", 0)
	})
	t.Run("missing objects", func(t *testing.T) {
		missing := b
		missing.VersionsCommit = strings.Repeat("a", 40)
		ack, err := events.Ingest(ctx, c, branch, burstFrame(t, missing))
		require.NoError(t, err)
		want, err := wire.BurstAck(1, 3, []string{strings.Repeat("a", 40)})
		require.NoError(t, err)
		require.Equal(t, want, ack)
		count("machine_event_receipts", 0)
	})
	t.Run("bad digest", func(t *testing.T) {
		bad := b
		bad.Files = append([]wire.BurstFile(nil), b.Files...)
		bad.Files[0].PostDigest = strings.Repeat("0", 64)
		_, err := events.Ingest(ctx, c, branch, burstFrame(t, bad))
		require.ErrorIs(t, err, wire.BadValue)
		count("machine_event_receipts", 0)
	})
	t.Run("rollback", func(t *testing.T) {
		_, err := pool.Exec(ctx, `CREATE FUNCTION refuse_burst() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture failure'; END$$; CREATE TRIGGER refuse BEFORE INSERT ON burst_files FOR EACH ROW EXECUTE FUNCTION refuse_burst()`)
		require.NoError(t, err)
		_, err = events.Ingest(ctx, c, branch, frame)
		require.Error(t, err)
		count("machine_event_receipts", 0)
		count("product_job_events", 0)
		_, err = pool.Exec(ctx, "DROP TRIGGER refuse ON burst_files")
		require.NoError(t, err)
	})
	t.Run("commit failure", func(t *testing.T) {
		_, err := pool.Exec(ctx, `CREATE CONSTRAINT TRIGGER refuse_commit AFTER INSERT ON burst_files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_burst()`)
		require.NoError(t, err)
		_, err = events.Ingest(ctx, c, branch, frame)
		require.Error(t, err)
		count("machine_event_receipts", 0)
		count("product_job_events", 0)
		count("burst_files", 0)
		_, err = pool.Exec(ctx, "DROP TRIGGER refuse_commit ON burst_files")
		require.NoError(t, err)
	})
	t.Run("commit then replay", func(t *testing.T) {
		listener, err := pool.Acquire(ctx)
		require.NoError(t, err)
		defer listener.Release()
		channel := "branch_" + strings.ReplaceAll(branch, "-", "") + "_activity"
		_, err = listener.Exec(ctx, "LISTEN "+pgx.Identifier{channel}.Sanitize())
		require.NoError(t, err)
		ack, err := events.Ingest(ctx, c, branch, frame)
		require.NoError(t, err)
		want, err := wire.BurstAck(1, 1, nil)
		require.NoError(t, err)
		require.Equal(t, want, ack)
		wait, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		notification, err := listener.Conn().WaitForNotification(wait)
		require.NoError(t, err)
		require.Equal(t, channel, notification.Channel)
		count("burst_files", 1)
		count("product_job_events", 1)
		count("machine_event_receipts", 1)
		queries := db.New(pool)
		file, readErr := queries.GetBurstFile(ctx, db.GetBurstFileParams{BranchID: branch, BurstID: uuid.UUID(b.ID).String(), Path: "a.ts"})
		require.NoError(t, readErr)
		require.Equal(t, b.Files[0].BeforeBlob, file.BeforeBlob.String)
		files, readErr := queries.ListBurstFiles(ctx, db.ListBurstFilesParams{BranchID: branch, BurstID: uuid.UUID(b.ID).String()})
		require.NoError(t, readErr)
		require.Len(t, files, 1)
		_, readErr = queries.GetBurstFile(ctx, db.GetBurstFileParams{BranchID: uuid.NewString(), BurstID: uuid.UUID(b.ID).String(), Path: "a.ts"})
		require.ErrorIs(t, readErr, pgx.ErrNoRows)
		var digest string
		require.NoError(t, pool.QueryRow(ctx, "SELECT after_digest FROM burst_files").Scan(&digest))
		require.Equal(t, b.Files[0].PostDigest, digest)
		ack, err = events.Ingest(ctx, c, branch, frame)
		require.NoError(t, err)
		want, err = wire.BurstAck(1, 2, nil)
		require.NoError(t, err)
		require.Equal(t, want, ack)
		replay := b
		replay.Sequence = 2
		replay.EventID = [16]byte{3}
		_, err = events.Ingest(ctx, c, branch, burstFrame(t, replay))
		require.NoError(t, err)
		count("burst_files", 1)
		count("product_job_events", 1)
		count("machine_event_receipts", 2)
		replay.Sequence = 3
		_, err = events.Ingest(ctx, c, branch, burstFrame(t, replay))
		require.ErrorIs(t, err, wire.BadValue)
		require.NoError(t, c.Close())
		out, err := store.git(ctx, "show", fmt.Sprintf("refs/smithers/branches/%s/bursts/%s:a/a.ts", branch, uuid.UUID(b.ID)))
		require.NoError(t, err)
		require.Equal(t, "before\n", string(out))
	})
}
func TestBurstPathAndVersionValidation(t *testing.T) {
	_, b := fixtureVersions(t)
	for _, p := range []string{"../etc/passwd", "/etc/passwd", ".git/config", "a/../b", ".jj/x", ""} {
		t.Run(p, func(t *testing.T) {
			bad := b
			bad.Files = append([]wire.BurstFile(nil), b.Files...)
			bad.Files[0].Path = p
			require.Error(t, validateBurst(bad))
		})
	}
	require.NoError(t, validateBurst(b))
	fragment := b
	fragment.Part, fragment.Parts = 1, 2
	require.ErrorIs(t, validateBurst(fragment), ErrNotReady)
	fragment.Part = 3
	require.ErrorIs(t, validateBurst(fragment), wire.BadValue)
}
