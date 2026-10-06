package compose

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Visit bookkeeping groups a person's sockets into one coarse scorecard fact.
// It stores neither locations nor a roster and cannot answer PresenceOn.
type presenceVisit struct {
	branch      string
	member      int64
	name        string
	start, last time.Time
	sessions    map[string]struct{}
}
type presenceVisits struct {
	mu     sync.Mutex
	visits map[string]*presenceVisit
	audit  *services.AuditService
	now    func() time.Time
}

func (v *presenceVisits) heartbeat(branch string, member int64, name, session string) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	key := branch + ":" + strconv.FormatInt(member, 10)
	if v.visits == nil {
		v.visits = map[string]*presenceVisit{}
	}
	visit := v.visits[key]
	if visit != nil && !now.Before(visit.last.Add(30*time.Second)) {
		v.finish(visit, visit.last.Add(30*time.Second))
		visit = nil
	}
	if visit == nil {
		visit = &presenceVisit{branch: branch, member: member, name: name, start: now, sessions: map[string]struct{}{}}
		v.visits[key] = visit
	}
	visit.last = now
	visit.sessions[session] = struct{}{}
}
func (v *presenceVisits) leave(branch string, member int64, session string) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	key := branch + ":" + strconv.FormatInt(member, 10)
	visit := v.visits[key]
	if visit == nil {
		return
	}
	delete(visit.sessions, session)
	if len(visit.sessions) == 0 {
		end := v.now()
		if expiry := visit.last.Add(30 * time.Second); expiry.Before(end) {
			end = expiry
		}
		v.finish(visit, end)
		delete(v.visits, key)
	}
}
func (v *presenceVisits) finish(visit *presenceVisit, end time.Time) {
	if end.Sub(visit.start) < 2*time.Minute || v.audit == nil {
		return
	}
	v.audit.Log(context.Background(), services.AuditEvent{EventType: "presence", ActorID: &visit.member, ActorName: visit.name, TargetType: "branch", TargetName: visit.branch, Action: "visit", Metadata: map[string]any{"branch": visit.branch, "member": visit.member, "via": "app", "start": visit.start.UTC().Format(time.RFC3339Nano), "end": end.UTC().Format(time.RFC3339Nano)}})
}
func (v *presenceVisits) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			v.mu.Lock()
			now := v.now()
			for key, visit := range v.visits {
				if !now.Before(visit.last.Add(30 * time.Second)) {
					v.finish(visit, visit.last.Add(30*time.Second))
					delete(v.visits, key)
				}
			}
			v.mu.Unlock()
		}
	}
}
