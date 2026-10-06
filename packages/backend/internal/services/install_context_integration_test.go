package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

type contextBranches func(context.Context, string, int64, int64) (db.Workspace, error)

func (read contextBranches) PresenceBranch(ctx context.Context, branch string, repo, user int64) (db.Workspace, error) {
	return read(ctx, branch, repo, user)
}

func nativeContext(t *testing.T) (*mirrorReadFixture, InstallContext, middleware.Credential) {
	t.Helper()
	f := newMirrorReadFixture(t)
	f.ready()
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://127.0.0.1:9", SigningKey: []byte(strings.Repeat("c", 32))})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	wiki := NewWikiService(db.New(f.pool), nil, WithWikiContent(content))
	return f, InstallContext{Source: f.reader, Wiki: wiki}, f.session(f.member, time.Now().Add(time.Hour))
}

func TestInstallContextReadsPinnedNativeFilesPublicWikiAndConfirmedTodos(t *testing.T) {
	f, reader, credential := nativeContext(t)
	ctx := t.Context()
	entries, _, pin, err := reader.Source.Repos.ListRepoContentsPage(ctx, &f.member, mirrorReadOwner, mirrorReadSlugName, f.commit, "", "", 1000)
	require.NoError(t, err)
	require.Equal(t, f.commit, pin)
	metadata := map[string]*bool{}
	for _, entry := range entries {
		metadata[entry.Path] = entry.RegularFile
	}
	require.NotNil(t, metadata["JOURNEY.md"])
	require.True(t, *metadata["JOURNEY.md"])
	for _, name := range []string{"link", "escape", "up", "docs", "vendor"} {
		require.NotNil(t, metadata[name], name)
		require.False(t, *metadata[name], name)
	}
	public, err := json.Marshal(entries)
	require.NoError(t, err)
	require.NotContains(t, string(public), "regular_file", "internal native metadata must not alter the public contents response")
	_, err = reader.Wiki.CreateWikiPage(ctx, &f.owner, mirrorReadOwner, mirrorReadSlugName, CreateWikiPageInput{Title: "Retries", Slug: "retries", Body: "Retry webhook deliveries three times"})
	require.NoError(t, err)
	private, err := WithWikiVisibility(ctx, "private")
	require.NoError(t, err)
	_, err = reader.Wiki.CreateWikiPage(private, &f.owner, mirrorReadOwner, mirrorReadSlugName, CreateWikiPageInput{Title: "Private", Slug: "private", Body: "canary-private-wiki"})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,title,state,revisions,request_run_id,request_outcome,summary)
 VALUES($1,'todo','Repair retries','queued','[{"text":"Retry three times"}]','retry-run','completed','Retry check passed'),
 ($1,'chat','canary-private-legacy','queued',NULL,'canary-private-run','','canary-private-summary'),
 ($2,'todo','canary-other-repository','queued','[]','','','')`, f.mirror, f.other)
	require.NoError(t, err)
	// Even an inherited private-wiki scope cannot broaden a shared answer.
	raw, err := reader.Read(private, credential, f.member.ID, f.mirror, "main")
	require.NoError(t, err)
	var result struct {
		State       string `json:"state"`
		TokenBudget int    `json:"tokenBudget"`
		Candidates  []struct {
			Item map[string]string `json:"item"`
			Text string            `json:"text"`
		} `json:"candidates"`
	}
	require.NoError(t, json.Unmarshal(raw, &result))
	require.Equal(t, "main", result.State)
	require.Equal(t, 24000, result.TokenBudget)
	selected := map[string]string{}
	for _, candidate := range result.Candidates {
		selected[candidate.Item["kind"]+":"+candidate.Item["ref"]] = candidate.Text
		if candidate.Item["kind"] == "file" {
			require.Equal(t, f.commit, candidate.Item["revision"])
		}
		if candidate.Item["kind"] == "page" {
			require.Equal(t, "1", candidate.Item["revision"])
		}
	}
	require.Len(t, selected, 6)
	require.Equal(t, "Add a greeting to JOURNEY.md\n", selected["file:JOURNEY.md"])
	require.Equal(t, "Read me second.\n", selected["file:docs/guide.md"])
	require.Equal(t, "kept exactly\n", selected["file:  spaced name "])
	require.Equal(t, "Retry webhook deliveries three times", selected["page:retries"])
	require.JSONEq(t, `{"title":"Repair retries","state":"queued","prompt_revisions":[{"text":"Retry three times"}]}`, selected["todo:T1"])
	require.JSONEq(t, `{"todo":"T1","state":"completed","summary":"Retry check passed"}`, selected["run:retry-run"])
	for _, ref := range []string{"file:link", "file:escape", "file:up", "file:vendor/lib", "file:big.txt", "file:bad-utf8.txt", "file:bin/blob.dat"} {
		require.NotContains(t, selected, ref)
	}
	require.NotContains(t, string(raw), "canary-")
	var machines int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.mirror).Scan(&machines))
	require.Zero(t, machines)
}

type contextPinnedHost struct {
	*repohost.Client
	bookmarks int
	firstPage func()
	list      func(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error)
	read      func(context.Context, string, string, string, string) (repohost.FileContent, error)
}

func (h *contextPinnedHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	h.bookmarks++
	if h.bookmarks > 1 {
		return repohost.Bookmark{TargetCommitID: strings.Repeat("b", 40)}, nil
	}
	return h.Client.GetBookmark(ctx, owner, repo, name)
}
func (h *contextPinnedHost) ListDirectory(ctx context.Context, owner, repo, revision, prefix, after string, limit int) ([]repohost.TreeEntry, error) {
	if h.list != nil {
		return h.list(ctx, owner, repo, revision, prefix, after, limit)
	}
	entries, err := h.Client.ListDirectory(ctx, owner, repo, revision, prefix, after, limit)
	if h.firstPage != nil {
		call := h.firstPage
		h.firstPage = nil
		call()
	}
	return entries, err
}

func TestInstallContextPinsMainOnceAndRechecksAuthority(t *testing.T) {
	f, reader, credential := nativeContext(t)
	host := &contextPinnedHost{Client: reader.Source.Repos.repoHost.(*repohost.Client)}
	reader.Source.Repos.repoHost = host
	raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
	require.NoError(t, err)
	require.Contains(t, string(raw), f.commit)
	require.NotContains(t, string(raw), strings.Repeat("b", 40))
	require.Equal(t, 1, host.bookmarks, "all directory pages and file reads must keep the first revision")
	host.bookmarks = 0
	host.firstPage = func() {
		_, err := f.pool.Exec(t.Context(), `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.mirror, f.member.ID)
		require.NoError(t, err)
	}
	raw, err = reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
	require.Error(t, err)
	require.Nil(t, raw)
}

