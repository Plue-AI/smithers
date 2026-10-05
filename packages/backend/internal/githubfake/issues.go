package githubfake

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// An issue a person opened on a fixture repository (OpenIssue), with what
// GitHub keeps of it: its text and author, its state, its labeled, unlabeled
// and closed events, and its comments. Labels live with the pull requests'
// (Server.labels); every App write still passes the token boundary and the
// permanent write log.
type issue struct {
	ID          int64
	Number      int64
	Title, Body string
	Author      string
	State       string
	StateReason string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// IssueEvent is one event on an issue's timeline: labeled, unlabeled or
// closed, by a person or the App (ViaApp).
type IssueEvent struct {
	ID        int64     `json:"id"`
	Event     string    `json:"event"`
	Actor     string    `json:"actor"`
	ViaApp    bool      `json:"via_app"`
	Label     string    `json:"label,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// IssueComment is one comment on an issue or pull request.
type IssueComment struct {
	ID        int64     `json:"id"`
	Body      string    `json:"body"`
	ViaApp    bool      `json:"via_app"`
	Author    string    `json:"author"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// IssueView is an issue as GitHub holds it now.
type IssueView struct {
	Number      int64
	Title, Body string
	Author      string
	State       string
	StateReason string
	Labels      []string
	Events      []IssueEvent
	Comments    []IssueComment
}

// OpenIssue opens an issue on repo as the person login (the owner when
// empty), as on github.com, and answers its number: issues and pull
// requests share one sequence.
func (s *Server) OpenIssue(repo, login, title, body string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if login == "" {
		login = s.config.OwnerLogin
	}
	number := s.nextNumber(repo)
	now := time.Now().UTC()
	s.issueIDs++
	s.opened[issueKey(repo, number)] = &issue{ID: s.issueIDs, Number: number, Title: title, Body: body, Author: login, State: "open", CreatedAt: now, UpdatedAt: now}
	return number
}

// LabelIssue applies label to repo#number as the person login, as on
// github.com, and answers the labeled event's id; 0 when no such issue
// is open.
func (s *Server) LabelIssue(repo string, number int64, login, label string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := issueKey(repo, number)
	if s.opened[key] == nil {
		return 0
	}
	if !slices.Contains(s.labels[key], label) {
		s.labels[key] = append(s.labels[key], label)
	}
	return s.event(key, "labeled", login, false, label)
}

// CommentIssue posts body on repo#number as the person login, as on
// github.com, and answers the comment's id; 0 when no such issue is open.
func (s *Server) CommentIssue(repo string, number int64, login, body string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.personComment(repo, number, login, body)
}

func (s *Server) personComment(repo string, number int64, login, body string) int64 {
	key := issueKey(repo, number)
	opened := s.opened[key]
	if opened == nil {
		return 0
	}
	s.commentIDs++
	now := time.Now().UTC()
	s.comments[key] = append(s.comments[key], IssueComment{ID: s.commentIDs, Body: body, Author: login, CreatedAt: now})
	opened.UpdatedAt = now
	return s.commentIDs
}

// Issue answers repo#number as GitHub holds it now, and whether it exists.
func (s *Server) Issue(repo string, number int64) (IssueView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := issueKey(repo, number)
	opened := s.opened[key]
	if opened == nil {
		return IssueView{}, false
	}
	return IssueView{Number: opened.Number, Title: opened.Title, Body: opened.Body, Author: opened.Author, State: opened.State,
		StateReason: opened.StateReason, Labels: append([]string{}, s.labels[key]...), Events: append([]IssueEvent{}, s.events[key]...),
		Comments: append([]IssueComment{}, s.comments[key]...)}, true
}

func issueKey(repo string, number int64) string { return repo + "/" + strconv.FormatInt(number, 10) }

// nextNumber is the number GitHub gives the next issue or pull request.
func (s *Server) nextNumber(repo string) int64 {
	number := int64(1)
	for _, existing := range s.issues(repo) {
		number = max(number, existing+1)
	}
	for _, p := range s.pulls {
		if p.Repository == repo {
			number = max(number, p.Number+1)
		}
	}
	return number
}

// event records one timeline event and answers its id.
func (s *Server) event(key, kind, actor string, viaApp bool, label string) int64 {
	s.eventIDs++
	s.events[key] = append(s.events[key], IssueEvent{ID: s.eventIDs, Event: kind, Actor: actor, ViaApp: viaApp, Label: label, CreatedAt: time.Now().UTC()})
	if opened := s.opened[key]; opened != nil {
		opened.UpdatedAt = time.Now().UTC()
	} else if pull, ok := s.pulls[key]; ok {
		pull.UpdatedAt = time.Now().UTC()
		s.pulls[key] = pull
	}
	return s.eventIDs
}

// appLogin is the App's bot account, the actor of its own events.
func (s *Server) appLogin() string { return s.config.Slug + "[bot]" }

func (s *Server) actor(login string, viaApp bool) map[string]any {
	if viaApp {
		return map[string]any{"login": s.appLogin(), "type": "Bot"}
	}
	return map[string]any{"login": login, "type": "User"}
}

func (s *Server) viaApp(viaApp bool) any {
	if viaApp {
		return map[string]int64{"id": s.config.AppID}
	}
	return nil
}

// issueJSON is the issue as GET /repos/{owner}/{repo}/issues/{n} answers it.
func (s *Server) issueJSON(repo string, i *issue) map[string]any {
	var reason any
	if i.StateReason != "" {
		reason = i.StateReason
	}
	key := issueKey(repo, i.Number)
	return map[string]any{"id": i.ID, "number": i.Number, "title": i.Title, "body": i.Body, "state": i.State, "state_reason": reason,
		"html_url": fmt.Sprintf("https://github.com/%s/issues/%d", repo, i.Number), "user": s.actor(i.Author, false),
		"labels": labelsOf(s.labels[key]), "comments": len(s.comments[key]), "performed_via_github_app": nil,
		"created_at": i.CreatedAt, "updated_at": i.UpdatedAt}
}

// issueList is GET /repos/{owner}/{repo}/issues: the issues people opened
// and the pull requests (each with its pull_request link, as GitHub lists
// them), in state (open by default, closed or all), newest first,
// per_page (30 by default, at most 100) from page.
func (s *Server) issueList(r *http.Request, repo string) []any {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	since, _ := time.Parse(time.RFC3339, r.URL.Query().Get("since"))
	type row struct {
		number  int64
		updated time.Time
		value   map[string]any
	}
	var rows []row
	for _, opened := range s.opened {
		if s.opened[issueKey(repo, opened.Number)] == opened && (state == "all" || state == opened.State) && (since.IsZero() || opened.UpdatedAt.After(since)) {
			rows = append(rows, row{opened.Number, opened.UpdatedAt, s.issueJSON(repo, opened)})
		}
	}
	for _, p := range s.pulls {
		if p.Repository == repo && (state == "all" || state == p.State) && (since.IsZero() || p.UpdatedAt.After(since)) {
			rows = append(rows, row{p.Number, p.UpdatedAt, s.pullIssueJSON(p)})
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if r.URL.Query().Get("sort") == "updated" && !rows[i].updated.Equal(rows[j].updated) {
			if r.URL.Query().Get("direction") == "asc" {
				return rows[i].updated.Before(rows[j].updated)
			}
			return rows[i].updated.After(rows[j].updated)
		}
		if r.URL.Query().Get("direction") == "asc" {
			return rows[i].number < rows[j].number
		}
		return rows[i].number > rows[j].number
	})
	start, end := pageBounds(r, len(rows))
	out := []any{}
	for _, entry := range rows[start:end] {
		out = append(out, entry.value)
	}
	return out
}

func (s *Server) pullIssueJSON(p Pull) map[string]any {
	return map[string]any{"id": p.ID, "number": p.Number, "title": p.Title, "body": p.Body, "state": p.State,
		"created_at": p.CreatedAt, "updated_at": p.UpdatedAt, "html_url": p.HTMLURL, "user": s.actor(s.appLogin(), true),
		"labels": labelsOf(s.labels[issueKey(p.Repository, p.Number)]), "pull_request": map[string]string{"html_url": p.HTMLURL}}
}

// SetIssueUpdatedAt fixes the source timestamp for deterministic cursor fixtures.
func (s *Server) SetIssueUpdatedAt(repo string, number int64, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if opened := s.opened[issueKey(repo, number)]; opened != nil {
		opened.UpdatedAt = at.UTC()
	}
}

// issueRequest serves the issue reads and writes beyond labels and new
// comments (issueWrite): the issue list, an issue, its edit or close, its
// events and its comments, and an edit of a comment. handled is false for
// any other path.
func (s *Server) issueRequest(r *http.Request, repo string, path []string, body []byte) (int, any, bool) {
	if len(path) == 1 && path[0] == "issues" && r.Method == http.MethodGet {
		return 200, s.issueList(r, repo), true
	}
	if len(path) < 2 || path[0] != "issues" {
		return 0, nil, false
	}
	if len(path) == 3 && path[1] == "comments" && r.Method == http.MethodPatch {
		if status, response, ok := s.accessible(r, "issues", "write"); !ok {
			return status, response, true
		}
		id, _ := strconv.ParseInt(path[2], 10, 64)
		var input struct{ Body string }
		if json.Unmarshal(body, &input) != nil || input.Body == "" {
			status, response := failure(422, "body required")
			return status, response, true
		}
		for key, comments := range s.comments {
			for i := range comments {
				if comments[i].ID == id && comments[i].ViaApp {
					comments[i].Body = input.Body
					comments[i].UpdatedAt = time.Now().UTC()
					s.comments[key] = comments
					return 200, map[string]any{"id": id, "body": input.Body}, true
				}
			}
		}
		status, response := failure(404, "comment not found")
		return status, response, true
	}
	if len(path) == 2 && path[1] == "comments" && r.Method == http.MethodGet {
		if status, response, ok := s.accessible(r, "issues", "read"); !ok {
			if _, _, canPull := s.accessible(r, "pull_requests", "read"); !canPull {
				return status, response, true
			}
		}
		return 200, s.repositoryIssueComments(r, repo), true
	}
	if len(path) == 2 && path[1] == "events" && r.Method == http.MethodGet {
		return 200, s.repositoryIssueEvents(r, repo), true
	}
	number, err := strconv.ParseInt(path[1], 10, 64)
	if err != nil {
		return 0, nil, false
	}
	key := issueKey(repo, number)
	opened := s.opened[key]
	switch {
	case len(path) == 2 && r.Method == http.MethodGet:
		if opened == nil {
			status, response := failure(404, "issue not found")
			return status, response, true
		}
		return 200, s.issueJSON(repo, opened), true
	case len(path) == 2 && r.Method == http.MethodPatch:
		if status, response, ok := s.accessible(r, "issues", "write"); !ok {
			return status, response, true
		}
		if opened == nil {
			status, response := failure(404, "issue not found")
			return status, response, true
		}
		var input struct {
			State       *string `json:"state"`
			StateReason *string `json:"state_reason"`
		}
		if json.Unmarshal(body, &input) != nil || input.State != nil && *input.State != "open" && *input.State != "closed" {
			status, response := failure(422, "invalid issue update")
			return status, response, true
		}
		if input.State != nil && *input.State != opened.State {
			opened.State, opened.StateReason = *input.State, ""
			if *input.State == "closed" {
				s.event(key, "closed", "", true, "")
				if input.StateReason != nil {
					opened.StateReason = *input.StateReason
				}
			}
		}
		return 200, s.issueJSON(repo, opened), true
	case len(path) == 3 && path[2] == "events" && r.Method == http.MethodGet:
		events := []any{}
		if page, _ := strconv.Atoi(r.URL.Query().Get("page")); page <= 1 {
			for _, event := range s.events[key] {
				entry := map[string]any{"id": event.ID, "event": event.Event, "actor": s.actor(event.Actor, event.ViaApp),
					"performed_via_github_app": s.viaApp(event.ViaApp), "created_at": event.CreatedAt}
				if event.Label != "" {
					entry["label"] = map[string]string{"name": event.Label}
				}
				events = append(events, entry)
			}
		}
		return 200, events, true
	case len(path) == 3 && path[2] == "comments" && r.Method == http.MethodGet:
		comments := []any{}
		if page, _ := strconv.Atoi(r.URL.Query().Get("page")); page <= 1 {
			for _, comment := range s.comments[key] {
				comments = append(comments, map[string]any{"id": comment.ID, "body": comment.Body, "user": s.actor(comment.Author, comment.ViaApp),
					"performed_via_github_app": s.viaApp(comment.ViaApp), "created_at": comment.CreatedAt})
			}
		}
		return 200, comments, true
	}
	return 0, nil, false
}

// repositoryIssueEvents is GET /repos/{owner}/{repo}/issues/events: every
// issue's events, newest first as GitHub lists them, per_page (30 by
// default, at most 100) from page (1 by default), each with the issue it
// happened on; an event on a pull request carries its pull_request link.
func (s *Server) repositoryIssueEvents(r *http.Request, repo string) []any {
	type located struct {
		number int64
		event  IssueEvent
	}
	var all []located
	prefix := repo + "/"
	for key, events := range s.events {
		number, err := strconv.ParseInt(strings.TrimPrefix(key, prefix), 10, 64)
		if !strings.HasPrefix(key, prefix) || err != nil {
			continue
		}
		for _, event := range events {
			all = append(all, located{number, event})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].event.ID > all[j].event.ID })
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	if perPage <= 0 {
		perPage = 30
	}
	perPage = min(perPage, 100)
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	page = max(page, 1)
	out := []any{}
	for _, at := range all[min((page-1)*perPage, len(all)):min(page*perPage, len(all))] {
		issue := map[string]any{"number": at.number, "pull_request": map[string]any{}}
		if opened := s.opened[issueKey(repo, at.number)]; opened != nil {
			issue = s.issueJSON(repo, opened)
		} else if p, ok := s.pulls[issueKey(repo, at.number)]; ok {
			issue = s.pullIssueJSON(p)
		}
		entry := map[string]any{"id": at.event.ID, "event": at.event.Event, "actor": s.actor(at.event.Actor, at.event.ViaApp),
			"performed_via_github_app": s.viaApp(at.event.ViaApp), "created_at": at.event.CreatedAt, "issue": issue}
		if at.event.Label != "" {
			entry["label"] = map[string]string{"name": at.event.Label}
		}
		out = append(out, entry)
	}
	return out
}

// issueText answers GraphQL's repository.issueOrPullRequest text fields for
// an issue a person opened: its author wrote both parts (no edit, no rename).
func (s *Server) issueText(installationID int64, body []byte) (int, any) {
	var input struct {
		Variables struct {
			Owner, Name string
			Number      int64
		}
	}
	if json.Unmarshal(body, &input) != nil {
		return failure(400, "invalid GraphQL request")
	}
	repo := input.Variables.Owner + "/" + input.Variables.Name
	installation, _ := s.installation(installationID)
	for _, allowed := range installation.Repositories {
		if allowed.FullName != repo {
			continue
		}
		opened := s.opened[issueKey(repo, input.Variables.Number)]
		if opened == nil {
			break
		}
		return 200, map[string]any{"data": map[string]any{"repository": map[string]any{"issueOrPullRequest": map[string]any{
			"title": opened.Title, "body": opened.Body, "author": map[string]string{"__typename": "User", "login": opened.Author},
			"userContentEdits": map[string]any{"nodes": []any{}}, "timelineItems": map[string]any{"nodes": []any{}}}}}}
	}
	return 200, map[string]any{"data": map[string]any{"repository": nil}, "errors": []map[string]string{{"message": fmt.Sprintf("Could not resolve to an issue or pull request with the number of %d.", input.Variables.Number)}}}
}

// isIssueTextQuery reports a GraphQL body that reads an issue's text writers.
func isIssueTextQuery(body []byte) bool { return strings.Contains(string(body), "issueOrPullRequest") }

// UpdateComment changes a fixture comment as a person would, with an explicit
// timestamp for equal-second edits and cursor boundaries.
func (s *Server) UpdateComment(repo string, id int64, body string, at time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, comments := range s.comments {
		if !strings.HasPrefix(key, repo+"/") {
			continue
		}
		for i := range comments {
			if comments[i].ID == id {
				comments[i].Body, comments[i].UpdatedAt = body, at.UTC()
				s.comments[key] = comments
				return true
			}
		}
	}
	return false
}

// Repository comment reads share GitHub's updated/created sort, direction,
// exclusive since boundary, paging and the server's conditional-read wrapper.
func (s *Server) repositoryIssueComments(r *http.Request, repo string) []any {
	type located struct {
		number  int64
		comment IssueComment
		updated time.Time
	}
	var all []located
	since, _ := time.Parse(time.RFC3339, r.URL.Query().Get("since"))
	for key, comments := range s.comments {
		if !strings.HasPrefix(key, repo+"/") {
			continue
		}
		number, err := strconv.ParseInt(strings.TrimPrefix(key, repo+"/"), 10, 64)
		if err != nil {
			continue
		}
		for _, c := range comments {
			updated := c.UpdatedAt
			if updated.IsZero() {
				updated = c.CreatedAt
			}
			if since.IsZero() || updated.After(since) {
				all = append(all, located{number, c, updated})
			}
		}
	}
	sort.Slice(all, func(i, j int) bool {
		a, b := all[i].comment.CreatedAt, all[j].comment.CreatedAt
		if r.URL.Query().Get("sort") == "updated" {
			a, b = all[i].updated, all[j].updated
		}
		less := a.Before(b)
		if a.Equal(b) {
			less = all[i].comment.ID < all[j].comment.ID
		}
		if r.URL.Query().Get("sort") != "" && r.URL.Query().Get("direction") == "desc" {
			return b.Before(a) || a.Equal(b) && all[i].comment.ID > all[j].comment.ID
		}
		return less
	})
	start, end := pageBounds(r, len(all))
	out := []any{}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	for _, e := range all[start:end] {
		c := e.comment
		out = append(out, map[string]any{"id": c.ID, "body": c.Body, "user": s.actor(c.Author, c.ViaApp), "performed_via_github_app": s.viaApp(c.ViaApp), "created_at": c.CreatedAt, "updated_at": e.updated, "issue_url": scheme + "://" + r.Host + "/repos/" + repo + "/issues/" + strconv.FormatInt(e.number, 10)})
	}
	return out
}
