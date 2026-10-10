package services

import (
	"math"
	"sort"
	"time"
)

// These are read projections, not persisted receipts or an ingestion API. The
// owning readers must supply server-derived identities and complete coverage.
// Source readers never accept facts from a request or turn table presence
// into coverage. Admin analytics counts runs,
// whereas this fold counts distinct TODOs and attributed lifecycle sources.
type scorecardTODO struct {
	Repository string
	ID         string
	Owner      string
	Accepted   time.Time
	State      string
	StateAt    time.Time
	Signatures map[string]bool
}
type scorecardAction struct {
	SourceKey, TODO, Person, Via, Kind string
	At                                 time.Time
	// For delegated actions Person is the confirming person, never the agent.
}
type scorecardPresence struct {
	ID, Branch, Person string
	From, To           time.Time
}
type scorecardLearning struct {
	ID, TODO, Signature, Repository string
	Accepted, Merged                time.Time
}
type scorecardFacts struct {
	// Coverage is set only by the owning source reader after its contract is
	// integrated. It is deliberately private and absent from ScorecardService.
	Coverage                  map[string]bool
	IncompleteStates          map[string]bool
	InstallStart, FirstAnswer *time.Time
	TODOs                     []scorecardTODO
	Actions                   []scorecardAction
	Presence                  []scorecardPresence
	Activations               map[string]time.Time
	MainCommits               map[string]bool // commit id -> associated with a TODO PR
	Learnings                 []scorecardLearning
}

