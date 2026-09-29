// Package ownership parses Smithers-generated OWNERS trees and GitHub
// CODEOWNERS files and resolves their policy for repository paths.
package ownership

import (
	"bufio"
	"context"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
)

const (
	RoleApprove = "approve"
	RoleReview  = "review"

	PolicyAutoLand     = "auto-land"
	PolicyHumanApprove = "human-approve"
	PolicyDeny         = "deny"
)

type Principal struct {
	Login   string   `json:"login,omitempty"`
	Team    string   `json:"team,omitempty"`
	Role    string   `json:"role"`
	Reasons []string `json:"reasons"`
}

func (p Principal) ID() string {
	if p.Team != "" {
		return "team:" + p.Team
	}
	return p.Login
}

type rule struct {
	pattern   string
	principal Principal
	policy    string
}

type File struct {
	NoParent           bool
	owners             []Principal
	perFile            []rule
	agents             []rule
	defaultAgentPolicy string
}

// ParseOWNERS accepts exactly the line-oriented format emitted by
// S.Owners.Tree. Unknown directives and malformed lines fail closed.
func ParseOWNERS(content string) (File, error) {
	var out File
	s := bufio.NewScanner(strings.NewReader(content))
	s.Buffer(make([]byte, 4096), 1024*1024)
	lineNo := 0
	seenDeclaration := false
	for s.Scan() {
		lineNo++
		body, comment := splitComment(s.Text())
		body = strings.TrimSpace(body)
		if body == "" {
			continue
		}
		if body == "set noparent" {
			if seenDeclaration || out.NoParent {
				return File{}, fmt.Errorf("line %d: set noparent must be first", lineNo)
			}
			out.NoParent = true
			seenDeclaration = true
			continue
		}
		seenDeclaration = true
		switch {
		case strings.HasPrefix(body, "per-file "):
			left, right, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(body, "per-file ")), "=")
			if !ok || strings.TrimSpace(left) == "" {
				return File{}, fmt.Errorf("line %d: malformed per-file directive", lineNo)
			}
			principal, err := parsePrincipal(strings.TrimSpace(right), RoleApprove, reasonFromComment(comment, "per-file "+strings.TrimSpace(left)))
			if err != nil {
				return File{}, fmt.Errorf("line %d: %w", lineNo, err)
			}
			out.perFile = append(out.perFile, rule{pattern: strings.TrimSpace(left), principal: principal})
		case strings.HasPrefix(body, "agents:"):
			fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(body, "agents:")))
			if len(fields) < 1 || len(fields) > 2 || !validPolicy(fields[0]) {
				return File{}, fmt.Errorf("line %d: malformed agents directive", lineNo)
			}
			if len(fields) == 1 {
				if out.defaultAgentPolicy != "" {
					return File{}, fmt.Errorf("line %d: duplicate default agents directive", lineNo)
				}
				out.defaultAgentPolicy = fields[0]
			} else {
				out.agents = append(out.agents, rule{policy: fields[0], pattern: fields[1]})
			}
		case strings.HasPrefix(body, "reviewers:"):
			principal, err := parsePrincipal(strings.TrimSpace(strings.TrimPrefix(body, "reviewers:")), RoleReview, reasonFromComment(comment, "direct"))
			if err != nil {
				return File{}, fmt.Errorf("line %d: %w", lineNo, err)
			}
			out.owners = append(out.owners, principal)
		default:
			principal, err := parsePrincipal(body, RoleApprove, reasonFromComment(comment, "direct"))
			if err != nil {
				return File{}, fmt.Errorf("line %d: %w", lineNo, err)
			}
			out.owners = append(out.owners, principal)
		}
	}
	if err := s.Err(); err != nil {
		return File{}, err
	}
	return out, nil
}

func splitComment(line string) (string, string) {
	before, after, ok := strings.Cut(line, "#")
	if !ok {
		return line, ""
	}
	return before, strings.TrimSpace(after)
}

