package services

import (
	"math"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

type WikiLink struct {
	Target  string `json:"target"`
	Heading string `json:"heading,omitempty"`
	Alias   string `json:"alias,omitempty"`
	Embed   bool   `json:"embed"`
	PageID  *int64 `json:"page_id,omitempty"`
}
type WikiMetadata struct {
	Frontmatter map[string]any `json:"frontmatter"`
	Aliases     []string       `json:"aliases"`
	Tags        []string       `json:"tags"`
	Headings    []string       `json:"headings"`
	Links       []WikiLink     `json:"links"`
	Error       string         `json:"error,omitempty"`
}

var wikiTagPattern = regexp.MustCompile(`(?:^|\s)#([\pL\pN_][\pL\pN_/-]*)`)

// ParseWikiMarkdown derives navigation only. The original Markdown remains
// byte-for-byte authoritative; no generated HTML is trusted by this API.
func ParseWikiMarkdown(body string) WikiMetadata {
	result := WikiMetadata{Frontmatter: map[string]any{}, Aliases: []string{}, Tags: []string{}, Headings: []string{}, Links: []WikiLink{}}
	lines := strings.Split(strings.ReplaceAll(strings.TrimPrefix(body, "\ufeff"), "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[0] == "---" {
		for i := 1; i < len(lines); i++ {
			if lines[i] == "---" || lines[i] == "..." {
				if err := yaml.Unmarshal([]byte(strings.Join(lines[1:i], "\n")), &result.Frontmatter); err != nil {
					result.Frontmatter = map[string]any{}
					result.Error = "invalid frontmatter"
				}
				result.Frontmatter = wikiJSONMap(result.Frontmatter)
				result.Aliases = wikiStrings(result.Frontmatter["aliases"])
				result.Tags = wikiStrings(result.Frontmatter["tags"])
				lines = lines[i+1:]
				break
			}
		}
	}
	var inComment bool
	var fence byte
	var width int
	for _, line := range lines {
		trimmed := strings.TrimLeft(line, " ")
		if len(line)-len(trimmed) >= 4 && fence == 0 {
			continue
		}
		if len(trimmed) >= 3 && (trimmed[0] == '`' || trimmed[0] == '~') {
			n := 0
			for n < len(trimmed) && trimmed[n] == trimmed[0] {
				n++
			}
			if fence == 0 && n >= 3 {
				fence = trimmed[0]
				width = n
				continue
			}
			if fence == trimmed[0] && n >= width && strings.TrimSpace(trimmed[n:]) == "" {
				fence = 0
				continue
			}
		}
		if fence != 0 {
			continue
		}
		line = wikiWithoutCode(line)
		line = wikiWithoutComments(line, &inComment)
		trimmed = strings.TrimSpace(line)
		n := 0
		for n < len(trimmed) && trimmed[n] == '#' {
			n++
		}
		if n > 0 && n <= 6 && n < len(trimmed) && trimmed[n] == ' ' {
			result.Headings = append(result.Headings, strings.TrimSpace(strings.TrimRight(trimmed[n:], "#")))
		}
		for _, match := range wikiTagPattern.FindAllStringSubmatch(line, -1) {
			if strings.IndexFunc(match[1], unicode.IsLetter) >= 0 || strings.ContainsAny(match[1], "_/-") {
				result.Tags = append(result.Tags, match[1])
			}
		}
		for offset := 0; offset < len(line); {
			rel := strings.Index(line[offset:], "[[")
			if rel < 0 {
				break
			}
			start := offset + rel
			endRel := strings.Index(line[start+2:], "]]")
			if endRel < 0 {
				break
			}
			end := start + 2 + endRel
			offset = end + 2
			if start > 0 && line[start-1] == '\\' {
				continue
			}
			text := line[start+2 : end]
			target, alias, _ := strings.Cut(text, "|")
			target, heading, _ := strings.Cut(target, "#")
			result.Links = append(result.Links, WikiLink{Target: strings.TrimSpace(target), Heading: strings.TrimSpace(heading), Alias: strings.TrimSpace(alias), Embed: start > 0 && line[start-1] == '!'})
		}
	}
	for i, tag := range result.Tags {
		result.Tags[i] = strings.TrimPrefix(strings.TrimSpace(tag), "#")
	}
	result.Tags = wikiUnique(result.Tags)
	result.Aliases = wikiUnique(result.Aliases)
	return result
}
func wikiWithoutCode(line string) string {
	bytes := []byte(line)
	for i := 0; i < len(bytes); i++ {
		if bytes[i] != '`' {
			continue
		}
		n := 1
		for i+n < len(bytes) && bytes[i+n] == '`' {
			n++
		}
		end := strings.Index(string(bytes[i+n:]), strings.Repeat("`", n))
		if end < 0 {
			i += n - 1
			continue
		}
		stop := i + n + end + n
		for j := i; j < stop; j++ {
			bytes[j] = ' '
		}
		i = stop - 1
	}
	return string(bytes)
}
func wikiStrings(value any) []string {
	out := []string{}
	switch v := value.(type) {
	case string:
		out = append(out, v)
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func wikiJSONMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range in {
		out[key] = wikiJSONValue(value)
	}
	return out
}
func wikiJSONValue(value any) any {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return strconv.FormatFloat(v, 'g', -1, 64)
		}
		return v
	case map[string]any:
		return wikiJSONMap(v)
	case map[any]any:
		out := map[string]any{}
		for k, item := range v {
			if key, ok := k.(string); ok {
				out[key] = wikiJSONValue(item)
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = wikiJSONValue(item)
		}
		return out
	default:
		return v
	}
}
func wikiUnique(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range in {
		if v != "" && !seen[v] {
			out = append(out, v)
			seen[v] = true
		}
	}
	sort.Strings(out)
	return out
}
func wikiPathKey(value string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(value)), ".md")
}

