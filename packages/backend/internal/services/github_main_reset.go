package services

import (
	"context"
	"fmt"
	"net/http"
	"os"
)

// GitHubMainResetIntent is persisted by the journal before the mirror write.
// ID is the stored attention ID, not an ID chosen by a reset caller.
type GitHubMainResetIntent struct {
	RepositoryID int64  `json:"repository_id"`
	ID           string `json:"id"`
	Old          string `json:"old"`
	New          string `json:"new"`
	Settled      bool   `json:"settled,omitempty"`
}

// GitHubMainSerialization is the stack's shared pull/reset/merge boundary.
// WithRepository retains the operation claim through callback settlement.
// Pending returns persisted intents at boot, including writes whose reply was lost.
// Providers must refuse until durable rebases and machine-only main-moved
// delivery are composed. There is deliberately no in-memory production fallback.
type GitHubMainSerialization interface {
	WithRepository(context.Context, int64, func(GitHubMainFence) error) error
	Pending(context.Context) ([]GitHubMainResetIntent, error)
}

// GitHubMainFence is held under repository serialization. VerifyLocked is
// called inside repo-host's write lock and rereads attention and merge fences.
// Prepare binds the stored attention and tips, and persists intent before write.
// Settle atomically closes that attention, updates projections, records pending
// rebases and keyed main-moved intents; repeat settlement is idempotent.
// LeaveOpen retires an unwritten/third-tip intent while retaining attention.
type GitHubMainFence interface {
	OpenForcePush(context.Context, GitHubMainForcePush) error
	Prepare(context.Context, string, string, string) (GitHubMainResetIntent, error)
	VerifyLocked(context.Context, GitHubMainResetIntent) error
	VerifyPull(context.Context, string, string) error
	Settle(context.Context, GitHubMainResetIntent) error
	LeaveOpen(context.Context, GitHubMainResetIntent) error
}

func (s *GitHubMainPullService) SetMainSerialization(provider GitHubMainSerialization) {
	s.mainSerialization = provider
}

// ResetToGitHub is called only after owner-session catalog admission. It never
// writes GitHub: the transfer destination is the private loopback mirror bridge.
func (s *GitHubMainPullService) ResetToGitHub(ctx context.Context, repositoryID int64, old, new string) error {
	return s.ResetMainAttention(ctx, repositoryID, "", old, new)
}

func (s *GitHubMainPullService) ResetMainAttention(ctx context.Context, repositoryID int64, id, old, new string) error {
	if !s.install || s.mainSerialization == nil || s.host == nil || !repositorySourceSHA.MatchString(old) || !repositorySourceSHA.MatchString(new) || old == new {
		return githubSyncUnavailable()
	}
	return s.mainSerialization.WithRepository(ctx, repositoryID, func(fence GitHubMainFence) error {
		if fence == nil {
			return githubSyncUnavailable()
		}
		intent, err := fence.Prepare(ctx, id, old, new)
		if err != nil {
			return err
		}
		if intent.RepositoryID != repositoryID || intent.ID == "" || (id != "" && intent.ID != id) || intent.Old != old || intent.New != new {
			return githubSyncUnavailable()
		}
		return s.resetPrepared(ctx, fence, intent)
	})
}

