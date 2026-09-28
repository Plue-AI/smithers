import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How long the whole upload may take, request and response body together.
 *
 * `runReview` awaits publication before posting the PR review, so an endpoint
 * that accepts the upload and then stalls would hold a finished review off
 * GitHub indefinitely. Generous enough for a multi-megabyte walkthrough on a
 * slow link, short enough that a wedged share service costs one minute.
 */
const PUBLISH_TIMEOUT_MS = 60_000;

function loadPublishConfig(homeDir = homedir()): { url: string; token: string } {
  let url = process.env.SMITHERS_REVIEW_PUBLISH_URL?.trim() || "";
  let token = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN?.trim() || "";
  if (!url || !token) {
    const path = join(homeDir, ".smithers-review.json");
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { publishUrl?: string; publishToken?: string };
      url = url || raw.publishUrl?.trim() || "";
      token = token || raw.publishToken?.trim() || "";
    }
  }
  if (!url) {
    throw new Error(
      'no publish URL: set SMITHERS_REVIEW_PUBLISH_URL or write ~/.smithers-review.json with { "publishUrl": "..." }',
    );
  }
  if (!token) {
    throw new Error(
      'no publish token: set SMITHERS_REVIEW_PUBLISH_TOKEN or write ~/.smithers-review.json with { "publishToken": "..." }',
    );
  }
  return { url: requireSecureUrl(url).replace(/\/$/, ""), token };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The publish request carries the bearer token, so it goes only over https:.
 * Plain http: is accepted for a loopback host, where no network sits between
 * the CLI and the service.
 */
function requireSecureUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid publish URL: ${url}`);
  }
  if (parsed.protocol === "https:") return url;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return url;
  throw new Error(`insecure publish URL: ${parsed.origin} must use https: (http: only for localhost)`);
}

/**
 * Upload a walkthrough HTML file to the publish service; returns the share URL.
 *
 * The upload is bounded by a single deadline that spans the request and the
 * response-body read, because a server may answer with headers and then hold
 * the body open. Aborting the signal tears the socket down; racing the
 * deadline bounds the wait even where the signal is ignored. On expiry this
 * throws like any other publish failure, which the caller already treats as a
 * warning, so the review still posts to the PR without a share link.
 */
export async function publishWalkthrough(
  htmlPath: string,
  options: { homeDir?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { url, token } = loadPublishConfig(options.homeDir);
  const html = readFileSync(htmlPath);
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`publish failed: no response within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetch(`${url}/api/walkthroughs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/html; charset=utf-8",
        },
        body: html,
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      const detail = await Promise.race([response.text(), deadline]).catch(() => "");
      throw new Error(`publish failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }
    const data = (await Promise.race([response.json(), deadline])) as { url?: string };
    if (!data.url) throw new Error("publish failed: response had no url");
    return data.url;
  } finally {
    // Always disarm: a timer left running would reject `deadline` with nothing
    // awaiting it, which surfaces as an unhandled rejection.
    clearTimeout(timer);
  }
}
