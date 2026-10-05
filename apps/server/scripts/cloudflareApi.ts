/** Cloudflare and wrangler share the brokered full API base. */
export const cloudflareApiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"