func TestInstallContextMissingItemSnapshotNeverFallsBackToMain(t *testing.T) {
	f, reader, credential := nativeContext(t)
	reader.Branches = contextBranches(func(_ context.Context, branch string, repo, user int64) (db.Workspace, error) {
		require.Equal(t, "item-branch", branch)
		require.Equal(t, f.mirror, repo)
		require.Equal(t, f.member.ID, user)
		return db.Workspace{Status: "stopped"}, nil
	})
	raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "item-branch")
	require.NoError(t, err)
	require.JSONEq(t, `{"state":"asleep","candidates":[],"tokenBudget":24000}`, string(raw))
	reader.Branches = contextBranches(func(context.Context, string, int64, int64) (db.Workspace, error) {
		return db.Workspace{Status: "stopped", HeadCommitID: f.commit}, nil
	})
	raw, err = reader.Read(t.Context(), credential, f.member.ID, f.mirror, "item-branch")
	require.NoError(t, err)
	require.Contains(t, string(raw), "JOURNEY.md")
	require.Contains(t, string(raw), f.commit)
	reader.Branches = contextBranches(func(context.Context, string, int64, int64) (db.Workspace, error) {
		return db.Workspace{}, ErrSourceForbidden
	})
	raw, err = reader.Read(t.Context(), credential, f.member.ID, f.mirror, "item-branch")
	require.ErrorIs(t, err, ErrSourceForbidden)
	require.Nil(t, raw)
}

