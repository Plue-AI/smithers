package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// IssueView is one saved issue view the repository's factory declares
// (S.Factory({ issueViews }) in .smithers/FACTORY.ts, projected to
// .smithers/factory.json): a named filter over the issue list.
type IssueView struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	State  string   `json:"state,omitempty"`
	Labels []string `json:"labels,omitempty"`
}

// issueViewID is the id shape @smthrs/targets Factory.IssueView accepts.
var issueViewID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// Bounds the declaration side enforces; a projection past them is refused.
const (
	maximumIssueViews      = 32
	maximumIssueViewLabels = 16
)

// parseFactoryIssueViews reads a factory projection's issueViews. A missing
// projection or key declares none; an unreadable or malformed one is an
// error, never an empty list.
func parseFactoryIssueViews(projection []byte) ([]IssueView, error) {
	if len(projection) == 0 {
		return []IssueView{}, nil
	}
	var factory struct {
		IssueViews []json.RawMessage `json:"issueViews"`
	}
	if err := json.Unmarshal(projection, &factory); err != nil {
		return nil, errors.New(factoryProjectionPath + " is not valid JSON")
	}
	if len(factory.IssueViews) > maximumIssueViews {
		return nil, fmt.Errorf("%s declares more than %d issue views", factoryProjectionPath, maximumIssueViews)
	}
	views := make([]IssueView, 0, len(factory.IssueViews))
	seen := map[string]bool{}
	for index, raw := range factory.IssueViews {
		// Strict, like the declaration: an unknown or null field never broadens a view.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("%s issue view %d is not an object", factoryProjectionPath, index)
		}
		for key, value := range fields {
			if key != "id" && key != "title" && key != "state" && key != "labels" {
				return nil, fmt.Errorf("%s issue view %d has an unknown field %q", factoryProjectionPath, index, key)
			}
			if string(value) == "null" {
				return nil, fmt.Errorf("%s issue view %d has a null %s", factoryProjectionPath, index, key)
			}
		}
		var view IssueView
		if err := json.Unmarshal(raw, &view); err != nil {
			return nil, fmt.Errorf("%s issue view %d is malformed", factoryProjectionPath, index)
		}
		views = append(views, view)
		if !issueViewID.MatchString(view.ID) {
			return nil, fmt.Errorf("%s declares an invalid issue view id %q", factoryProjectionPath, view.ID)
		}
		if seen[view.ID] {
			return nil, fmt.Errorf("%s declares the issue view %q twice", factoryProjectionPath, view.ID)
		}
		seen[view.ID] = true
		if strings.TrimSpace(view.Title) == "" || strings.ContainsAny(view.Title, "\r\n") {
			return nil, fmt.Errorf("%s issue view %q has an invalid title", factoryProjectionPath, view.ID)
		}
		switch view.State {
		case "", "open", "closed", "fixed", "verified", "all":
		default:
			return nil, fmt.Errorf("%s issue view %q has an invalid state %q", factoryProjectionPath, view.ID, view.State)
		}
		if len(view.Labels) > maximumIssueViewLabels {
			return nil, fmt.Errorf("%s issue view %q names more than %d labels", factoryProjectionPath, view.ID, maximumIssueViewLabels)
		}
		lowered := map[string]bool{}
		for _, label := range view.Labels {
			key := strings.ToLower(label)
			if label == "" || strings.TrimSpace(label) != label || utf8.RuneCountInString(label) > 255 || lowered[key] {
				return nil, fmt.Errorf("%s issue view %q has an invalid label %q", factoryProjectionPath, view.ID, label)
			}
			lowered[key] = true
		}
	}
	return views, nil
}

// WithIssueFactoryReader lets IssueService read the committed factory
// projection on the repository's default bookmark, where saved issue views
// are declared. Without it, a repository declares no views.
func WithIssueFactoryReader(host repositoryPolicyHost) IssueServiceOption {
	return func(s *IssueService) {
		s.factory = host
	}
}

// readIssueViews is the view list the owner committed to the repository's
// default bookmark. No bookmark or no projection declares none; a failed
// read or a malformed projection is an error. The repo host caches a
// commit's file, so an unchanged main reads nothing new.
func (s *IssueService) readIssueViews(ctx context.Context, owner string, repository db.Repository) ([]IssueView, error) {
	if s.factory == nil {
		return []IssueView{}, nil
	}
	commit, found, err := bookmarkCommit(ctx, s.factory, owner, repository.Name, repository.DefaultBookmark)
	if err != nil {
		return nil, pkgerrors.Internal("failed to read the repository's issue views").WithCause(err)
	}
	if !found {
		return []IssueView{}, nil
	}
	file, err := s.factory.GetFileAtCommit(ctx, owner, repository.Name, commit, factoryProjectionPath)
	if repohost.IsFileNotFound(err) {
		return []IssueView{}, nil
	}
	if err != nil {
		return nil, pkgerrors.Internal("failed to read the repository's issue views").WithCause(err)
	}
	if file.TooLarge || file.Encoding == "base64" {
		return nil, pkgerrors.UnprocessableEntity(factoryProjectionPath + " is not readable text")
	}
	views, err := parseFactoryIssueViews([]byte(file.Content))
	if err != nil {
		return nil, pkgerrors.UnprocessableEntity(err.Error())
	}
	return views, nil
}

// ListIssueViews is the saved issue views a readable repository declares, in
// declaration order.
func (s *IssueService) ListIssueViews(ctx context.Context, viewer *db.User, owner, repo string) ([]IssueView, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, err
	}
	return s.readIssueViews(ctx, owner, repository)
}

// ListIssuesInView is one page of the issue list with the named saved view's
// filters applied: its state, and every label it names. The page, cursor and
// count are the plain list's, over the filtered issues. An undeclared view
// is not found.
func (s *IssueService) ListIssuesInView(ctx context.Context, viewer *db.User, owner, repo, view string, afterNumber int64, limit int) ([]IssueResponse, string, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, "", 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, "", 0, err
	}
	views, err := s.readIssueViews(ctx, owner, repository)
	if err != nil {
		return nil, "", 0, err
	}
	for _, declared := range views {
		if declared.ID != view {
			continue
		}
		labels := make([]string, 0, len(declared.Labels))
		for _, label := range declared.Labels {
			labels = append(labels, strings.ToLower(label))
		}
		return s.listIssues(ctx, viewer, repository, afterNumber, limit, declared.State, labels)
	}
	return nil, "", 0, pkgerrors.NotFound(fmt.Sprintf("issue view %q not found", view))
}
