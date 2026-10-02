// Main-only secrets (D-24): seam and backend tests cover it; the real backend run is owed.
export const secrets = [
  "secrets.bind", "secrets.connect.codex", "secrets.move", "secrets.scope",
] as const
