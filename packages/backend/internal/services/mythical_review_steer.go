package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// A review or review comment on a TODO's pull request is a steer (mvp.md
// J10.2, §6.3): the stack reads the pull request's reviews on its poll
// (installs have no public webhook), and each new one enters the TODO's
// activity as a steer attributed to the reviewer's GitHub login. The TODO
// goes back to Working through the same path a person's steer on a TODO in
// review takes (mythicalSteered): its next attempt starts with the review as
// its first input and its proposal updates the same pull request. Agent
// replies inside GitHub threads are deferred.

const (
	// mythicalReviewSteerBytes bounds one review's steer text; a longer
	// review is cut on a character boundary and says so.
	mythicalReviewSteerBytes = 8 << 10
	// mythicalReviewPages bounds the pages (100 each) of reviews and of
	// review comments one poll reads.
	mythicalReviewPages = 5
	// mythicalReviewSteersPerTodo bounds the GitHub reviews one TODO keeps
	// as steers, so its checks stay bounded on a very long review thread.
	mythicalReviewSteersPerTodo = 64
)

const mythicalReviewTruncated = "\n[review truncated]"

// gitHubPullReview is one submitted review as GET pulls/{n}/reviews
// answers it.
type gitHubPullReview struct {
	ID          int64       `json:"id"`
	User        gitHubActor `json:"user"`
	Body        string      `json:"body"`
	State       string      `json:"state"`
	CommitID    string      `json:"commit_id"`
	SubmittedAt time.Time   `json:"submitted_at"`
}

// gitHubPullReviewComment is one line comment as GET pulls/{n}/comments
// answers it; PullRequestReviewID is the review that submitted it.
type gitHubPullReviewComment struct {
	gitHubReviewLine
	PullRequestReviewID int64 `json:"pull_request_review_id"`
}

// mythicalReviewReader reads a pull request's reviews and review comments.
// The GitHub API implements it; a stack whose GitHub does not reads none.
type mythicalReviewReader interface {
	PullReviews(ctx context.Context, gh mythicalGitHubRepo, number int64) ([]gitHubPullReview, []gitHubPullReviewComment, error)
}

// PullReviews reads every review and review comment of a pull request, up
// to mythicalReviewPages pages of each.
func (g *mythicalGitHubAPI) PullReviews(ctx context.Context, gh mythicalGitHubRepo, number int64) ([]gitHubPullReview, []gitHubPullReviewComment, error) {
	base := landingGitHubRepoPath(gh.Owner, gh.Name) + "/pulls/" + strconv.FormatInt(number, 10)
	var reviews []gitHubPullReview
	for page := 1; page <= mythicalReviewPages; page++ {
		var batch []gitHubPullReview
		status, err := g.api.request(ctx, gh.Token, http.MethodGet, base+"/reviews?per_page=100&page="+strconv.Itoa(page), nil, &batch)
		if err != nil {
			return nil, nil, err
		}
		if status != http.StatusOK {
			return nil, nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read pull request reviews")
		}
		reviews = append(reviews, batch...)
		if len(batch) < 100 {
			break
		}
	}
	var comments []gitHubPullReviewComment
	for page := 1; page <= mythicalReviewPages; page++ {
		var batch []gitHubPullReviewComment
		status, err := g.api.request(ctx, gh.Token, http.MethodGet, base+"/comments?per_page=100&page="+strconv.Itoa(page), nil, &batch)
		if err != nil {
			return nil, nil, err
		}
		if status != http.StatusOK {
			return nil, nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read pull request review comments")
		}
		comments = append(comments, batch...)
		if len(batch) < 100 {
			break
		}
	}
	return reviews, comments, nil
}

// mythicalReviewSteer is one GitHub review as a steer: its key
// ("review:<id>"), the reviewer's login, its text and when it was submitted.
type mythicalReviewSteer struct {
	Key   string
	Login string
	Text  string
	At    time.Time
}

