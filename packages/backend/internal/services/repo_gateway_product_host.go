package services

import (
	"context"
	"strings"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	repoGatewayProductHostPath        = "/usr/local/lib/smithers/product-gateway.mjs"
	repoGatewayProductHostB64Path     = "/workspace/.product-gateway.mjs.gz.b64"
	repoGatewayProductHostMarker      = "smithers-product-gateway-v1"
	repoGatewayProductHostVersionPath = "/usr/local/lib/smithers/product-gateway.version"
)

// The complete, lockfile-resolved host ships in the API release. Never install
// npm packages inside a guest: a top-level version does not pin its transitive
// dependencies, and the retired 0.33 engine cannot serve the product's 1.0 RPC.
func (s *RepoGatewayService) addProductGatewayHost(files map[string]sandbox.SandboxFile) error {
	if !addWorkspaceExecutable(files, s.productHostPath, repoGatewayProductHostB64Path, "", "product gateway") {
		return pkgerrors.Internal("product gateway artifact is missing from this API release")
	}
	return nil
}

func (s *RepoGatewayService) installProductGatewayHost(ctx context.Context, vmID string) error {
	command := strings.Join([]string{
		"set -euo pipefail",
		"install -d /usr/local/lib/smithers /workspace/.tmp /workspace/.cache",
		"base64 -d " + shellQuote(repoGatewayProductHostB64Path) + " | gzip -d > " + shellQuote(repoGatewayProductHostPath),
		"chmod 755 " + shellQuote(repoGatewayProductHostPath),
		"/usr/local/bin/bun " + shellQuote(repoGatewayProductHostPath) + " --help >/dev/null",
		"printf '%s\\n' " + shellQuote(repoGatewayProductHostMarker) + " > " + shellQuote(repoGatewayProductHostVersionPath),
		"rm -f " + shellQuote(repoGatewayProductHostB64Path),
	}, "\n")
	return s.execGatewayCommand(ctx, vmID, command, "install product gateway host", time.Minute)
}

func (s *RepoGatewayService) gatewayHasProductHost(ctx context.Context, vmID string) (bool, error) {
	timeoutMS := int64((30 * time.Second) / time.Millisecond)
	resp, err := s.sandbox.Execute(ctx, vmID, sandbox.ExecRequest{
		Command:   "test -s " + shellQuote(repoGatewayProductHostPath) + " && grep -qx " + shellQuote(repoGatewayProductHostMarker) + " " + shellQuote(repoGatewayProductHostVersionPath),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return false, err
	}
	return resp.StatusCode != nil && *resp.StatusCode == 0, nil
}

// productGatewayEnv returns the gateway service environment and the model
// seat credentials its egress proxy must hold; the environment carries only
// their placeholders.
func (s *RepoGatewayService) productGatewayEnv(ctx context.Context, token, gatewayID string, input RepoGatewayConnectionInput) (map[string]string, []sandbox.EgressProxySecret) {
	env := s.buildGatewayEnv(token)
	secrets := s.bindGatewayModelSeats(ctx, env, gatewayID, input)
	env["SMITHERS_GATEWAY_ID"] = gatewayID
	env["SMITHERS_REPO"] = input.RepoOwner + "/" + input.RepoName
	return env, secrets
}