func aggregateScorecard(window ScorecardWindow, facts scorecardFacts) Scorecard {
	out := unavailableScorecard(window)
	if facts.IncompleteStates == nil {
		facts.IncompleteStates = make(map[string]bool)
	}
	inWindow := func(at time.Time) bool { return !at.Before(window.From) && at.Before(window.To) }
	set := func(name string, value any, verdict string) {
		m := out.Measures[name]
		missing := make([]string, 0)
		for _, ticket := range m.MissingTickets {
			covered := facts.Coverage[ticket]
			if scoped, ok := facts.Coverage[name+":"+ticket]; ok {
				covered = scoped
			}
			if !covered || facts.IncompleteStates[name] {
				missing = append(missing, ticket)
			}
		}
		m.MissingTickets = missing
		if len(missing) == 0 {
			m.Value, m.Verdict = value, verdict
		}
		out.Measures[name] = m
	}
	todos := make(map[string]scorecardTODO)
	for _, todo := range facts.TODOs {
		todos[todo.ID] = todo
	}
	accepted, merged, dropped, failed := 0, 0, 0, 0
	weeks := make([]int, int(math.Ceil(window.To.Sub(window.From).Hours()/168)))
	var firstMerge *time.Time
	mergedIDs := make(map[string]bool)
	for _, todo := range todos {
		if inWindow(todo.Accepted) {
			accepted++
			weeks[int(todo.Accepted.Sub(window.From).Hours()/168)]++
		}
		// Current state excludes dropped-then-reopened TODOs from dropped counts.
		if todo.State == "merged" && !todo.StateAt.IsZero() {
			if firstMerge == nil || todo.StateAt.Before(*firstMerge) {
				at := todo.StateAt.UTC()
				firstMerge = &at
			}
		}
		if !inWindow(todo.StateAt) {
			continue
		}
		switch todo.State {
		case "merged":
			merged++
			mergedIDs[todo.ID] = true
		case "dropped":
			dropped++
		case "failed":
			failed++
		}
	}
	utc := func(at *time.Time) *time.Time {
		if at == nil {
			return nil
		}
		value := at.UTC()
		return &value
	}
	set("install_start", utc(facts.InstallStart), "between")
	set("first_answer", utc(facts.FirstAnswer), "between")
	set("first_merge", firstMerge, "between")
	set("accepted", accepted, "between")
	set("merged", merged, "between")
	set("dropped", dropped, "between")
	set("failed", failed, "between")
	outside := 0
	for _, associated := range facts.MainCommits {
		if !associated {
			outside++
		}
	}
	percent := func(n, total int) any {
		if total == 0 {
			return nil
		}
		return math.Round(float64(n)*1000/float64(total)) / 10
	}
	outsideShare := percent(outside, len(facts.MainCommits))
	set("outside_work", map[string]any{"commits": outside, "total": len(facts.MainCommits), "percent": outsideShare}, "between")
	dogfood := "between"
	if merged >= 50 {
		dogfood = "pass"
	}
	if merged < 20 || outside*2 > len(facts.MainCommits) {
		dogfood = "kill"
	}
	set("dogfood", map[string]any{"merged": merged, "outside_percent": outsideShare}, dogfood)
	var minutes any
	activation := "between"
	if facts.InstallStart != nil && firstMerge != nil && !firstMerge.Before(*facts.InstallStart) {
		elapsed := firstMerge.Sub(*facts.InstallStart).Minutes()
		minutes = elapsed
		if elapsed <= 60 {
			activation = "pass"
		}
	}
	set("activation", minutes, activation)
	core := "pass"
	for _, count := range weeks {
		if count < 10 {
			core = "between"
		}
	}
	if len(weeks) >= 2 && weeks[1] < 3 {
		core = "kill"
	}
	set("core_value", map[string]any{"accepted_per_week": weeks}, core)
	// A seven-day request may select week 3 directly; a longer request must
	// contain week 3 before a retention verdict is meaningful.
	var retained any
	retention := "between"
	count := -1
	if len(weeks) >= 3 {
		count = weeks[2]
	} else if window.To.Sub(window.From) == 7*24*time.Hour {
		count = accepted
	}
	if count >= 0 {
		retained = count
		if count >= 10 {
			retention = "pass"
		} else if count < 3 {
			retention = "kill"
		}
	}
	set("retention", retained, retention)
	edits, second := 0, 0
	personEdited := make(map[string]bool)
	seen := make(map[string]bool)
	for _, action := range facts.Actions {
		// IDs belong to wait/confirmation/burst namespaces, not delivery event ids.
		key := action.Kind + ":" + action.SourceKey
		if action.SourceKey == "" || seen[key] || action.Person == "" {
			continue
		}
		seen[key] = true
		if action.Kind == "edit" {
			if todo, ok := todos[action.TODO]; ok && (todo.State != "merged" || !action.At.After(todo.StateAt)) {
				personEdited[action.TODO] = true
			}
		}
		if !inWindow(action.At) {
			continue
		}
		if action.Kind == "edit" && (action.Via == "terminal" || action.Via == "ssh") {
			edits++
		}
		if todo, ok := todos[action.TODO]; ok && action.Person != todo.Owner {
			second++
		}
	}
	set("terminal_edits", edits, "between")
	set("second_member_actions", second, "between")
	noCode := 0
	for id := range mergedIDs {
		if !personEdited[id] {
			noCode++
		}
	}
	set("no_hand_written_code", map[string]any{"todos": noCode, "merged": merged, "percent": percent(noCode, merged)}, "between")
	revisions := 0
	for _, at := range facts.Activations {
		if inWindow(at) {
			revisions++
		}
	}
	set("flow_revisions", revisions, "between")
	// Each audit row is one person's session on a branch (§7.3.1a). A
	// multiplayer session is one separate interval in which two or more
	// members share a branch: overlapping co-presence is one session however
	// many rows, people or sockets it spans.
	type span struct{ from, to time.Time }
	branches := make(map[string][]scorecardPresence)
	rowSeen := make(map[string]bool)
	for _, row := range facts.Presence {
		if row.ID == "" || row.Branch == "" || row.Person == "" || row.To.Sub(row.From) < 2*time.Minute || rowSeen[row.ID] {
			continue
		}
		rowSeen[row.ID] = true
		branches[row.Branch] = append(branches[row.Branch], row)
	}
	sessions := 0
	sessionWeeks := make([]int, len(weeks))
	for _, rows := range branches {
		shared := []span{}
		for i, a := range rows {
			for _, b := range rows[i+1:] {
				if a.Person == b.Person {
					continue
				}
				start, end := a.From, a.To
				if b.From.After(start) {
					start = b.From
				}
				if b.To.Before(end) {
					end = b.To
				}
				if start.Before(end) {
					shared = append(shared, span{start, end})
				}
			}
		}
		sort.Slice(shared, func(i, j int) bool { return shared[i].from.Before(shared[j].from) })
		for i := 0; i < len(shared); {
			session := shared[i]
			for i++; i < len(shared) && !shared[i].from.After(session.to); i++ {
				if shared[i].to.After(session.to) {
					session.to = shared[i].to
				}
			}
			if inWindow(session.from) {
				sessions++
				sessionWeeks[int(session.from.Sub(window.From).Hours()/168)]++
			}
		}
	}
	multi := "pass"
	for _, count := range sessionWeeks {
		if count < 3 {
			multi = "between"
		}
	}
	if len(sessionWeeks) >= 2 && sessionWeeks[1] == 0 {
		multi = "kill"
	}
	set("multiplayer", map[string]any{"sessions": sessions, "per_week": sessionWeeks}, multi)
	ordered := make([]scorecardTODO, 0, len(todos))
	for _, todo := range todos {
		ordered = append(ordered, todo)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Accepted.Equal(ordered[j].Accepted) {
			return ordered[i].ID < ordered[j].ID
		}
		return ordered[i].Accepted.Before(ordered[j].Accepted)
	})
	helped, proposals := 0, 0
	seen = make(map[string]bool)
	for _, learning := range facts.Learnings {
		if learning.ID == "" || seen[learning.ID] {
			continue
		}
		seen[learning.ID] = true
		if inWindow(learning.Accepted) {
			proposals++
		}
		if !inWindow(learning.Merged) {
			continue
		}
		before, after := []scorecardTODO{}, []scorecardTODO{}
		for _, todo := range ordered {
			if todo.ID == learning.TODO || todo.Repository != learning.Repository {
				continue
			}
			if todo.Accepted.Before(learning.Merged) {
				before = append(before, todo)
			} else {
				after = append(after, todo)
			}
		}
		if len(before) < 5 || len(after) < 5 {
			continue
		}
		complete := true
		for _, item := range append(before[len(before)-5:], after[:5]...) {
			if item.Signatures == nil {
				complete = false
			}
		}
		if !complete {
			facts.IncompleteStates["self_improvement"] = true
			continue
		}
		failures := func(items []scorecardTODO) int {
			n := 0
			for _, item := range items {
				if item.Signatures[learning.Signature] {
					n++
				}
			}
			return n
		}
		if failures(after[:5]) < failures(before[len(before)-5:]) {
			helped++
		}
	}
	improvement := "between"
	// The kill signal is no accepted proposal in two weeks; a shorter
	// window without one cannot show it.
	if helped > 0 {
		improvement = "pass"
	} else if proposals == 0 && window.To.Sub(window.From) >= 14*24*time.Hour {
		improvement = "kill"
	}
	set("self_improvement", helped, improvement)
	return out
}
