package compose

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type branchPresence struct {
	hosts           *flowhost.Store
	terminalManager *routes.TerminalSessionManager
	queries         *db.Queries
	branches        *services.WorkspaceService
	dispatcher      browserFlowDispatcher
	members         *services.Members
	visits          *presenceVisits
	publicOrigin    func() string
	// Composed registry, attribution and revocation providers must all report
	// ready. A missing callback keeps safe-idle and rebases unknown. Production
	// binds sourceCensus once the live socket is mounted.
	sourcesReady func(context.Context, db.Workspace) bool
	daemons      daemonSnapshots
	startedAt    time.Time
	now          func() time.Time
	terminals    func(context.Context, db.Workspace, map[string]int) ([]any, error)
}

type leaseParticipant struct {
	ParticipantID    string          `json:"participantId"`
	SessionID        string          `json:"sessionId"`
	AgentKind        string          `json:"agentKind"`
	Via              string          `json:"via"`
	RunID            string          `json:"runId"`
	ForMember        string          `json:"for_member"`
	Kind             string          `json:"kind"`
	DisplayName      string          `json:"displayName"`
	Where            json.RawMessage `json:"where"`
	Watching         string          `json:"watching"`
	LeaseExpiresAtMs int64           `json:"leaseExpiresAtMs"`
}

