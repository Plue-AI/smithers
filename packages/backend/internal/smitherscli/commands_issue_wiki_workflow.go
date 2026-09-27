package smitherscli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	incur "github.com/smithersai/incur"
)

func issueCommand() *incur.Cli {
	cmd := incur.New("issue", incur.WithDescription("Manage issues"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create an issue",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"title": stringSchema("Issue title")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"title":    stringSchema("Issue title"),
			"body":     {Type: "string", Description: "Issue body", Default: ""},
			"assignee": stringSchema("Assignee username"),
			"repo":     stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			title := stringValue(ctx.Options["title"])
			if strings.TrimSpace(title) == "" {
				title = stringValue(ctx.Args["title"])
			}
			if strings.TrimSpace(title) == "" {
				return nil, fmt.Errorf("issue title is required")
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{"title": title, "body": stringValue(ctx.Options["body"])}
			if assignee := stringValue(ctx.Options["assignee"]); assignee != "" {
				body["assignees"] = []string{assignee}
			}
			issue, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/issues", owner, repo), body, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				if ctx.Format == string(incur.FormatTOON) {
					return formatIssueCreateToon(issue), nil
				}
				return issue, nil
			}
			return formatIssueCreate(issue), nil
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description: "List issues",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"state":  enumSchema("Filter by state", []string{"open", "closed", "fixed", "verified", "all"}, "open"),
			"limit":  numberSchema("Results per page", 30),
			"cursor": stringSchema("Pagination cursor (from previous response)"),
			"all":    booleanSchema("Fetch all pages automatically", false),
			"repo":   stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			buildPath := func(cursor string) string {
				query := url.Values{}
				query.Set("limit", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
				if state := stringValue(ctx.Options["state"]); state != "" && state != "all" {
					query.Set("state", state)
				}
				if cursor != "" {
					query.Set("cursor", cursor)
				}
				return fmt.Sprintf("/api/repos/%s/%s/issues?%s", owner, repo, query.Encode())
			}
			if ctx.Options["all"] == true {
				issues, err := APIListAll(buildPath, nil)
				if err != nil {
					return nil, cleanAPIError(err)
				}
				if ctx.FormatExplicit {
					return issues, nil
				}
				return formatIssueList(issues), nil
			}
			issues, nextCursor, err := APIList(buildPath(stringValue(ctx.Options["cursor"])), nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			issueList := arrayValue(issues)
			if ctx.FormatExplicit {
				if nextCursor != "" {
					return map[string]any{"issues": issues, "next_cursor": nextCursor}, nil
				}
				return issues, nil
			}
			formatted := formatIssueList(issueList)
			if nextCursor != "" {
				return formatted + "\n\nMore results available. Use --cursor " + nextCursor + " for the next page, or --all to fetch everything.", nil
			}
			return formatted, nil
		},
	})
	cmd.Command("view", issueNumberCommand("View an issue", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		issue, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/issues/%d", owner, repo, number), nil, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return issue, nil
		}
		return formatIssueView(issue), nil
	}))
	cmd.Command("close", issueNumberCommandWithOptions("Close an issue", map[string]*incur.JSONSchema{
		"comment": stringSchema("Add a comment when closing"),
	}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		if comment := stringValue(ctx.Options["comment"]); comment != "" {
			if _, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/issues/%d/comments", owner, repo, number), map[string]any{"body": comment}, nil); err != nil {
				return nil, cleanAPIError(err)
			}
		}
		issue, err := APIRequest("PATCH", fmt.Sprintf("/api/repos/%s/%s/issues/%d", owner, repo, number), map[string]any{"state": "closed"}, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return issue, nil
		}
		return formatIssueMutation("Closed", issue), nil
	}))
	cmd.Command("reopen", issueNumberCommand("Reopen an issue", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		issue, err := APIRequest("PATCH", fmt.Sprintf("/api/repos/%s/%s/issues/%d", owner, repo, number), map[string]any{"state": "open"}, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return issue, nil
		}
		return formatIssueMutation("Reopened", issue), nil
	}))
	cmd.Command("edit", issueNumberCommandWithOptions("Edit an issue", map[string]*incur.JSONSchema{
		"title":    stringSchema("New title"),
		"body":     stringSchema("New body"),
		"assignee": stringSchema("Add assignee username"),
		"label":    stringSchema("Add label name"),
	}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		body := map[string]any{}
		if _, ok := ctx.Options["title"]; ok {
			body["title"] = stringValue(ctx.Options["title"])
		}
		if _, ok := ctx.Options["body"]; ok {
			body["body"] = stringValue(ctx.Options["body"])
		}
		issuePath := fmt.Sprintf("/api/repos/%s/%s/issues/%d", owner, repo, number)
		// PATCH replaces the whole label and assignee sets, so --label goes
		// through the additive labels route and --assignee sends the current
		// assignees plus the new one.
		if label := stringValue(ctx.Options["label"]); label != "" {
			if _, err := APIRequest("POST", issuePath+"/labels", map[string]any{"labels": []string{label}}, nil); err != nil {
				return nil, cleanAPIError(err)
			}
		}
		if assignee := stringValue(ctx.Options["assignee"]); assignee != "" {
			current, err := APIRequest("GET", issuePath, nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			body["assignees"] = appendAssignee(objectValue(current)["assignees"], assignee)
		}
		issue, err := APIRequest("PATCH", issuePath, body, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return issue, nil
		}
		return formatIssueMutation("Updated", issue), nil
	}))
	cmd.Command("comment", issueNumberCommandWithOptions("Add a comment to an issue", map[string]*incur.JSONSchema{
		"body": stringSchema("Comment body"),
	}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		comment, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/issues/%d/comments", owner, repo, number), map[string]any{"body": stringValue(ctx.Options["body"])}, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return comment, nil
		}
		return fmt.Sprintf("Added a comment to issue #%d", number), nil
	}))

	return cmd
}

