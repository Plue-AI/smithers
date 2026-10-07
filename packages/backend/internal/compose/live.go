package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/externalsessions"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// liveTodos is what the home and todo:<n> topics read: the TODO cards GET
// /api/todos and GET /api/todos/{n} serve (services.MythicalService).
type liveTodos interface {
	Todo(context.Context, int64, int64) (map[string]any, error)
	Todos(context.Context, int64) ([]map[string]any, error)
}

// liveSync is the install's GitHub sync health, main's row on Home.
type liveSync interface {
	SyncHealth(context.Context) (services.GitHubSyncHealth, error)
}

// liveTopics resolves the install's shared topics (spec §7.2) for one
// person: home, todo:<n>, flows and members. Every topic serves shared facts only,
// so one stream serves every member byte for byte.
type liveTopics struct {
	changePool    *pgxpool.Pool
	queries       *db.Queries
	todos         liveTodos
	sync          liveSync
	install       *services.InstallSetupService
	members       *services.Members
	documents     *live.DocRelay
	wikiDocuments *live.WikiHost
	capacity      *services.InstallCapacityService
	presence      *branchPresence
	conversation  func(context.Context, int64, string) (json.RawMessage, error)
	viewState     func(context.Context, int64, string) (json.RawMessage, error)
	secrets       *services.SecretService
	external      *externalsessions.Finder
	jobs          *jobs.Store
}

// liveRefreshEvery bounds how stale a topic is when its facts change without
// a stack hint (a machine waking, a check finishing).
const liveRefreshEvery = time.Second

// installRepository is the install's persisted GitHub repository, never a
// caller-supplied one (as routes.TodoHandler resolves it).
func installRepository(ctx context.Context, q *db.Queries) (int64, string, error) {
	binding, err := q.ReadInstallRepositoryBinding(ctx)
	if err != nil {
		return 0, "", err
	}
	repositoryID, err := services.InstallRepositoryID(ctx, q)
	if err != nil {
		return 0, "", err
	}
	return repositoryID, binding.Owner + "/" + binding.Name, nil
}

// resolver answers r's topics. The repository is read once per socket; a
// socket opened before setup bound one serves no repository topic.
func (t *liveTopics) resolver(r *http.Request) (live.Resolver, int64) {
	repository, slug, err := installRepository(r.Context(), t.queries)
	if err != nil {
		repository = 0
	}
	member := int64(0)
	if user := middleware.UserFromContext(r.Context()); user != nil {
		member = user.ID
	}
	return func(ctx context.Context, topic string) (live.Source, string) {
		if topic == "secrets" {
			if _, err := services.Authorize(r.Context(), t.queries, "secrets.read"); err != nil {
				return live.Source{}, live.Forbidden
			}
		}
		if topic == "members" {
			if t.members == nil || t.members.Pool == nil || t.members.Credentials == nil || t.members.Minter == nil {
				return live.Source{}, live.Unsupported
			}
			if _, err := services.Authorize(r.Context(), t.queries, "members.list"); err != nil {
				return live.Source{}, live.Forbidden
			}
		}
		if strings.HasPrefix(topic, "confirmations:") {
			info := middleware.AuthInfoFromContext(r.Context())
			if info == nil || info.IsTokenAuth || info.SessionHash == "" || info.IsAgent() {
				return live.Source{}, live.Forbidden
			}
		}
		if strings.HasPrefix(topic, "branch:") {
			if strings.HasSuffix(topic, ":activity") || strings.HasSuffix(topic, ":files") {
				return t.branchChanges(ctx, topic, repository, member)
			}
			source, refusal := t.presence.source(r.Context(), strings.TrimPrefix(topic, "branch:"), repository, member, slug)
			if refusal != "" || t.todos == nil {
				return source, refusal
			}
			build := source.Build
			source.Build = func(ctx context.Context) (json.RawMessage, error) {
				raw, err := build(ctx)
				if err != nil {
					return nil, err
				}
				var branch struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(raw, &branch); err != nil {
					return nil, err
				}
				lane, err := t.queries.GetMythicalLane(ctx, branch.ID)
				if errors.Is(err, pgx.ErrNoRows) {
					return raw, nil
				}
				if err != nil {
					return nil, err
				}
				if lane.RepositoryID != repository {
					return nil, fmt.Errorf("branch item repository mismatch")
				}
				item, err := t.queries.GetMythicalItem(ctx, lane.ItemID)
				if err != nil {
					return nil, err
				}
				if !item.Number.Valid {
					return raw, nil
				}
				card, err := t.todos.Todo(ctx, repository, item.Number.Int64)
				if err != nil {
					return nil, err
				}
				return branchItemProjection(raw, []map[string]any{card})
			}
			return source, ""
		}
		return t.resolve(ctx, topic, repository, slug, member)
	}, repository
}

