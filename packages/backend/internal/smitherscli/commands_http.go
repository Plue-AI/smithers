package smitherscli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"

	incur "github.com/smithersai/incur"
)

func apiCommand() *incur.Cli {
	cmd := incur.New("api", incur.WithDescription("Make raw API calls to the Smithers server"))
	cmd.Command("", &incur.CommandDef{
		Description: "Make raw API calls to the Smithers server",
		ArgsSchema: objectSchema([]string{"endpoint"}, map[string]*incur.JSONSchema{
			"endpoint": stringSchema("API endpoint path (e.g. /api/repos/owner/name)"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"method": {Type: "string", Description: "HTTP method", Default: "GET"},
			"field":  arraySchema("Request body field (key=value)"),
			"header": arraySchema("Request header (key:value)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			method := strings.ToUpper(stringValue(ctx.Options["method"]))
			valid := map[string]struct{}{"GET": {}, "POST": {}, "PUT": {}, "PATCH": {}, "DELETE": {}}
			if _, ok := valid[method]; !ok {
				return nil, fmt.Errorf("Invalid HTTP method '%s'; expected one of: GET, POST, PUT, PATCH, DELETE", method)
			}
			endpoint := stringValue(ctx.Args["endpoint"])
			if !strings.HasPrefix(endpoint, "/") {
				return nil, fmt.Errorf("Endpoint must begin with '/'")
			}
			var body map[string]string
			fields := stringSliceValue(ctx.Options["field"])
			if len(fields) > 0 {
				body = map[string]string{}
				for _, field := range fields {
					eq := strings.Index(field, "=")
					if eq == -1 {
						return nil, fmt.Errorf("Field must be in key=value format: %s", field)
					}
					body[field[:eq]] = field[eq+1:]
				}
			}
			extraHeaders := map[string]string{}
			for _, header := range stringSliceValue(ctx.Options["header"]) {
				colon := strings.Index(header, ":")
				if colon == -1 {
					return nil, fmt.Errorf("Header must be in key:value format: %s", header)
				}
				extraHeaders[strings.TrimSpace(header[:colon])] = strings.TrimSpace(header[colon+1:])
			}
			return rawAPIRequest(method, endpoint, body, extraHeaders)
		},
	})
	return cmd
}

// rawAPIMarshal is a seam so the defensive marshal-error branch in
// rawAPIRequest can be exercised (json.Marshal never fails for map[string]string).
var rawAPIMarshal = json.Marshal

func rawAPIRequest(method, endpoint string, body map[string]string, extraHeaders map[string]string) (any, error) {
	authToken, err := RequireAuthToken(nil)
	if err != nil {
		return nil, err
	}
	var rawBody []byte
	if body != nil {
		rawBody, err = rawAPIMarshal(body)
		if err != nil {
			return nil, err
		}
	}
	resp, cancel, err := doAPI(apiCall{
		Method:  method,
		URL:     authToken.APIURL + endpoint,
		Path:    endpoint,
		RawBody: rawBody,
		Token:   authToken.Token,
		Headers: extraHeaders,
	})
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			return nil, rawAPIError{apiErr}
		}
		return nil, err
	}
	defer cancel()
	defer func() { _ = resp.Body.Close() }()
	textBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIResponseBytes))
	if err != nil {
		return nil, err
	}
	if len(textBytes) == 0 {
		return nil, nil
	}
	var decoded any
	if json.Unmarshal(textBytes, &decoded) == nil {
		return decoded, nil
	}
	_, _ = os.Stdout.Write(textBytes)
	return nil, nil
}

// rawAPIError prints only the server's message, as `smithers api` always has,
// and keeps the typed *APIError reachable with errors.As.
type rawAPIError struct{ *APIError }

func (e rawAPIError) Error() string {
	if e.RequestID != "" {
		return e.Detail + " [request " + e.RequestID + "]"
	}
	return e.Detail
}