// appendAssignee returns the logins in an issue's assignees list with login
// added unless it is already present. Usernames compare case-insensitively,
// matching the server.
func appendAssignee(assignees any, login string) []string {
	logins := []string{}
	for _, entry := range arrayValue(assignees) {
		if existing := stringValue(objectValue(entry)["login"]); existing != "" {
			logins = append(logins, existing)
		}
	}
	for _, existing := range logins {
		if strings.EqualFold(existing, login) {
			return logins
		}
	}
	return append(logins, login)
}

func issueNumberCommand(description string, handler func(owner, repo string, number int, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	return issueNumberCommandWithOptions(description, nil, handler)
}

func issueNumberCommandWithOptions(description string, extra map[string]*incur.JSONSchema, handler func(owner, repo string, number int, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	properties := map[string]*incur.JSONSchema{"repo": stringSchema("Repository (OWNER/REPO)")}
	for key, schema := range extra {
		properties[key] = schema
	}
	requiredOptions := []string{}
	if _, ok := extra["body"]; ok && description == "Add a comment to an issue" {
		requiredOptions = append(requiredOptions, "body")
	}
	if _, ok := extra["blocks"]; ok {
		requiredOptions = append(requiredOptions, "blocks")
	}
	return &incur.CommandDef{
		Description:   description,
		ArgsSchema:    objectSchema([]string{"number"}, map[string]*incur.JSONSchema{"number": stringSchema("Issue number")}),
		OptionsSchema: objectSchema(requiredOptions, properties),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			number, err := parseIssueNumber(stringValue(ctx.Args["number"]), "issue number")
			if err != nil {
				return nil, err
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return handler(owner, repo, number, ctx)
		},
	}
}

func parseIssueNumber(value, label string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("invalid %s", label)
	}
	return parsed, nil
}

func wikiCommand() *incur.Cli {
	cmd := incur.New("wiki", incur.WithDescription("Manage wiki pages"))
	cmd.Command("list", &incur.CommandDef{
		Description: "List wiki pages",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"page":       numberSchema("Page number", 1),
			"limit":      numberSchema("Results per page", 30),
			"query":      stringSchema("Search titles, slugs, and body content"),
			"repo":       stringSchema("Repository (OWNER/REPO)"),
			"visibility": wikiVisibilitySchema(),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			pages, err := wikiListRequest(ctx, "/wiki", true)
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				return pages, nil
			}
			return formatWikiList(arrayValue(pages)), nil
		},
	})
	cmd.Command("view", wikiSlugCommand("View a wiki page", func(owner, repo, slug string, ctx *incur.CommandContext) (any, error) {
		page, err := APIRequest("GET", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki/%s", owner, repo, url.PathEscape(slug))), nil, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return page, nil
		}
		return formatWikiView(page), nil
	}))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a wiki page",
		OptionsSchema: objectSchema([]string{"title"}, map[string]*incur.JSONSchema{
			"title":      stringSchema("Page title"),
			"slug":       stringSchema("Page slug (defaults to a slugified title)"),
			"body":       {Type: "string", Description: "Page content (Markdown)", Default: ""},
			"path":       stringSchema("Markdown path in the space (defaults to <slug>.md)"),
			"repo":       stringSchema("Repository (OWNER/REPO)"),
			"visibility": wikiVisibilitySchema(),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{
				"title": stringValue(ctx.Options["title"]),
				"slug":  nullableString(stringValue(ctx.Options["slug"])),
				"body":  stringValue(ctx.Options["body"]),
			}
			if path := stringValue(ctx.Options["path"]); path != "" {
				body["path"] = path
			}
			page, err := APIRequest("POST", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki", owner, repo)), body, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return page, nil
			}
			return formatWikiCreate(page), nil
		},
	})
	cmd.Command("edit", wikiSlugCommandWithOptions("Edit a wiki page", map[string]*incur.JSONSchema{
		"title":             stringSchema("New title"),
		"slug":              stringSchema("New slug"),
		"body":              stringSchema("New content (Markdown)"),
		"path":              stringSchema("New Markdown path in the space"),
		"expected-revision": numberSchema("The revision you read; a stale one is refused instead of overwritten", 0),
	}, func(owner, repo, slug string, ctx *incur.CommandContext) (any, error) {
		body := map[string]any{}
		if _, ok := ctx.Options["title"]; ok {
			body["title"] = stringValue(ctx.Options["title"])
		}
		if _, ok := ctx.Options["slug"]; ok {
			body["slug"] = stringValue(ctx.Options["slug"])
		}
		if _, ok := ctx.Options["body"]; ok {
			body["body"] = stringValue(ctx.Options["body"])
		}
		if _, ok := ctx.Options["path"]; ok {
			body["path"] = stringValue(ctx.Options["path"])
		}
		if revision := intValue(ctx.Options["expected-revision"], 0); revision > 0 {
			body["expected_revision"] = revision
		}
		page, err := APIRequest("PATCH", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki/%s", owner, repo, url.PathEscape(slug))), body, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return page, nil
		}
		return formatWikiMutation("Updated", page), nil
	}))
	cmd.Command("delete", wikiSlugCommand("Delete a wiki page", func(owner, repo, slug string, ctx *incur.CommandContext) (any, error) {
		if _, err := APIRequest("DELETE", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki/%s", owner, repo, url.PathEscape(slug))), nil, nil); err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return map[string]any{"status": "deleted", "slug": slug}, nil
		}
		return "Deleted wiki page " + slug, nil
	}))
	cmd.Command("search", &incur.CommandDef{
		Description: "Search wiki pages by title, slug, and body content",
		OptionsSchema: objectSchema([]string{"query"}, map[string]*incur.JSONSchema{
			"query":      stringSchema("Search query"),
			"page":       numberSchema("Page number", 1),
			"limit":      numberSchema("Results per page", 30),
			"repo":       stringSchema("Repository (OWNER/REPO)"),
			"visibility": wikiVisibilitySchema(),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			pages, err := wikiListRequest(ctx, "/wiki/search", false)
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				return pages, nil
			}
			return formatWikiList(arrayValue(pages)), nil
		},
	})
	cmd.Command("revisions", wikiSlugCommandWithOptions("List revisions for a wiki page", map[string]*incur.JSONSchema{
		"page":  numberSchema("Page number", 1),
		"limit": numberSchema("Results per page", 30),
	}, func(owner, repo, slug string, ctx *incur.CommandContext) (any, error) {
		query := url.Values{}
		query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
		query.Set("per_page", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
		revisions, err := APIRequest("GET", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki/%s/revisions?%s", owner, repo, url.PathEscape(slug), query.Encode())), nil, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return revisions, nil
		}
		return formatWikiRevisionList(arrayValue(revisions)), nil
	}))
	// The wiki spaces (#1922): the navigation index of one space, and a page's history by its id (renames and the deletion included).
	cmd.Command("index", &incur.CommandDef{
		Description: "Show a space's navigation index: pages with tags and backlinks, folders, tags",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":       stringSchema("Repository (OWNER/REPO)"),
			"visibility": wikiVisibilitySchema(),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			index, err := APIRequest("GET", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki/navigation/index", owner, repo)), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return index, nil
			}
			return formatWikiIndex(index), nil
		},
	})
	cmd.Command("history", &incur.CommandDef{
		Description: "List a wiki page's history by page id, renames and the deletion included",
		ArgsSchema:  objectSchema([]string{"page-id"}, map[string]*incur.JSONSchema{"page-id": stringSchema("Wiki page id")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"page":       numberSchema("Page number", 1),
			"limit":      numberSchema("Results per page", 30),
			"repo":       stringSchema("Repository (OWNER/REPO)"),
			"visibility": wikiVisibilitySchema(),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			pageID, err := strconv.ParseInt(strings.TrimSpace(stringValue(ctx.Args["page-id"])), 10, 64)
			if err != nil || pageID <= 0 {
				return nil, fmt.Errorf("invalid wiki page id")
			}
			query := url.Values{}
			query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
			query.Set("per_page", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
			revisions, err := APIRequest("GET", wikiScoped(ctx, fmt.Sprintf("/api/repos/%s/%s/wiki/history/%d?%s", owner, repo, pageID, query.Encode())), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return revisions, nil
			}
			return formatWikiRevisionList(arrayValue(revisions)), nil
		},
	})
	return cmd
}

// wikiVisibilitySchema is the space a wiki command reads or writes (#1922): public (the default) or private.
func wikiVisibilitySchema() *incur.JSONSchema {
	return &incur.JSONSchema{Type: "string", Description: "Wiki space: public (default) or private", Enum: []any{"public", "private"}}
}

// wikiScoped appends the space the command names to a wiki route; a command naming none reads the backend's default, public.
func wikiScoped(ctx *incur.CommandContext, route string) string {
	visibility := strings.TrimSpace(stringValue(ctx.Options["visibility"]))
	if visibility == "" {
		return route
	}
	separator := "?"
	if strings.Contains(route, "?") {
		separator = "&"
	}
	return route + separator + "visibility=" + url.QueryEscape(visibility)
}

// formatWikiIndex prints a space's index one page per line: the path, its tags, and how many pages link to it.
func formatWikiIndex(index any) string {
	object, _ := index.(map[string]any)
	pages := arrayValue(object["pages"])
	if len(pages) == 0 {
		return "No wiki pages in this space."
	}
	var lines []string
	for _, entry := range pages {
		page, _ := entry.(map[string]any)
		line := stringValue(page["path"])
		if metadata, ok := page["metadata"].(map[string]any); ok {
			if tags := arrayValue(metadata["tags"]); len(tags) > 0 {
				var names []string
				for _, tag := range tags {
					names = append(names, "#"+stringValue(tag))
				}
				line += "  " + strings.Join(names, " ")
			}
		}
		if backlinks := arrayValue(page["backlinks"]); len(backlinks) > 0 {
			line += fmt.Sprintf("  ← %d", len(backlinks))
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func wikiListRequest(ctx *incur.CommandContext, suffix string, optionalQuery bool) (any, error) {
	owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
	if err != nil {
		return nil, err
	}
	query := url.Values{}
	if value := strings.TrimSpace(stringValue(ctx.Options["query"])); value != "" {
		query.Set("q", value)
	} else if !optionalQuery {
		query.Set("q", stringValue(ctx.Options["query"]))
	}
	query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
	query.Set("per_page", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
	pages, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s%s?%s", owner, repo, suffix, query.Encode()), nil, nil)
	if err != nil {
		return nil, cleanAPIError(err)
	}
	return pages, nil
}

func wikiSlugCommand(description string, handler func(owner, repo, slug string, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	return wikiSlugCommandWithOptions(description, nil, handler)
}

func wikiSlugCommandWithOptions(description string, extra map[string]*incur.JSONSchema, handler func(owner, repo, slug string, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	properties := map[string]*incur.JSONSchema{"repo": stringSchema("Repository (OWNER/REPO)"), "visibility": wikiVisibilitySchema()}
	for key, schema := range extra {
		properties[key] = schema
	}
	return &incur.CommandDef{
		Description:   description,
		ArgsSchema:    objectSchema([]string{"slug"}, map[string]*incur.JSONSchema{"slug": stringSchema("Wiki page slug")}),
		OptionsSchema: objectSchema(nil, properties),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return handler(owner, repo, stringValue(ctx.Args["slug"]), ctx)
		},
	}
}

func workflowCommand() *incur.Cli {
	cmd := incur.New("workflow", incur.WithDescription("Manage workflows"))
	cmd.Command("list", repoOnlyCommand("List workflows", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workflows", owner, repo), nil, nil)
	}))
	cmd.Command("dispatch", workflowDispatchCommand("Trigger a workflow"))
	cmd.Command("run", &incur.CommandDef{
		Description:   "Run a workflow by name",
		ArgsSchema:    objectSchema([]string{"workflow"}, map[string]*incur.JSONSchema{"workflow": stringSchema("Workflow name")}),
		OptionsSchema: workflowDispatchOptions(),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			response, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workflows", owner, repo), nil, nil)
			if err != nil {
				return nil, err
			}
			matchID := 0
			requested := strings.ToLower(strings.TrimSpace(stringValue(ctx.Args["workflow"])))
			for _, workflow := range arrayValue(objectValue(response)["workflows"]) {
				record := objectValue(workflow)
				if strings.ToLower(strings.TrimSpace(stringValue(record["name"]))) == requested {
					matchID = intValue(record["id"], 0)
					break
				}
			}
			if matchID == 0 {
				return nil, fmt.Errorf("Workflow %s not found in %s/%s", stringValue(ctx.Args["workflow"]), owner, repo)
			}
			return dispatchWorkflow(owner, repo, matchID, ctx)
		},
	})
	cmd.Command("watch", workflowRunWatchCommand("Watch a workflow run in real-time"))
	return cmd
}

func workflowRunCommand() *incur.Cli {
	cmd := incur.New("run", incur.WithDescription("View and manage workflow runs"))
	cmd.Command("list", repoOnlyCommand("List workflow runs", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/runs", owner, repo), nil, nil)
	}))
	cmd.Command("view", workflowRunRequestCommand("View a workflow run", "GET", ""))
	cmd.Command("rerun", workflowRunRequestCommand("Rerun a workflow", "POST", "/rerun"))
	cmd.Command("cancel", workflowRunRequestCommand("Cancel a workflow run", "POST", "/cancel"))
	cmd.Command("logs", &incur.CommandDef{
		Description: "Stream logs for a workflow run",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Run ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			_, err = streamWorkflowRunEvents(owner, repo, intValue(ctx.Args["id"], 0))
			return nil, err
		},
	})
	cmd.Command("watch", workflowRunWatchCommand("Watch a workflow run in real-time (streams logs, status changes, and completion)"))
	return cmd
}

func workflowDispatchOptions() *incur.JSONSchema {
	return objectSchema(nil, map[string]*incur.JSONSchema{
		"ref":   {Type: "string", Description: "Git ref to run against", Default: "main"},
		"repo":  stringSchema("Repository (OWNER/REPO)"),
		"input": arraySchema("Input key=value pairs (can be repeated)"),
	})
}

func workflowDispatchCommand(description string) *incur.CommandDef {
	return &incur.CommandDef{
		Description:   description,
		ArgsSchema:    objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Workflow ID", nil)}),
		OptionsSchema: workflowDispatchOptions(),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return dispatchWorkflow(owner, repo, intValue(ctx.Args["id"], 0), ctx)
		},
	}
}

func dispatchWorkflow(owner, repo string, workflowID int, ctx *incur.CommandContext) (any, error) {
	inputs := parseInputFlags(stringSliceValue(ctx.Options["input"]))
	body := map[string]any{"ref": stringValue(ctx.Options["ref"])}
	if len(inputs) > 0 {
		body["inputs"] = inputs
	}
	result, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/workflows/%d/dispatches", owner, repo, workflowID), body, nil)
	if err != nil {
		return nil, err
	}
	if firstRun := firstWorkflowRun(result); firstRun != nil {
		fmt.Fprintf(os.Stderr, "Dispatched run #%d\n", intValue(firstRun["workflow_run_id"], 0))
	}
	if result == nil {
		return map[string]any{"status": "dispatched"}, nil
	}
	return result, nil
}

func parseInputFlags(flags []string) map[string]string {
	result := map[string]string{}
	for _, flag := range flags {
		idx := strings.Index(flag, "=")
		if idx == -1 {
			continue
		}
		key := strings.TrimSpace(flag[:idx])
		if key != "" {
			result[key] = flag[idx+1:]
		}
	}
	return result
}

func firstWorkflowRun(result any) map[string]any {
	for _, run := range arrayValue(objectValue(result)["runs"]) {
		if record := objectValue(run); record != nil {
			return record
		}
	}
	return nil
}

func workflowRunRequestCommand(description, method, suffix string) *incur.CommandDef {
	return &incur.CommandDef{
		Description: description,
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Run ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest(method, fmt.Sprintf("/api/repos/%s/%s/runs/%d%s", owner, repo, intValue(ctx.Args["id"], 0), suffix), nil, nil)
		},
	}
}