func (t *liveTopics) resolve(ctx context.Context, topic string, repository int64, slug string, member int64) (live.Source, string) {
	kind, rest, _ := strings.Cut(topic, ":")
	hints := []string{"mythical_" + strconv.FormatInt(repository, 10)}
	switch kind {
	case "confirmations":
		if member <= 0 || rest != strconv.FormatInt(member, 10) {
			return live.Source{}, live.Forbidden
		}
		if t.queries == nil {
			return live.Source{}, live.Unsupported
		}
		return live.Source{Key: topic, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			rows, err := t.queries.ListMemberConfirmations(ctx, member)
			if service, ok := t.todos.(interface {
				RefreshConfirmationCards(context.Context, int64, []db.Confirmation) error
			}); err == nil && ok {
				err = service.RefreshConfirmationCards(ctx, member, rows)
				if err == nil {
					rows, err = t.queries.ListMemberConfirmations(ctx, member)
				}
			}
			if err != nil {
				return nil, err
			}
			return json.Marshal(rows)
		}}, ""
	case "view":
		owner, branch, hasBranch := strings.Cut(rest, ":")
		if member <= 0 || owner != strconv.FormatInt(member, 10) {
			return live.Source{}, live.Forbidden
		}
		if !hasBranch || branch == "" || repository <= 0 || t.viewState == nil {
			return live.Source{}, live.Unsupported
		}
		return live.Source{Key: topic, Hints: []string{"view_" + strconv.FormatInt(repository, 10) + "_" + owner}, Every: liveRefreshEvery, FailClosed: true, Build: func(ctx context.Context) (json.RawMessage, error) {
			return t.viewState(ctx, member, branch)
		}}, ""
	case "install":
		if topic != "install" || t.install == nil {
			return live.Source{}, live.Unsupported
		}
		source := live.Source{Key: "install", Hints: []string{"install"}, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			status, err := t.install.Status(ctx)
			if err != nil {
				return nil, err
			}
			return json.Marshal(status)
		}}
		if t.jobs != nil {
			source = liveJobSource(source, t.jobs, jobs.Scope{TenantID: "install", PrincipalID: "owner"})
			source.RefreshSnapshot = func(data json.RawMessage) json.RawMessage { return data }
			source.RefreshEvery = liveRefreshEvery
		}
		return source, ""
	case "doc":
		if strings.HasPrefix(topic, "doc:wiki:") {
			return t.wikiDocuments.Resolve(ctx, topic, repository, member)
		}
		return t.documents.Resolve(ctx, topic, repository, member)
	case "conversation":
		if repository <= 0 || member <= 0 || rest == "" || t.conversation == nil {
			return live.Source{}, live.Unsupported
		}
		// Authorize before Join can deliver a cached snapshot. Scope the
		// builder to its reader so losing a workspace grant fails closed even
		// while another member remains subscribed to the same conversation.
		initial, err := t.conversation(ctx, member, rest)
		if err != nil {
			return live.Source{}, live.Forbidden
		}
		var identity struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(initial, &identity) != nil || identity.ID == "" {
			return live.Source{}, live.Unsupported
		}
		key := "conversation:" + strconv.FormatInt(repository, 10) + ":" + identity.ID + ":member:" + strconv.FormatInt(member, 10)
		return live.Source{Key: key, Every: liveRefreshEvery, FailClosed: true, Build: func(ctx context.Context) (json.RawMessage, error) { return t.conversation(ctx, member, identity.ID) }}, ""
	case "branch", "run":
		return live.Source{}, live.Unsupported
	case "external":
		return t.externalSession(ctx, topic, rest)
	}
	if repository == 0 {
		return live.Source{}, live.Unsupported
	}
	switch {
	case topic == "secrets":
		if t.secrets == nil {
			return live.Source{}, live.Unsupported
		}
		return live.Source{Key: topic, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			rows, err := t.queries.ListSecrets(ctx, repository)
			if err != nil {
				return nil, err
			}
			secrets := []map[string]any{}
			for _, row := range rows {
				scope := "all_branches"
				if row.MainOnly {
					scope = "main_only"
				}
				hosts := row.Hosts
				if hosts == nil {
					hosts = []string{}
				}
				secrets = append(secrets, map[string]any{"name": row.Name, "scope": scope, "hosts": hosts, "actions": []any{}})
			}
			return json.Marshal(map[string]any{"secrets": secrets})
		}}, ""
	case topic == "proposals":
		if provider, ok := t.todos.(interface {
			LearningProposalsSnapshot(context.Context, int64) (int64, []services.LearningProposalCard, error)
		}); ok {
			return live.Source{Key: topic, Hints: hints, Every: liveRefreshEvery, Log: &live.LogSource{Page: func(ctx context.Context, after *int64) (live.LogPage, error) {
				cursor, cards, err := provider.LearningProposalsSnapshot(ctx, repository)
				if err != nil {
					return live.LogPage{}, err
				}
				if after != nil && *after != cursor {
					return live.LogPage{Gap: true}, nil
				}
				data, err := json.Marshal(cards)
				return live.LogPage{Cursor: cursor, Data: data}, err
			}}}, ""
		}
		provider, ok := t.todos.(routes.LearningProposalRoutes)
		if !ok {
			return live.Source{}, live.Unsupported
		}
		return live.Source{Key: topic, Hints: hints, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			rows, err := provider.LearningProposals(ctx, repository)
			if err != nil {
				return nil, err
			}
			return json.Marshal(rows)

		}}, ""
	case topic == "members":
		if t.members == nil {
			return live.Source{}, live.Unsupported
		}
		return live.Source{Key: topic, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			roster, err := t.members.SharedRoster(ctx)
			if err != nil {
				return nil, err
			}
			return json.Marshal(roster)
		}}, ""
	case topic == "agents":
		return live.Source{Key: topic, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			profiles, err := agentProfiles(ctx, t.queries)
			if err != nil {
				return nil, err
			}
			return json.Marshal(profiles)
		}}, ""
	case topic == "home":
		if t.todos == nil {
			return live.Source{}, live.Unsupported
		}
		return live.Source{Key: topic, Hints: hints, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			return t.home(ctx, repository, slug)
		}}, ""
	case topic == "flows":
		return live.Source{Key: topic, Hints: hints, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			cards, err := services.RepositoryFlowCatalog(ctx, t.queries, repository, flowProposalReader(t.todos))
			if err != nil {
				return nil, err
			}
			return json.Marshal(cards)
		}}, ""
	case kind == "todo":
		n, err := strconv.ParseInt(rest, 10, 64)
		if err != nil || n <= 0 || strconv.FormatInt(n, 10) != rest {
			return live.Source{}, live.UnknownTopic
		}
		item, err := t.queries.GetMythicalItemByNumber(ctx, repository, n)
		if err != nil {
			return live.Source{}, live.UnknownTopic
		}
		source := live.Source{Key: topic, Hints: hints, Every: liveRefreshEvery, Build: func(ctx context.Context) (json.RawMessage, error) {
			card, err := t.todos.Todo(ctx, repository, n)
			if err != nil {
				return nil, err
			}
			return json.Marshal(card)
		}}
		if t.jobs != nil {
			scope := jobs.Scope{TenantID: strconv.FormatInt(repository, 10), PrincipalID: "todo:" + uuid.UUID(item.ID.Bytes).String()}
			source = liveJobSource(source, t.jobs, scope)
			// Machine positions change without a TODO journal event, for example
			// when a person cancels a wake. Refresh the same card at its journal cursor.
			source.RefreshSnapshot = func(data json.RawMessage) json.RawMessage { return data }
			source.RefreshEvery = liveRefreshEvery
		}

		return source, ""

	}
	return live.Source{}, live.UnknownTopic
}

