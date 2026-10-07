package chat

import (
	"encoding/json"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The fixed offline avatar from @smthrs/rpc/CardPrimitives. An agent remains a
// distinct participant even when the owner's real avatar is unavailable.
const externalAvatar = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"

func externalActor(owner db.User, draft ExternalDraft, color int) map[string]any {
	name, avatar := owner.DisplayName, owner.AvatarUrl
	if name == "" {
		name = owner.Username
	}
	if !strings.HasPrefix(avatar, "https://") && !strings.HasPrefix(avatar, "http://") {
		avatar = externalAvatar
	}
	person := map[string]any{"login": owner.Username, "name": name, "avatar_url": avatar}
	if draft.Kind == "prompt" {
		person["kind"], person["color_index"] = "person", color
		return person
	}
	return map[string]any{"kind": "agent", "id": draft.Participant, "agent": draft.Agent, "session_id": draft.Session, "avatar_url": externalAvatar, "color_index": color, "for_member": person}
}

// Imports use the app's existing read-only Message contract. They never expose
// journal run IDs, frames, executable actions or owner-only turn capabilities.
func (turn SharedTurn) MarshalJSON() ([]byte, error) {
	if turn.ExternalDraft == nil {
		type plain SharedTurn
		return json.Marshal(plain(turn))
	}
	draft := turn.ExternalDraft
	if !draft.valid() || turn.externalActor == nil {
		return nil, ErrCorrupt
	}
	role, status := "smithers", "complete"
	if draft.Kind == "prompt" {
		role = "user"
	}
	if draft.Failed || draft.Kind == "error" {
		status = "failed"
	}
	at := turn.externalAt
	if draft.At > 0 {
		at = draft.At
	}
	text, act := externalText(*draft)
	message := map[string]any{
		"id": turn.ID, "origin": "external", "agent_kind": draft.Agent, "format_version": draft.Profile,
		"source_id": draft.SourceID, "session_id": draft.Session, "participant_id": draft.Participant,
		"actor": turn.externalActor, "read_only": true, "role": role, "text": text, "status": status,
		"createdAt": at, "ordinal": turn.externalOrdinal,
		"authorLogin": turn.AuthorLogin,
	}
	if turn.AuthorName != "" {
		message["authorName"] = turn.AuthorName
	}
	if draft.CallID != "" {
		message["correlation_id"] = draft.CallID
	}
	if act != "" {
		message["act"] = act
	}
	if draft.Kind == "thinking" {
		message["reasoning"], message["text"] = text, ""
	}
	return json.Marshal(message)
}

func externalText(draft ExternalDraft) (text, act string) {
	if json.Unmarshal(draft.Body, &text) == nil {
		return text, ""
	}
	var part struct {
		Text      string `json:"text"`
		Message   string `json:"message"`
		Command   string `json:"command"`
		Output    string `json:"output"`
		Query     string `json:"query"`
		Objective string `json:"objective"`
		Activity  string `json:"activity"`
		Files     []struct {
			Path string `json:"path"`
			Diff string `json:"diff"`
		} `json:"files"`
	}
	if json.Unmarshal(draft.Body, &part) != nil {
		return string(draft.Body), ""
	}
	switch draft.Kind {
	case "tool_request", "tool_result":
		return part.Output, part.Command
	case "edit":
		var files []string
		for _, file := range part.Files {
			files = append(files, file.Path+"\n"+file.Diff)
		}
		return strings.Join(files, "\n"), ""
	}
	for _, value := range []string{part.Text, part.Message, part.Query, part.Objective, part.Activity} {
		if value != "" {
			return value, ""
		}
	}
	// Keep otherwise unknown normalized content copyable. This is decoded data,
	// never the original transcript record or an executable command request.
	return string(draft.Body), ""
}
