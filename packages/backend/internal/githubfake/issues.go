package githubfake

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
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
	ID     int64  `json:"id"`
	Body   string `json:"body"`
	ViaApp bool   `json:"via_app"`
	Author string `json:"author"`
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
	s.opened[issueKey(repo, number)] = &issue{Number: number, Title: title, Body: body, Author: login, State: "open", CreatedAt: now, UpdatedAt: now}
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
	return map[string]any{"number": i.Number, "title": i.Title, "body": i.Body, "state": i.State, "state_reason": reason,
		"html_url": fmt.Sprintf("https://github.com/%s/issues/%d", repo, i.Number), "user": s.actor(i.Author, false),
		"labels": labelsOf(s.labels[issueKey(repo, i.Number)]), "performed_via_github_app": nil,
		"created_at": i.CreatedAt, "updated_at": i.UpdatedAt}
}

// issueRequest serves the issue reads and writes beyond labels and new
// comments (issueWrite): an issue, its edit or close, its events and its
// comments, and an edit of a comment. handled is false for any other path.
func (s *Server) issueRequest(r *http.Request, repo string, path []string, body []byte) (int, any, bool) {
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
					s.comments[key] = comments
					return 200, map[string]any{"id": id, "body": input.Body}, true
				}
			}
		}
		status, response := failure(404, "comment not found")
		return status, response, true
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
					"performed_via_github_app": s.viaApp(comment.ViaApp)})
			}
		}
		return 200, comments, true
	}
	return 0, nil, false
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
