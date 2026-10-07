package compose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The accepted candidate fixture is transferred through the install's real Git
// door. The HTTP read runs the composed service, real engine and PostgreSQL.
func TestTODOAcceptedDiffComposedInstall(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_GH03_REHEARSAL", "C-J10-01", "gh03-")
	require.True(t, r.setupSource())
	token, err := r.token("write:repository")
	require.NoError(t, err)
	work := filepath.Join(t.TempDir(), "candidate")
	_, err = r.gitDoor(token, "clone", "-q", r.origin+"/rehearsal-owner/app.git", work)
	require.NoError(t, err)
	commit := func(path, content, message string) string {
		require.NoError(t, os.WriteFile(filepath.Join(work, path), []byte(content), 0600))
		_, err := r.gitDoor(token, "-C", work, "add", path)
		require.NoError(t, err)
		_, err = r.gitDoor(token, "-C", work, "commit", "-q", "-m", message)
		require.NoError(t, err)
		head, err := r.gitDoor(token, "-C", work, "rev-parse", "HEAD")
		require.NoError(t, err)
		return head
	}
	prefix := commit("earlier.txt", "earlier item\n", "earlier item")
	head := commit("item.txt", "this item\n", "this item")
	_, err = r.gitDoor(token, "-C", work, "push", "-q", "origin", "HEAD:refs/heads/gh03-candidate")
	require.NoError(t, err)
	var repository int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT id FROM repositories WHERE name='app'`).Scan(&repository))
	_, err = r.pool.Exec(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,issue_title,checks,candidate_base,candidate_head,candidate_verified) VALUES ($1,'todo','blocked','Diff fixture','{"branch":"smithers/diff-fixture"}',$2,$3,true)`, repository, prefix, head)
	require.NoError(t, err)
	data, err := r.expect("GET", "/api/branches/smithers%2Fdiff-fixture/diff", "", 200)
	require.NoError(t, err)
	var response struct {
		Files []struct {
			Path    string
			Against struct{ Kind, Rev string }
			Hunks   []struct{ Lines []struct{ Op, Text string } }
		}
	}
	require.NoError(t, json.Unmarshal(data, &response))
	require.Len(t, response.Files, 1)
	require.Equal(t, "item.txt", response.Files[0].Path)
	require.Equal(t, "item_base", response.Files[0].Against.Kind)
	require.Equal(t, prefix, response.Files[0].Against.Rev)
	require.Len(t, response.Files[0].Hunks, 1)
	require.Equal(t, "+", response.Files[0].Hunks[0].Lines[0].Op)
	require.Equal(t, "this item", response.Files[0].Hunks[0].Lines[0].Text)
	for _, selector := range []string{"entry=burst-1", "snapshot_before=before&snapshot_after=after"} {
		data, err := r.expect("GET", "/api/branches/smithers%2Fdiff-fixture/diff?"+selector, "", 400)
		require.NoError(t, err)
		require.JSONEq(t, `{"code":"bad_request","class":"user","message":"Unsupported diff selector"}`, string(data))
	}
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET candidate_verified=false WHERE repository_id=$1 AND issue_title='Diff fixture'`, repository)
	require.NoError(t, err)
	_, err = r.expect("GET", "/api/branches/smithers%2Fdiff-fixture/diff", "", 503)
	require.NoError(t, err)
	_, err = r.expect("GET", "/api/branches/missing/diff", "", 404)
	require.NoError(t, err)
}
