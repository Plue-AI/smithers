package githubfake

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// PullReview is one review a person submitted on a pull request, with the
// line comment it carried, as GitHub's pulls/{n}/reviews and
// pulls/{n}/comments list them.
type PullReview struct {
	ID          int64     `json:"id"`
	Login       string    `json:"login"`
	State       string    `json:"state"`
	Body        string    `json:"body"`
	Path        string    `json:"path,omitempty"`
	Line        int       `json:"line,omitempty"`
	CommitID    string    `json:"commit_id"`
	SubmittedAt time.Time `json:"submitted_at"`
	// Bot is a review an App's bot account submitted (SubmitReview);
	// Comments are the further line comments it carried; Outdated, that
	// its line comments' lines left the diff (reviews.go).
	Bot      bool             `json:"bot,omitempty"`
	Comments []PullReviewLine `json:"comments,omitempty"`
	Outdated bool             `json:"outdated,omitempty"`
}

// reviewStates are the states a person can submit a review in.
var reviewStates = map[string]bool{"APPROVED": true, "CHANGES_REQUESTED": true, "COMMENTED": true}

// people serves what the people on GitHub do in a browser proof, outside
// the App: review a pull request (with a line comment), merge one, require
// approving reviews on main, and take GitHub down and back. It also reads
// back the pull requests and issues as GitHub holds them, and answers
// GitHub's own review and review-comment lists. Called under the lock.
func (s *Server) people(w http.ResponseWriter, r *http.Request) bool {
	reply := func(status int, value any) bool {
		if value == nil {
			w.WriteHeader(status)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
		return true
	}
	decode := func(into any) bool {
		return json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(into) == nil
	}
	if !strings.HasPrefix(r.URL.Path, "/_fake/") && s.down {
		return reply(http.StatusBadGateway, map[string]string{"message": "Bad Gateway"})
	}
	path := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/_fake/pulls":
		repo := r.URL.Query().Get("repo")
		result := []map[string]any{}
		for key, p := range s.pulls {
			if p.Repository != repo {
				continue
			}
			p = s.current(key)
			result = append(result, map[string]any{"number": p.Number, "title": p.Title, "body": p.Body, "state": p.State, "draft": p.Draft,
				"merged": p.Merged, "head": map[string]string{"ref": p.Head.Ref, "sha": p.Head.SHA}, "base": map[string]string{"ref": p.Base.Ref},
				"labels": p.Labels, "reviews": append([]PullReview{}, s.pullReviews[key]...), "review_decision": s.reviewDecision(p)})
		}
		sort.Slice(result, func(i, j int) bool { return result[i]["number"].(int64) < result[j]["number"].(int64) })
		return reply(200, result)
	case r.Method == http.MethodGet && r.URL.Path == "/_fake/issue":
		number, _ := strconv.ParseInt(r.URL.Query().Get("number"), 10, 64)
		key := issueKey(r.URL.Query().Get("repo"), number)
		opened := s.opened[key]
		if opened == nil {
			return reply(404, map[string]string{"message": "issue not found"})
		}
		return reply(200, IssueView{Number: opened.Number, Title: opened.Title, Body: opened.Body, Author: opened.Author, State: opened.State,
			StateReason: opened.StateReason, Labels: append([]string{}, s.labels[key]...), Events: append([]IssueEvent{}, s.events[key]...),
			Comments: append([]IssueComment{}, s.comments[key]...)})
	case r.Method == http.MethodPost && r.URL.Path == "/_fake/reviews":
		var body struct {
			Repo, Login, State, Body, Path string
			Number                         int64
			Line                           int
		}
		if !decode(&body) || body.Repo == "" || body.Login == "" || !reviewStates[body.State] || body.Line < 0 || (body.Path == "") != (body.Line == 0) ||
			body.State != "APPROVED" && body.Body == "" {
			return reply(400, map[string]string{"message": "repo, number, login, state (APPROVED, CHANGES_REQUESTED or COMMENTED), a body unless approving, and path with line or neither are required"})
		}
		key := issueKey(body.Repo, body.Number)
		if _, ok := s.pulls[key]; !ok {
			return reply(404, map[string]string{"message": "pull request not found"})
		}
		p := s.current(key)
		if p.State != "open" {
			return reply(422, map[string]string{"message": "Can not review a closed pull request"})
		}
		s.reviewIDs++
		review := PullReview{ID: s.reviewIDs, Login: body.Login, State: body.State, Body: body.Body, Path: body.Path, Line: body.Line, CommitID: p.Head.SHA, SubmittedAt: time.Now().UTC()}
		s.pullReviews[key] = append(s.pullReviews[key], review)
		// A comment-only review leaves the reviewer's approval or request as it was.
		if body.State != "COMMENTED" {
			if s.reviews[key] == nil {
				s.reviews[key] = map[string]string{}
			}
			s.reviews[key][body.Login] = body.State
		}
		return reply(200, review)
	case r.Method == http.MethodPost && r.URL.Path == "/_fake/merge":
		var body struct {
			Repo   string
			Number int64
		}
		if !decode(&body) || body.Repo == "" {
			return reply(400, map[string]string{"message": "repo and number are required"})
		}
		key := issueKey(body.Repo, body.Number)
		if _, ok := s.pulls[key]; !ok {
			return reply(404, map[string]string{"message": "pull request not found"})
		}
		p := s.current(key)
		if p.State != "open" || p.Draft {
			return reply(405, map[string]string{"message": "Pull request is not mergeable"})
		}
		// A person's merge on github.com meets main's protection as the App's does.
		if refusal := s.protectionRefusal(body.Repo, p); refusal != "" {
			return reply(405, map[string]string{"message": refusal})
		}
		merged, ok := s.merge(key, p, "", "")
		if !ok {
			return reply(405, map[string]string{"message": "Pull Request is not mergeable"})
		}
		return reply(200, map[string]any{"merged": true, "sha": merged.MergeCommitSHA})
	case r.Method == http.MethodPost && r.URL.Path == "/_fake/protection":
		var body struct{ Reviews int }
		if !decode(&body) || body.Reviews < 0 || body.Reviews > 6 {
			return reply(400, map[string]string{"message": "reviews is 0 to 6"})
		}
		s.protected = true
		s.reviewRule = body.Reviews
		return reply(http.StatusNoContent, nil)
	case r.Method == http.MethodPost && r.URL.Path == "/_fake/outage":
		var body struct{ Down *bool }
		if !decode(&body) || body.Down == nil {
			return reply(400, map[string]string{"message": "down is required"})
		}
		s.down = *body.Down
		return reply(http.StatusNoContent, nil)
	case r.Method == http.MethodGet && len(path) == 6 && path[0] == "repos" && path[3] == "pulls" && (path[5] == "reviews" || path[5] == "comments"):
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			return reply(401, map[string]string{"message": "Requires authentication"})
		}
		if s.unread[r.URL.Path] > 0 {
			// FailNextReads: GitHub did not answer this read.
			s.unread[r.URL.Path]--
			return reply(http.StatusBadGateway, map[string]string{"message": "Bad Gateway"})
		}
		key := path[1] + "/" + path[2] + "/" + path[4]
		if _, ok := s.pulls[key]; !ok {
			return reply(404, map[string]string{"message": "Not Found"})
		}
		result := s.reviewListing(s.pullReviews[key], path[5] == "comments")
		start, end := pageBounds(r, len(result))
		return reply(200, result[start:end])
	}
	return false
}
