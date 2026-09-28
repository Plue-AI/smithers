package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// gitDirHost serves upload-pack for owner/repo from local bare repositories
// with the real git binary, the way repo-host serves the smart protocol.
type gitDirHost struct {
	dirs map[string]string
}

func (h gitDirHost) dir(owner, repo string) (string, error) {
	dir, ok := h.dirs[owner+"/"+repo]
	if !ok {
		return "", fmt.Errorf("no repository %s/%s", owner, repo)
	}
	return dir, nil
}

func (h gitDirHost) InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error) {
	dir, err := h.dir(owner, repo)
	if err != nil {
		return nil, err
	}
	return exec.CommandContext(ctx, "git", "upload-pack", "--stateless-rpc", "--advertise-refs", dir).Output()
}

func (h gitDirHost) ProxyUploadPackBody(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
	dir, err := h.dir(owner, repo)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "git", "upload-pack", "--stateless-rpc", dir)
	cmd.Stdin, cmd.Stdout = body, stdout
	return cmd.Run()
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@example.com", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@example.com")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

// untar reads a gzip-compressed tar archive into path -> contents.
func untar(t *testing.T, archive []byte) map[string][]byte {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	require.NoError(t, err)
	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return files
		}
		require.NoError(t, err)
		body, err := io.ReadAll(tr)
		require.NoError(t, err)
		files[header.Name] = body
	}
}

