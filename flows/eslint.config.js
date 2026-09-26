import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import tseslint from "typescript-eslint"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../eslint.invariants.js"

export default tseslint.config(
  {
    ignores: ["**/dist", "**/build", "**/coverage", "**/fixtures/**", "test/**", "**/*.test.ts"]
  },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["./tsconfig.json"]
        }
      }
    },
    plugins: {
      unicorn
    },
    rules: {
      "@typescript-eslint/array-type": ["error", { default: "generic", readonly: "generic" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-constraint": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-useless-empty-export": "error",
      "import/no-duplicates": "error",
      "import/no-empty-named-blocks": "error",
      "import/no-self-import": "error",
      "no-await-in-loop": "off",
      "no-console": "error",
      "no-fallthrough": "off",
      "no-shadow": "off",
      "no-unneeded-ternary": "error",
      "no-unused-vars": "off",
      "no-useless-concat": "error",
      "no-useless-constructor": "error",
      "no-var": "error",
      "object-shorthand": "off",
      "require-yield": "off",
      "unicorn/no-abusive-eslint-disable": "error",
      "unicorn/no-accessor-recursion": "error",
      "unicorn/prefer-array-flat-map": "error"
    }
  },
  {
    // A flow reads its own default export back through a self-import.
    files: ["**/flow.ts"],
    rules: { "import/no-self-import": "off" }
  },
  {
    // Process entry points print to the terminal.
    files: ["invoke/serve.ts", "librarian/serve.ts", "wiki/main.ts"],
    rules: { "no-console": "off" }
  },
  // The shared invariant scope names `src/`; flows have no `src/`.
  ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
    .map((config) => ({ ...config, files: ["**/*.ts"] }))
)