// externalSession is external:<agent>:<session> (mvp.md M-38): the size of
// the owner's session file, read every liveRefreshEvery, so the app reads
// what the agent appended at once instead of at its next poll. Like GET
// /api/external/sessions, it is the install owner's alone: the socket's own
// credential is authorized for external.read, a person-only command, so
// the topic and the route take one decision.
func (t *liveTopics) externalSession(ctx context.Context, topic, rest string) (live.Source, string) {
	if t.external == nil {
		return live.Source{}, live.Unsupported
	}
	name, prefix, _ := strings.Cut(rest, ":")
	agent, ok := externalsessions.ParseAgent(name)
	if !ok || !externalsessions.IDPattern.MatchString(prefix) {
		return live.Source{}, live.UnknownTopic
	}
	if _, err := services.Authorize(ctx, t.queries, "external.read"); err != nil {
		return live.Source{}, live.Forbidden
	}
	if _, err := t.external.Find(agent, prefix); err != nil {
		return live.Source{}, live.UnknownTopic
	}
	return live.Source{Key: topic, Every: liveRefreshEvery, Build: func(context.Context) (json.RawMessage, error) {
		session, err := t.external.Find(agent, prefix)
		if err != nil {
			return nil, err
		}
		size, err := session.Size()
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"session_id": session.ID, "size": size})
	}}, ""
}