func reasonFromComment(comment, fallback string) string {
	if strings.HasPrefix(comment, "upstream-of //") {
		return comment
	}
	return fallback
}

func parsePrincipal(raw, role, reason string) (Principal, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, " \t=/") {
		return Principal{}, fmt.Errorf("invalid owner %q", raw)
	}
	p := Principal{Role: role, Reasons: []string{reason}}
	if strings.HasPrefix(raw, "team:") {
		p.Team = strings.TrimPrefix(raw, "team:")
		if p.Team == "" {
			return Principal{}, fmt.Errorf("invalid team owner")
		}
	} else {
		p.Login = strings.TrimPrefix(raw, "@")
		if p.Login == "" || strings.Contains(p.Login, ":") {
			return Principal{}, fmt.Errorf("invalid login owner")
		}
	}
	return p, nil
}

func validPolicy(policy string) bool {
	return policy == PolicyAutoLand || policy == PolicyHumanApprove || policy == PolicyDeny
}

type CodeownersRule struct {
	pattern string
	owners  []Principal
}

func ParseCODEOWNERS(content string) ([]CodeownersRule, error) {
	var rules []CodeownersRule
	s := bufio.NewScanner(strings.NewReader(content))
	s.Buffer(make([]byte, 4096), 1024*1024)
	for lineNo := 1; s.Scan(); lineNo++ {
		body, _ := splitComment(s.Text())
		fields := strings.Fields(body)
		if len(fields) == 0 {
			continue
		}
		// A pattern with no owners is valid: it clears ownership for the
		// paths it matches.
		r := CodeownersRule{pattern: fields[0]}
		for _, raw := range fields[1:] {
			raw = strings.TrimPrefix(raw, "@")
			// GitHub teams are written org/team. Keep only the stable team name;
			// Smithers team rosters remain server-side and are never expanded.
			if slash := strings.LastIndexByte(raw, '/'); slash >= 0 {
				r.owners = append(r.owners, Principal{Team: raw[slash+1:], Role: RoleApprove, Reasons: []string{"workspace"}})
			} else {
				r.owners = append(r.owners, Principal{Login: raw, Role: RoleApprove, Reasons: []string{"workspace"}})
			}
		}
		rules = append(rules, r)
	}
	return rules, s.Err()
}

type Tree struct {
	Files      map[string]File
	Codeowners []CodeownersRule
}

var codeownersLocations = []string{".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"}

type FileLoader interface {
	LoadFile(ctx context.Context, revision, filePath string) (content string, found bool, err error)
}