func TestAdminExportUserArchivesOwnedDataWithManifest(t *testing.T) {
	pool := setupTestPool(t)
	ctx := ContextWithAdminAuditActor(context.Background(), AdminAuditActor{UserID: 0, Username: "ops-admin"})
	base := time.Now().UnixNano()
	a, b := base, base+1
	aName, bName := fmt.Sprintf("export-a-%d", base), fmt.Sprintf("export-b-%d", base)
	run := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	id := func(sql string, args ...any) int64 {
		t.Helper()
		var n int64
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n), sql)
		return n
	}
	run(`INSERT INTO users(id,username,lower_username,email,lower_email,display_name,bio) VALUES ($1,$2,$2,$3,$3,'Alice Example','alice bio')`, a, aName, aName+"@example.com")
	run(`INSERT INTO users(id,username,lower_username,email,lower_email) VALUES ($1,$2,$2,$3,$3)`, b, bName, bName+"@example.com")
	run(`INSERT INTO ssh_keys(user_id,name,fingerprint,public_key) VALUES ($1,'laptop',$2,'ssh-ed25519 AAAA')`, a, fmt.Sprintf("SHA256:%d", base))
	aRepo := id(`INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'a-repo','a-repo') RETURNING id`, a)
	id(`INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'a-empty','a-empty') RETURNING id`, a)
	bRepo := id(`INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'b-repo','b-repo') RETURNING id`, b)
	aIssue := id(`INSERT INTO issues(repository_id,number,title,body,author_id) VALUES ($1,1,'a issue','a body',$2) RETURNING id`, aRepo, a)
	run(`INSERT INTO issue_comments(issue_id,user_id,body) VALUES ($1,$2,'b on a')`, aIssue, b)
	bIssue := id(`INSERT INTO issues(repository_id,number,title,author_id) VALUES ($1,1,'b issue',$2) RETURNING id`, bRepo, b)
	run(`INSERT INTO issue_comments(issue_id,user_id,body) VALUES ($1,$2,'a on b')`, bIssue, a)
	landing := id(`INSERT INTO landing_requests(repository_id,number,title,author_id,target_bookmark) VALUES ($1,2,'a landing',$2,'main') RETURNING id`, aRepo, a)
	run(`INSERT INTO landing_request_comments(landing_request_id,user_id,path,line,body) VALUES ($1,$2,'README',1,'a review note')`, landing, a)
	definition := id(`INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES ($1,'ci','.smithers/ci.ts','{}') RETURNING id`, aRepo)
	run(`INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event,trigger_ref) VALUES ($1,$2,'success','push','main')`, aRepo, definition)
	run(`INSERT INTO agent_sessions(id,repository_id,user_id,title,status) VALUES ($1,$2,$3,'fix bug','completed')`, uuid.NewString(), bRepo, a)

	// a-repo has history on two bookmarks; a-empty has none.
	root := t.TempDir()
	work := filepath.Join(root, "work")
	require.NoError(t, os.Mkdir(work, 0o755))
	runGit(t, work, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(work, "README"), []byte("hello\n"), 0o644))
	runGit(t, work, "add", "README")
	runGit(t, work, "commit", "-q", "-m", "first")
	runGit(t, work, "checkout", "-q", "-b", "feature")
	require.NoError(t, os.WriteFile(filepath.Join(work, "README"), []byte("hello feature\n"), 0o644))
	runGit(t, work, "commit", "-q", "-am", "feature")
	runGit(t, work, "checkout", "-q", "main")
	mainSHA, featureSHA := runGit(t, work, "rev-parse", "main"), runGit(t, work, "rev-parse", "feature")
	runGit(t, root, "clone", "-q", "--bare", work, "a-repo.git")
	runGit(t, root, "init", "-q", "--bare", "a-empty.git")
	host := gitDirHost{dirs: map[string]string{
		aName + "/a-repo":  filepath.Join(root, "a-repo.git"),
		aName + "/a-empty": filepath.Join(root, "a-empty.git"),
	}}

	svc := NewAdminUserService(db.New(pool), WithAccountExport(AccountExport{Pool: pool, Git: host}))
	var archive bytes.Buffer
	manifest, err := svc.ExportUser(ctx, strings.ToUpper(aName), &archive)
	require.NoError(t, err)
	require.Equal(t, a, manifest.UserID)
	require.Equal(t, aName, manifest.Username)

	files := untar(t, archive.Bytes())
	// The manifest in the archive is the one returned, and it lists every
	// other file with its size and digest.
	var archived AccountExportManifest
	require.NoError(t, json.Unmarshal(files["manifest.json"], &archived))
	require.Equal(t, manifest.Files, archived.Files)
	listed := map[string]AccountExportFile{}
	for _, file := range manifest.Files {
		listed[file.Path] = file
		body, ok := files[file.Path]
		require.True(t, ok, "%s is listed but missing", file.Path)
		sum := sha256.Sum256(body)
		require.Equal(t, hex.EncodeToString(sum[:]), file.SHA256, file.Path)
		require.Equal(t, int64(len(body)), file.Bytes, file.Path)
	}
	for path := range files {
		if path != "manifest.json" {
			require.Contains(t, listed, path, "%s is archived but not listed", path)
		}
	}
	paths := make([]string, 0, len(listed))
	for path := range listed {
		paths = append(paths, path)
	}
	require.ElementsMatch(t, []string{"profile.json", "repositories.json", "issues.json", "comments.json", "landing_requests.json", "runs.json", "repositories/a-repo.bundle"}, paths)
	require.Equal(t, 2, listed["repositories.json"].Records)
	require.Equal(t, []AccountExportRepository{{Name: "a-empty", Refs: 0}, {Name: "a-repo", Refs: 3, Bundle: "repositories/a-repo.bundle"}}, manifest.Repositories)

	var profile map[string]any
	require.NoError(t, json.Unmarshal(files["profile.json"], &profile))
	require.Equal(t, aName+"@example.com", profile["email"])
	require.Equal(t, "alice bio", profile["bio"])
	require.Len(t, profile["ssh_keys"], 1)

	items := func(path string) []map[string]any {
		t.Helper()
		var out []map[string]any
		require.NoError(t, json.Unmarshal(files[path], &out), path)
		require.Equal(t, len(out), listed[path].Records, path)
		return out
	}
	issues := items("issues.json")
	require.Len(t, issues, 1)
	require.Equal(t, "a issue", issues[0]["title"])
	require.Equal(t, aName+"/a-repo", issues[0]["repository"])
	comments := items("comments.json")
	require.Len(t, comments, 2, "A's own comments only; B's comment in A's repository is B's")
	require.Equal(t, []any{"a on b", "a review note"}, []any{comments[0]["body"], comments[1]["body"]})
	require.Equal(t, bName+"/b-repo", comments[0]["repository"])
	landings := items("landing_requests.json")
	require.Len(t, landings, 1)
	require.Equal(t, "a landing", landings[0]["title"])
	runs := items("runs.json")
	require.Len(t, runs, 2)
	require.ElementsMatch(t, []any{"workflow_run", "agent_session"}, []any{runs[0]["kind"], runs[1]["kind"]})

	// The bundle clones with every bookmark at its source commit.
	bundle := filepath.Join(root, "a-repo.bundle")
	require.NoError(t, os.WriteFile(bundle, files["repositories/a-repo.bundle"], 0o644))
	runGit(t, root, "clone", "-q", bundle, "restored")
	restored := filepath.Join(root, "restored")
	require.Equal(t, mainSHA, runGit(t, restored, "rev-parse", "HEAD"))
	require.Equal(t, featureSHA, runGit(t, restored, "rev-parse", "origin/feature"))

	var operator string
	var records int
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata->>'operator', (metadata->>'files')::int FROM audit_log
		WHERE event_type='admin.user.export' AND target_id=$1`, a).Scan(&operator, &records))
	require.Equal(t, "ops-admin", operator)
	require.Equal(t, len(manifest.Files), records)

	_, err = svc.ExportUser(ctx, "never-existed-"+aName, io.Discard)
	require.True(t, isNotFound(err), "an unknown username is not found, got %v", err)
	gone := base + 5
	tombstone := erasedUserPrefixFor(fmt.Sprintf("gone-%d", base)) + fmt.Sprint(gone)
	run(`INSERT INTO users(id,username,lower_username,deleted_at,is_active) VALUES ($1,$2,$2,now(),false)`, gone, tombstone)
	_, err = svc.ExportUser(ctx, tombstone, io.Discard)
	require.True(t, isNotFound(err), "an erased account has nothing to export, got %v", err)
}