// home is the Home card's shared model (HomeCardSchema, spec §14.3): a row
// per unmerged TODO in stack order with the controls its state offers,
// every state counted, a machine per TODO branch that is awake or waking,
// and main's row from the install's GitHub sync. Last look and role filter
// stay in the browser (§7.2.2).
func (t *liveTopics) home(ctx context.Context, repository int64, slug string) (json.RawMessage, error) {
	todos, err := t.todos.Todos(ctx, repository)
	if err != nil {
		return nil, err
	}
	var sync *services.GitHubSyncHealth
	if t.sync != nil {
		if health, err := t.sync.SyncHealth(ctx); err == nil {
			sync = &health
		}
	}
	// One JSON round trip gives the cards as the browser reads them.
	raw, err := json.Marshal(todos)
	if err != nil {
		return nil, err
	}
	var cards []map[string]any
	if err = json.Unmarshal(raw, &cards); err != nil {
		return nil, err
	}
	model := homeModel(slug, cards, sync)
	if provider, ok := t.todos.(interface {
		LearningBackgroundRuns(context.Context, int64) ([]map[string]any, error)
	}); ok {
		runs, err := provider.LearningBackgroundRuns(ctx, repository)
		if err != nil {
			return nil, err
		}
		model["background_runs"] = runs
	}
	if provider, ok := t.todos.(interface {
		WikiBackgroundRuns(context.Context, int64) ([]map[string]any, error)
	}); ok {
		runs, err := provider.WikiBackgroundRuns(ctx, repository)
		if err != nil {
			return nil, err
		}
		if existing, ok := model["background_runs"].([]map[string]any); ok {
			runs = append(existing, runs...)
		}
		model["background_runs"] = runs
	}
	if provider, ok := t.todos.(interface {
		BackgroundRuns(context.Context, int64) ([]map[string]any, error)
	}); ok {
		runs, err := provider.BackgroundRuns(ctx, repository)
		if err != nil {
			return nil, err
		}
		if existing, ok := model["background_runs"].([]map[string]any); ok {
			runs = append(existing, runs...)
		}
		model["background_runs"] = runs
	}
	if t.capacity != nil {
		status, err := t.capacity.Read(ctx)
		if err != nil {
			return nil, err
		}
		machines := model["machines"].(map[string]any)
		machines["in_use"] = status.Machines.InUse
		machines["capacity"] = status.Machines.Capacity
	}
	if t.install != nil && t.install.Capacity != nil {
		// The limit is shared state. The first subscriber must not determine
		// its visibility or whether an invalid setting is reported. Only the
		// write command and the browser's controls depend on the viewer's role.
		parallel, err := t.install.Capacity.Parallel(ctx)
		if err != nil {
			return nil, err
		}
		model["parallel"] = parallel.Effective
	}
	return json.Marshal(model)
}

