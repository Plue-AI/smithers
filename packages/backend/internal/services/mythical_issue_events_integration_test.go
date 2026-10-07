package services

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// C-J2-02 through the install's issue-events stream (T-GH-02, T-STK-09):
// real PostgreSQL, the GitHub fake's repository issue-events list and the
// production ReadIssueEvents. A member's todo label commits one TODO from
// the issue's text; a label from before the first read, a non-member's
// label and later reads commit none; the cursor only moves forward.
func TestInstallIssueEventsCommitAMembersTodoLabelOnce(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	const repo = "rehearsal-owner/app"
	f.fake.SetCollaborator(8, "ben", "write")
	f.fake.SetCollaborator(9, "eve", "read")
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,github_login,github_id,permission) VALUES($1,'ben',8,'write')`, f.repoID)
	require.NoError(t, err)

	key := mythicalIssueEventsCursor + strconv.FormatInt(f.repoID, 10)
	count := func(issue int64) int {
		t.Helper()
		var n int
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id = $1 AND issue_number = $2`, f.repoID, issue).Scan(&n))
		return n
	}
	cursor := func() int64 {
		t.Helper()
		var value json.RawMessage
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key = $1`, key).Scan(&value))
		var decoded struct{ Cursor int64 }
		require.NoError(t, json.Unmarshal(value, &decoded))
		return decoded.Cursor
	}

	// A label from before the install first read GitHub is no request.
	early := f.fake.OpenIssue(repo, "ben", "Early", "Labeled before the install read GitHub.")
	earlyEvent := f.fake.LabelIssue(repo, early, "ben", "todo")
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	require.Zero(t, count(early))
	require.Equal(t, earlyEvent, cursor(), "the first read sets the cursor at the newest event")

	// A non-member's label and another label make no TODO; a member's todo
	// label on an issue a member wrote makes one, from its text now.
	outsider := f.fake.OpenIssue(repo, "eve", "Outsider", "Eve asks.")
	f.fake.LabelIssue(repo, outsider, "eve", "todo")
	labeled := f.fake.OpenIssue(repo, "ben", "Say goodbye", "JOURNEY.md should end with a farewell.")
	f.fake.LabelIssue(repo, labeled, "ben", "bug")
	event := f.fake.LabelIssue(repo, labeled, "ben", "todo")
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	require.Zero(t, count(outsider), "a non-member's label is no door")
	require.Equal(t, 1, count(labeled))
	require.Equal(t, event, cursor())
	item, err := db.New(f.pool).GetMythicalItemByIssue(ctx, f.repoID, labeled)
	require.NoError(t, err)
	require.Equal(t, "queued", item.State)
	require.True(t, item.FixesIssue)
	var revisions []struct {
		Text string `json:"text"`
		By   struct {
			Login string `json:"login"`
		} `json:"by"`
		Reason string `json:"reason"`
	}
	require.NoError(t, json.Unmarshal(item.Revisions, &revisions))
	require.Len(t, revisions, 1)
	require.Equal(t, "Say goodbye\n\nJOURNEY.md should end with a farewell.", revisions[0].Text)
	require.Equal(t, "ben", revisions[0].By.Login)
	require.Equal(t, "from-issue", revisions[0].Reason)
	require.Equal(t, event, mythicalChecksOf(item).TodoEvent)

	// Later reads hand nothing over again, and the cursor never moves back.
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	require.Equal(t, 1, count(labeled))
	refusal, ok := f.fake.Issue(repo, outsider)
	require.True(t, ok)
	require.Len(t, refusal.Events, 2)
	require.Equal(t, "unlabeled", refusal.Events[1].Event)
	require.True(t, refusal.Events[1].ViaApp)
	require.Equal(t, refusal.Events[1].ID, cursor(), "the App's refusal event is consumed too")
	require.NoError(t, f.service.saveIssueEventsCursor(ctx, key, earlyEvent))
	require.Equal(t, refusal.Events[1].ID, cursor())

	// A repository with no stack reads nothing.
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID+1000))
}

func TestInstallTodoLabelsRequireRosterAndFreezeConsumedEvents(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	const repo = "rehearsal-owner/app"
	for id, login := range map[int64]string{8: "ben", 9: "mia", 10: "carol", 11: "erin"} {
		permission := "write"
		if login == "mia" {
			permission = "maintain"
		}
		f.fake.SetCollaborator(id, login, permission)
	}
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,github_login,github_id,permission,suspended_at)
 VALUES($1,'ben',8,'write',NULL),($1,'mia',9,'admin',NULL),($1,'erin',11,'write',now()),($1,'rehearsal-owner',7,'write',NULL)`, f.repoID)
	require.NoError(t, err)
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	cases := []struct {
		actor, author, comment string
		admitted               bool
	}{
		{"ben", "ben", "", true},
		{"mia", "carol", "", true},
		{"rehearsal-owner", "carol", "", true},
		{"ben", "carol", "Only a maintainer can make a TODO from this issue", false},
		{"carol", "ben", "only members of this install can add `todo`", false},
		{"erin", "ben", "only members of this install can add `todo`", false},
		{"other-app[bot]", "ben", "only members of this install can add `todo`", false},
	}
	for _, tc := range cases {
		t.Run(tc.actor+"-"+tc.author, func(t *testing.T) {
			number := f.fake.OpenIssue(repo, tc.author, "Frozen title", "Frozen body")
			event := f.fake.LabelIssue(repo, number, tc.actor, "todo")
			require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
			var count int
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND issue_number=$2`, f.repoID, number).Scan(&count))
			if tc.admitted {
				require.Equal(t, 1, count)
				item, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
				require.NoError(t, err)
				require.Equal(t, "Frozen body", item.IssueBody)
				require.Equal(t, event, mythicalChecksOf(item).TodoEvent)
				// Drop, then replay the original event by rewinding only the fixture's
				// cursor. A consumed label never resurrects work; a new label may.
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='cancelled' WHERE id=$1`, item.ID)
				require.NoError(t, err)
				before, _ := f.fake.Issue(repo, number)
				require.True(t, f.fake.EditIssue(repo, number, "carol", "Later outsider title", "Later outsider body"))
				_, err = f.pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_build_object('cursor',$2::bigint) WHERE key=$1`, mythicalIssueEventsCursor+strconv.FormatInt(f.repoID, 10), event-1)
				require.NoError(t, err)
				require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
				_, err = db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
				require.Error(t, err)
				replayed, _ := f.fake.Issue(repo, number)
				require.Len(t, replayed.Comments, len(before.Comments), "a consumed event cannot be refused again after later edits")
				require.Contains(t, replayed.Labels, "todo")
				require.True(t, f.fake.EditIssue(repo, number, "ben", "Fresh title", "Fresh body"))
				f.fake.LabelIssue(repo, number, tc.actor, "todo")
				require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
				next, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
				require.NoError(t, err)
				require.NotEqual(t, item.ID, next.ID)
			} else {
				require.Zero(t, count)
				view, ok := f.fake.Issue(repo, number)
				require.True(t, ok)
				require.NotContains(t, view.Labels, "todo")
				require.Len(t, view.Comments, 1)
				require.Contains(t, view.Comments[0].Body, tc.comment)
				// Cursor replay also proves keyed refusal completion avoids writes.
				_, err = f.pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_build_object('cursor',$2::bigint) WHERE key=$1`, mythicalIssueEventsCursor+strconv.FormatInt(f.repoID, 10), event-1)
				require.NoError(t, err)
				require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
				view, _ = f.fake.Issue(repo, number)
				require.Len(t, view.Comments, 1)
			}
		})
	}
}

