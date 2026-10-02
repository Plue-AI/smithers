package workspace

import (
	"context"
	"errors"
	"net/url"
	"strings"
)

// WorkspaceCodingBinding contains the backend's source-publication authority.
// Guest paths and the guest username belong to the runtime, never the caller.
// It carries no provider key or repository token.
type WorkspaceCodingBinding struct {
	ActorID        int64  `json:"actorId"`
	RepositoryID   int64  `json:"repositoryId"`
	RepositorySlug string `json:"repositorySlug"`
	APIBaseURL     string `json:"apiBaseUrl"`
	GitURL         string `json:"gitUrl"`
}

// WorkspaceCodingBindingInstaller installs only the fixed root-owned source
// binding in a sandboxed guest. It does not expose privileged shell execution.
type WorkspaceCodingBindingInstaller interface {
	InstallWorkspaceCodingBinding(context.Context, string, WorkspaceCodingBinding) error
}

func (binding WorkspaceCodingBinding) Validate() error {
	owner, repository, ok := strings.Cut(binding.RepositorySlug, "/")
	if binding.ActorID <= 0 || binding.RepositoryID <= 0 || !ok || !codingSlugPart(owner) || !codingSlugPart(repository) {
		return errors.New("workspace coding binding identity is invalid")
	}
	api, err := url.Parse(binding.APIBaseURL)
	if err != nil || !codingHTTPURL(api) || api.Path != "/api" {
		return errors.New("workspace coding binding API origin is invalid")
	}
	git, err := url.Parse(binding.GitURL)
	if err != nil || !codingHTTPURL(git) || git.Scheme != api.Scheme || git.Host != api.Host || git.Path != "/"+binding.RepositorySlug+".git" {
		return errors.New("workspace coding binding Git URL is invalid")
	}
	return nil
}

func codingSlugPart(part string) bool {
	return part != "" && part != "." && part != ".." && strings.TrimSpace(part) == part && !strings.ContainsAny(part, "/\\\x00\r\n")
}

func codingHTTPURL(value *url.URL) bool {
	return value != nil && (value.Scheme == "http" || value.Scheme == "https") && value.Host != "" && value.User == nil && value.RawQuery == "" && !value.ForceQuery && value.Fragment == ""
}
