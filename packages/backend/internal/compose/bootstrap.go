package compose

import (
	"encoding/json"
	"net/http"
	"runtime"
	"strings"

	"github.com/go-chi/cors"
)

// BuildVersion and BuildSHA are set by release builds. Plain local Go builds
// retain the development version and may leave the revision unset.
var BuildVersion = "dev"
var BuildSHA string

// appBootstrap describes only capabilities that this assembled process can
// actually serve. The browser reads it before making any authenticated call.
//
// Host is always "cloud": every origin this backend serves — hosted or
// single-owner self-host — is the same web app, and the differences travel as
// Capabilities and AuthFlow. The desktop shell is never named here; its own
// renderer relay appends the "native.shell" capability (apps/app/src/bun/
// NativeRendererServer.ts), so a web page can never be mistaken for the shell.
type appBootstrap struct {
	APIVersion   int      `json:"apiVersion"`
	Host         string   `json:"host"`
	Version      string   `json:"version"`
	BuildSHA     string   `json:"buildSha"`
	Capabilities []string `json:"capabilities"`
	AuthFlow     string   `json:"authFlow"`
	Sandbox      *struct {
		Platform string `json:"platform"`
		Mode     string `json:"mode"`
	} `json:"sandbox"`
}

type bootstrapFeatures struct {
	role             topology
	identity         bool
	redirectAuth     bool
	github           bool
	agent            bool
	modelTurn        bool
	recommend        bool
	workspace        bool
	terminal         bool
	billingBalance   bool
	billingOverview  bool
	billingPlans     bool
	billingPortal    bool
	billingCheckout  bool
	workspaceRuntime bool
	isolatedSandbox  bool
}

func newAppBootstrap(features bootstrapFeatures) appBootstrap {
	version, sha := buildIdentity()
	result := appBootstrap{APIVersion: 1, Host: "cloud", Version: version, BuildSHA: sha,
		Capabilities: make([]string, 0, 4), AuthFlow: "none"}
	if features.identity {
		result.Capabilities = append(result.Capabilities, "identity")
		if !features.role.hosted() {
			result.AuthFlow = "credentials"
		} else if features.redirectAuth {
			result.AuthFlow = "redirect"
		}
	}
	if features.agent {
		result.Capabilities = append(result.Capabilities, "agent")
	}
	if features.github {
		result.Capabilities = append(result.Capabilities, "github")
	}
	if features.modelTurn {
		result.Capabilities = append(result.Capabilities, "model.turn")
	}
	if features.recommend {
		// Selection is served by the same Jev handler as recommendations.
		result.Capabilities = append(result.Capabilities, "recommend", "commands.select")
	}
	if features.workspace {
		result.Capabilities = append(result.Capabilities, "cloud")
	}
	if features.terminal {
		result.Capabilities = append(result.Capabilities, "cloud.terminal")
	}
	if features.billingBalance {
		result.Capabilities = append(result.Capabilities, "billing.balance")
	}
	if features.billingOverview {
		result.Capabilities = append(result.Capabilities, "billing.overview")
	}
	if features.billingPlans {
		result.Capabilities = append(result.Capabilities, "billing.plans")
	}
	if features.billingPortal {
		result.Capabilities = append(result.Capabilities, "billing.portal")
	}
	if features.billingCheckout {
		result.Capabilities = append(result.Capabilities, "billing.checkout")
	}
	if features.workspaceRuntime || features.isolatedSandbox {
		mode := "trusted-only"
		if features.isolatedSandbox {
			mode = "enforced"
		}
		result.Sandbox = &struct {
			Platform string `json:"platform"`
			Mode     string `json:"mode"`
		}{Platform: runtime.GOOS, Mode: mode}
	}
	return result
}

func buildIdentity() (version, sha string) {
	sha = strings.TrimSpace(BuildSHA)
	if sha == "" {
		sha = "unknown"
	}
	return BuildVersion, sha
}

func withAppBootstrap(next http.Handler, bootstrap appBootstrap, corsOptions cors.Options) http.Handler {
	bootstrapHandler := cors.Handler(corsOptions)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "GET, HEAD")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodHead {
			return
		}
		_ = json.NewEncoder(w).Encode(bootstrap)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/bootstrap" {
			next.ServeHTTP(w, r)
			return
		}
		bootstrapHandler.ServeHTTP(w, r)
	})
}