func TestInstallTodoLabelRejectsLaterOutsiderEdits(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	const repo = "rehearsal-owner/app"
	for id, login := range map[int64]string{8: "ben", 9: "mia", 10: "carol"} {
		f.fake.SetCollaborator(id, login, "write")
	}
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,github_id,github_login,permission) VALUES($1,8,'ben','write'),($1,9,'mia','admin')`, f.repoID)
	require.NoError(t, err)
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	for _, part := range []string{"body", "title"} {
		number := f.fake.OpenIssue(repo, "ben", "Original", "Original body")
		f.fake.LabelIssue(repo, number, "mia", "todo")
		title, body := "Original", "Original body"
		if part == "body" {
			body = "Outsider body"
		} else {
			title = "Outsider title"
		}
		require.True(t, f.fake.EditIssue(repo, number, "carol", title, body))
		require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
		_, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
		require.Error(t, err, "later outsider %s edit must refuse", part)
		view, _ := f.fake.Issue(repo, number)
		require.NotContains(t, view.Labels, "todo")
		require.Len(t, view.Comments, 1)
		require.Contains(t, view.Comments[0].Body, "Changed after it was labeled. Label it again to make a TODO.")
		// The next maintainer label approves precisely the new outsider text.
		f.fake.LabelIssue(repo, number, "mia", "todo")
		require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
		item, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
		require.NoError(t, err)
		require.True(t, item.Outsider)
		require.Equal(t, title, item.IssueTitle)
		require.Equal(t, body, item.IssueBody)
		require.True(t, f.fake.EditIssue(repo, number, "carol", "Later title", "Later body"))
		f.fake.LabelIssue(repo, number, "mia", "todo")
		require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
		kept, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
		require.NoError(t, err)
		require.Equal(t, item.Revisions, kept.Revisions)
	}
	number := f.fake.OpenIssue(repo, "ben", "Member issue", "Before")
	f.fake.LabelIssue(repo, number, "ben", "todo")
	require.True(t, f.fake.EditIssue(repo, number, "ben", "Member issue", "First read"))
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	item, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, number)
	require.NoError(t, err)
	require.Equal(t, "First read", item.IssueBody)
	appIssue := f.fake.OpenIssue(repo, "ben", "App edit", "Before")
	f.fake.LabelIssue(repo, appIssue, "ben", "todo")
	require.True(t, f.fake.EditIssue(repo, appIssue, "smithers-install[bot]", "App edit", "Install App text"))
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	appItem, err := db.New(f.pool).GetActiveMythicalItemByIssue(ctx, f.repoID, appIssue)
	require.NoError(t, err)
	require.False(t, appItem.Outsider)
	require.Equal(t, "Install App text", appItem.IssueBody)
}
