package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-J8-04 (T-FLW-10) fixture oracles. Bodies, revisions, slugs and digests
// are literals; nothing below derives an expectation from a digest helper,
// the selector or an observed receipt.
const (
	citedSlug          = "retry-policy"
	citedRevision3     = "Webhook retries use `retry()` with exponential backoff."
	citedDigest3       = "0314a7d6edf2ad4b7057d059f7dfdf17df0ab800ec24b502f02ecb38c1bbed22"
	citedRevision4     = "Webhook retries use `retryFixed(5000)`."
	citedDigest4       = "e47d2d025a859ead6080b931b2b718bfa2937244433746068d08770278b36c7c"
	unrelatedSlug      = "release-process"
	unrelatedRevision2 = "Releases ship on Tuesdays."
	unrelatedDigest2   = "23a9b3561adda1dffe7def42f87d882b7cf5e65f7dfaa9ca599df819ea5ad96f"
	planRunID          = "plan-run-12"
	planWorkspaceID    = "12121212-1212-4121-a121-121212121212"
)

// The backend half of C-J8-04 with real PostgreSQL and the production wiki
// store: the run's authority over wiki reads, the revisions and digests a
// plan cites, and the attempt evidence that keeps each revision after later
// edits. The plan step itself runs in a branch machine; that end-to-end
// subcase runs only on the reference host (see the skip below).
func TestPlanWikiCitationsIntegration(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repositoryID, otherID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES($1,'app','app','main',false) RETURNING id`, owner.ID).Scan(&repositoryID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES($1,'other','other','main',false) RETURNING id`, owner.ID).Scan(&otherID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"ben","repository_name":"app","repository_id":%d}`, repositoryID))}))
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: filepath.Join(t.TempDir(), "wiki"), PublicBaseURL: "http://127.0.0.1:9", SigningKey: []byte(strings.Repeat("w", 32))})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	wiki := NewWikiService(q, nil, WithWikiContent(content))

	// retry-policy reaches revision 3 and release-process revision 2.
	edit := func(slug, title string, bodies ...string) WikiPageResponse {
		page, err := wiki.CreateWikiPage(ctx, &owner, "ben", "app", CreateWikiPageInput{Title: title, Slug: slug, Body: bodies[0]})
		require.NoError(t, err)
		for _, body := range bodies[1:] {
			expected := page.Revision
			page, err = wiki.UpdateWikiPage(ctx, &owner, "ben", "app", slug, UpdateWikiPageInput{Body: &body, ExpectedRevision: &expected})
			require.NoError(t, err)
		}
		return page
	}
	cited := edit(citedSlug, "Retry policy", "Webhook retries are undecided.", "Webhook retries use `retry()`.", citedRevision3)
	unrelated := edit(unrelatedSlug, "Release process", "Releases ship weekly.", unrelatedRevision2)
	require.EqualValues(t, 3, cited.Revision)
	require.Equal(t, citedDigest3, cited.ContentDigest)
	require.EqualValues(t, 2, unrelated.Revision)
	require.Equal(t, unrelatedDigest2, unrelated.ContentDigest)
	stored := func(pageID, revision int64) (string, string) {
		var body, digest string
		require.NoError(t, pool.QueryRow(ctx, `SELECT body,content_digest FROM wiki_page_revisions WHERE page_id=$1 AND revision=$2`, pageID, revision).Scan(&body, &digest))
		return body, digest
	}
	body, digest := stored(cited.ID, 3)
	require.Equal(t, citedRevision3, body)
	require.Equal(t, citedDigest3, digest, "the cited digest is SHA-256 of revision 3's stored Markdown")

	// The selector's candidates are every shared page at its pinned revision.
	candidates, err := WikiContextCandidates(ctx, wiki, &owner, "ben", "app")
	require.NoError(t, err)
	offered := map[string]string{}
	for _, candidate := range candidates {
		item := candidate["item"].(map[string]string)
		require.Equal(t, "page", item["kind"])
		offered[item["ref"]] = item["revision"] + ":" + candidate["text"].(string)
	}
	require.Equal(t, map[string]string{citedSlug: "3:" + citedRevision3, unrelatedSlug: "2:" + unrelatedRevision2}, offered)

	// The TODO runs in its own lane with the provisioned run credential.
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name) VALUES($1,$2,$3,'todo-12')`, planWorkspaceID, repositoryID, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repositoryID, owner.ID)
	require.NoError(t, err)
	var itemID pgtype.UUID
	var number int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,attempt)
 VALUES($1,'todo','running',12,1,'Retry failed webhook deliveries',$2,$3,$4,1) RETURNING id,number`, repositoryID, planWorkspaceID, planRunID, owner.ID).Scan(&itemID, &number))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'todo-12')`, planWorkspaceID, repositoryID, itemID)
	require.NoError(t, err)
	runContext := func(scopes string) context.Context {
		token, err := issueTemporaryRepoTokenWithTTL(ctx, q, owner.ID, "plan-"+fmt.Sprint(time.Now().UnixNano()), scopes, time.Hour)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(token.Plaintext))
		return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, IsTokenAuth: true, TokenSystemIssued: true,
			TokenID: token.ID, TokenHash: hex.EncodeToString(sum[:]), RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)})
	}
	landing := boxHostLandingTokenScopes(repositoryID, planWorkspaceID)
	run := runContext(landing + "," + middleware.AgentSessionRestrictionScope(planRunID))
	subject, err := ResolveInstallExecutionSubject(run, q, repositoryID)
	require.NoError(t, err)
	require.Equal(t, InstallSubject{RepositoryID: repositoryID, WorkspaceID: planWorkspaceID, TodoNumber: number}, subject)
	decision, err := Authorize(run, q, "wiki.read", subject)
	require.NoError(t, err)
	require.Equal(t, owner.ID, decision.UserID)

	// Refusals: another repository, another run, an unbound or expired
	// credential. None is a person credential and none gains write scope.
	refused := func(ctx context.Context, subject InstallSubject, status int) {
		t.Helper()
		_, err := Authorize(ctx, q, "wiki.read", subject)
		var access *AccessError
		require.ErrorAs(t, err, &access)
		require.Equal(t, status, access.Status)
	}
	refused(run, InstallSubject{RepositoryID: otherID, WorkspaceID: planWorkspaceID, TodoNumber: number}, 403)
	refused(run, InstallSubject{RepositoryID: repositoryID}, 403)
	refused(runContext(landing+","+middleware.AgentSessionRestrictionScope("another-run")), subject, 403)
	refused(runContext(landing), subject, 403)
	_, err = Authorize(run, q, "wiki.edit", subject)
	require.Error(t, err)
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 minute' WHERE scopes=$1`, landing+","+middleware.AgentSessionRestrictionScope(planRunID))
	require.NoError(t, err)
	refused(run, subject, 401)

	// The plan receipt names the page, its ID, revision and digest; the
	// unrelated page never entered the context and is not cited.
	receipt := func(revision int, digest string) string {
		return fmt.Sprintf(`{"plan":{"wikiCitations":[{"slug":%q,"pageID":"%d","revision":%d,"digest":%q}],"changes":[{"title":"Retry","atoms":[{"changeId":null,"message":"Retry failed webhook deliveries"}],"checks":[]}]}}`, citedSlug, cited.ID, revision, digest)
	}
	project := func(output string) json.RawMessage {
		plan := mythicalPlanSummary(flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.FlowRuntimeRun{FinalOutput: &output}}})
		require.NotEmpty(t, plan)
		return plan
	}
	item, err := q.GetMythicalItem(ctx, itemID)
	require.NoError(t, err)
	item.CandidateHead, item.Plan = strings.Repeat("a", 40), project(receipt(3, citedDigest3))
	first := todoEvidence(item)
	require.Len(t, first, 1)
	require.Equal(t, []map[string]any{{"kind": "wiki", "slug": citedSlug, "pageID": fmt.Sprint(cited.ID), "revision": int64(3), "digest": citedDigest3}}, first[0].Items)
	require.NotContains(t, string(item.Plan), unrelatedSlug)

	// The page is edited to revision 4. The first attempt's evidence keeps
	// revision 3; the retry's receipt cites revision 4.
	revision4, expected := citedRevision4, int64(3)
	cited, err = wiki.UpdateWikiPage(ctx, &owner, "ben", "app", citedSlug, UpdateWikiPageInput{Body: &revision4, ExpectedRevision: &expected})
	require.NoError(t, err)
	require.EqualValues(t, 4, cited.Revision)
	require.Equal(t, citedDigest4, cited.ContentDigest)
	item = retainTodoAttemptEvidence(item)
	item.Attempt, item.CandidateHead, item.Plan = 2, strings.Repeat("b", 40), project(receipt(4, citedDigest4))
	both := todoEvidence(item)
	require.Len(t, both, 2)
	require.EqualValues(t, 3, both[0].Items[0]["revision"])
	require.Equal(t, citedDigest3, both[0].Items[0]["digest"])
	require.EqualValues(t, 4, both[1].Items[0]["revision"])
	require.Equal(t, citedDigest4, both[1].Items[0]["digest"])
	// Each citation's history content is that revision's exact bytes.
	for revision, want := range map[int64]string{3: citedRevision3, 4: citedRevision4} {
		read, err := wiki.GetWikiRevisionContent(ctx, &owner, "ben", "app", cited.ID, revision)
		require.NoError(t, err)
		require.Equal(t, want, string(read.Data))
		body, digest := stored(cited.ID, revision)
		require.Equal(t, want, body)
		require.Equal(t, read.Digest, digest)
	}

	t.Run("real plan step in a branch machine", func(t *testing.T) {
		if os.Getenv("SMITHERS_C_J8_04_REFERENCE_HOST") == "" {
			t.Skip("C-J8-04's dispatcher, microVM coding host and recorded selector run only on the reference host")
		}
		t.Fatal("the reference-host harness is not in this repository yet; record C-J8-04 as pending, never passed")
	})
}