func TestInstallContextOwnerBudgetAndRequiredProviders(t *testing.T) {
	f, reader, credential := nativeContext(t)
	for _, value := range []string{`{"tokenBudget":0}`, `{"tokenBudget":1000000}`} {
		f.setting("context.preflight", value)
		raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
		require.NoError(t, err)
		var got map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(raw, &got))
		var want map[string]json.RawMessage
		require.NoError(t, json.Unmarshal([]byte(value), &want))
		require.JSONEq(t, string(want["tokenBudget"]), string(got["tokenBudget"]))
	}
	for _, value := range []string{`{}`, `{"tokenBudget":null}`, `{"tokenBudget":-1}`, `{"tokenBudget":1000001}`, `{"tokenBudget":1.5}`, `{"tokenBudget":"24000"}`} {
		f.setting("context.preflight", value)
		raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
		require.ErrorIs(t, err, ErrSourceNotReady)
		require.Nil(t, raw)
	}
	f.setting("context.preflight", `{"tokenBudget":24000}`)
	for _, invalid := range []InstallContext{{}, {Source: reader.Source}, {Source: InstallSource{Pool: f.pool}, Wiki: reader.Wiki}} {
		raw, err := invalid.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
		require.ErrorIs(t, err, ErrSourceNotReady)
		require.Nil(t, raw)
	}
	raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "branch-without-provider")
	require.ErrorIs(t, err, ErrSourceNotReady)
	require.Nil(t, raw)
	_, err = f.pool.Exec(t.Context(), `DELETE FROM auth_sessions WHERE session_key=$1`, credential.SessionHash)
	require.NoError(t, err)
	raw, err = reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
	require.ErrorIs(t, err, ErrSourceForbidden)
	require.Nil(t, raw)
}

// Fault injection changes responses at the repository-host seam; authorization
// and repository lookup still use the real product database. Native confinement
// is separately exercised above. The paged host fixture below isolates cursor
// handling without building a thousand-file native repository.
func (h *contextPinnedHost) GetFileAtCommit(ctx context.Context, owner, repo, revision, path string) (repohost.FileContent, error) {
	if h.read != nil {
		return h.read(ctx, owner, repo, revision, path)
	}
	return h.Client.GetFileAtCommit(ctx, owner, repo, revision, path)
}

func TestInstallContextRefusesMalformedRepositoryResponses(t *testing.T) {
	f, reader, credential := nativeContext(t)
	host := &contextPinnedHost{Client: reader.Source.Repos.repoHost.(*repohost.Client)}
	reader.Source.Repos.repoHost = host
	for _, mode := range []string{"traversal", "absolute", "wrong-parent", "duplicate", "page-error", "file-error", "storage-404", "repeated-page"} {
		t.Run(mode, func(t *testing.T) {
			host.bookmarks = 0
			host.read = nil
			host.list = func(_ context.Context, _, _, _, _, _ string, _ int) ([]repohost.TreeEntry, error) {
				switch mode {
				case "traversal":
					return []repohost.TreeEntry{{Path: "../outside", Kind: "file"}}, nil
				case "absolute":
					return []repohost.TreeEntry{{Path: "/etc/passwd", Kind: "file"}}, nil
				case "wrong-parent":
					return []repohost.TreeEntry{{Path: "nested/file", Kind: "file"}}, nil
				case "duplicate":
					return []repohost.TreeEntry{{Path: "docs", Kind: "dir"}, {Path: "docs", Kind: "dir"}}, nil
				case "page-error":
					return nil, errors.New("repository offline")
				case "file-error", "storage-404":
					return []repohost.TreeEntry{{Path: "JOURNEY.md", Kind: "file"}}, nil
				default:
					// The server repeats an already-read page. Refuse instead of looping
					// or silently dropping/duplicating candidate data.
					entries := make([]repohost.TreeEntry, 1001)
					for i := range entries {
						entries[i] = repohost.TreeEntry{Path: fmt.Sprintf("f%04d", i), Kind: "file"}
					}
					return entries, nil
				}
			}
			host.read = func(context.Context, string, string, string, string) (repohost.FileContent, error) {
				if mode == "storage-404" {
					return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404, Code: "repository_not_found"}
				}
				if mode == "file-error" {
					return repohost.FileContent{}, errors.New("blob unavailable")
				}
				return repohost.FileContent{Content: "data"}, nil
			}
			raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
			require.Error(t, err)
			require.Nil(t, raw)
		})
	}
}

