import type { State } from "./durableState.ts";

/** A repository's published app URL and when it was committed. */
export type Ready = { appUrl: string; completedAt: string };

/**
 * The only authority for one normalized repository's published app URL.
 * Reachable only through the Worker's binding, which validates the URL first;
 * KV `repo-ready:` mirrors the committed record and never flows back in.
 */
export class RepoCompletion {
  constructor(private readonly ctx: State) {}

  /** GET: the committed record or 404. POST {appUrl, completedAt}: commit the first candidate; answer the committed record. */
  async fetch(request: Request): Promise<Response> {
    const candidate = request.method === "POST" ? await request.json() as Ready : undefined;
    const ready = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<Ready>("ready");
      if (existing || !candidate) return existing ?? null;
      await txn.put("ready", candidate);
      return candidate;
    });
    return ready ? Response.json(ready) : new Response(null, { status: 404 });
  }
}
