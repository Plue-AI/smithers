package smitherscli

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	incur "github.com/smithersai/incur"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// `smithers repo push` (#1964) shares a local checkout with Smithers Cloud:
// it writes one commit, with its whole history, to the caller's own ref
// refs/smithers/users/<user id>/<name> on the Cloud git host, where a
// workspace can fetch it. The server lets only that user write that
// namespace (repohost.UserRef); the ref is not a bookmark, so it never moves
// main, starts no push hook, and is never mirrored to GitHub.
//
// Each user has at most 20 refs per repository, a push that writes one
// carries at most 256 MiB, and a ref expires 30 days after its last push
// (repo-host SMITHERS_USER_REF_*; #1968). Every push, even of an unchanged
// commit, restarts that ref's expiry and answers expires_at; --list shows
// them all.
//
// Auth is the product CLI login (`smithers auth login`, the keyring,
// ~/.config/smithers/auth.json, or SMITHERS_TOKEN). The token reaches git
// only as an Authorization header scoped to the API origin through
// GIT_CONFIG_* environment entries, never argv, with redirects off.

const defaultPushName = "head"

// localCheckout is the git directory holding a checkout's objects and the
// commit a push sends.
type localCheckout struct {
	gitDir      string
	commit      string
	uncommitted bool
}