func TestInstallContextWalksAllPagesAtOneRevision(t *testing.T) {
	f, reader, credential := nativeContext(t)
	host := &contextPinnedHost{Client: reader.Source.Repos.repoHost.(*repohost.Client)}
	reader.Source.Repos.repoHost = host
	var cursors []string
	host.list = func(_ context.Context, _, _, revision, directory, after string, limit int) ([]repohost.TreeEntry, error) {
		require.Equal(t, f.commit, revision)
		require.Empty(t, directory)
		require.Equal(t, 1001, limit)
		cursors = append(cursors, after)
		if after == "f0999" {
			return []repohost.TreeEntry{{Path: "f1000", Kind: "file"}}, nil
		}
		require.Empty(t, after)
		entries := make([]repohost.TreeEntry, 1001)
		for i := range entries {
			entries[i] = repohost.TreeEntry{Path: fmt.Sprintf("f%04d", i), Kind: "file"}
		}
		return entries, nil
	}
	host.read = func(_ context.Context, _, _, revision, path string) (repohost.FileContent, error) {
		require.Equal(t, f.commit, revision)
		return repohost.FileContent{Content: "text " + path}, nil
	}
	raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "main")
	require.NoError(t, err)
	var result struct {
		Candidates []struct {
			Item map[string]string `json:"item"`
			Text string            `json:"text"`
		} `json:"candidates"`
	}
	require.NoError(t, json.Unmarshal(raw, &result))
	require.Len(t, result.Candidates, 1001)
	require.Equal(t, []string{"", "f0999"}, cursors)
	require.Equal(t, "f1000", result.Candidates[1000].Item["ref"])
	require.Equal(t, f.commit, result.Candidates[1000].Item["revision"])
	require.Equal(t, "text f1000", result.Candidates[1000].Text)
	require.Equal(t, 1, host.bookmarks)
}

func TestInstallContextRechecksItemAccessAndRejectsMutableHeads(t *testing.T) {
	f, reader, credential := nativeContext(t)
	reader.Branches = contextBranches(func(context.Context, string, int64, int64) (db.Workspace, error) {
		return db.Workspace{HeadCommitID: "main"}, nil
	})
	raw, err := reader.Read(t.Context(), credential, f.member.ID, f.mirror, "item")
	require.ErrorIs(t, err, ErrSourceNotReady)
	require.Nil(t, raw)
	calls := 0
	reader.Branches = contextBranches(func(context.Context, string, int64, int64) (db.Workspace, error) {
		calls++
		if calls == 2 {
			return db.Workspace{}, ErrSourceForbidden
		}
		return db.Workspace{HeadCommitID: f.commit}, nil
	})
	raw, err = reader.Read(t.Context(), credential, f.member.ID, f.mirror, "item")
	require.ErrorIs(t, err, ErrSourceForbidden)
	require.Nil(t, raw)
	require.Equal(t, 2, calls)
}