// homeStates are the TODO states Home counts (TodoStateSchema).
var homeStates = []string{"queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"}

// placeholderAvatar is @smthrs/rpc's PlaceholderAvatarUrl.
const placeholderAvatar = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"

// syncCauses are main's row causes for a refused sync (HomeContainer).
var syncCauses = map[string]string{"permission": "GitHub App permission missing", "not_installed": "GitHub App not installed"}

// homeModel builds Home from the TODO cards (as GET /api/todos serves them)
// and the sync's health.
func homeModel(repository string, todos []map[string]any, sync *services.GitHubSyncHealth) map[string]any {
	counts := map[string]any{}
	for _, state := range homeStates {
		counts[state] = 0
	}
	items := []any{}
	slots := []any{}
	for _, todo := range todos {
		state, _ := todo["state"].(string)
		if state == "merged" || state == "dropped" {
			continue
		}
		if count, ok := counts[state].(int); ok {
			counts[state] = count + 1
		}
		n, _ := todo["n"].(float64)
		args := map[string]any{"n": strconv.FormatInt(int64(n), 10)}
		actions := []any{map[string]any{"tag": "todo", "label": todo["title"], "args": map[string]any{"n": args["n"], "door": "title"}}}
		merge, _ := todo["merge"].(map[string]any)
		switch state {
		case "needs_you":
			actions = append(actions, map[string]any{"tag": "todo.answer", "label": "Answer", "args": args, "primary": true})
		case "in_review":
			if merge["state"] == "ready" {
				actions = append(actions, map[string]any{"tag": "merge", "label": "Merge", "args": args, "primary": true})
			} else {
				actions = append(actions, map[string]any{"tag": "todo", "label": "Review", "args": args})
			}
		case "failed":
			actions = append(actions, map[string]any{"tag": "todo.retry", "label": "Retry", "args": args})
		case "paused":
			actions = append(actions, map[string]any{"tag": "todo.resume", "label": "Resume", "args": args})
		}
		item := map[string]any{"n": todo["n"], "title": todo["title"], "state": todo["state"], "owner": todo["owner"], "merge": todo["merge"],
			"present": todo["present"], "actions": actions, "branch": map[string]any{"id": "", "name": ""}}
		for _, field := range []string{"place", "queue", "step", "rebase_pending", "approval_cleared", "lessons"} {
			if value, ok := todo[field]; ok {
				item[field] = value
			}
		}
		if waits, _ := todo["waits"].([]any); len(waits) > 0 {
			if wait, ok := waits[0].(map[string]any); ok {
				item["needs_you"] = map[string]any{"kind": wait["kind"], "prompt": wait["prompt"]}
			}
		}
		if pr, ok := todo["pr"].(map[string]any); ok {
			item["pr"] = map[string]any{"number": pr["number"], "draft": pr["draft"]}
		}
		revisions, _ := todo["prompt_revisions"].([]any)
		item["amendments"] = max(0, len(revisions)-1)
		if branch, ok := todo["branch"].(map[string]any); ok {
			item["branch"] = map[string]any{"id": branch["id"], "name": branch["name"]}
			machine, _ := branch["machine"].(map[string]any)
			if machine["state"] == "awake" || machine["state"] == "waking" {
				slots = append(slots, map[string]any{"branch": branch["name"], "awake": machine["state"] == "awake",
					"actor": map[string]any{"kind": "agent", "id": fmt.Sprintf("agent:%v", branch["id"]), "agent": "coding", "avatar_url": placeholderAvatar,
						"for_member": todo["owner"], "todo": todo["n"], "color_index": 6}})
			}
		}
		items = append(items, item)
	}
	main := map[string]any{"sha": "", "title": "main", "last_success_at": time.Unix(0, 0).UTC().Format("2006-01-02T15:04:05.000Z"), "health": "limited"}
	// Health and pauses are authoritative even before the first successful read.
	if sync != nil {
		main["health"] = sync.State
		if sync.LastSuccessAt != nil {
			main["last_success_at"] = sync.LastSuccessAt.Format(time.RFC3339Nano)
		}
		if cause, ok := syncCauses[sync.Cause]; ok {
			main["cause"] = cause
		}
		if sync.RetryAt != nil {
			main["retry_at"] = sync.RetryAt.Format(time.RFC3339Nano)
		}
	}
	return map[string]any{
		"repository": repository, "main": main, "attention": []any{}, "items": items, "counts": counts,
		"merged_since_last_look": []any{}, "machines": map[string]any{"in_use": len(slots), "capacity": 0, "slots": slots},
		"background_runs": []any{},
	}
}