// runGit runs git with extra environment entries and answers trimmed stdout.
var runGit = func(env []string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && strings.TrimSpace(string(exitErr.Stderr)) != "" {
			return "", errors.New(strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// resolveLocalCheckout finds the commit to push: in a jj checkout `@-` (the
// committed work) or `@` with workingCopy (jj snapshots uncommitted edits
// into it); in a plain git checkout HEAD.
func resolveLocalCheckout(workingCopy bool) (localCheckout, error) {
	if _, err := runJj([]string{"root"}); err == nil {
		gitDir, err := runJj([]string{"git", "root"})
		if err != nil {
			return localCheckout{}, err
		}
		revision := "@-"
		if workingCopy {
			revision = "@"
		}
		out, err := runJj([]string{"log", "-r", revision, "--no-graph", "-T", `commit_id ++ "\n"`})
		if err != nil {
			return localCheckout{}, err
		}
		commits := nonEmptyLines(out)
		if len(commits) != 1 {
			return localCheckout{}, fmt.Errorf("%s names %d commits; push exactly one", revision, len(commits))
		}
		// jj's root commit is all zeros, which git reads as a deletion.
		if strings.Trim(commits[0], "0") == "" {
			return localCheckout{}, fmt.Errorf("%s is the root commit: commit work first or pass --working-copy", revision)
		}
		return localCheckout{gitDir: strings.TrimSpace(gitDir), commit: strings.TrimSpace(commits[0])}, nil
	}
	if workingCopy {
		return localCheckout{}, errors.New("--working-copy needs a jj checkout; commit the changes and push HEAD")
	}
	gitDir, err := runGit(nil, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return localCheckout{}, fmt.Errorf("not a jj or git checkout: %w", err)
	}
	commit, err := runGit(nil, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return localCheckout{}, fmt.Errorf("HEAD has no commit to push: %w", err)
	}
	status, err := runGit(nil, "status", "--porcelain")
	if err != nil {
		return localCheckout{}, err
	}
	return localCheckout{gitDir: gitDir, commit: commit, uncommitted: status != ""}, nil
}

// resolvePushRepository names the Cloud repository: -R, a Smithers remote,
// else the GitHub origin (git's, or jj's in a checkout with no .git), whose
// Cloud mirror has the same owner/name.
func resolvePushRepository(override string) (string, string, error) {
	owner, repo, err := ResolveRepoRef(override)
	if err == nil || strings.TrimSpace(override) != "" {
		return owner, repo, err
	}
	urls := []string{}
	if url, remoteErr := runGit(nil, "remote", "get-url", "origin"); remoteErr == nil {
		urls = append(urls, url)
	}
	if listed, remoteErr := runJj([]string{"git", "remote", "list"}); remoteErr == nil {
		for _, line := range nonEmptyLines(listed) {
			if fields := strings.Fields(line); len(fields) == 2 && fields[0] == "origin" {
				urls = append(urls, fields[1])
			}
		}
	}
	for _, url := range urls {
		if owner, repo, ok := parseRepoFromURL(url, "github.com"); ok {
			return owner, repo, nil
		}
	}
	return "", "", err
}

// pushAuthEnv scopes the bearer to the API origin and keeps git from
// following a redirect with it or prompting for anything.
func pushAuthEnv(apiURL, token string) []string {
	origin := strings.TrimRight(apiURL, "/") + "/"
	return []string{
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=http." + origin + ".extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Bearer " + strings.TrimSpace(token),
		"GIT_CONFIG_KEY_1=http.followRedirects",
		"GIT_CONFIG_VALUE_1=false",
	}
}

func pushUserID() (int64, error) {
	user, err := APIRequest("GET", "/api/user", nil, nil)
	if err != nil {
		return 0, err
	}
	id, ok := objectValue(user)["id"].(float64)
	if !ok || id <= 0 || id != float64(int64(id)) {
		return 0, errors.New("the Smithers API answered no user id")
	}
	return int64(id), nil
}

func runRepoPush(ctx *incur.CommandContext) (any, error) {
	name := stringValue(ctx.Options["name"])
	if name == "" {
		name = defaultPushName
	}
	if _, ok := repohost.UserIDFromRef(repohost.UserRef(1, name)); !ok {
		return nil, fmt.Errorf("--name %q is not a valid ref name of [A-Za-z0-9._-] segments separated by /", name)
	}
	owner, repo, err := resolvePushRepository(stringValue(ctx.Options["repo"]))
	if err != nil {
		return nil, err
	}
	// Your refs in this repository, when each expires, and the limits.
	if ctx.Options["list"] == true {
		return APIRequest("GET", "/api/repos/"+owner+"/"+repo+"/user-refs", nil, nil)
	}
	token, err := RequireAuthToken(nil)
	if err != nil {
		return nil, err
	}
	deleting := ctx.Options["delete"] == true
	workingCopy := ctx.Options["working-copy"] == true

	var checkout localCheckout
	if deleting {
		gitDir, gitErr := runGit(nil, "rev-parse", "--absolute-git-dir")
		if gitErr != nil {
			if gitDir, gitErr = runJj([]string{"git", "root"}); gitErr != nil {
				return nil, gitErr
			}
		}
		checkout.gitDir = strings.TrimSpace(gitDir)
	} else if checkout, err = resolveLocalCheckout(workingCopy); err != nil {
		return nil, err
	}
	// Other readers do not see refs/smithers/users/<id>/, but it is not
	// secret: its objects share a public repository's object store, and jj
	// snapshots untracked files into @.
	if workingCopy {
		repository, err := APIRequest("GET", "/api/repos/"+owner+"/"+repo, nil, nil)
		if err != nil {
			return nil, err
		}
		if public, _ := objectValue(repository)["is_public"].(bool); public {
			return nil, fmt.Errorf("--working-copy is refused on public %s/%s: everyone can read pushed refs there", owner, repo)
		}
	}
	userID, err := pushUserID()
	if err != nil {
		return nil, err
	}
	ref := repohost.UserRef(userID, name)
	remote := strings.TrimRight(token.APIURL, "/") + "/" + owner + "/" + repo + ".git"
	env := pushAuthEnv(token.APIURL, token.Token)

	advertised, err := runGit(env, "--git-dir", checkout.gitDir, "ls-remote", remote, ref)
	if err != nil {
		return nil, err
	}
	previous := ""
	for _, line := range nonEmptyLines(advertised) {
		if fields := strings.Fields(line); len(fields) == 2 && fields[1] == ref {
			previous = fields[0]
		}
	}
	result := map[string]any{
		"repository": owner + "/" + repo,
		"ref":        ref,
		"previous":   nullableString(previous),
	}
	if deleting {
		result["deleted"] = previous != ""
		if previous == "" {
			return result, nil
		}
		_, err = runGit(env, "--git-dir", checkout.gitDir, "push", "--force-with-lease="+ref+":"+previous, remote, ":"+ref)
		return result, err
	}
	result["commit"] = checkout.commit
	result["uncommitted"] = checkout.uncommitted
	result["updated"] = previous != checkout.commit
	if previous != checkout.commit {
		if _, err := runGit(env, "--git-dir", checkout.gitDir, "push", "--force-with-lease="+ref+":"+previous, remote, checkout.commit+":"+ref); err != nil {
			return result, err
		}
	}
	// A pushed ref expires (#1968). An unchanged commit sends git nothing,
	// so every push, even a no-op, restarts the expiry here.
	renewed, err := APIRequest("POST", "/api/repos/"+owner+"/"+repo+"/user-refs/renew", map[string]any{"name": name}, nil)
	if err != nil {
		return result, fmt.Errorf("pushed %s, but could not renew its expiry: %w", ref, err)
	}
	result["expires_at"] = objectValue(renewed)["expires_at"]
	return result, nil
}

func repoPushCommand() *incur.CommandDef {
	return &incur.CommandDef{
		Description: "Push this checkout to your own ref on Smithers Cloud for a workspace to fetch",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":         stringSchema("Repository (OWNER/REPO); detected from the remote when omitted"),
			"name":         {Type: "string", Description: "Ref name under refs/smithers/users/<your id>/", Default: defaultPushName},
			"working-copy": booleanSchema("jj: push @ with uncommitted edits instead of @-", false),
			"delete":       booleanSchema("Delete the ref instead", false),
			"list":         booleanSchema("List your refs in this repository with their expiry instead", false),
		}),
		Handler: runRepoPush,
	}
}
