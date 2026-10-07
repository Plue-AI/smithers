package compose

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// Completed accepted trees are fixture input. Publication, item-only diff,
// fetched containment, mirror sync, Home and the person's OK are production.
func TestTODOGitHubOrderAndShapeComposedInstall(t *testing.T) {
	t.Setenv("REHEARSAL_INSTALLATION_ID", "95")
	t.Setenv("REHEARSAL_PUBLIC_REPOSITORY", "1")
	r := newRehearsal(t, "SMITHERS_GH03_ORDER_REHEARSAL", "C-STK-04", "gh03-order-", 25)
	r.stepBudget = 2 * time.Minute
	require.True(t, r.setupSource())
	token, err := r.token("write:repository")
	require.NoError(t, err)
	work := filepath.Join(t.TempDir(), "accepted")
	_, err = r.gitDoor(token, "clone", "-q", r.origin+"/rehearsal-owner/app.git", work)
	require.NoError(t, err)
	var repository, owner int64
	require.Eventually(t, func() bool {
		return r.pool.QueryRow(r.ctx, `SELECT repository_id,actor_user_id FROM mythical_stacks WHERE state='active'`).Scan(&repository, &owner) == nil
	}, 30*time.Second, 50*time.Millisecond)
	type accepted struct {
		number, pull       int64
		base, head, branch string
	}
	items := []accepted{}
	base := r.mainCommit
	for i, title := range []string{"First", "Second", "Third"} {
		branch := "smithers/" + strings.ToLower(title)
		require.NoError(t, os.WriteFile(filepath.Join(work, strings.ToUpper(title)+".txt"), []byte(strings.ToLower(title)+"\n"), 0600))
		for _, argv := range [][]string{{"add", "."}, {"commit", "-q", "-m", "accepted " + title}} {
			_, err := r.gitDoor(token, append([]string{"-C", work}, argv...)...)
			require.NoError(t, err)
		}
		head, err := r.gitDoor(token, "-C", work, "rev-parse", "HEAD")
		require.NoError(t, err)
		_, err = r.gitDoor(token, "-C", work, "push", "-q", "origin", "HEAD:refs/heads/order-candidate-"+title)
		require.NoError(t, err)
		pack := exec.Command("/usr/bin/git", "-C", work, "pack-objects", "--stdout")
		pack.Stdin = strings.NewReader("")
		empty, err := pack.Output()
		require.NoError(t, err)
		keep := repohost.MythicalReservedRefNS + "keep/" + head
		update := strings.Repeat("0", 40) + " " + head + " " + keep + "\x00report-status\n"
		request := bytes.NewBufferString(fmt.Sprintf("%04x%s0000", len(update)+4, update))
		request.Write(empty)
		var receipt bytes.Buffer
		require.NoError(t, r.repoClient.ProxyReceivePack(r.ctx, "rehearsal-owner", "app", request, &receipt, repohost.ReceivePackMetadata{RepositoryID: repository, ControlPlane: true, PusherLogin: "fixture"}))
		require.Contains(t, receipt.String(), "ok "+keep)
		var number int64
		err = r.pool.QueryRow(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,issue_title,title,revisions,owner_id,candidate_base,candidate_head,candidate_verified,attempt,checks)
   VALUES ($1,'todo','proposing',$2,$2,jsonb_build_array(jsonb_build_object('rev',1,'text',$3::text,'acceptance',jsonb_build_array('passes'),'by',jsonb_build_object('person','rehearsal-owner'),'at','2026-10-02T12:00:00Z')),$4,$5,$6,true,1,jsonb_build_object('branch',$7::text,'todo',true)) RETURNING number`, repository, title, strings.ToLower(title), owner, base, head, branch).Scan(&number)
		require.NoError(t, err)
		_, err = r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET requested_generation=requested_generation+1,next_attempt_at=clock_timestamp() WHERE repository_id=$1`, repository)
		require.NoError(t, err)
		item := accepted{number: number, base: base, head: head, branch: branch}
		require.Eventually(t, func() bool {
			return r.pool.QueryRow(r.ctx, `SELECT pr_number FROM mythical_items WHERE number=$1 AND state='proposed' AND pending_op IS NULL AND checks->'prManifests' IS NOT NULL`, number).Scan(&item.pull) == nil
		}, 60*time.Second, 100*time.Millisecond, "publication %d", i+1)
		items = append(items, item)
		base = head
	}
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(r.pool, codec)
	connections := services.NewRepoConnectionService(r.pool, credentials)
	access, err := connections.CreateGitHubInstallationToken(r.ctx, 95, services.GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"pull_requests": "write", "contents": "write"}})
	require.NoError(t, err)
	callFake := func(method, path, body string) githubfake.Pull {
		req, err := http.NewRequest(method, r.fake.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+access.Token)
		response, err := r.fake.Client().Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Less(t, response.StatusCode, 300)
		var pull githubfake.Pull
		require.NoError(t, json.NewDecoder(response.Body).Decode(&pull))
		return pull
	}
	for i, item := range items {
		pull := callFake("GET", fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", item.pull), "")
		require.Equal(t, item.branch, pull.Head.Ref)
		require.Equal(t, "main", pull.Base.Ref)
		require.Equal(t, []string{"First", "Second", "Third"}[i], pull.Title)
		require.Equal(t, i > 0, pull.Draft)
		require.Contains(t, pull.Body, "Requested by @rehearsal-owner")
	}
	code, raw, err := r.request("GET", "/api/branches/smithers%2Fsecond/diff", "")
	require.NoError(t, err)
	require.Equal(t, 200, code, string(raw))
	var diff services.BranchDiff
	require.NoError(t, json.Unmarshal(raw, &diff))
	require.Len(t, diff.Files, 1)
	require.Equal(t, "SECOND.txt", diff.Files[0].Path)
	githubLifecycleBrowserPhase(t, r, items[1].number, "shape")
	if os.Getenv("SMITHERS_GH03_BROWSER_PHASE") == "shape" {
		return // Publication and diff have their own browser check; order runs separately.
	}
	var fixingIssue, referenceIssue int64
	if os.Getenv("SMITHERS_GH03_BROWSER_PHASE") == "issue_merge" {
		fixingIssue = r.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Fix first", "first")
		referenceIssue = r.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Reference second", "second")
		_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET issue_number=$2,fixes_issue=$3 WHERE number=$1`, items[0].number, fixingIssue, true)
		require.NoError(t, err)
		_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET issue_number=$2,fixes_issue=$3 WHERE number=$1`, items[1].number, referenceIssue, false)
		require.NoError(t, err)
	}
	second := items[1]
	r.fake.UpdatePull("rehearsal-owner/app", second.pull, func(p *githubfake.Pull) { p.Draft = false })
	pull := callFake("GET", fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", second.pull), "")
	callFake("PUT", fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", second.pull), fmt.Sprintf(`{"sha":%q,"merge_method":"squash"}`, pull.Head.SHA))
	code, _, err = r.keyed("POST", "/api/github/sync", "", "external-order-merge")
	require.NoError(t, err)
	require.Equal(t, 202, code)
	require.Eventually(t, func() bool {
		var count int
		err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items WHERE number=ANY($1) AND state='landed'`, []int64{items[0].number, second.number}).Scan(&count)
		return err == nil && count == 2
	}, 90*time.Second, 100*time.Millisecond)
	if fixingIssue != 0 {
		require.Eventually(t, func() bool {
			fixed, ok := r.fake.Issue("rehearsal-owner/app", fixingIssue)
			return ok && fixed.State == "closed"
		}, 60*time.Second, 100*time.Millisecond)
		referenced, ok := r.fake.Issue("rehearsal-owner/app", referenceIssue)
		require.True(t, ok)
		require.Equal(t, "open", referenced.State)
		// The install issue door reads GitHub through its real provider.
		for issueNumber, expected := range map[int64]string{fixingIssue: "closed", referenceIssue: "open"} {
			code, raw, err := r.request("GET", fmt.Sprintf("/api/issues/%d", issueNumber), "")
			require.NoError(t, err)
			require.Equal(t, 200, code, string(raw))
			var thread services.InstallIssueThread
			require.NoError(t, json.Unmarshal(raw, &thread))
			require.Equal(t, expected, thread.Issue.State)
			if issueNumber == fixingIssue {
				require.Len(t, thread.Comments, 1, "one durable completion comment")
			}
		}
		githubLifecycleBrowserPhase(t, r, second.number, "issue_merge", map[string]any{"fixingIssue": fixingIssue, "referenceIssue": referenceIssue})
		closes, mergeWrites := 0, 0
		for _, write := range r.fake.Writes() {
			if write.Method == "PATCH" && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d", fixingIssue) {
				closes++
			}
			require.NotContains(t, write.Path, "/reviews", "completion never creates approvals")
			if write.Method == "PUT" {
				mergeWrites++
				require.Equal(t, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", second.pull), write.Path, "only the person's external merge")
			}
		}
		require.Equal(t, 1, closes)
		require.Equal(t, 1, mergeWrites)
		return
	}
	socket, err := r.openLive(r.jar)
	require.NoError(t, err)
	_, err = socket.subscribe("home")
	require.NoError(t, err)
	var home struct {
		Attention []services.OrderAttention `json:"attention"`
	}
	_, err = socket.latest("home", 30*time.Second, func(frame liveFrame) bool {
		return json.Unmarshal(frame.Data, &home) == nil && len(home.Attention) == 1
	})
	require.NoError(t, err)
	require.Len(t, home.Attention, 1)
	require.Equal(t, "T2 merged before T1; T1's change is in T2's commit", home.Attention[0].Text)
	attention := home.Attention[0]
	code, raw, err = r.keyed("POST", fmt.Sprintf("/api/todos/%d/merge", items[2].number), `{"reviewed_head_sha":"0000000000000000000000000000000000000001"}`, "fenced-merge")
	require.NoError(t, err)
	require.Equal(t, 409, code, string(raw))
	require.Contains(t, string(raw), `"code":"attention"`)
	githubLifecycleBrowserPhase(t, r, second.number, "order")
	code, raw, err = r.keyed("POST", "/api/stack/attention/"+attention.ID, fmt.Sprintf(`{"revision":%d}`, attention.Revision), "order-ok")
	require.NoError(t, err)
	require.Equal(t, 204, code, string(raw))
	var settled bool
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT (attention->0->>'settled_by')::bigint=$2 FROM mythical_stacks WHERE repository_id=$1`, repository, owner).Scan(&settled))
	require.True(t, settled)
}