func (s *GitHubMainPullService) resetPrepared(ctx context.Context, fence GitHubMainFence, intent GitHubMainResetIntent) error {
	if intent.Settled {
		return nil
	}
	repository, err := s.store.GetRepoByID(ctx, intent.RepositoryID)
	if err != nil {
		return err
	}
	owner, err := repositoryOwnerName(ctx, s.store, repository)
	if err != nil {
		return err
	}
	branch := repository.DefaultBookmark
	if branch == "" {
		branch = "main"
	}
	current, err := s.bookmarkCommit(ctx, owner, repository.Name, branch)
	if err != nil {
		return err
	}
	if current == intent.New {
		return fence.Settle(ctx, intent)
	}
	if current != intent.Old {
		if err := fence.LeaveOpen(ctx, intent); err != nil {
			return err
		}
		return staleMainReset()
	}
	githubOwner, githubRepo, err := resolveGitHubDestination(ctx, s.store, s.connections, repository.UserID.Int64, repository.ID, owner, repository.Name)
	if err != nil {
		return err
	}
	token, err := s.readToken(ctx, repository, githubOwner, githubRepo)
	if err != nil {
		return err
	}
	upstream, err := gitMirrorURL(s.gitHubGitBaseURL(), token, githubOwner, githubRepo)
	if err != nil {
		return err
	}
	verifyRepository := RepositoryStillAt(s.store, repository.ID, owner, repository.Name)
	ref := "refs/heads/" + branch
	verificationFailures := make(chan error, 1)
	verify := func(ctx context.Context) error {
		refuse := func(err error) error {
			select {
			case verificationFailures <- err:
			default:
			}
			return err
		}
		if err := verifyRepository(ctx); err != nil {
			return refuse(err)
		}
		if err := fence.VerifyLocked(ctx, intent); err != nil {
			return refuse(err)
		}
		// The remote can move after fetch. Reread its bound tip immediately
		// before the expected-old write, inside repo-host's write lock.
		refs, err := s.lsRemote(ctx, upstream, ref, "refs/heads/smithers/*")
		if err != nil {
			return refuse(fmt.Errorf("verify GitHub main: %s", sanitizeMirrorError(err, upstream)))
		}
		if refs[ref] != intent.New {
			return refuse(staleMainReset())
		}
		return nil
	}
	bridge, err := startGitHubMainPullBridge(ctx, s.host, owner, repository.Name, gitHubMainPullUpdate{repositoryID: repository.ID, ref: ref, old: intent.Old, writer: s.mainWriter()}, verify)
	if err != nil {
		return err
	}
	defer bridge.Close()
	dir, err := os.MkdirTemp("", "smithers-main-reset-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	base, tip, err := s.git.Fetch(ctx, dir, bridge.URL(), upstream, ref)
	if err != nil {
		return fmt.Errorf("fetch reset: %s", sanitizeMirrorError(err, upstream, bridge.URL()))
	}
	if base != intent.Old || tip != intent.New {
		return staleMainReset()
	}
	resetter, ok := s.git.(interface {
		Reset(context.Context, string, string, string, string, string) error
	})
	if !ok {
		return githubSyncUnavailable()
	}
	bridge.allow(intent.New)
	if err := resetter.Reset(ctx, dir, bridge.URL(), intent.Old, intent.New, ref); err != nil {
		// Preserve a typed pre-write refusal rather than losing it in Git's
		// transport error. Ambiguous writes retain intent for recovery.
		select {
		case refused := <-verificationFailures:
			return refused
		default:
		}
		after, readErr := s.bookmarkCommit(ctx, owner, repository.Name, branch)
		if readErr == nil && after != intent.Old && after != intent.New {
			return staleMainReset()
		}
		return fmt.Errorf("reset mirror: %s", sanitizeMirrorError(err, upstream, bridge.URL()))
	}
	after, err := s.bookmarkCommit(ctx, owner, repository.Name, branch)
	if err != nil {
		return err
	}
	if after != intent.New {
		return fmt.Errorf("mirror did not reach reset tip")
	}
	return fence.Settle(ctx, intent)
}

// RecoverMainResets never retries a write. At old it keeps attention open; at
// new it settles once; at a third tip it preserves that tip and the attention.
func (s *GitHubMainPullService) RecoverMainResets(ctx context.Context) error {
	if !s.install || s.mainSerialization == nil || s.host == nil {
		return githubSyncUnavailable()
	}
	intents, err := s.mainSerialization.Pending(ctx)
	if err != nil {
		return err
	}
	for _, intent := range intents {
		if intent.RepositoryID <= 0 || intent.ID == "" || intent.Old == intent.New || !repositorySourceSHA.MatchString(intent.Old) || !repositorySourceSHA.MatchString(intent.New) {
			return githubSyncUnavailable()
		}
		err := s.mainSerialization.WithRepository(ctx, intent.RepositoryID, func(fence GitHubMainFence) error {
			if fence == nil {
				return githubSyncUnavailable()
			}
			repository, err := s.store.GetRepoByID(ctx, intent.RepositoryID)
			if err != nil {
				return err
			}
			owner, err := repositoryOwnerName(ctx, s.store, repository)
			if err != nil {
				return err
			}
			branch := repository.DefaultBookmark
			if branch == "" {
				branch = "main"
			}
			tip, err := s.bookmarkCommit(ctx, owner, repository.Name, branch)
			if err != nil {
				return err
			}
			if tip == intent.New {
				return fence.Settle(ctx, intent)
			}
			return fence.LeaveOpen(ctx, intent)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (g cliGitHubMainPullGit) Reset(ctx context.Context, dir, mirrorURL, old, new, ref string) error {
	_, err := g.run(ctx, dir, "push", "--quiet", "--no-verify", "--force-with-lease="+ref+":"+old, mirrorURL, new+":"+ref)
	return err
}

func staleMainReset() error {
	return &TodoControlError{Status: http.StatusConflict, Class: "conflict", Code: "stale_attention", Message: "Main changed"}
}