func (e rawAPIError) Unwrap() error { return e.APIError }

func searchCommand() *incur.Cli {
	cmd := incur.New("search", incur.WithDescription("Search repos, issues, and code"))
	for _, spec := range []struct {
		name        string
		description string
		endpoint    string
	}{
		{"repos", "Search repositories", "repositories"},
		{"issues", "Search issues", "issues"},
		{"code", "Search code", "code"},
		{"users", "Search users", "users"},
	} {
		spec := spec
		cmd.Command(spec.name, &incur.CommandDef{
			Description: spec.description,
			ArgsSchema: objectSchema([]string{"query"}, map[string]*incur.JSONSchema{
				"query": stringSchema("Search query"),
			}),
			OptionsSchema: pageLimitOptions(),
			Handler: func(ctx *incur.CommandContext) (any, error) {
				searchQuery := strings.TrimSpace(stringValue(ctx.Args["query"]))
				if searchQuery == "" {
					return nil, fmt.Errorf("search query is required")
				}
				query := url.Values{}
				query.Set("q", searchQuery)
				query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
				query.Set("per_page", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
				return APIRequest("GET", "/api/search/"+spec.endpoint+"?"+query.Encode(), nil, nil)
			},
		})
	}
	return cmd
}

func labelCommand() *incur.Cli {
	cmd := incur.New("label", incur.WithDescription("Manage labels"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a label",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Label name")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"color":       {Type: "string", Description: "Label color (hex)", Default: ""},
			"description": {Type: "string", Description: "Label description", Default: ""},
			"repo":        stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/labels", owner, repo), map[string]any{
				"name":        stringValue(ctx.Args["name"]),
				"color":       stringValue(ctx.Options["color"]),
				"description": stringValue(ctx.Options["description"]),
			}, nil)
		},
	})
	cmd.Command("list", repoOnlyCommand("List labels", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/labels", owner, repo), nil, nil)
	}))
	cmd.Command("delete", &incur.CommandDef{
		Description: "Delete a label",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Label ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := intValue(ctx.Args["id"], 0)
			if id <= 0 {
				return nil, fmt.Errorf("invalid label id")
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/repos/%s/%s/labels/%d", owner, repo, id), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "id": id}, nil
		},
	})
	return cmd
}

func secretCommand() *incur.Cli {
	cmd := incur.New("secret", incur.WithDescription("Manage secrets"))
	cmd.Command("list", repoOnlyCommand("List secrets", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/secrets", owner, repo), nil, nil)
	}))
	cmd.Command("set", &incur.CommandDef{
		Description: "Set a secret",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Secret name")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"body-stdin": booleanSchema("Read the secret value from stdin", false),
			"main-only":  booleanSchema("Only trusted runs on the default bookmark receive it", false),
			"repo":       stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			if ctx.Options["body-stdin"] != true {
				return nil, fmt.Errorf("secret values must be provided via stdin with --body-stdin")
			}
			value, err := readStdinText("secret value", false)
			if err != nil {
				return nil, err
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{"name": stringValue(ctx.Args["name"]), "value": value}
			if ctx.Options["main-only"] == true {
				body["main_only"] = true
			}
			return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/secrets", owner, repo), body, nil)
		},
	})
	cmd.Command("scope", &incur.CommandDef{
		Description: "Limit a secret to trusted runs on the default bookmark, or give it to every run",
		ArgsSchema: objectSchema([]string{"name", "scope"}, map[string]*incur.JSONSchema{
			"name":  stringSchema("Secret name"),
			"scope": enumSchema("main-only or all", []string{"main-only", "all"}, ""),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{"repo": stringSchema("Repository (OWNER/REPO)")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			name := stringValue(ctx.Args["name"])
			return APIRequest("PATCH", fmt.Sprintf("/api/repos/%s/%s/secrets/%s", owner, repo, url.PathEscape(name)), map[string]any{
				"main_only": stringValue(ctx.Args["scope"]) == "main-only",
			}, nil)
		},
	})
	cmd.Command("delete", namedRepoDeleteCommand("Delete a secret", "Secret name", "/api/repos/%s/%s/secrets/%s"))
	return cmd
}

func variableCommand() *incur.Cli {
	cmd := incur.New("variable", incur.WithDescription("Manage variables"))
	cmd.Command("list", repoOnlyCommand("List variables", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/variables", owner, repo), nil, nil)
	}))
	cmd.Command("get", &incur.CommandDef{
		Description:   "Get a variable value",
		ArgsSchema:    objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Variable name")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{"repo": stringSchema("Repository (OWNER/REPO)")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			name := stringValue(ctx.Args["name"])
			if strings.TrimSpace(name) == "" {
				return nil, fmt.Errorf("variable name is required")
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/variables/%s", owner, repo, url.PathEscape(name)), nil, nil)
		},
	})
	cmd.Command("set", &incur.CommandDef{
		Description: "Set a variable",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Variable name")}),
		OptionsSchema: objectSchema([]string{"body"}, map[string]*incur.JSONSchema{
			"body": stringSchema("Variable value"),
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/variables", owner, repo), map[string]any{
				"name":  stringValue(ctx.Args["name"]),
				"value": stringValue(ctx.Options["body"]),
			}, nil)
		},
	})
	cmd.Command("delete", namedRepoDeleteCommand("Delete a variable", "Variable name", "/api/repos/%s/%s/variables/%s"))
	return cmd
}