// gitHubBotAuthor reports whether a review's author is an App's bot
// account: the install's own App, or any other. Neither steers a TODO.
func gitHubBotAuthor(user gitHubActor) bool {
	return strings.EqualFold(user.Type, "Bot") || strings.HasSuffix(strings.ToLower(user.Login), "[bot]")
}

// mythicalReviewSteers answers the reviews that are new steers, oldest
// first: a CHANGES_REQUESTED review, and a COMMENTED review with a body or a
// line comment. An approval, a dismissed or pending review, a review by a
// bot (the install's App included), one with no author, and one whose key is
// already seen are not. A review's text is its body and then each of its
// author's line comments with its anchor (normalizeGitHubReviewText).
func mythicalReviewSteers(reviews []gitHubPullReview, comments []gitHubPullReviewComment, seen map[string]bool) []mythicalReviewSteer {
	ordered := append([]gitHubPullReview(nil), reviews...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	byReview := map[int64][]gitHubPullReviewComment{}
	for _, comment := range comments {
		byReview[comment.PullRequestReviewID] = append(byReview[comment.PullRequestReviewID], comment)
	}
	var out []mythicalReviewSteer
	taken := map[string]bool{}
	for _, review := range ordered {
		key := "review:" + strconv.FormatInt(review.ID, 10)
		state := strings.ToUpper(review.State)
		if review.ID <= 0 || strings.TrimSpace(review.User.Login) == "" || gitHubBotAuthor(review.User) || seen[key] || taken[key] ||
			state != "CHANGES_REQUESTED" && state != "COMMENTED" {
			continue
		}
		text := mythicalReviewText(review, byReview[review.ID])
		if text == "" {
			if state != "CHANGES_REQUESTED" {
				continue
			}
			text = "Changes requested."
		}
		taken[key] = true
		out = append(out, mythicalReviewSteer{Key: key, Login: review.User.Login, Text: mythicalBoundReviewText(text), At: review.SubmittedAt})
	}
	return out
}

// mythicalReviewText is review's body and its author's line comments.
// normalizeGitHubReviewText refuses a whole review when one comment has no
// committed line anchor, so a comment on a whole file, or one with no
// commit, is said here with its path and text instead.
func mythicalReviewText(review gitHubPullReview, comments []gitHubPullReviewComment) string {
	input := gitHubReviewInput{ID: review.ID, Body: review.Body, State: review.State, User: review.User}
	if input.User.ID <= 0 {
		// normalizeGitHubReviewText needs an author id; a fetched review
		// always carries one, and authority never rests on it here.
		input.User.ID = 1
	}
	var loose []string
	for _, comment := range comments {
		line := comment.gitHubReviewLine
		if line.ID <= 0 || strings.TrimSpace(line.Body) == "" || !strings.EqualFold(line.User.Login, review.User.Login) {
			continue
		}
		line.User = input.User
		anchor := line.Line
		commit := line.CommitID
		if anchor == nil {
			anchor, commit = line.OriginalLine, line.OriginalCommitID
		}
		if anchor == nil || *anchor <= 0 || strings.TrimSpace(line.Path) == "" || strings.TrimSpace(commit) == "" {
			if path := strings.TrimSpace(line.Path); path != "" {
				loose = append(loose, path+"\n"+line.Body)
			} else {
				loose = append(loose, line.Body)
			}
			continue
		}
		input.Comments = append(input.Comments, line)
	}
	for _, line := range input.Comments {
		if strings.TrimSpace(line.Body) == strings.TrimSpace(input.Body) {
			// A single line comment's review may repeat the comment as its
			// body: the anchored comment says it once.
			input.Body = ""
		}
	}
	text, err := normalizeGitHubReviewText(input, 0)
	if err != nil {
		text = review.Body
	}
	parts := []string{}
	if strings.TrimSpace(text) != "" {
		parts = append(parts, text)
	}
	parts = append(parts, loose...)
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// mythicalBoundReviewText is text as valid UTF-8 within
// mythicalReviewSteerBytes, cut on a character boundary and marked when cut.
func mythicalBoundReviewText(text string) string {
	text = strings.ToValidUTF8(text, "\uFFFD")
	if len(text) <= mythicalReviewSteerBytes {
		return text
	}
	cut := mythicalReviewSteerBytes - len(mythicalReviewTruncated)
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + mythicalReviewTruncated
}

// gitHubReviewActor is a GitHub reviewer as a TodoCard actor (packages/rpc
// CardPrimitives ActorSchema kind "github"): attributed by login, whether or
// not they are a member.
func gitHubReviewActor(login string) json.RawMessage {
	encoded, _ := json.Marshal(map[string]any{"kind": "github", "login": login, "color_index": 7})
	return encoded
}

// reviewSteer reads the reviews of item's open pull request and, when there
// are new ones, steers the TODO with them in one transaction: each review is
// one steer attributed to its reviewer, held for the next attempt, and the
// TODO goes back to Working (mythicalSteered), its review run cancelled.
// item is the TODO as follow answered it, still in review; nil means
// nothing changed. A GitHub read that fails changes nothing: the next poll
// reads again. Each review is a steer once, by its id, across polls and
// restarts.
func (st *mythicalItemStep) reviewSteer(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	s := st.s
	reader, ok := s.github.(mythicalReviewReader)
	if !ok || st.gh == nil || !item.PRNumber.Valid || item.PRState != "open" || item.State != "proposed" || item.PausedAt.Valid ||
		len(item.PendingOp) > 0 || !mythicalTodo(item) {
		return nil, nil
	}
	checks := mythicalChecksOf(item)
	if checks.ForeignHead != "" {
		return nil, nil
	}
	seen, kept := map[string]bool{}, 0
	for _, steer := range checks.Steers {
		if steer.GitHub != "" {
			seen[steer.GitHub] = true
			kept++
		}
	}
	if kept >= mythicalReviewSteersPerTodo {
		return nil, nil
	}
	reviews, comments, err := reader.PullReviews(ctx, *st.gh, item.PRNumber.Int64)
	if err != nil {
		s.logger.Warn("mythical.review_read_failed", "item", uuidString(item.ID), "error", err)
		return nil, nil
	}
	steers := mythicalReviewSteers(reviews, comments, seen)
	if len(steers) == 0 {
		return nil, nil
	}
	if room := mythicalReviewSteersPerTodo - kept; len(steers) > room {
		steers = steers[:room]
	}
	var saved db.MythicalItem
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, item.RepositoryID); err != nil {
			return err
		}
		q := db.New(tx)
		stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
		if err != nil {
			return err
		}
		current, err := q.GetMythicalItem(ctx, item.ID)
		if err != nil {
			return err
		}
		if current.Version != item.Version {
			// Another writer moved the TODO (a person's steer, a drop): the
			// next poll reads it again.
			return db.ErrMythicalItemMoved
		}
		if err := s.cancelAttempt(ctx, tx, stack, current); err != nil {
			return err
		}
		next := mythicalSteered(item)
		steered := mythicalChecksOf(next)
		now := s.now().UTC()
		for _, review := range steers {
			at := review.At.UTC()
			if at.IsZero() {
				at = now
			}
			steered.Steers = append(steered.Steers, todoSteer{Text: review.Text, By: gitHubReviewActor(review.Login), At: at,
				Attempt: item.Attempt + 1, GitHub: review.Key})
		}
		next.Checks = steered.encode()
		saved, err = q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ErrMythicalItemMoved
		}
		if err != nil {
			return err
		}
		for _, review := range steers {
			fact, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "attempt": item.Attempt + 1,
				"delivery": "next_attempt", "source": "github_review", "review": review.Key, "pr": item.PRNumber.Int64,
				"actor": map[string]any{"kind": "github", "login": review.Login}, "by": map[string]any{"github": review.Login},
				"from": todoState(item), "to": todoState(saved)})
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.steered", todoState(saved), fact); err != nil {
				return err
			}
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return nil
	})
	if errors.Is(err, db.ErrMythicalItemMoved) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &saved, nil
}
