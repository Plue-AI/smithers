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
	require.NotNil(t, mythicalChecksOf(item).Notice)
	require.Equal(t, mythicalCommittedKeyPrefix+strconv.FormatInt(item.Number.Int64, 10), mythicalChecksOf(item).Notice.Key)
	var authors []map[string]any
	require.NoError(t, json.Unmarshal(item.Revisions, &authors))
	by := authors[0]["by"].(map[string]any)
	require.NotEmpty(t, by["name"])
	require.Equal(t, "https://github.com/ben.png", by["avatar_url"])
	require.Contains(t, by, "color_index")

	// Later reads hand nothing over again, and the cursor never moves back.
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID))
	require.Equal(t, 1, count(labeled))
	require.NoError(t, f.service.saveIssueEventsCursor(ctx, key, earlyEvent))
	require.Equal(t, event, cursor())

	// A repository with no stack reads nothing.
	require.NoError(t, f.service.ReadIssueEvents(ctx, f.repoID+1000))
}
