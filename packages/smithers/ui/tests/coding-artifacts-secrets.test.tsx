/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentVariable, EnvironmentVariables } from "../src/artifacts/EnvironmentVariables";
import { SecretField } from "../src/artifacts/SecretField";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("SecretField", () => {
  test("while masked the secret string is not present anywhere in the DOM", async () => {
    await render(<SecretField value="super-secret-value" onCopy={() => {}} />);
    expect(container!.innerHTML).not.toContain("super-secret-value");
    expect(container!.querySelector(".sui-secret-mask")!.textContent).toBe("••••••••");
  });

  test("mask length is fixed and unrelated to the value length", async () => {
    await render(<SecretField value="ab" maskLength={12} onCopy={() => {}} />);
    expect(container!.querySelector(".sui-secret-mask")!.textContent).toBe("••••••••••••");
  });

  test("maskLength is normalized and capped at 64 bullets", async () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [Number.POSITIVE_INFINITY, 64],
      [1e9, 64],
      [Number.NaN, 8],
      [0, 8],
      [-5, 1],
      [2.7, 2],
      [8, 8],
    ];

    await render(<SecretField value="secret" maskLength={cases[0]![0]} onCopy={() => {}} />);
    for (const [maskLength, expectedLength] of cases) {
      const current = root!;
      await act(async () => current.render(<SecretField value="secret" maskLength={maskLength} onCopy={() => {}} />));
      expect(container!.querySelector(".sui-secret-mask")!.textContent).toHaveLength(expectedLength);
    }
  });

  test("reveal toggles via aria-pressed and reports through onRevealedChange", async () => {
    const changes: boolean[] = [];
    await render(<SecretField value="s3cr3t" onRevealedChange={(r) => changes.push(r)} onCopy={() => {}} />);
    const toggle = container!.querySelector('[data-slot="secret-field-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Reveal secret");
    await act(async () => toggle.click());
    expect(changes).toEqual([true]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide secret");
    expect(container!.querySelector(".sui-secret-value")!.textContent).toBe("s3cr3t");
  });

  test("controlled revealed wins over internal state", async () => {
    await render(<SecretField value="s3cr3t" revealed={false} onCopy={() => {}} />);
    const toggle = container!.querySelector('[data-slot="secret-field-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    // still masked: controlled prop governs
    expect(container!.innerHTML).not.toContain("s3cr3t");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("copy routes the value through onCopy WITHOUT revealing", async () => {
    const copied: string[] = [];
    await render(<SecretField value="super-secret-value" onCopy={(v) => copied.push(v)} />);
    const copy = container!.querySelector('[data-slot="secret-field-copy"]') as HTMLButtonElement;
    await act(async () => copy.click());
    expect(copied).toEqual(["super-secret-value"]);
    expect(container!.querySelector(".sui-secret-value")).toBeNull();
    expect(container!.innerHTML).not.toContain("super-secret-value");
  });

  test("label extends the accessible names", async () => {
    await render(<SecretField value="x" label="API_KEY" onCopy={() => {}} />);
    expect(container!.querySelector('[data-slot="secret-field-toggle"]')!.getAttribute("aria-label")).toBe(
      "Reveal secret API_KEY",
    );
    expect(container!.querySelector('[data-slot="secret-field-copy"]')!.getAttribute("aria-label")).toBe(
      "Copy secret API_KEY",
    );
  });
});

describe("EnvironmentVariables", () => {
  test("model mode renders rows; secrets go through SecretField", async () => {
    await render(
      <EnvironmentVariables
        variables={[
          { name: "NODE_ENV", value: "production" },
          { name: "API_KEY", value: "shh", secret: true },
          { name: "UNSET_VAR" },
        ]}
      />,
    );
    const rows = container!.querySelectorAll('[data-slot="environment-variable"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("production");
    expect(rows[1]!.getAttribute("data-secret")).toBe("true");
    expect(rows[1]!.querySelector('[data-slot="secret-field"]')).not.toBeNull();
    expect(rows[1]!.innerHTML).not.toContain("shh");
    expect(rows[2]!.textContent).toContain("—");
  });

  test("a credential-shaped name masks its value unless the caller opts out", async () => {
    await render(
      <EnvironmentVariables
        variables={[
          { name: "OPENAI_API_KEY", value: "sk-leak-1" },
          { name: "GITHUB_TOKEN", value: "ghp-leak-2" },
          { name: "DB_PASSWORD", value: "pw-leak-3" },
          { name: "PUBLIC_KEY_ID", value: "shown-4", secret: false },
          { name: "NODE_ENV", value: "production" },
          { name: "DATABASE_URL", value: "postgres://app:pw-leak-5@db/app" },
          { name: "REDIS_URI", value: "redis://:redis-leak-6@cache" },
          { name: "GPG_PASSPHRASE", value: "phrase-leak-7" },
          { name: "HASH_SALT", value: "salt-leak-8" },
          { name: "TLS_CERT", value: "cert-leak-9" },
          { name: "SIGNING_KEY_PEM", value: "sign-leak-10" },
          { name: "UPSTREAM", value: "https://u:pw-leak-11@proxy.example" },
          { name: "MYSQL_PWD", value: "leak-12" },
          { name: "ADMIN_PW", value: "leak-13" },
          { name: "STRIPE_SK", value: "leak-14" },
          { name: "GH_PAT", value: "leak-15" },
          { name: "TOTP_SEED", value: "leak-16" },
          { name: "OTP", value: "leak-17" },
          { name: "WEBHOOK_HMAC", value: "leak-18" },
          { name: "BEARER", value: "leak-19" },
          { name: "API_PIN", value: "leak-20" },
          { name: "MIRROR", value: "  postgres://a:leak-21@db" },
          { name: "PATH", value: "/usr/bin" },
          { name: "FOOTPRINT", value: "small" },
        ]}
      />,
    );
    const html = container!.innerHTML;
    for (const leak of ["sk-leak-1", "ghp-leak-2", "pw-leak-3", "pw-leak-5", "redis-leak-6", "phrase-leak-7", "salt-leak-8", "cert-leak-9", "sign-leak-10", "pw-leak-11",
      "leak-12", "leak-13", "leak-14", "leak-15", "leak-16", "leak-17", "leak-18", "leak-19", "leak-20", "leak-21"]) {
      expect(html).not.toContain(leak);
    }
    expect(html).toContain("shown-4");
    expect(html).toContain("production");
    expect(html).toContain("/usr/bin");
    expect(html).toContain("small");
    const secrets = [...container!.querySelectorAll('[data-slot="environment-variable"]')].map((row) => row.getAttribute("data-secret"));
    expect(secrets).toEqual(["true", "true", "true", "false", "false", "true", "true", "true", "true", "true", "true", "true",
      "true", "true", "true", "true", "true", "true", "true", "true", "true", "true", "false", "false"]);
  });

  test("an ordinary setting whose name contains a credential word stays visible", async () => {
    const shown = [
      "PUBLIC_URL", "NEXT_PUBLIC_API_URL", "VITE_BASE_URL", "AUTHOR", "SIGNAL_LEVEL", "KEYBOARD_LAYOUT",
      "PASSTHROUGH", "SESSION_TIMEOUT", "CERTIFIED", "DATABASE_URL",
    ];
    await render(
      <EnvironmentVariables variables={shown.map((name, index) => ({ name, value: `https://shown-${index}.example/` }))} />,
    );
    const rows = [...container!.querySelectorAll('[data-slot="environment-variable"]')];
    expect(rows.map((row) => row.getAttribute("data-secret"))).toEqual(shown.map(() => "false"));
    for (const [index] of shown.entries()) expect(container!.innerHTML).toContain(`shown-${index}.example`);
  });

  test("a credential in a URL query, a connection string, or a whole-word name still masks", async () => {
    await render(
      <EnvironmentVariables
        variables={[
          { name: "SEARCH_URL", value: "https://search.example/?api_key=leak-a" },
          { name: "SQL_CONNECTION", value: "Server=db;User Id=app;Password=leak-b;" },
          { name: "SLACK_WEBHOOK_URL", value: "https://hooks.example/services/leak-c" },
          { name: "SESSION_ID", value: "leak-d" },
          { name: "AUTHORIZATION", value: "leak-e" },
          { name: "OAUTH_CLIENT", value: "leak-f" },
          { name: "APP_SESSION", value: "leak-g" },
          { name: "SMTP_PASS", value: "leak-h" },
          { name: "APIKEY", value: "leak-i" },
          { name: "SIGNATURE", value: "leak-j" },
        ]}
      />,
    );
    const html = container!.innerHTML;
    for (const leak of ["leak-a", "leak-b", "leak-c", "leak-d", "leak-e", "leak-f", "leak-g", "leak-h", "leak-i", "leak-j"]) {
      expect(html).not.toContain(leak);
    }
  });

  test("compound mode renders EnvironmentVariable children", async () => {
    await render(
      <EnvironmentVariables>
        <EnvironmentVariable name="A" value="1" />
      </EnvironmentVariables>,
    );
    expect(container!.querySelectorAll('[data-slot="environment-variable"]')).toHaveLength(1);
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<EnvironmentVariables variables={[{ name: "A", value: "1" }]} />);
    expect(container!.querySelector('[data-slot="environment-variables"]')).not.toBeNull();
  });
});
