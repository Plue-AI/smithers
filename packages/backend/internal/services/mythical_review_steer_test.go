package services

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func reviewFixture(id int64, login, state, body string) gitHubPullReview {
	return gitHubPullReview{ID: id, User: gitHubActor{ID: 100 + id, Login: login, Type: "User"}, State: state, Body: body,
		CommitID: "head", SubmittedAt: time.Date(2026, 10, 5, 10, 0, int(id), 0, time.UTC)}
}

func lineFixture(id, review int64, login, path string, line int64, body string) gitHubPullReviewComment {
	comment := gitHubPullReviewComment{PullRequestReviewID: review}
	comment.ID, comment.Body, comment.Path, comment.CommitID, comment.OriginalCommitID = id, body, path, "head", "head"
	comment.User = gitHubActor{ID: 999, Login: login, Type: "User"}
	if line > 0 {
		comment.Line, comment.OriginalLine = &line, &line
	}
	return comment
}

// Which reviews steer: changes requested (with or without words), a comment
// review with a body or a line comment; never an approval, a dismissed or
// pending review, an empty comment review, a bot's review (the install's
// App's included) or one already seen.
func TestReviewSteersChooseWhichReviewsSteer(t *testing.T) {
	reviews := []gitHubPullReview{
		reviewFixture(7, "dana", "APPROVED", ""),
		reviewFixture(3, "alice", "CHANGES_REQUESTED", "Use the backoff helper"),
		reviewFixture(4, "ben", "COMMENTED", ""),
		reviewFixture(5, "ben", "COMMENTED", "Name it retryDelay"),
		reviewFixture(6, "carol", "CHANGES_REQUESTED", ""),
		reviewFixture(8, "owner", "APPROVED", "LGTM, ship it"),
		reviewFixture(9, "erin", "DISMISSED", "old"),
		reviewFixture(10, "erin", "PENDING", "draft"),
		{ID: 11, User: gitHubActor{ID: 5, Login: "smithers-install[bot]", Type: "Bot"}, State: "CHANGES_REQUESTED", Body: "bot"},
		{ID: 12, User: gitHubActor{ID: 6, Login: "copilot", Type: "Bot"}, State: "COMMENTED", Body: "bot"},
		{ID: 13, User: gitHubActor{ID: 0, Login: ""}, State: "COMMENTED", Body: "ghost"},
		reviewFixture(14, "frank", "COMMENTED", ""),
		reviewFixture(15, "gus", "commented", "lower-case state"),
		reviewFixture(16, "seen", "CHANGES_REQUESTED", "already a steer"),
	}
	comments := []gitHubPullReviewComment{lineFixture(40, 14, "frank", "src/retry.ts", 12, "Use the existing backoff helper")}
	steers := mythicalReviewSteers(reviews, comments, map[string]bool{"review:16": true})
	var got []string
	for _, steer := range steers {
		got = append(got, steer.Key+" "+steer.Login+" "+steer.Text)
	}
	assert.Equal(t, []string{
		"review:3 alice Use the backoff helper",
		"review:5 ben Name it retryDelay",
		"review:6 carol Changes requested.",
		"review:14 frank src/retry.ts:12 @ head\nUse the existing backoff helper",
		"review:15 gus lower-case state",
	}, got, "oldest first, by review id")
	assert.Equal(t, reviews[1].SubmittedAt, steers[0].At)
}

// A review's text is its body and its author's line comments, each with
// its anchor; an outdated comment keeps its original line and commit; a
// comment on a whole file keeps its path; another author's reply and an
// empty comment are not the reviewer's words.
func TestReviewSteerTextCarriesLineCommentsAndAnchors(t *testing.T) {
	review := reviewFixture(3, "alice", "CHANGES_REQUESTED", "Two things")
	outdated := lineFixture(42, 3, "alice", "src/old.ts", 0, "Gone now")
	original := int64(4)
	outdated.OriginalLine, outdated.OriginalCommitID = &original, "before"
	comments := []gitHubPullReviewComment{
		lineFixture(41, 3, "alice", "src/retry.ts", 12, "Use the helper"),
		outdated,
		lineFixture(43, 3, "alice", "README.md", 0, "Whole file note"),
		lineFixture(44, 3, "bob", "src/retry.ts", 13, "A reply by someone else"),
		lineFixture(45, 3, "alice", "src/retry.ts", 14, "   "),
		lineFixture(46, 99, "alice", "src/other.ts", 1, "Another review's comment"),
	}
	steers := mythicalReviewSteers([]gitHubPullReview{review}, comments, nil)
	require.Len(t, steers, 1)
	assert.Equal(t, "Two things\n\nsrc/retry.ts:12 @ head\nUse the helper\n\nsrc/old.ts:4 @ before\nGone now\n\nREADME.md\nWhole file note", steers[0].Text)
}

