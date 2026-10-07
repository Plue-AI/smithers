package githubfake

import (
	"net/http"
	"strconv"
	"strings"
)

type resourceBudget struct {
	limit, remaining int
	reset            int64
}
type streamLimit struct {
	status     int
	retryAfter string
}

// RequestCounter separates conditional responses from locally charged requests.
type RequestCounter struct{ Raw, Charged int }

// SetResourceBudget supplies literal response headers without deriving them from
// the product's accounting. Unconfigured resources emit no budget headers.
func (s *Server) SetResourceBudget(resource string, limit, remaining int, reset int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resourceBudgets == nil {
		s.resourceBudgets = make(map[string]resourceBudget)
	}
	s.resourceBudgets[resource] = resourceBudget{limit, remaining, reset}
}

// LimitNextStream refuses one request without applying its effects.
func (s *Server) LimitNextStream(stream string, status int, retryAfter string) {
	if status != 403 && status != 429 {
		panic("rate limit status must be 403 or 429")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.streamLimits == nil {
		s.streamLimits = make(map[string]streamLimit)
	}
	s.streamLimits[stream] = streamLimit{status, retryAfter}
}

// RequestCounters returns an independent snapshot by stream and status. Git
// smart HTTP and the fake's browser controls are excluded from API accounting.
func (s *Server) RequestCounters() map[string]map[int]RequestCounter {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot := make(map[string]map[int]RequestCounter, len(s.counters))
	for stream, statuses := range s.counters {
		snapshot[stream] = make(map[int]RequestCounter, len(statuses))
		for status, count := range statuses {
			snapshot[stream][status] = count
		}
	}
	return snapshot
}

func requestStream(r *http.Request) string {
	p := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(p) > 0 && p[0] == "search" {
		return "search"
	}
	if strings.HasSuffix(r.URL.Path, "/access_tokens") {
		return "installation-token"
	}
	if len(p) >= 4 && p[0] == "repos" {
		if p[3] == "issues" && len(p) >= 5 {
			if p[4] == "events" {
				return "issue-events"
			}
			if p[4] == "comments" {
				return "conversation-comments"
			}
		}
		if p[3] == "pulls" && len(p) >= 5 {
			if p[4] == "comments" || len(p) >= 6 && p[5] == "comments" {
				return "review-comments"
			}
			if len(p) >= 6 && p[5] == "reviews" {
				return "reviews"
			}
		}
		if p[3] == "commits" && len(p) >= 6 {
			return "checks"
		}
		if p[3] == "collaborators" {
			return "permissions"
		}
		return p[3]
	}
	return "repository-list"
}

func (s *Server) writeBudgetHeaders(w http.ResponseWriter, stream string) {
	resource := "core"
	if stream == "search" {
		resource = "search"
	}
	if budget, ok := s.resourceBudgets[resource]; ok {
		w.Header().Set("X-RateLimit-Resource", resource)
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(budget.limit))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(budget.remaining))
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(budget.reset, 10))
	}
}

func (s *Server) countRequest(stream string, status int) {
	if s.counters == nil {
		s.counters = make(map[string]map[int]RequestCounter)
	}
	if s.counters[stream] == nil {
		s.counters[stream] = make(map[int]RequestCounter)
	}
	count := s.counters[stream][status]
	count.Raw++
	if status != http.StatusNotModified {
		count.Charged++
	}
	s.counters[stream][status] = count
}