func sshKeyCommand() *incur.Cli {
	cmd := incur.New("ssh-key", incur.WithDescription("Manage SSH keys"))
	cmd.Command("add", &incur.CommandDef{
		Description: "Add an SSH key",
		OptionsSchema: objectSchema([]string{"title", "key"}, map[string]*incur.JSONSchema{
			"title": stringSchema("Key title"),
			"key":   stringSchema("Public key content"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", "/api/user/keys", map[string]any{
				"title": stringValue(ctx.Options["title"]),
				"key":   stringValue(ctx.Options["key"]),
			}, nil)
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description: "List SSH keys",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/user/keys", nil, nil)
		},
	})
	cmd.Command("delete", &incur.CommandDef{
		Description: "Delete an SSH key",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": stringSchema("Key ID")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id, err := strconv.Atoi(stringValue(ctx.Args["id"]))
			if err != nil || id <= 0 {
				return nil, fmt.Errorf("invalid SSH key id")
			}
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/user/keys/%d", id), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "id": id}, nil
		},
	})
	return cmd
}

func notificationCommand() *incur.Cli {
	cmd := incur.New("notification", incur.WithDescription("Manage notifications"))
	cmd.Command("list", &incur.CommandDef{
		Description: "List notifications",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"unread": booleanSchema("Show only unread notifications", false),
			"limit":  numberSchema("Results per page", 30),
			"cursor": stringSchema("Pagination cursor (from previous response)"),
			"all":    booleanSchema("Fetch all pages automatically", false),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			buildPath := func(cursor string) string {
				query := url.Values{}
				query.Set("limit", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
				if ctx.Options["unread"] == true {
					query.Set("status", "unread")
				}
				if cursor != "" {
					query.Set("cursor", cursor)
				}
				return "/api/notifications/list?" + query.Encode()
			}
			if ctx.Options["all"] == true {
				return APIListAll(buildPath, nil)
			}
			data, nextCursor, err := APIList(buildPath(stringValue(ctx.Options["cursor"])), nil)
			if err != nil {
				return nil, err
			}
			if nextCursor != "" {
				return map[string]any{"data": data, "next_cursor": nextCursor}, nil
			}
			return data, nil
		},
	})
	cmd.Command("read", &incur.CommandDef{
		Description:   "Mark a notification as read",
		ArgsSchema:    objectSchema(nil, map[string]*incur.JSONSchema{"id": stringSchema("Notification ID")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{"all": booleanSchema("Mark all notifications as read", false)}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			if ctx.Options["all"] == true {
				if _, err := APIRequest("PUT", "/api/notifications/mark-read", nil, nil); err != nil {
					return nil, err
				}
				return map[string]any{"status": "all_read"}, nil
			}
			id := stringValue(ctx.Args["id"])
			if id == "" {
				return nil, fmt.Errorf("Provide a notification ID or use --all to mark all as read.")
			}
			return APIRequest("PATCH", "/api/notifications/"+url.PathEscape(id), map[string]any{"read": true}, nil)
		},
	})
	return cmd
}

func cacheCommand() *incur.Cli {
	cmd := incur.New("cache", incur.WithDescription("Manage workflow caches"))
	cmd.Command("list", &incur.CommandDef{
		Description: "List workflow caches for a repository",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":     stringSchema("Repository (OWNER/REPO)"),
			"bookmark": stringSchema("Filter by bookmark name"),
			"key":      stringSchema("Filter by cache key"),
			"page":     numberSchema("Page number", 1),
			"limit":    numberSchema("Number of results", 30),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			query := cacheQuery(ctx, true)
			return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/caches%s", owner, repo, query), nil, nil)
		},
	})
	cmd.Command("stats", repoOnlyCommand("Show workflow cache statistics for a repository", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/caches/stats", owner, repo), nil, nil)
	}))
	cmd.Command("clear", &incur.CommandDef{
		Description: "Clear workflow caches for a repository",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":     stringSchema("Repository (OWNER/REPO)"),
			"bookmark": stringSchema("Filter by bookmark name"),
			"key":      stringSchema("Filter by cache key"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("DELETE", fmt.Sprintf("/api/repos/%s/%s/caches%s", owner, repo, cacheQuery(ctx, false)), nil, nil)
		},
	})
	registerBuildCacheCommands(cmd)
	return cmd
}