func workflowRunWatchCommand(description string) *incur.CommandDef {
	return &incur.CommandDef{
		Description: description,
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Run ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			run, err := watchWorkflowRun(owner, repo, intValue(ctx.Args["id"], 0))
			if err == nil && workflowRunFailed(stringValue(objectValue(run)["status"])) {
				pendingProcessExitCode = 1
			}
			return run, err
		},
	}
}

func watchWorkflowRun(owner, repo string, runID int) (any, error) {
	runData, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/runs/%d", owner, repo, runID), nil, nil)
	if err != nil {
		return nil, err
	}
	runRecord := objectValue(runData)
	status := stringValue(runRecord["status"])
	fmt.Fprintf(os.Stderr, "Watching run #%d (status: %s)...\n", intValue(runRecord["id"], runID), status)
	if workflowRunTerminal(status) {
		fmt.Fprintf(os.Stderr, "Run #%d already %s.\n", intValue(runRecord["id"], runID), status)
		return runData, nil
	}
	events, err := streamWorkflowRunEvents(owner, repo, runID)
	if err != nil {
		return nil, err
	}
	// The log stream is only a wakeup. Read the durable run status after it
	// ends so the CLI exit code reflects the settled run.
	finalData, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/runs/%d", owner, repo, runID), nil, nil)
	if err != nil {
		return nil, err
	}
	if final := objectValue(finalData); final != nil {
		runRecord = final
	}
	out := map[string]any{}
	for key, value := range runRecord {
		out[key] = value
	}
	out["events"] = events
	return out, nil
}

