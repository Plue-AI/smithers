export function journey(id, title, steps) {
  return { id, title, steps: [...steps.map(([suffix, check, procedure, options = {}]) => ({
    id: `${id}.${suffix}`, check, kind: "browser", procedure: Array.isArray(procedure) ? procedure : [procedure], ...options
  })), { id: `${id}.keyboard`, check: "C-UI-01", kind: "browser", procedure: [
    "Complete every app action with the keyboard guard active in Chromium and WebKit; record focus and --ring-border after each action.",
    "Escape each palette, form, Confirm and maximized card; verify focus returns to its opener and Tab reaches every action without a trap.",
    "Review the entire journey input log: only keyboard input on the install; list GitHub-hosted, host-terminal and SSH exclusions."
  ] }] }
}