func repoOnlyCommand(description string, handler func(owner, repo string, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	return &incur.CommandDef{
		Description: description,
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return handler(owner, repo, ctx)
		},
	}
}

func namedRepoDeleteCommand(description, argDescription, pathFormat string) *incur.CommandDef {
	return &incur.CommandDef{
		Description: description,
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema(argDescription)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			name := stringValue(ctx.Args["name"])
			if strings.TrimSpace(name) == "" {
				return nil, fmt.Errorf("%s is required", strings.ToLower(argDescription))
			}
			if _, err := APIRequest("DELETE", fmt.Sprintf(pathFormat, owner, repo, url.PathEscape(name)), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "name": name}, nil
		},
	}
}

func pageLimitOptions() *incur.JSONSchema {
	return objectSchema(nil, map[string]*incur.JSONSchema{
		"page":  numberSchema("Page number", 1),
		"limit": numberSchema("Results per page", 30),
	})
}

func readStdinText(description string, allowEmpty bool) (string, error) {
	stat, err := os.Stdin.Stat()
	if err == nil && (stat.Mode()&os.ModeCharDevice) != 0 {
		return "", fmt.Errorf("%s must be provided on stdin", description)
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	if !allowEmpty && len(data) == 0 {
		return "", fmt.Errorf("no %s provided on stdin", description)
	}
	return string(data), nil
}

func cacheQuery(ctx *incur.CommandContext, includePage bool) string {
	query := url.Values{}
	if includePage {
		query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
		query.Set("per_page", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
	}
	if bookmark := strings.TrimSpace(stringValue(ctx.Options["bookmark"])); bookmark != "" {
		query.Set("bookmark", bookmark)
	}
	if key := strings.TrimSpace(stringValue(ctx.Options["key"])); key != "" {
		query.Set("key", key)
	}
	if len(query) == 0 {
		return ""
	}
	return "?" + query.Encode()
}