func resolveWikiLinks(pages []WikiIndexPage) {
	byPath := map[string][]int{}
	byName := map[string][]int{}
	for i, p := range pages {
		key := wikiPathKey(p.Path)
		byPath[key] = append(byPath[key], i)
		names := append([]string{path.Base(key), p.Slug, p.Title}, p.Metadata.Aliases...)
		for _, name := range wikiUnique(names) {
			key := wikiPathKey(name)
			byName[key] = append(byName[key], i)
		}
	}
	unique := func(indices []int) (int, bool) {
		if len(indices) == 0 {
			return 0, false
		}
		first := indices[0]
		for _, i := range indices {
			if i != first {
				return 0, false
			}
		}
		return first, true
	}
	for source := range pages {
		for l := range pages[source].Metadata.Links {
			link := &pages[source].Metadata.Links[l]
			key := wikiPathKey(link.Target)
			var candidates []int
			if key == "" {
				candidates = []int{source}
			} else {
				relative := wikiPathKey(path.Join(path.Dir(pages[source].Path), key))
				candidates = byPath[relative]
				if len(candidates) == 0 {
					candidates = byPath[key]
				}
				if len(candidates) == 0 && !strings.Contains(key, "/") {
					candidates = byName[key]
				}
			}
			if target, ok := unique(candidates); ok {
				id := pages[target].ID
				link.PageID = &id
				pages[target].Backlinks = append(pages[target].Backlinks, WikiBacklink{PageID: pages[source].ID, Path: pages[source].Path, Heading: link.Heading, Embed: link.Embed})
			}
		}
	}
}

func wikiWithoutComments(line string, inComment *bool) string {
	bytes := []byte(line)
	for i := 0; i < len(line); {
		if !*inComment {
			start := strings.Index(line[i:], "<!--")
			if start < 0 {
				break
			}
			i += start
			*inComment = true
		}
		end := strings.Index(line[i:], "-->")
		stop := len(line)
		if end >= 0 {
			stop = i + end + 3
			*inComment = false
		}
		for j := i; j < stop; j++ {
			bytes[j] = ' '
		}
		i = stop
	}
	return string(bytes)
}
