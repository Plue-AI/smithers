package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// InstallContext reads repository data for the packaged recall selector. It
// neither ranks candidates nor executes repository code. All files in a read
// use one immutable repository-store revision; it has no machine IO provider.
type InstallContext struct {
	Source   InstallSource
	Wiki     *WikiService
	Branches interface {
		PresenceBranch(context.Context, string, int64, int64) (db.Workspace, error)
	}
}

// Read supplies the repository-owned portion of ContextPreflightInput. A
// missing item snapshot contributes no files; source/authority failures refuse.
func (s InstallContext) Read(ctx context.Context, credential middleware.Credential, userID, repositoryID int64, branch string) (json.RawMessage, error) {
	if s.Source.Pool == nil || s.Source.Repos == nil || s.Source.Members == nil || s.Wiki == nil {
		return nil, ErrSourceNotReady
	}
	owner, repository, member, err := s.Source.readable(ctx, credential, userID, repositoryID)
	if err != nil {
		return nil, err
	}
	state, revision := "main", ""
	if branch == "main" {
		revision, err = s.Source.Repos.resolveContentsCommit(ctx, owner, repository.Name, repository.DefaultBookmark)
		if err != nil {
			return nil, err
		}
	} else {
		if s.Branches == nil {
			return nil, ErrSourceNotReady
		}
		row, e := s.Branches.PresenceBranch(ctx, branch, repository.ID, userID)
		if e != nil {
			return nil, e
		}
		state = branchMachineState(row)
		// A TODO's accepted candidate is separate from its workspace head.
		// Never substitute that head, source_commit or main when it is missing.
		revision, err = s.branchRevision(ctx, row, repository.ID)
		if err != nil {
			return nil, err
		}
		if revision != "" && !immutableCommitSHA(revision) {
			return nil, ErrSourceNotReady
		}
	}
	candidates := []map[string]any{}
	if revision != "" {
		files, e := s.files(ctx, owner, repository, member, revision)
		if e != nil {
			return nil, e
		}
		candidates = append(candidates, files...)
	}
	// A conversation is shared. Even its author's readable private wiki is not
	// an eligible source; discard any private scope inherited from a caller.
	shared, _ := WithWikiVisibility(ctx, "public")
	index, err := s.Wiki.GetWikiIndex(shared, member, owner, repository.Name)
	if err != nil {
		return nil, err
	}
	for _, entry := range index.Pages {
		page, e := s.Wiki.GetWikiPage(shared, member, owner, repository.Name, entry.Slug)
		if e != nil {
			return nil, e
		}
		if page.Attachment != nil {
			continue
		}
		candidates = append(candidates, map[string]any{"item": map[string]string{"kind": "page", "label": page.Title, "ref": page.Slug, "revision": strconv.FormatInt(page.Revision, 10)}, "text": page.Body})
	}
	todos, err := s.todos(ctx, repository.ID)
	if err != nil {
		return nil, err
	}
	candidates = append(candidates, todos...)
	budget := 24000
	setting, err := db.New(s.Source.Pool).GetInstallSetting(ctx, "context.preflight")
	if err == nil {
		var configured struct {
			TokenBudget *int `json:"tokenBudget"`
		}
		if json.Unmarshal(setting.Value, &configured) != nil || configured.TokenBudget == nil || *configured.TokenBudget < 0 || *configured.TokenBudget > 1000000 {
			return nil, ErrSourceNotReady
		}
		budget = *configured.TokenBudget
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// The credential/member and repository permission may change during IO.
	if _, _, _, err = s.Source.readable(ctx, credential, userID, repository.ID); err != nil {
		return nil, err
	}
	if branch != "main" {
		row, e := s.Branches.PresenceBranch(ctx, branch, repository.ID, userID)
		if e != nil {
			return nil, e
		}
		current, e := s.branchRevision(ctx, row, repository.ID)
		if e != nil {
			return nil, e
		}
		if current != revision {
			return nil, ErrSourceNotReady
		}
	}
	return json.Marshal(map[string]any{"state": state, "candidates": candidates, "tokenBudget": budget})
}

// branchRevision reuses the stack's accepted candidate for S1 item branches.
// Candidate verification and immutable object reads are the same prerequisites
// used by TODOBranchDiff. A missing candidate contributes no file context.
func (s InstallContext) branchRevision(ctx context.Context, row db.Workspace, repositoryID int64) (string, error) {
	if branchKind(row.TargetBookmark) != "item" {
		return row.HeadCommitID, nil
	}
	q := db.New(s.Source.Pool)
	lane, err := q.GetMythicalLane(ctx, row.ID)
	if err != nil {
		return "", err
	}
	if lane.RepositoryID != repositoryID || lane.RetiredAt.Valid {
		return "", ErrSourceForbidden
	}
	item, err := q.GetMythicalItem(ctx, lane.ItemID)
	if err != nil {
		return "", err
	}
	if item.RepositoryID != repositoryID || item.WorkspaceID != row.ID || !mythicalTodo(item) || !item.Number.Valid {
		return "", ErrSourceForbidden
	}
	if !item.CandidateVerified || item.CandidateHead == "" {
		return "", nil
	}
	if !immutableCommitSHA(item.CandidateHead) || !immutableCommitSHA(item.CandidateBase) {
		return "", ErrSourceNotReady
	}
	return item.CandidateHead, nil
}

func (s InstallContext) files(ctx context.Context, owner string, repository db.Repository, member *db.User, revision string) ([]map[string]any, error) {
	host, ok := s.Source.Repos.repoHost.(repositoryPolicyHost)
	if !ok {
		return nil, ErrSourceNotReady
	}
	candidates := []map[string]any{}
	directories := []string{""}
	seen := map[string]bool{}
	for len(directories) > 0 {
		directory := directories[0]
		directories = directories[1:]
		after := ""
		for {
			entries, next, pin, err := s.Source.Repos.ListRepoContentsPage(ctx, member, owner, repository.Name, revision, directory, after, sourceListLimit)
			if err != nil {
				return nil, err
			}
			if pin != revision {
				return nil, ErrSourceNotReady
			}
			for _, entry := range entries {
				parent := path.Dir(entry.Path)
				if parent == "." {
					parent = ""
				}
				if ValidateRepositoryPath(entry.Path) != nil || parent != directory || seen[entry.Path] {
					return nil, ErrSourcePathRefused
				}
				seen[entry.Path] = true
				if entry.Type == "dir" {
					directories = append(directories, entry.Path)
					continue
				}
				if entry.Type != "file" || entry.RegularFile != nil && !*entry.RegularFile {
					continue
				}
				file, err := host.GetFileAtCommit(ctx, owner, repository.Name, revision, entry.Path)
				// Only an explicit absent-file receipt may be omitted. Generic storage
				// or revision 404s must refuse the context read.
				if repohost.IsFileNotFound(err) {
					continue
				}
				if err != nil {
					return nil, err
				}
				// Oversized and binary blobs have no text representation in the existing
				// source reader. Never decode them or dereference their targets on the host.
				if file.TooLarge || file.Encoding == "base64" || strings.ContainsRune(file.Content, 0) {
					continue
				}
				candidates = append(candidates, map[string]any{"item": map[string]string{"kind": "file", "label": path.Base(entry.Path), "ref": entry.Path, "revision": revision}, "text": file.Content})
			}
			if next == "" {
				break
			}
			if next <= after {
				return nil, ErrSourceNotReady
			}
			after = next
		}
	}
	return candidates, nil
}

// A numbered, confirmed TODO is shared repository data. Read only its public
// prompt revisions and run summary, never Drafts, pending Confirm payloads,
// run arguments, credentials, private journals or unapproved contributor issues.
// This is uncapped: the TODO card's display page is not a context policy.
func (s InstallContext) todos(ctx context.Context, repositoryID int64) ([]map[string]any, error) {
	rows, err := s.Source.Pool.Query(ctx, `SELECT number,title,revisions,state,version,request_run_id,summary,request_outcome
 FROM mythical_items WHERE repository_id=$1 AND source='todo' AND number IS NOT NULL ORDER BY number`, repositoryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []map[string]any{}
	for rows.Next() {
		var number, version int64
		var title, state, run, summary, outcome string
		var revisions json.RawMessage
		if err = rows.Scan(&number, &title, &revisions, &state, &version, &run, &summary, &outcome); err != nil {
			return nil, err
		}
		text, err := json.Marshal(map[string]any{"title": title, "state": state, "prompt_revisions": revisions})
		if err != nil {
			return nil, err
		}
		ref := fmt.Sprintf("T%d", number)
		candidates = append(candidates, map[string]any{"item": map[string]string{"kind": "todo", "label": ref + " " + title, "ref": ref, "revision": strconv.FormatInt(version, 10)}, "text": string(text)})
		if run != "" {
			text, err = json.Marshal(map[string]string{"todo": ref, "state": outcome, "summary": summary})
			if err != nil {
				return nil, err
			}
			candidates = append(candidates, map[string]any{"item": map[string]string{"kind": "run", "label": ref + " run", "ref": run, "revision": strconv.FormatInt(version, 10)}, "text": string(text)})
		}
	}
	return candidates, rows.Err()
}
