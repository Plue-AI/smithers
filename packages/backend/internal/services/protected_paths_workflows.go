package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// The paths a revision's GitHub workflows execute with elevated trust,
// derived from the workflows themselves each time the list is read:
//
//   - every local action a workflow step uses (`uses: ./dir`), and every local
//     action those actions' composite steps use, transitively; an action this
//     repository publishes and a workflow uses by name
//     (`uses: owner/repo/dir@ref`, where dir holds an action here) counts too;
//   - the package that encloses each such action (its nearest directory with a
//     package.json below the root), whose code the action may run;
//   - every script file a `run:` step names in a job that holds a secret or a
//     write, id-token or default token permission, and in a local action;
//   - every file those scripts and the actions' scripts import by a relative
//     specifier, transitively;
//   - every workspace package such an enclosing package depends on, as
//     pnpm-lock.yaml resolves it (a `link:` dependency, including every
//     `workspace:` one, or an injected `file:` directory), transitively: an action's command imports those by
//     name after an install. The root install files are built-in roots.
//
// Limits: code reached any other way is not derived. That is package imports
// of a script outside an action's package, package manager scripts and
// workspace tools (`pnpm test`, `pnpm exec tool`), a workspace dependency no
// pnpm lockfile at the repository root resolves (a `workspace:`, `link:` or
// `file:` one without a lockfile importer is an error), scripts named through a shell variable or
// expression other than the workspace, files a shell script sources, and an
// action a workflow uses by name from the repository root (`owner/repo@ref`). A workflow that runs on pull
// requests therefore never runs a local action from the pull request's
// checkout in a job with elevated trust (see the workflow lint test); it runs
// the default branch's action by name.

const workflowsDir = ".github/workflows"

// workflowTrustReadLimit bounds the files one derivation reads.
const workflowTrustReadLimit = 2000