// LoadTree reads only the root and ancestor OWNERS files relevant to paths.
// This keeps resolution bounded by touched paths rather than repository size.
func LoadTree(ctx context.Context, loader FileLoader, revision string, paths []string) (Tree, error) {
	tree := Tree{Files: make(map[string]File)}
	dirs := map[string]struct{}{"": {}}
	for _, filePath := range paths {
		for _, dir := range ancestorDirs(path.Dir(cleanRepoPath(filePath))) {
			dirs[dir] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(dirs))
	for dir := range dirs {
		ordered = append(ordered, dir)
	}
	sort.Strings(ordered)
	for _, dir := range ordered {
		filePath := "OWNERS"
		if dir != "" {
			filePath = dir + "/OWNERS"
		}
		content, found, err := loader.LoadFile(ctx, revision, filePath)
		if err != nil {
			return Tree{}, fmt.Errorf("load %s: %w", filePath, err)
		}
		if !found {
			continue
		}
		parsed, err := ParseOWNERS(content)
		if err != nil {
			return Tree{}, fmt.Errorf("parse %s: %w", filePath, err)
		}
		tree.Files[dir] = parsed
	}
	// GitHub reads the first CODEOWNERS it finds in this order.
	for _, filePath := range codeownersLocations {
		content, found, err := loader.LoadFile(ctx, revision, filePath)
		if err != nil {
			return Tree{}, fmt.Errorf("load %s: %w", filePath, err)
		}
		if !found {
			continue
		}
		tree.Codeowners, err = ParseCODEOWNERS(content)
		if err != nil {
			return Tree{}, fmt.Errorf("parse %s: %w", filePath, err)
		}
		break
	}
	return tree, nil
}

type PathResolution struct {
	Path        string      `json:"path"`
	Package     string      `json:"package"`
	Owners      []Principal `json:"owners"`
	AgentPolicy string      `json:"agent_policy"`
	Packages    []string    `json:"packages"`
}

func (t Tree) Resolve(filePath string) PathResolution {
	filePath = cleanRepoPath(filePath)
	dirs := ancestorDirs(path.Dir(filePath))
	owners := make([]Principal, 0)
	packages := make([]string, 0)
	hadOwnersFile := false
	policy := ""
	for i := len(dirs) - 1; i >= 0; i-- {
		dir := dirs[i]
		f, ok := t.Files[dir]
		if !ok {
			continue
		}
		hadOwnersFile = true
		packages = append(packages, packageName(dir))
		rel := relativeToDir(dir, filePath)
		for _, p := range f.owners {
			cp := p
			if i != len(dirs)-1 && len(cp.Reasons) == 1 && cp.Reasons[0] == "direct" {
				cp.Reasons = []string{"inherited from " + packageName(dir)}
			}
			owners = mergePrincipal(owners, cp)
			packages = appendReasonPackages(packages, cp.Reasons)
		}
		for _, r := range f.perFile {
			if matchGlob(r.pattern, rel) {
				owners = mergePrincipal(owners, r.principal)
				packages = appendReasonPackages(packages, r.principal.Reasons)
			}
		}
		if policy == "" {
			for _, r := range f.agents {
				if matchGlob(r.pattern, rel) {
					policy = r.policy
					break
				}
			}
			if policy == "" && f.defaultAgentPolicy != "" {
				policy = f.defaultAgentPolicy
			}
		}
		if f.NoParent {
			break
		}
	}
	if !hadOwnersFile {
		for _, r := range t.Codeowners {
			if matchCodeowners(r.pattern, filePath) {
				owners = append(make([]Principal, 0, len(r.owners)), r.owners...) // last rule wins
			}
		}
	}
	if policy == "" {
		policy = PolicyHumanApprove
	}
	pkg := "//"
	if len(packages) > 0 {
		pkg = packages[0]
	}
	return PathResolution{Path: filePath, Package: pkg, Owners: owners, AgentPolicy: policy, Packages: packages}
}

func appendReasonPackages(packages, reasons []string) []string {
	for _, reason := range reasons {
		if !strings.HasPrefix(reason, "upstream-of //") {
			continue
		}
		pkg := strings.TrimSpace(strings.TrimPrefix(reason, "upstream-of "))
		if !contains(packages, pkg) {
			packages = append(packages, pkg)
		}
	}
	return packages
}

func mergePrincipal(items []Principal, add Principal) []Principal {
	for i := range items {
		if items[i].ID() == add.ID() && items[i].Role == add.Role {
			for _, reason := range add.Reasons {
				if !contains(items[i].Reasons, reason) {
					items[i].Reasons = append(items[i].Reasons, reason)
				}
			}
			return items
		}
	}
	return append(items, add)
}

func contains(items []string, item string) bool {
	for _, got := range items {
		if got == item {
			return true
		}
	}
	return false
}

func ancestorDirs(dir string) []string {
	if dir == "." || dir == "/" {
		return []string{""}
	}
	parts := strings.Split(strings.Trim(dir, "/"), "/")
	out := []string{""}
	for i := range parts {
		out = append(out, strings.Join(parts[:i+1], "/"))
	}
	return out
}

func packageName(dir string) string {
	if dir == "" {
		return "//"
	}
	return "//" + dir
}

func relativeToDir(dir, p string) string {
	if dir == "" {
		return p
	}
	return strings.TrimPrefix(p, dir+"/")
}

func cleanRepoPath(p string) string {
	// Whitespace belongs to repository names; trimming it can select a
	// different directory's ownership policy.
	p = strings.TrimPrefix(path.Clean("/"+p), "/")
	if p == "." {
		return ""
	}
	return p
}

// matchCodeowners follows GitHub's CODEOWNERS rules, which are gitignore
// rules: a leading or middle slash anchors the pattern to the root, a
// trailing slash matches only directories, a pattern that matches a
// directory covers everything under it, and "dir/*" covers only the files
// directly in dir.
func matchCodeowners(pattern, p string) bool {
	pattern = strings.TrimSpace(pattern)
	dirOnly := strings.HasSuffix(pattern, "/")
	pattern = strings.TrimSuffix(pattern, "/")
	anchored := strings.Contains(pattern, "/")
	pattern = strings.TrimPrefix(pattern, "/")
	if pattern == "" || p == "" {
		return false
	}
	re := codeownersRegexp(pattern, anchored)
	coversDescendants := pattern != "*" && !strings.HasSuffix(pattern, "/*")
	segments := strings.Split(p, "/")
	for i := 1; i <= len(segments); i++ {
		isFile := i == len(segments)
		if (isFile && dirOnly) || (!isFile && !coversDescendants) {
			continue
		}
		if re.MatchString(strings.Join(segments[:i], "/")) {
			return true
		}
	}
	return false
}

func codeownersRegexp(pattern string, anchored bool) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	if !anchored {
		b.WriteString("(?:.*/)?")
	}
	for i := 0; i < len(pattern); {
		switch {
		case strings.HasPrefix(pattern[i:], "**/"):
			b.WriteString("(?:.*/)?")
			i += 3
		case strings.HasPrefix(pattern[i:], "**"):
			b.WriteString(".*")
			i += 2
		case pattern[i] == '*':
			b.WriteString("[^/]*")
			i++
		case pattern[i] == '?':
			b.WriteString("[^/]")
			i++
		default:
			b.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
			i++
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// matchGlob implements the Smithers ownership glob subset. A bare file glob
// matches at every depth; ** crosses directories; * does not.
func matchGlob(pattern, p string) bool {
	pattern = strings.TrimPrefix(strings.TrimSpace(pattern), "./")
	if pattern == "" {
		return false
	}
	if !strings.Contains(pattern, "/") {
		pattern = "**/" + pattern
	}
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); {
		switch {
		case i+1 < len(pattern) && pattern[i:i+2] == "**":
			if i+2 < len(pattern) && pattern[i+2] == '/' {
				b.WriteString("(?:.*/)?")
				i += 3
			} else {
				b.WriteString(".*")
				i += 2
			}
		case pattern[i] == '*':
			b.WriteString("[^/]*")
			i++
		case pattern[i] == '?':
			b.WriteString("[^/]")
			i++
		default:
			b.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
			i++
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String()).MatchString(p)
}

// Match reports whether a repository-relative path is covered by an OWNERS
// glob (including ** and bare file patterns).
func Match(pattern, filePath string) bool { return matchGlob(pattern, cleanRepoPath(filePath)) }

func RequiredApprovers(paths []PathResolution) []string {
	seen := map[string]struct{}{}
	for _, item := range paths {
		for _, owner := range item.Owners {
			if owner.Role == RoleApprove {
				seen[owner.ID()] = struct{}{}
			}
		}
	}
	return sortedKeys(seen)
}

func SuggestedReviewers(paths []PathResolution) []string {
	seen := map[string]struct{}{}
	for _, item := range paths {
		for _, owner := range item.Owners {
			if owner.Role == RoleReview {
				seen[owner.ID()] = struct{}{}
			}
		}
	}
	return sortedKeys(seen)
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		if key != "" {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}
