import type { ReviewWorkerEnv } from "./env.ts";

/** Explicit content origin; never infer an upload host from an incoming request. */
export function walkthroughOrigin(env: ReviewWorkerEnv): string | null {
  if (!env.PUBLIC_BASE_URL) return null;
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    const hostname = url.hostname.replace(/\.$/, "");
    if (
      url.protocol !== "https:" || url.username || url.password || url.hostname.endsWith(".") ||
      url.pathname !== "/" || url.search || url.hash ||
      ["jjhub.tech", "smithers.sh"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}
