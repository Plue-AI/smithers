package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Exercise the shipped command from a repository-shaped fixture, including
// generation and freshness checks rather than only its import recognizer.
func TestCheckConsumerProvenance(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "generate")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build generator: %v\n%s", err, output)
	}
	const bridge = "packages/smithers/agent/model/src/Pricing.ts"
	consumers := []string{"evals/swebench/prices.ts"}
	const public = `import { table as PRICES } from "@smthrs/model/Pricing";`
	const generated = `import { type ModelPrice, modelPrices } from "./internal/prices.generated.ts"`
	cases := []struct {
		name, source string
		valid        bool
	}{
		{"named", public, true},
		{"multiline", "import {\n table as PRICES,\n type Rates\n} from '@smthrs/model/Pricing'", true},
		{"namespace", `import * as Pricing from "@smthrs/model/Pricing"`, true},
		{"truncated double quote", `import { table } from "`, false},
		{"unterminated module", `import { table } from "@smthrs/model/PricingX`, false},
		{"truncated single quote", "import { table } from '", false},
		{"missing", "export const PRICES = {}", false},
		{"wrong private path", `import { modelPrices } from "./internal/prices.generated.ts"`, false},
		{"type only", `import type { table } from "@smthrs/model/Pricing"`, false},
		{"type specifier", `import { type table } from "@smthrs/model/Pricing"`, false},
		{"unrelated value", `import { type table, Rates } from "@smthrs/model/Pricing"`, false},
		{"line comment", "// " + public, false},
		{"block comment", "/* " + public + " */", false},
		{"string", "const text = `" + public + "`", false},
	}
	write := func(t *testing.T, root, path, content string) {
		t.Helper()
		target := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	fixture := func(t *testing.T) string {
		t.Helper()
		root := t.TempDir()
		write(t, root, "packages/smithers/agent/model/src/internal/prices.generated.ts", "")
		write(t, root, "apps/site/src/content/docs/docs/model-prices.mdx", "")
		write(t, root, bridge, generated)
		for _, path := range consumers {
			write(t, root, path, public)
		}
		cmd := exec.Command(binary)
		cmd.Dir = root
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("generate fixture: %v\n%s", err, output)
		}
		return root
	}
	check := func(t *testing.T, root, path string, valid bool) {
		t.Helper()
		cmd := exec.Command(binary, "-check")
		cmd.Dir = root
		output, err := cmd.CombinedOutput()
		if valid {
			if err != nil {
				t.Fatalf("valid provenance rejected: %v\n%s", err, output)
			}
			return
		}
		if err == nil {
			t.Fatalf("invalid provenance accepted for %s", path)
		}
		if !strings.Contains(string(output), path) {
			t.Fatalf("failure must identify %s, got %s", path, output)
		}
	}
	for _, path := range consumers {
		relative, err := filepath.Rel(filepath.Dir(path), "packages/smithers/agent/model/src/internal/prices.generated.ts")
		if err != nil {
			t.Fatal(err)
		}
		t.Run(path+"/direct generated import", func(t *testing.T) {
			root := fixture(t)
			write(t, root, path, `import { modelPrices as PRICES } from "`+filepath.ToSlash(relative)+`"`)
			check(t, root, path, true)
		})
		for _, tc := range cases {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				root := fixture(t)
				write(t, root, path, tc.source)
				check(t, root, path, tc.valid)
			})
		}
	}
	for _, path := range append(append([]string{}, consumers...), bridge) {
		t.Run(path+"/absent file", func(t *testing.T) {
			root := fixture(t)
			if err := os.Remove(filepath.Join(root, path)); err != nil {
				t.Fatal(err)
			}
			check(t, root, path, false)
		})
	}
	for _, tc := range []struct {
		name, source string
		valid        bool
	}{
		{"generated import", generated, true},
		{"truncated double quote", `import { modelPrices } from "`, false},
		{"unterminated module", `import { modelPrices } from "./internal/prices.generated.tsX`, false},
		{"truncated single quote", "import { modelPrices } from '", false},
		{"public self import", public, false},
		{"aliased", `import { modelPrices as prices } from './internal/prices.generated.ts'`, true},
		{"missing", "export const table = {}", false},
		{"comment", "// " + generated, false},
		{"type only", `import type { modelPrices } from "./internal/prices.generated.ts"`, false},
		{"wrong module", `import { modelPrices } from "./prices.generated.ts"`, false},
	} {
		t.Run("bridge/"+tc.name, func(t *testing.T) {
			root := fixture(t)
			write(t, root, bridge, tc.source)
			check(t, root, bridge, tc.valid)
		})
	}
	t.Run("stale generated table", func(t *testing.T) {
		root := fixture(t)
		path := "packages/smithers/agent/model/src/internal/prices.generated.ts"
		write(t, root, path, "stale")
		check(t, root, path, false)
	})
	t.Run("stale generated documentation", func(t *testing.T) {
		root := fixture(t)
		path := "apps/site/src/content/docs/docs/model-prices.mdx"
		write(t, root, path, "stale")
		check(t, root, path, false)
	})
}
