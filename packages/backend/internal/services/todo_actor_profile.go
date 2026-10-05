package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
)

// memberProfile is shared by Members and TODO attribution, including people
// who have GitHub access but have not signed in to this install yet.
func memberProfile(login, name string, color int) map[string]any {
	if name == "" {
		name = login
	}
	return map[string]any{"login": login, "name": name, "avatar_url": "https://github.com/" + login + ".png", "color_index": color % 6}
}

func (s *MythicalService) personProfile(ctx context.Context, repositoryID int64, login string) (map[string]any, error) {
	var name string
	var color int
	err := s.store.QueryRow(ctx, `WITH roster AS (
 SELECT coalesce(c.github_login,u.username) AS login,
 coalesce(nullif(u.display_name,''),c.github_login,u.username) AS name,
 (row_number() OVER (ORDER BY coalesce(c.user_id=o.user_id,false) DESC,c.id)-1)::int % 6 AS color
 FROM collaborators c LEFT JOIN users u ON u.id=c.user_id CROSS JOIN self_host_owners o
 WHERE c.repository_id=$1 AND (c.user_id IS NOT NULL OR c.github_id IS NOT NULL))
 SELECT name,color FROM roster WHERE lower(login)=lower($2)`, repositoryID, login).Scan(&name, &color)
	if errors.Is(err, pgx.ErrNoRows) {
		err = s.store.QueryRow(ctx, `SELECT display_name FROM users WHERE lower(username)=lower($1)`, login).Scan(&name)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	actor := memberProfile(login, name, color)
	actor["kind"] = "person"
	return actor, nil
}

// Complete historical authors at the serving boundary too: old label-door
// revisions remain readable without rewriting their immutable attribution.
func (s *MythicalService) authoredRows(ctx context.Context, repositoryID int64, value any) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var decoded any
	if err = json.Unmarshal(data, &decoded); err != nil {
		return nil, err
	}
	var visit func(any) error
	visit = func(value any) error {
		switch row := value.(type) {
		case []any:
			for _, child := range row {
				if err := visit(child); err != nil {
					return err
				}
			}
		case map[string]any:
			if by, ok := row["by"].(map[string]any); ok {
				login, _ := by["login"].(string)
				kind, _ := by["kind"].(string)
				if historical, ok := by["person"].(string); ok {
					via, _ := by["via"].(string)
					if via == "" || via == "terminal" || via == "cli" || via == "ssh" {
						login = historical
						kind = "person"
					}
				}
				if kind == "person" && login != "" {
					profile, err := s.personProfile(ctx, repositoryID, login)
					if err != nil {
						return err
					}
					for key, value := range by {
						if key != "person" {
							profile[key] = value
						}
					}
					// Missing fields get the member profile; recorded complete actors retain
					// their original attribution, including delegated via/session fields.
					row["by"] = profile
				}
			}
			for key, child := range row {
				if key != "by" {
					if err := visit(child); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	if err := visit(decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}
