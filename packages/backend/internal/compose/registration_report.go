package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// registrationReports is the cross-account report store (#2158).
type registrationReports interface {
	Record(ctx context.Context, repo, commit string, report json.RawMessage) (bool, error)
	Lookup(ctx context.Context, repo string) (services.SharedRegistrationReport, bool, error)
}

// registrationObserved dedupes the recordings one completed run's repeated
// snapshots ask for: a report is recorded once per repository and commit,
// and a refusal (a private repository) is not asked again for a while.
type registrationObserved struct {
	mu   sync.Mutex
	seen map[string]time.Time
	wait sync.WaitGroup
}

const registrationObservedTTL = 10 * time.Minute

func (o *registrationObserved) claim(key string, now time.Time) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.seen == nil {
		o.seen = map[string]time.Time{}
	}
	if at, ok := o.seen[key]; ok && now.Sub(at) < registrationObservedTTL {
		return false
	}
	o.seen[key] = now
	return true
}

func (o *registrationObserved) forget(key string) {
	o.mu.Lock()
	delete(o.seen, key)
	o.mu.Unlock()
}

// observedRegistration is a report read from a completed registration run.
type observedRegistration struct {
	repo, commit string
	report       json.RawMessage
}

// completedRegistrations reads the terminal decision a run's journal page
// carries. Only a completed `register-repository` run that finished with an
// outcome yields a report, and only when its report names the repository its
// input link named.
func completedRegistrations(rows []json.RawMessage) []observedRegistration {
	found := []observedRegistration{}
	for _, raw := range rows {
		var event struct {
			Kind    string `json:"kind"`
			Payload struct {
				EventType string `json:"eventType"`
				Payload   struct {
					State struct {
						FlowName string `json:"flowName"`
						Payload  struct {
							Link string `json:"link"`
						} `json:"payload"`
						Result struct {
							Tag  string `json:"_tag"`
							Exit struct {
								Tag   string `json:"_tag"`
								Value struct {
									Report json.RawMessage `json:"report"`
								} `json:"value"`
							} `json:"exit"`
						} `json:"result"`
					} `json:"state"`
				} `json:"payload"`
			} `json:"payload"`
		}
		if json.Unmarshal(raw, &event) != nil || event.Kind != "control.engine.event" || event.Payload.EventType != "flows.engine.run-decision" {
			continue
		}
		state := event.Payload.Payload.State
		if state.FlowName != "register-repository" || state.Result.Tag != "Complete" || state.Result.Exit.Tag != "Success" {
			continue
		}
		var report struct {
			Repo  string `json:"repo"`
			Clone struct {
				Commit string `json:"commit"`
			} `json:"clone"`
		}
		if json.Unmarshal(state.Result.Exit.Value.Report, &report) != nil || report.Repo == "" || !strings.Contains(strings.ToLower(state.Payload.Link), report.Repo) {
			continue
		}
		found = append(found, observedRegistration{repo: report.Repo, commit: report.Clone.Commit, report: state.Result.Exit.Value.Report})
	}
	return found
}

// observeRegistration records the completed registration runs a relayed
// journal page shows. The page came from the box's own host, never from the
// client; the store shares only what it can confirm is public.
func (api *browserFlowAPI) observeRegistration(answer json.RawMessage) {
	if api.reports == nil || !bytes.Contains(answer, []byte(`"register-repository"`)) {
		return
	}
	var page struct {
		Payload struct {
			Rows []json.RawMessage `json:"rows"`
		} `json:"payload"`
	}
	if json.Unmarshal(answer, &page) != nil {
		return
	}
	for _, found := range completedRegistrations(page.Payload.Rows) {
		key := found.repo + "@" + found.commit
		if !api.observed.claim(key, time.Now()) {
			continue
		}
		api.observed.wait.Add(1)
		go func() {
			defer api.observed.wait.Done()
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if _, err := api.reports.Record(ctx, found.repo, found.commit, found.report); err != nil {
				if !errors.Is(err, services.ErrRegistrationReportUnshareable) {
					api.observed.forget(key)
					slog.Warn("registration report not recorded", "repo", found.repo, "error", err)
				}
			}
		}()
	}
}

// registrationReport answers Registration.Report: the shared report of the
// public repository named in the payload at its current commit, or none.
func (api *browserFlowAPI) registrationReport(w http.ResponseWriter, r *http.Request, payload json.RawMessage) {
	var input struct {
		Repo string `json:"repo"`
	}
	if json.Unmarshal(payload, &input) != nil || strings.TrimSpace(input.Repo) == "" || api.reports == nil {
		browserFlowRefusal(w, http.StatusBadRequest, "Name the GitHub repository.")
		return
	}
	shared, ok, err := api.reports.Lookup(r.Context(), strings.ToLower(input.Repo))
	if err != nil {
		// Unreadable is not private and not absent: the app analyses normally.
		slog.Warn("registration report lookup failed", "repo", input.Repo, "error", err)
		browserFlowRefusal(w, http.StatusServiceUnavailable, "Shared report unavailable.")
		return
	}
	if !ok {
		browserFlowJSON(w, http.StatusOK, map[string]any{"ok": true, "payload": map[string]any{"report": nil}})
		return
	}
	browserFlowJSON(w, http.StatusOK, map[string]any{"ok": true, "payload": map[string]any{"report": shared}})
}
