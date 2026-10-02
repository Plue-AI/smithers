/**
 * vault lane CSS fragment. All classes `sui-vault-*` namespaced and colored
 * only through the tokens bridge (`var(--house-token, lightFallback)` /
 * `color-mix(in srgb, ...)`). Composed into `smithersUiCss` by uiCss.ts,
 * which every vault component injects through `useVaultCss`; exported for
 * hosts that mount the lane alone.
 */
export const VAULT_CSS_ID = "vault";

export const vaultCss = `
.sui-vault-graph-shell { min-width:0; display:grid; gap:8px; }
.sui-vault-graph-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-vault-graph-actions { display:flex; align-items:center; gap:6px; flex:none; }
.sui-vault-graph { display:block; width:100%; height:auto; border:1px solid var(--border, rgba(33, 29, 24, 0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fffefa); color:var(--text-muted, #665f54); touch-action:none; user-select:none; }
.sui-vault-graph-edge { stroke:currentColor; }
.sui-vault-graph-node circle { fill:currentColor; stroke:var(--border-strong, rgba(33, 29, 24, 0.14)); }
.sui-vault-graph-node[data-tint='brand'] { color:color-mix(in srgb, var(--brand, #0f766e) 80%, var(--text, #211d18)); }
.sui-vault-graph-node[data-tint='success'] { color:color-mix(in srgb, var(--success, #0b5b57) 80%, var(--text, #211d18)); }
.sui-vault-graph-node[data-tint='info'] { color:color-mix(in srgb, var(--info, #3c6879) 80%, var(--text, #211d18)); }
.sui-vault-graph-node[data-tint='warning'] { color:color-mix(in srgb, var(--warning, #8c5a08) 80%, var(--text, #211d18)); }
.sui-vault-graph-label { fill:var(--text-muted, #665f54); }
.sui-vault-graph-meta { color:var(--text-muted, #665f54); font-size:11px; }
.sui-vault-graph-fallback { min-width:0; display:grid; gap:6px; align-content:start; }
.sui-vault-links { min-width:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
.sui-vault-links-section { min-width:0; display:grid; gap:6px; align-content:start; }
.sui-vault-links-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-vault-links-empty { margin:0; color:var(--text-muted, #665f54); font-size:var(--fs-2, 12px); }
.sui-vault-link-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-vault-link-path { min-width:0; max-width:50%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-faint, #6c655a); font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace); font-size:11px; }
.sui-vault-outline { min-width:0; display:flex; flex-direction:column; gap:1px; }
.sui-vault-outline-item { display:flex; align-items:center; width:100%; min-height:28px; padding:2px 8px; border:none; border-radius:var(--r-1, 6px); background:transparent; color:var(--text, #211d18); font:inherit; font-size:13px; text-align:left; cursor:pointer; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.sui-vault-outline-item:hover { background:var(--hover, #efeae0); }
.sui-vault-outline-item:focus-visible { outline:none; box-shadow:0 0 0 3px var(--ring, color-mix(in srgb, var(--brand, #0f766e) 22%, transparent)); }
.sui-vault-outline-item[data-depth='1'] { font-weight:650; }
.sui-vault-outline-empty { margin:0; padding:8px; color:var(--text-muted, #665f54); font-size:var(--fs-2, 12px); }
`;
