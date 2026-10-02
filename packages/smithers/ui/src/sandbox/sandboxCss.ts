export const SANDBOX_CSS_ID = "sandbox-previews";

export const sandboxCss = `
.sui-sandbox { border:1px solid var(--border, rgba(33, 29, 24, 0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fffefa); overflow:hidden; }
.sui-sandbox-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 10px; border:0; background:transparent; color:var(--text, #211d18); font:inherit; font-size:var(--fs-2, 12px); font-weight:650; cursor:pointer; text-align:left; }
.sui-sandbox-trigger:hover { background:var(--hover-subtle, rgba(33, 29, 24, 0.03)); }
.sui-sandbox-trigger:focus-visible { outline:none; border-color:color-mix(in srgb, var(--brand, #0f766e) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #0f766e) 22%, transparent); }
.sui-sandbox-chevron { display:inline-block; transition:transform 120ms ease; color:var(--text-muted, #665f54); }
.sui-sandbox[data-state='open'] > .sui-sandbox-trigger .sui-sandbox-chevron { transform:rotate(90deg); }
.sui-sandbox-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 10px; border-top:1px solid var(--border, rgba(33, 29, 24, 0.08)); font-size:var(--fs-2, 12px); }
.sui-sandbox-identity { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; flex:1; }
.sui-sandbox-workspace, .sui-sandbox-repository { display:inline-flex; align-items:center; gap:4px; color:var(--text-muted, #665f54); font-family:ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace; }
.sui-sandbox-repository { color:var(--text, #211d18); }
.sui-sandbox-actions { display:flex; align-items:center; gap:6px; padding:6px 10px; border-top:1px solid var(--border, rgba(33, 29, 24, 0.08)); }
.sui-sandbox-action { display:inline-flex; align-items:center; gap:4px; min-height:var(--ctl-h, 32px); padding:0 10px; border:1px solid var(--border-solid, #e4ddcf); border-radius:var(--r-1, 6px); background:var(--surface, #fffefa); color:var(--text, #211d18); font:inherit; font-size:var(--fs-2, 12px); cursor:pointer; }
.sui-sandbox-action:hover { background:var(--hover, #efeae0); }
.sui-sandbox-action:focus-visible { outline:none; border-color:color-mix(in srgb, var(--brand, #0f766e) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #0f766e) 22%, transparent); }
.sui-sandbox-content { border-top:1px solid var(--border, rgba(33, 29, 24, 0.08)); padding:8px 10px; }
.sui-webpreview { display:flex; flex-direction:column; border:1px solid var(--border, rgba(33, 29, 24, 0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fffefa); overflow:hidden; }
.sui-webpreview-toolbar { display:flex; align-items:center; gap:4px; padding:6px 8px; border-bottom:1px solid var(--border, rgba(33, 29, 24, 0.08)); }
.sui-webpreview-toolbar-button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border:0; border-radius:var(--r-1, 6px); background:transparent; color:var(--text-muted, #665f54); font:inherit; cursor:pointer; }
.sui-webpreview-toolbar-button:hover { background:var(--hover, #efeae0); color:var(--text, #211d18); }
.sui-webpreview-toolbar-button:focus-visible { outline:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #0f766e) 22%, transparent); }
.sui-webpreview-address { flex:1; min-width:0; }
.sui-webpreview-address-row { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
.sui-webpreview-address-error { color:var(--danger, #a4442a); font-size:var(--fs-2, 12px); }
.sui-webpreview-content { position:relative; min-height:120px; background:var(--surface-2, #efeae0); }
.sui-webpreview-frame { display:block; width:100%; height:100%; min-height:120px; border:0; background:var(--surface, #fffefa); }
.sui-webpreview-loading { position:absolute; inset:0; z-index:1; }
.sui-jsxpreview { border:1px solid var(--border, rgba(33, 29, 24, 0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fffefa); overflow:hidden; }
.sui-jsxpreview-frame { padding:8px 10px; }
`;