func (p *branchPresence) call(ctx context.Context, row db.Workspace, slug, procedure string, fields map[string]any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	// Membership is checked before this call. Resolve the existing host's
	// durable principal, which may differ from the branch machine's owner.
	// The dispatcher still rechecks current access and host identity; this
	// lookup never creates a host or grants the caller host credentials.
	target, err := p.hosts.ExistingCodingTarget(ctx, row.RepositoryID, row.ID, slug)
	if err != nil {
		return nil, err
	}
	fields["branchId"] = row.ID
	if procedure == "Branch.PresenceOn" {
		fields["sourcesReady"] = p.sourcesReady != nil && p.sourcesReady(ctx, row)
	}
	// Existing BranchProtocol requires this envelope. The host adapter discards
	// it and mints its own signed scope after authenticating the runtime bearer.
	fields["capability"] = map[string]any{"signature": "", "claims": map[string]any{"kid": "host", "branchId": row.ID, "capabilityId": "host", "access": "write", "issuedAtMs": 0, "expiresAtMs": 0}}
	raw, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	answer, err := p.dispatcher.CallRPC(ctx, target, procedure, raw)
	if err != nil {
		return nil, err
	}
	var result struct {
		OK      bool            `json:"ok"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(answer, &result) != nil || !result.OK {
		return nil, errors.New("presence bridge refused")
	}
	return result.Payload, nil
}

func (p *branchPresence) session(r *http.Request, repository int64) live.PresenceSession {
	user := middleware.UserFromContext(r.Context())
	if p == nil || p.dispatcher == nil || p.branches == nil || p.queries == nil || user == nil || repository == 0 {
		return live.PresenceSession{}
	}
	_, slug, err := installRepository(r.Context(), p.queries)
	if err != nil {
		return live.PresenceSession{}
	}
	session := uuid.NewString()
	actor := "member:" + strconv.FormatInt(user.ID, 10)
	var held *db.Workspace
	var mu sync.Mutex
	closed := false
	leave := func() {
		if held == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Second)
		defer cancel()
		_, _ = p.call(ctx, *held, slug, "Branch.Leave", map[string]any{"participantId": actor, "sessionId": session})
		p.visits.leave(held.ID, user.ID, session)
		held = nil
	}
	return live.PresenceSession{Close: func() { mu.Lock(); defer mu.Unlock(); closed = true; leave() }, Move: func(ctx context.Context, raw json.RawMessage) string {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return live.Forbidden
		}
		var where struct {
			Branch   string `json:"branch"`
			Path     string `json:"path"`
			Line     *int64 `json:"line"`
			Terminal string `json:"terminal"`
			Watching string `json:"watching"`
			Run      string `json:"run"`
			Step     string `json:"step"`
		}
		if len(raw) == 0 || json.Unmarshal(raw, &where) != nil {
			return live.Forbidden
		}
		if where.Branch == "" {
			leave()
			return ""
		}
		// Browser heartbeats cannot claim a run or foreign terminal. Those sources
		// require their authenticated session adapters, not user-controlled IDs.
		if where.Terminal != "" || where.Watching != "" || where.Run != "" || where.Step != "" {
			return live.Unsupported
		}
		location := map[string]any{"kind": "branch"}
		if where.Path != "" {
			if !presencePath(where.Path) {
				return live.Forbidden
			}
			location = map[string]any{"kind": "file", "path": where.Path}
			if where.Line != nil {
				if *where.Line <= 0 {
					return live.Forbidden
				}
				location["line"] = *where.Line
			}
		} else if where.Line != nil {
			return live.Forbidden
		}
		row, err := p.branches.PresenceBranch(ctx, where.Branch, repository, user.ID)
		if err != nil {
			return live.Forbidden
		}
		if held != nil && held.ID != row.ID {
			leave()
		}
		name := user.DisplayName
		if name == "" {
			name = user.Username
		}
		held = &row
		_, err = p.call(ctx, row, slug, "Branch.Announce", map[string]any{"participantId": actor, "sessionId": session, "displayName": name, "cursor": nil, "kind": "person", "where": location})
		if err != nil {
			return live.Unsupported
		}
		held = &row
		p.visits.heartbeat(row.ID, user.ID, user.Username, session)
		return ""
	}}
}

func (p *branchPresence) source(ctx context.Context, branch string, repository, member int64, slug string) (live.Source, string) {
	if p == nil || p.branches == nil || p.queries == nil {
		return live.Source{}, live.Unsupported
	}
	row, err := p.branches.PresenceBranch(ctx, branch, repository, member)
	if err != nil {
		return live.Source{}, live.Forbidden
	}
	if p.dispatcher == nil && row.Status == "running" {
		return live.Source{}, live.Unsupported
	}
	return live.Source{Key: "branch:" + row.ID, Hints: []string{"workspace_status_" + strings.ReplaceAll(row.ID, "-", "")}, Every: 250 * time.Millisecond, MinInterval: 250 * time.Millisecond, FailClosed: true, Build: func(ctx context.Context) (json.RawMessage, error) {
		// Refresh by stable identity: a rename or machine transition must update
		// the same mounted card, and removed access must stop the projection.
		current, err := p.branches.PresenceBranch(ctx, row.ID, repository, member)
		if err != nil {
			return nil, err
		}
		var leases []leaseParticipant
		// Only a running machine has a live host roster. Persisted waking,
		// failed and asleep facts remain readable without starting a host.
		running := current.Status == "running"
		if p.dispatcher != nil && running {
			raw, err := p.call(ctx, current, slug, "Branch.Roster", map[string]any{})
			if err != nil {
				return nil, err
			}
			if err = json.Unmarshal(raw, &leases); err != nil {
				return nil, err
			}
		} else if running {
			return nil, errors.New("awake branch roster unavailable")
		}
		// Multiple sessions retain leases but render one participant, at the newest
		// location. Lease timestamps stay internal, so heartbeats do not fan out.
		latest := map[string]leaseParticipant{}
		order := []string{}
		for _, lease := range leases {
			prior, ok := latest[lease.ParticipantID]
			if !ok {
				order = append(order, lease.ParticipantID)
			}
			if !ok || lease.LeaseExpiresAtMs > prior.LeaseExpiresAtMs {
				latest[lease.ParticipantID] = lease
			}
		}
		presence := []any{}
		colors := map[string]int{}
		if p.members != nil {
			roster, err := p.members.SharedRoster(ctx)
			if err != nil {
				return nil, err
			}
			for _, member := range roster.Members {
				colors[member.Login] = member.ColorIndex
			}
		}
		for _, id := range order {
			lease := latest[id]
			memberID, err := strconv.ParseInt(strings.TrimPrefix(id, "member:"), 10, 64)
			if lease.Kind == "agent" {
				var sponsor *db.User
				color := 6
				if lease.ForMember != "" {
					sponsorID, parseErr := strconv.ParseInt(strings.TrimPrefix(lease.ForMember, "member:"), 10, 64)
					if parseErr != nil {
						return nil, parseErr
					}
					person, lookupErr := p.queries.GetUserByID(ctx, sponsorID)
					if lookupErr != nil {
						return nil, lookupErr
					}
					sponsor = &person
					color = colors[person.Username]
				}
				actor := branchAgentActor(id, lease, sponsor, color)
				presence = append(presence, presenceEntry(actor, lease, leases))
				continue
			}
			if err != nil || lease.Kind != "person" {
				continue
			}
			person, err := p.queries.GetUserByID(ctx, memberID)
			if err != nil {
				return nil, err
			}
			actor := branchPersonActor(person, colors[person.Username])
			if lease.Via != "" {
				actor["via"] = lease.Via
			}
			presence = append(presence, presenceEntry(actor, lease, leases))
		}
		origin := ""
		if p.publicOrigin != nil {
			origin = p.publicOrigin()
		}
		model := branchPresenceModel(current, presence, origin)
		if current.IsFork {
			projected, err := p.branches.GetBranch(ctx, current.ID, repository, member)
			if err != nil {
				return nil, err
			}
			// Older fork rows may predate retained source metadata.
			// Preserve their main fallback without overwriting a recorded source.
			if projected.Kind == "scratch" && projected.ForkedFrom == nil {
				model["scratch"] = map[string]any{"forked_from": map[string]any{"kind": "main"}}
			}
			if projected.Kind == "scratch" && projected.ForkedFrom != nil {
				from := projected.ForkedFrom
				origin := map[string]any{"kind": from.Kind}
				switch from.Kind {
				case "item":
					item, err := p.queries.GetMythicalItemByNumber(ctx, repository, from.Item)
					if err != nil {
						return nil, err
					}
					origin["n"], origin["title"] = from.Item, item.Title
				case "branch":
					origin["name"] = from.Ref
				}
				model["scratch"] = map[string]any{"forked_from": origin}
			}
		}
		if p.terminals != nil {
			terminals, err := p.terminals(ctx, current, colors)
			if err != nil {
				return nil, err
			}
			if err = projectTerminalAgents(terminals, presence); err != nil {
				return nil, err
			}
			model["terminals"] = terminals
		}
		moved, err := p.queries.WorkspaceMovedOff(ctx, current.ID)
		if err != nil {
			return nil, err
		}
		if len(moved) != 0 {
			model["moved_off"] = moved
		}
		if position, waiting := p.branches.MachinePlace(current); waiting {
			model["machine"] = map[string]any{"state": "waiting", "position": position}
		}
		return json.Marshal(model)
	}}, ""
}

// The projection uses the persisted machine, never a wake or admission request.
func branchPresenceModel(row db.Workspace, presence []any, origin string) map[string]any {
	machine := map[string]any{"state": "closed"}
	switch row.Status {
	case "suspended", "stopped":
		machine["state"] = "asleep"
	case "releasing":
		machine["state"] = "releasing"
	case "running":
		machine["state"] = "awake"
	case "starting", "pending":
		machine["state"] = "waking"
	case "failed":
		machine["state"] = "failed"
		machine["error"] = map[string]any{"class": "infra", "code": "machine_failed", "message": "Machine failed"}
	}
	host := "localhost"
	if address, err := url.Parse(origin); err == nil && address.Hostname() != "" {
		host = address.Hostname()
	}
	return map[string]any{"id": row.ID, "name": row.TargetBookmark, "head": row.HeadCommitID, "machine": machine, "presence": presence, "terminals": []any{}, "ssh_line": "ssh -p 2222 " + row.TargetBookmark + "@" + host}
}

// rebasePresence reads authenticated leases afresh at the stack boundary. It
// never uses the card projection (which intentionally omits unknown actors),
// starts a host, or treats a failed roster request as an empty branch.
func (p *branchPresence) rebasePresence(ctx context.Context, repository int64, workspace string) (services.RebasePresence, error) {
	if p == nil || p.queries == nil || p.dispatcher == nil {
		return services.RebasePresenceUnknown, nil
	}
	// The TS host can survive a Go host restart; its older startup clock must
	// never shorten this host's own reconstruction window.
	if p.terminalManager.HasBranchTerminal(repository, workspace) {
		return services.RebasePresencePeople, nil
	}
	if p.startupUnknown() {
		return services.RebasePresenceUnknown, nil
	}
	row, err := p.queries.GetWorkspace(ctx, workspace)
	if err != nil {
		return services.RebasePresenceUnknown, err
	}
	if row.RepositoryID != repository {
		return services.RebasePresenceUnknown, nil
	}
	_, slug, err := installRepository(ctx, p.queries)
	if err != nil {
		return services.RebasePresenceUnknown, err
	}
	health, err := p.call(ctx, row, slug, "Branch.PresenceOn", map[string]any{})
	if err != nil {
		return services.RebasePresenceUnknown, err
	}
	var readiness string
	if json.Unmarshal(health, &readiness) != nil || (readiness != "present" && readiness != "empty") {
		return services.RebasePresenceUnknown, nil
	}
	raw, err := p.call(ctx, row, slug, "Branch.Roster", map[string]any{})
	if err != nil {
		return services.RebasePresenceUnknown, err
	}
	var leases []leaseParticipant
	if err := json.Unmarshal(raw, &leases); err != nil {
		return services.RebasePresenceUnknown, err
	}
	// null is not an authenticated empty roster.
	if leases == nil {
		return services.RebasePresenceUnknown, nil
	}
	state := services.RebasePresenceEmpty
	now := time.Now().UnixMilli()
	for _, lease := range leases {
		if lease.ParticipantID == "" || lease.SessionID == "" || lease.LeaseExpiresAtMs <= 0 {
			return services.RebasePresenceUnknown, nil
		}
		if lease.LeaseExpiresAtMs <= now {
			continue
		}
		switch lease.Kind {
		case "person":
			return services.RebasePresencePeople, nil
		case "agent":
			state = services.RebasePresenceAgent
		default:
			return services.RebasePresenceUnknown, nil
		}
	}
	return state, nil
}

// Keep session locations available for hover while rendering each participant once.
func presenceEntry(actor map[string]any, lease leaseParticipant, leases []leaseParticipant) map[string]any {
	location := lease.Where
	if len(location) == 0 {
		location = json.RawMessage(`{"kind":"branch"}`)
	}
	entry := map[string]any{"actor": actor, "where": location}
	sessions := []any{}
	for _, session := range leases {
		if session.ParticipantID == lease.ParticipantID {
			sessions = append(sessions, map[string]any{"id": session.SessionID, "where": session.Where, "via": session.Via})
		}
	}
	entry["sessions"] = sessions
	if lease.Watching != "" {
		entry["watching"] = lease.Watching
	}
	return entry
}

func (p *branchPresence) startupUnknown() bool {
	if p.startedAt.IsZero() {
		return false
	}
	now := time.Now
	if p.now != nil {
		now = p.now
	}
	return now().Before(p.startedAt.Add(30 * time.Second))
}

// Presence and durable authors use the same member projection.
func branchPersonActor(person db.User, color int) map[string]any {
	avatar, name := person.AvatarUrl, person.DisplayName
	if avatar == "" {
		avatar = placeholderAvatar
	}
	if name == "" {
		name = person.Username
	}
	return map[string]any{"kind": "person", "login": person.Username, "name": name, "avatar_url": avatar, "color_index": color}
}

// branchAgentActor is shared by live presence and persisted change attribution.
func branchAgentActor(id string, lease leaseParticipant, sponsor *db.User, color int) map[string]any {
	actor := map[string]any{"kind": "agent", "id": id, "agent": lease.AgentKind, "name": lease.DisplayName, "avatar_url": placeholderAvatar, "color_index": 6}
	if lease.SessionID != "" {
		actor["session_id"] = lease.SessionID
	}
	if lease.RunID != "" {
		actor["run_id"] = lease.RunID
	}
	if sponsor != nil {
		person := branchPersonActor(*sponsor, color)
		actor["for_member"] = map[string]any{"login": person["login"], "name": person["name"], "avatar_url": person["avatar_url"]}
		actor["color_index"] = color
	}
	if lease.AgentKind == "" {
		actor["agent"] = "external"
	}
	return actor
}

// bindRebasePresence installs the same authenticated lease reader used by live
// browser sessions. Bind even a missing reader so install startup cannot enable
// the legacy automatic rebase path while providers are reconstructing.
func bindRebasePresence(stack interface {
	SetRebasePresence(func(context.Context, int64, string) (services.RebasePresence, error))
}, presence *branchPresence) {
	stack.SetRebasePresence(presence.rebasePresence)
}