func workflowRunTerminal(status string) bool {
	switch status {
	case "success", "failure", "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func workflowRunFailed(status string) bool {
	switch status {
	case "failure", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func streamWorkflowRunEvents(owner, repo string, runID int) ([]map[string]any, error) {
	auth, err := RequireAuthToken(nil)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/api/repos/%s/%s/runs/%d/logs", owner, repo, runID)
	resp, cancel, err := doAPI(apiCall{Method: http.MethodGet, URL: auth.APIURL + path, Path: path, Token: auth.Token, Accept: "text/event-stream", Stream: true})
	if err != nil {
		return nil, fmt.Errorf("Failed to connect to run stream: %w", err)
	}
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	events := []map[string]any{}
	currentEventType := ""
	currentEventID := ""
	currentData := ""
	flush := func() bool {
		if currentData == "" {
			return false
		}
		eventType := currentEventType
		if eventType == "" {
			eventType = "log"
		}
		parsed := parseSSEData(currentData)
		event := map[string]any{"type": eventType, "data": parsed}
		if currentEventID != "" {
			event["id"] = currentEventID
		}
		events = append(events, event)
		writeWorkflowEvent(eventType, parsed, currentData)
		currentEventType = ""
		currentEventID = ""
		currentData = ""
		return eventType == "done"
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			currentEventType = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
		case strings.HasPrefix(line, "id: "):
			currentEventID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
		case strings.HasPrefix(line, "data: "):
			currentData = strings.TrimPrefix(line, "data: ")
		case line == "" && currentData != "":
			if flush() {
				return events, nil
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if flush() {
		return events, nil
	}
	return events, nil
}

func parseSSEData(data string) any {
	var parsed any
	if err := json.Unmarshal([]byte(data), &parsed); err == nil {
		return parsed
	}
	return data
}

func writeWorkflowEvent(eventType string, parsed any, raw string) {
	record := objectValue(parsed)
	switch eventType {
	case "log":
		prefix := ""
		if step := stringValue(record["step"]); step != "" {
			prefix = "[step " + step + "] "
		}
		content := stringValue(record["content"])
		if content == "" {
			content = raw
		}
		fmt.Fprintln(os.Stderr, prefix+content)
	case "status":
		status := stringValue(record["status"])
		if status == "" {
			status = "unknown"
		}
		suffix := ""
		if step := stringValue(record["step"]); step != "" {
			suffix = " (step " + step + ")"
		}
		fmt.Fprintln(os.Stderr, "Status: "+status+suffix)
	case "done":
		status := stringValue(record["status"])
		if status == "" {
			status = "unknown"
		}
		fmt.Fprintln(os.Stderr, "Run completed: "+status)
	default:
		fmt.Fprintln(os.Stderr, raw)
	}
}
