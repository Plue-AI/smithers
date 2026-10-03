package repohost

import (
	"context"
	"net/http"
	"net/url"
)

// IsAncestor compares immutable commits in the received Git object graph.
func (c *Client) IsAncestor(ctx context.Context, owner, repo, ancestor, descendant string) (bool, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return false, err
	}
	var out struct {
		IsAncestor bool `json:"is_ancestor"`
	}
	query := url.Values{"ancestor": {ancestor}, "descendant": {descendant}}
	err = c.doJSON(ctx, http.MethodGet, repoByIDEndpoint(baseURL, owner, repo)+"/commits/ancestry?"+query.Encode(), nil, http.StatusOK, &out)
	return out.IsAncestor, err
}