// A long review is cut to its bound on a character boundary and says so;
// invalid UTF-8 never reaches the steer.
func TestReviewSteerTextIsBoundedOnACharacterBoundary(t *testing.T) {
	long := strings.Repeat("é", mythicalReviewSteerBytes)
	text := mythicalBoundReviewText(long)
	assert.LessOrEqual(t, len(text), mythicalReviewSteerBytes)
	assert.True(t, utf8.ValidString(text))
	assert.True(t, strings.HasSuffix(text, mythicalReviewTruncated))
	assert.Equal(t, "short", mythicalBoundReviewText("short"))
	assert.Equal(t, "a\uFFFDb", mythicalBoundReviewText("a\xffb"))
	steers := mythicalReviewSteers([]gitHubPullReview{reviewFixture(1, "alice", "COMMENTED", long)}, nil, nil)
	require.Len(t, steers, 1)
	assert.Equal(t, text, steers[0].Text)
}

// The reviewer is the card's GitHub actor (CardPrimitives kind "github"),
// attributed by login whether or not they are a member.
func TestReviewSteerActorIsTheReviewersGitHubLogin(t *testing.T) {
	var actor map[string]any
	require.NoError(t, json.Unmarshal(gitHubReviewActor("alice"), &actor))
	assert.Equal(t, map[string]any{"kind": "github", "login": "alice", "color_index": float64(7)}, actor)
	assert.True(t, gitHubBotAuthor(gitHubActor{Login: "smithers-install[bot]"}))
	assert.True(t, gitHubBotAuthor(gitHubActor{Login: "x", Type: "Bot"}))
	assert.False(t, gitHubBotAuthor(gitHubActor{Login: "alice", Type: "User"}))
}

// Property: whatever GitHub answers, every steer is valid UTF-8 within its
// bound, non-empty, from a non-bot author, a CHANGES_REQUESTED or COMMENTED
// review, never a seen one, at most once per review id, in id order; and
// the answer does not depend on the order GitHub listed reviews in.
func FuzzReviewSteers(f *testing.F) {
	f.Add(int64(1), "alice", "CHANGES_REQUESTED", "Use the helper", int64(1), "src/a.ts", int64(3), "fix", false, int64(1))
	f.Add(int64(2), "app[bot]", "COMMENTED", "", int64(2), "", int64(0), "", true, int64(0))
	f.Add(int64(3), "bob", "APPROVED", "\xff\xfe", int64(3), "a", int64(-1), strings.Repeat("ü", 9000), false, int64(3))
	f.Fuzz(func(t *testing.T, id int64, login, state, body string, reviewOf int64, path string, line int64, comment string, bot bool, seenID int64) {
		user := gitHubActor{ID: id, Login: login, Type: "User"}
		if bot {
			user.Type = "Bot"
		}
		reviews := []gitHubPullReview{
			{ID: id, User: user, State: state, Body: body},
			{ID: id + 1, User: user, State: "COMMENTED", Body: body + comment},
			{ID: id, User: user, State: state, Body: body},
		}
		c := gitHubPullReviewComment{PullRequestReviewID: reviewOf}
		c.ID, c.Body, c.Path, c.User, c.CommitID = id+7, comment, path, user, "head"
		if line != 0 {
			c.Line = &line
		}
		seen := map[string]bool{"review:" + itoa(seenID): true}
		steers := mythicalReviewSteers(reviews, []gitHubPullReviewComment{c}, seen)
		reversed := mythicalReviewSteers([]gitHubPullReview{reviews[2], reviews[1], reviews[0]}, []gitHubPullReviewComment{c}, seen)
		require.Equal(t, steers, reversed, "GitHub's listing order does not matter")
		keys := map[string]bool{}
		for i, steer := range steers {
			require.True(t, utf8.ValidString(steer.Text))
			require.LessOrEqual(t, len(steer.Text), mythicalReviewSteerBytes)
			require.NotEmpty(t, strings.TrimSpace(steer.Text))
			require.False(t, seen[steer.Key], "a seen review never steers again")
			require.False(t, keys[steer.Key], "one steer per review")
			keys[steer.Key] = true
			require.False(t, bot || strings.HasSuffix(strings.ToLower(login), "[bot]"), "a bot never steers")
			require.NotEmpty(t, strings.TrimSpace(steer.Login))
			if i > 0 {
				require.Less(t, reviewKeyID(t, steers[i-1].Key), reviewKeyID(t, steer.Key), "oldest review first")
			}
		}
		bounded := mythicalBoundReviewText(body + comment)
		require.True(t, utf8.ValidString(bounded))
		require.LessOrEqual(t, len(bounded), mythicalReviewSteerBytes)
		if valid := strings.ToValidUTF8(body+comment, "\uFFFD"); len(valid) <= mythicalReviewSteerBytes {
			require.Equal(t, valid, bounded, "a text within the bound is kept whole")
		} else {
			require.True(t, strings.HasPrefix(valid, strings.TrimSuffix(bounded, mythicalReviewTruncated)), "a cut text is a prefix of the review")
		}
	})
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func reviewKeyID(t *testing.T, key string) int64 {
	t.Helper()
	id, err := strconv.ParseInt(strings.TrimPrefix(key, "review:"), 10, 64)
	require.NoError(t, err)
	return id
}