func flowProposalReader(provider any) services.FlowProposalReader {
	reader, _ := provider.(services.FlowProposalReader)
	return reader
}

// Reuse the TODO read model; only a stable workspace binding identifies its item.
// Names can change and are never a substitute for that binding. No read wakes a machine.
func branchItemProjection(raw json.RawMessage, todos []map[string]any) (json.RawMessage, error) {
	var model map[string]any
	if err := json.Unmarshal(raw, &model); err != nil {
		return nil, err
	}
	for _, todo := range todos {
		branch, ok := todo["branch"].(map[string]any)
		if !ok || branch["id"] != model["id"] {
			continue
		}
		place := todo["place"]
		if place == nil {
			place = 0
		}
		item := map[string]any{"n": todo["n"], "title": todo["title"], "state": todo["state"], "place": place}
		if steps, ok := todo["steps"].([]map[string]any); ok {
			for _, step := range steps {
				if step["state"] == "current" {
					item["step"] = step["label"]
					break
				}
			}
		}
		model["item"] = item
		if pending, ok := todo["rebase_pending"].(map[string]any); ok {
			model["rebase"] = map[string]any{"state": "pending", "onto": pending["onto"]}
		}
		break
	}
	return json.Marshal(model)
}

// liveJobSource uses the existing job allocator, replay and retention. The
// optimistic head check binds a snapshot to facts without taking a new lock.
func liveJobSource(source live.Source, store *jobs.Store, scope jobs.Scope) live.Source {

	source.Hints = append(source.Hints, "smithers_product_jobs")
	source.Every = 250 * time.Millisecond
	source.Durable = &sse.DurableStream{
		Head: func(ctx context.Context) (int64, error) { return store.Head(ctx, scope) },
		Validate: func(ctx context.Context, cursor int64) error {
			_, err := store.Replay(ctx, scope, cursor, 1)
			return liveReplayError(err)
		},
		Load: func(ctx context.Context, after int64, limit int) (sse.DurablePage, error) {
			page, err := store.Replay(ctx, scope, after, limit)
			if err != nil {
				return sse.DurablePage{}, liveReplayError(err)
			}
			result := sse.DurablePage{Cursor: page.Cursor, More: page.More}
			for _, event := range page.Events {
				data, err := json.Marshal(event)
				if err != nil {
					return sse.DurablePage{}, err
				}
				result.Events = append(result.Events, sse.Event{ID: strconv.FormatInt(event.Sequence, 10), Data: string(data)})
			}
			return result, nil
		},
	}
	source.Snapshot = func(ctx context.Context) (int64, json.RawMessage, error) {
		for attempt := 0; attempt < 5; attempt++ {
			before, err := store.Head(ctx, scope)
			if err != nil {
				return 0, nil, err
			}
			data, err := source.Build(ctx)
			if err != nil {
				return 0, nil, err
			}
			after, err := store.Head(ctx, scope)
			if err != nil {
				return 0, nil, err
			}
			if before == after {
				return after, data, nil
			}
		}
		return 0, nil, fmt.Errorf("TODO changed throughout snapshot read")
	}
	return source
}

// Translate only the source's retention/ahead refusals into the existing
// cursor contract. Database errors retain the cursor and retry replay.
func liveReplayError(err error) error {
	var expired *jobs.CursorExpiredError
	if errors.As(err, &expired) || errors.Is(err, jobs.ErrCursorAhead) {
		return pkgerrors.UnknownCursor("TODO cursor is outside retained source facts")
	}
	return err
}
