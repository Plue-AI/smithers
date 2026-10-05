package services

import (
	"context"
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// todoActor is who did a TODO action, as the full TodoCard Actor
// (packages/rpc CardPrimitives ActorSchema), so the card's reader needs no
// roster to name it: the person in their browser; "Ben's terminal" for their
// terminal's own credential; and "Claude Code for Ben" when the agent working
// in that terminal acts with it (spec §5.3, M-34). The credential's stored
// kind and via decide it; the Smithers-Via hint only names which agent
// (middleware.AuthInfo.ActingVia).
func todoActor(ctx context.Context, person db.User) json.RawMessage {
	name := person.DisplayName
	if name == "" {
		name = person.Username
	}
	ref := map[string]any{"login": person.Username, "name": name, "avatar_url": todoAvatar(person)}
	info := middleware.AuthInfoFromContext(ctx)
	delegation, delegated := info.Delegation()
	actor := map[string]any{"kind": "person", "color_index": 0}
	for key, value := range ref {
		actor[key] = value
	}
	switch via := info.ActingVia(); {
	case !delegated:
	case via == "terminal" || via == "cli" || via == "ssh":
		actor["via"] = via
	default:
		// An agent acting for the person: Claude Code, Codex, or another the
		// credential names. Its id is the terminal session's when it has one.
		agent, id := via, "agent-"+via+"-"+person.Username
		if agent != "claude-code" && agent != "codex" {
			agent = "external"
		}
		if delegation.Session != "" {
			id = "agent-session-" + delegation.Session
		}
		actor = map[string]any{"kind": "agent", "id": id, "agent": agent, "avatar_url": todoAvatar(db.User{}), "for_member": ref, "color_index": 0}
		if agent == "external" {
			actor["name"] = via
		}
		if delegation.Session != "" {
			actor["session_id"] = delegation.Session
		}
	}
	encoded, _ := json.Marshal(actor)
	return encoded
}

// todoActorRef is the same actor as a TODO's facts record it: the person,
// and for a delegated credential the via it acted through and its terminal
// session ({person, via?, session?}, apps/app ProductActor's notation).
func todoActorRef(ctx context.Context, person db.User) map[string]any {
	ref := map[string]any{"person": person.Username}
	info := middleware.AuthInfoFromContext(ctx)
	if delegation, delegated := info.Delegation(); delegated {
		ref["via"] = info.ActingVia()
		if delegation.Session != "" {
			ref["session"] = delegation.Session
		}
	}
	return ref
}