func TestInstallContextItemCandidateBindingAndInvalidation(t *testing.T) {
	f, reader, credential := nativeContext(t)
	ctx := t.Context()
	const workspace = "a3039070-cfd0-4530-9f66-ed39ed449118"
	const item = "d477d7cc-f831-4895-a4bf-100b48a068fd"
	reader.Branches = contextBranches(func(context.Context, string, int64, int64) (db.Workspace, error) {
		return db.Workspace{ID: workspace, TargetBookmark: "smithers/retry", Status: "stopped", HeadCommitID: f.commit}, nil
	})
	_, err := f.pool.Exec(ctx, `INSERT INTO mythical_items(id,repository_id,source,title,state,workspace_id,candidate_base,candidate_head,candidate_verified,revisions)
      VALUES($1,$2,'todo','Retry','queued',$3,$4,$4,true,'[]')`, item, f.mirror, workspace, f.commit)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'coding')`, workspace, f.mirror, item)
	require.NoError(t, err)
	read := func() (json.RawMessage, error) { return reader.Read(ctx, credential, f.member.ID, f.mirror, workspace) }
	raw, err := read()
	require.NoError(t, err)
	require.Contains(t, string(raw), "JOURNEY.md")
	for _, test := range []struct {
		name, sql string
		want      error
	}{
		{"unverified", `UPDATE mythical_items SET candidate_verified=false WHERE id=$1`, nil},
		{"missing", `UPDATE mythical_items SET candidate_head='' WHERE id=$1`, nil},
		{"mutable head", `UPDATE mythical_items SET candidate_head='main' WHERE id=$1`, ErrSourceNotReady},
		{"mutable base", `UPDATE mythical_items SET candidate_base='main' WHERE id=$1`, ErrSourceNotReady},
		{"other attempt", `UPDATE mythical_items SET workspace_id='other' WHERE id=$1`, ErrSourceForbidden},
		{"non TODO", `UPDATE mythical_items SET source='chat' WHERE id=$1`, ErrSourceForbidden},
		{"retired lane", `UPDATE mythical_lanes SET retired_at=now() WHERE item_id=$1`, ErrSourceForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := f.pool.Exec(ctx, test.sql, item)
			require.NoError(t, err)
			raw, err := read()
			if test.want == nil {
				require.NoError(t, err)
				require.NotContains(t, string(raw), "JOURNEY.md", "missing candidate must not use workspace head")
			} else {
				require.ErrorIs(t, err, test.want)
				require.Nil(t, raw)
			}
			_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET source='todo',workspace_id=$2,candidate_base=$3,candidate_head=$3,candidate_verified=true WHERE id=$1`, item, workspace, f.commit)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=NULL WHERE item_id=$1`, item)
			require.NoError(t, err)
		})
	}
	host := &contextPinnedHost{Client: reader.Source.Repos.repoHost.(*repohost.Client)}
	reader.Source.Repos.repoHost = host
	host.firstPage = func() {
		_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=false WHERE id=$1`, item)
		require.NoError(t, err)
	}
	raw, err = read()
	require.ErrorIs(t, err, ErrSourceNotReady, "candidate invalidated during IO must not escape the callback")
	require.Nil(t, raw)
	for _, table := range []string{"mythical_lanes", "mythical_items"} {
		t.Run("other repository "+table, func(t *testing.T) {
			key := "id"
			if table == "mythical_lanes" {
				key = "item_id"
			}
			// Table and key are fixed test literals, never request input.
			_, err := f.pool.Exec(ctx, "UPDATE "+table+" SET repository_id=$2 WHERE "+key+"=$1", item, f.other)
			require.NoError(t, err)
			raw, err := read()
			require.ErrorIs(t, err, ErrSourceForbidden)
			require.Nil(t, raw)
			_, err = f.pool.Exec(ctx, "UPDATE "+table+" SET repository_id=$2 WHERE "+key+"=$1", item, f.mirror)
			require.NoError(t, err)
		})
	}
	_, err = f.pool.Exec(ctx, `DELETE FROM mythical_lanes WHERE item_id=$1`, item)
	require.NoError(t, err)
	raw, err = read()
	require.Error(t, err, "a missing lane must refuse rather than return its workspace head")
	require.Nil(t, raw)
}