var (
	workflowScriptExtensions = []string{".sh", ".bash", ".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".rb", ".pl", ".ps1"}
	workflowImportExtensions = []string{".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"}
	workflowSecretsReference = regexp.MustCompile(`\bsecrets\b`)
	workflowWorkspacePrefix  = regexp.MustCompile(`(\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE)/`)
	workflowRelativeImport   = regexp.MustCompile(`(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["'](\.{1,2}/[^"'\n]+)["']`)
	workflowRunSeparators    = regexp.MustCompile("[\\s;|&()<>'\"`=]+")
)

type workflowDocument struct {
	On          yaml.Node              `yaml:"on"`
	Permissions yaml.Node              `yaml:"permissions"`
	Env         yaml.Node              `yaml:"env"`
	Defaults    workflowDefaults       `yaml:"defaults"`
	Jobs        map[string]workflowJob `yaml:"jobs"`
}

type workflowDefaults struct {
	Run struct {
		WorkingDirectory string `yaml:"working-directory"`
	} `yaml:"run"`
}

type workflowJob struct {
	Permissions yaml.Node        `yaml:"permissions"`
	Defaults    workflowDefaults `yaml:"defaults"`
	Uses        string           `yaml:"uses"`
	Steps       []workflowStep   `yaml:"steps"`
	node        yaml.Node
}

func (j *workflowJob) UnmarshalYAML(node *yaml.Node) error {
	type plain workflowJob
	var decoded plain
	if err := node.Decode(&decoded); err != nil {
		return err
	}
	*j = workflowJob(decoded)
	j.node = *node
	return nil
}

type workflowStep struct {
	Uses             string `yaml:"uses"`
	Run              string `yaml:"run"`
	WorkingDirectory string `yaml:"working-directory"`
}

type actionDocument struct {
	Runs struct {
		Main  string         `yaml:"main"`
		Pre   string         `yaml:"pre"`
		Post  string         `yaml:"post"`
		Steps []workflowStep `yaml:"steps"`
	} `yaml:"runs"`
}

// workflowTrust walks one revision's workflows.
type workflowTrust struct {
	tree     revisionTree
	reads    int
	paths    map[string]bool
	actions  map[string]bool
	scripts  map[string]bool
	packages map[string]bool
}

// workflowTrustPaths lists, sorted, the root-relative paths ("/"-prefixed)
// the revision's workflows execute with elevated trust. A workflow or local
// action that does not parse is an error, never an empty list.
func workflowTrustPaths(ctx context.Context, tree revisionTree) ([]string, error) {
	w := &workflowTrust{tree: tree, paths: map[string]bool{}, actions: map[string]bool{}, scripts: map[string]bool{}, packages: map[string]bool{}}
	workflows, err := readWorkflows(ctx, tree)
	if err != nil {
		return nil, err
	}
	for _, workflow := range workflows {
		for _, job := range workflow.doc.Jobs {
			elevated := workflowJobElevated(workflow.doc, job)
			for _, step := range job.Steps {
				if err := w.uses(ctx, step.Uses); err != nil {
					return nil, err
				}
				if elevated {
					if step.WorkingDirectory == "" {
						step.WorkingDirectory = job.Defaults.Run.WorkingDirectory
					}
					if step.WorkingDirectory == "" {
						step.WorkingDirectory = workflow.doc.Defaults.Run.WorkingDirectory
					}
					if err := w.run(ctx, step); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	if err := w.workspaceDependencies(ctx); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(w.paths))
	for entry := range w.paths {
		out = append(out, "/"+entry)
	}
	sort.Strings(out)
	return out, nil
}

type parsedWorkflow struct {
	path string
	doc  workflowDocument
}

// readWorkflows parses the revision's .github/workflows/*.yml and *.yaml.
func readWorkflows(ctx context.Context, tree revisionTree) ([]parsedWorkflow, error) {
	files, err := tree.files(ctx, workflowsDir)
	if err != nil {
		return nil, err
	}
	var workflows []parsedWorkflow
	for _, file := range files {
		if path.Dir(file) != workflowsDir || !(strings.HasSuffix(file, ".yml") || strings.HasSuffix(file, ".yaml")) {
			continue
		}
		content, found, err := tree.read(ctx, file)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		var doc workflowDocument
		if err := yaml.Unmarshal(content, &doc); err != nil {
			return nil, fmt.Errorf("%s does not parse: %w", file, err)
		}
		workflows = append(workflows, parsedWorkflow{path: file, doc: doc})
	}
	return workflows, nil
}

// workflowJobElevated reports whether a job holds a secret, or a token that
// can write or mint an id token. A job with no permissions at either level
// gets the repository's default token, which may write.
func workflowJobElevated(doc workflowDocument, job workflowJob) bool {
	permissions := job.Permissions
	if permissions.Kind == 0 {
		permissions = doc.Permissions
	}
	if permissions.Kind == 0 || workflowPermissionsWrite(&permissions) {
		return true
	}
	return workflowNodeMentionsSecrets(&doc.Env) || workflowNodeMentionsSecrets(&job.node)
}

func workflowPermissionsWrite(node *yaml.Node) bool {
	switch node.Kind {
	case yaml.ScalarNode:
		return node.Value != "read-all" && node.Value != ""
	case yaml.MappingNode:
		for i := 1; i < len(node.Content); i += 2 {
			if node.Content[i].Value == "write" {
				return true
			}
		}
	}
	return false
}

func workflowNodeMentionsSecrets(node *yaml.Node) bool {
	if node.Kind == yaml.ScalarNode {
		return workflowSecretsReference.MatchString(node.Value)
	}
	for _, child := range node.Content {
		if workflowNodeMentionsSecrets(child) {
			return true
		}
	}
	return false
}

// localActionDir is the repository directory a `uses:` value runs, if any.
func (w *workflowTrust) localActionDir(ctx context.Context, uses string) (string, bool, error) {
	uses = strings.TrimSpace(uses)
	if uses == "" || strings.HasPrefix(uses, "docker://") || strings.Contains(uses, "${{") {
		return "", false, nil
	}
	if strings.HasPrefix(uses, "./") || uses == "." {
		dir := path.Clean(uses)
		if dir == ".." || strings.HasPrefix(dir, "../") {
			return "", false, nil
		}
		return dir, true, nil
	}
	name, _, ok := strings.Cut(uses, "@")
	parts := strings.SplitN(name, "/", 3)
	if !ok || len(parts) < 3 || parts[2] == "" {
		return "", false, nil
	}
	dir := path.Clean(parts[2])
	if dir == "." || dir == ".." || strings.HasPrefix(dir, "../") {
		return "", false, nil
	}
	_, found, err := w.actionManifest(ctx, dir)
	return dir, found && err == nil, err
}

// uses protects the local action a step runs, and everything it runs.
func (w *workflowTrust) uses(ctx context.Context, uses string) error {
	dir, ok, err := w.localActionDir(ctx, uses)
	if err != nil || !ok || w.actions[dir] {
		return err
	}
	w.actions[dir] = true
	if strings.HasSuffix(dir, ".yml") || strings.HasSuffix(dir, ".yaml") {
		// A reusable workflow: it lives under .github and is read as a workflow.
		w.paths[dir] = true
		return nil
	}
	if dir == "." {
		w.paths["action.yml"], w.paths["action.yaml"] = true, true
	} else {
		w.paths[dir] = true
		if err := w.enclosingPackage(ctx, dir); err != nil {
			return err
		}
	}
	manifest, found, err := w.actionManifest(ctx, dir)
	if err != nil || !found {
		return err
	}
	var action actionDocument
	if err := yaml.Unmarshal(manifest, &action); err != nil {
		return fmt.Errorf("%s/action.yml does not parse: %w", dir, err)
	}
	for _, entry := range []string{action.Runs.Main, action.Runs.Pre, action.Runs.Post} {
		if file := path.Join(dir, strings.TrimSpace(entry)); entry != "" && file != ".." && !strings.HasPrefix(file, "../") {
			if err := w.script(ctx, file); err != nil {
				return err
			}
		}
	}
	for _, step := range action.Runs.Steps {
		if err := w.uses(ctx, step.Uses); err != nil {
			return err
		}
		if err := w.run(ctx, step); err != nil {
			return err
		}
	}
	if dir == "." {
		return nil
	}
	files, err := w.tree.files(ctx, dir)
	if err != nil {
		return err
	}
	for _, file := range files {
		if workflowHasExtension(file, workflowImportExtensions) && !strings.Contains("/"+file+"/", "/node_modules/") {
			if err := w.script(ctx, file); err != nil {
				return err
			}
		}
	}
	return nil
}

// enclosingPackage protects the nearest directory, the action's own or one
// above it, that holds a package.json, short of the repository root.
func (w *workflowTrust) enclosingPackage(ctx context.Context, dir string) error {
	for parent := dir; parent != "." && parent != "/"; parent = path.Dir(parent) {
		if _, found, err := w.readCounted(ctx, path.Join(parent, "package.json")); err != nil || found {
			if found {
				w.paths[parent] = true
				w.packages[parent] = true
			}
			return err
		}
	}
	return nil
}

// pnpmLockfile is the root lockfile an install resolves workspace packages
// from.
const pnpmLockfile = "pnpm-lock.yaml"

// workspaceDependencies protects every workspace package a protected package
// depends on, transitively, as the lockfile resolves it.
func (w *workflowTrust) workspaceDependencies(ctx context.Context) error {
	if len(w.packages) == 0 {
		return nil
	}
	lockfile, found, err := w.readCounted(ctx, pnpmLockfile)
	if err != nil {
		return err
	}
	var lock struct {
		Importers map[string]map[string]yaml.Node `yaml:"importers"`
	}
	if found {
		if err := yaml.Unmarshal(lockfile, &lock); err != nil {
			return fmt.Errorf("%s does not parse: %w", pnpmLockfile, err)
		}
	}
	pending := make([]string, 0, len(w.packages))
	for dir := range w.packages {
		pending = append(pending, dir)
	}
	sort.Strings(pending)
	for len(pending) > 0 {
		dir := pending[0]
		pending = pending[1:]
		importer, ok := lock.Importers[dir]
		if !ok {
			if err := w.unresolvedWorkspaceDependency(ctx, dir); err != nil {
				return err
			}
			continue
		}
		for _, section := range []string{"dependencies", "devDependencies", "optionalDependencies"} {
			deps := importer[section]
			for i := 1; i < len(deps.Content); i += 2 {
				version := deps.Content[i]
				if version.Kind == yaml.MappingNode {
					var entry struct {
						Version string `yaml:"version"`
					}
					if err := version.Decode(&entry); err != nil {
						return fmt.Errorf("%s importer %s does not parse: %w", pnpmLockfile, dir, err)
					}
					version = &yaml.Node{Kind: yaml.ScalarNode, Value: entry.Version}
				}
				// link: is relative to the importer; file: (an injected
				// workspace package) to the lockfile's directory.
				var target string
				if link, ok := strings.CutPrefix(version.Value, "link:"); ok {
					target = path.Join(dir, link)
				} else if file, ok := strings.CutPrefix(version.Value, "file:"); ok && !workflowTarball(file) {
					target = path.Clean(file)
				} else {
					continue
				}
				if target == "." || target == ".." || strings.HasPrefix(target, "../") || path.IsAbs(target) || w.packages[target] {
					continue
				}
				w.packages[target] = true
				w.paths[target] = true
				pending = append(pending, target)
			}
		}
	}
	return nil
}

// workflowTarball reports whether a file: dependency names an archive rather
// than a directory.
func workflowTarball(file string) bool {
	return strings.HasSuffix(file, ".tgz") || strings.HasSuffix(file, ".tar.gz") || strings.HasSuffix(file, ".tar")
}

// unresolvedWorkspaceDependency refuses a package whose manifest names a
// `workspace:`, `link:` or `file:` dependency that no lockfile importer
// resolves: the packages
// it runs cannot be derived, so the list would be incomplete.
func (w *workflowTrust) unresolvedWorkspaceDependency(ctx context.Context, dir string) error {
	content, found, err := w.readCounted(ctx, path.Join(dir, "package.json"))
	if err != nil || !found {
		return err
	}
	var manifest map[string]any
	if err := json.Unmarshal(content, &manifest); err != nil {
		return fmt.Errorf("%s/package.json does not parse: %w", dir, err)
	}
	for _, section := range []string{"dependencies", "devDependencies", "optionalDependencies", "peerDependencies"} {
		deps, _ := manifest[section].(map[string]any)
		for name, spec := range deps {
			if text, _ := spec.(string); strings.HasPrefix(text, "workspace:") || strings.HasPrefix(text, "link:") || strings.HasPrefix(text, "file:") {
				return fmt.Errorf("%s/package.json depends on %s through the workspace, and no %s importer resolves it", dir, name, pnpmLockfile)
			}
		}
	}
	return nil
}

func (w *workflowTrust) actionManifest(ctx context.Context, dir string) ([]byte, bool, error) {
	for _, name := range []string{"action.yml", "action.yaml"} {
		content, found, err := w.readCounted(ctx, path.Join(dir, name))
		if err != nil || found {
			return content, found, err
		}
	}
	return nil, false, nil
}

// run protects the script files a run step names that exist.
func (w *workflowTrust) run(ctx context.Context, step workflowStep) error {
	base := strings.Trim(strings.TrimSpace(workflowWorkspacePrefix.ReplaceAllString(strings.TrimSpace(step.WorkingDirectory)+"/", "")), "/")
	if base == "" || strings.Contains(base, "$") {
		base = "."
	}
	script := workflowWorkspacePrefix.ReplaceAllString(step.Run, "")
	for _, token := range workflowRunSeparators.Split(script, -1) {
		if !workflowHasExtension(token, workflowScriptExtensions) || strings.ContainsAny(token, "${}*?~") {
			continue
		}
		file := path.Join(base, token)
		if path.IsAbs(file) || file == ".." || strings.HasPrefix(file, "../") {
			continue
		}
		if _, found, err := w.readCounted(ctx, file); err != nil {
			return err
		} else if found {
			if err := w.script(ctx, file); err != nil {
				return err
			}
		}
	}
	return nil
}

// script protects one script file and, for JavaScript and TypeScript, the
// files it imports by a relative specifier, transitively.
func (w *workflowTrust) script(ctx context.Context, file string) error {
	if w.scripts[file] {
		return nil
	}
	w.scripts[file] = true
	w.paths[file] = true
	if !workflowHasExtension(file, workflowImportExtensions) {
		return nil
	}
	content, found, err := w.readCounted(ctx, file)
	if err != nil || !found {
		return err
	}
	for _, match := range workflowRelativeImport.FindAllSubmatch(content, -1) {
		target := path.Join(path.Dir(file), string(match[1]))
		if target == ".." || strings.HasPrefix(target, "../") {
			continue
		}
		resolved, err := w.resolveImport(ctx, target)
		if err != nil {
			return err
		}
		if resolved != "" {
			if err := w.script(ctx, resolved); err != nil {
				return err
			}
		}
	}
	return nil
}

// resolveImport finds the file a relative import names, as the TypeScript
// and Node resolvers would: exact, a .js specifier's .ts source, an added
// extension, or a directory index.
func (w *workflowTrust) resolveImport(ctx context.Context, target string) (string, error) {
	candidates := []string{target}
	if ext := path.Ext(target); ext == ".js" || ext == ".mjs" || ext == ".cjs" {
		candidates = append(candidates, strings.TrimSuffix(target, ext)+strings.Replace(ext, "j", "t", 1))
	}
	for _, ext := range workflowImportExtensions {
		candidates = append(candidates, target+ext)
	}
	for _, ext := range workflowImportExtensions {
		candidates = append(candidates, target+"/index"+ext)
	}
	for _, candidate := range candidates {
		if w.scripts[candidate] {
			return candidate, nil
		}
		if !workflowHasExtension(candidate, workflowImportExtensions) {
			continue
		}
		if _, found, err := w.readCounted(ctx, candidate); err != nil || found {
			return candidate, err
		}
	}
	return "", nil
}

func (w *workflowTrust) readCounted(ctx context.Context, file string) ([]byte, bool, error) {
	w.reads++
	if w.reads > workflowTrustReadLimit {
		return nil, false, errors.New("the workflows' trusted code is too large to derive protected paths from")
	}
	return w.tree.read(ctx, file)
}

func workflowHasExtension(file string, extensions []string) bool {
	ext := path.Ext(file)
	for _, candidate := range extensions {
		if ext == candidate {
			return true
		}
	}
	return false
}
