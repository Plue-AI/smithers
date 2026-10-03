// Observations only. Formal acceptance remains partial without reference
// hardware and a second Mac; source decisions belong to T-COL-10 / ADR 0003.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [dir03, dir07, snapshotDir = dir03, mode = "all"] = process.argv.slice(2);
const failures = [];
if (!["all", "rtt", "keystrokes", "snapshot"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const requested = kind => mode === "all" || mode === kind;
const read = async (p, required = false) => {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (error) { if (required) failures.push(`${p}: ${error.message}`); return undefined; }
};
const rtt = await read(join(dir03,"summary.json"), requested("rtt"));
const snapshot = await read(join(snapshotDir,"snapshot-summary.json"), requested("snapshot"));
const browser = [];
for (const transport of ["relay","bridge"]) {
  for (const run of await readdir(join(dir07,transport)).catch(()=>[])) {
    const data = await read(join(dir07,transport,run,"summary.json"), requested("keystrokes"));
    if (data) browser.push({ transport, run, data });
  }
}
if (requested("rtt") && (!rtt || rtt.cells?.length !== 8 || typeof rtt.local_gate_passed !== "boolean")) failures.push("RTT: expected 8 cells and an evaluated gate");
if (requested("snapshot")) {
  for (const load of ["idle", "busy"]) for (const count of [0, 1, 12, 200]) {
    const cells = (snapshot?.cells ?? []).filter(c => c.load === load && c.changed_files === count);
    if (cells.length !== 1 || cells[0].stats?.n < 100 || !Number.isFinite(cells[0].stats?.p95_ns)) failures.push(`snapshot: missing/invalid ${load} ${count}-file cell`);
  }
  if (typeof snapshot?.idle_12_file_gate_passed !== "boolean") failures.push("snapshot: gate not evaluated");
}
if (requested("keystrokes")) for (const transport of ["relay", "bridge"]) {
  if (browser.filter(x => x.transport === transport).length !== 3) failures.push(`${transport} browser: expected 3 workload results`);
}
const successful = browser.filter(x=>x.data.local_assertions==="passed");
const measuredRuns = browser.filter(x=>x.data.p50_ms&&x.data.p95_ms&&x.data.p99_ms);
const chosen = rtt?.chosen_transport || "undetermined";
const idleCandidates = ["relay","bridge"].map(transport=>({transport,cells:(rtt?.cells??[]).filter(c=>c.transport===transport&&c.load==="idle")})).filter(x=>x.cells.length===2&&x.cells.every(c=>c.stats.n>=1000&&c.stats.p95_ns<20e6)).sort((a,b)=>Math.max(...a.cells.map(c=>c.stats.p95_ns))-Math.max(...b.cells.map(c=>c.stats.p95_ns)));
const candidate = chosen==="undetermined" ? idleCandidates[0]?.transport : chosen;
const chosenRuns = successful.filter(x=>x.transport===candidate);
const fallback = chosenRuns.length===3 ? "not indicated by these local observations" : "undetermined; insufficient successful observations";
const rows=[];
const fmt=n=>(n/1e6).toFixed(3);
for(const c of rtt?.cells??[])rows.push(`| ${c.transport} RTT ${c.load} ${c.size} B | ${c.stats.n} | ${fmt(c.stats.p50_ns)} | ${fmt(c.stats.p95_ns)} | ${fmt(c.stats.p99_ns)} | Recorded host profile; same-Mac browser deviation applies to keystrokes |`);
for(const t of rtt?.connection_setup??[])rows.push(`| ${t.transport} ready connection setup | ${t.stats.n} | ${fmt(t.stats.p50_ns)} | ${fmt(t.stats.p95_ns)} | ${fmt(t.stats.p99_ns)} | Recorded host profile; same-Mac browser deviation applies to keystrokes |`);
for(const name of ["control","one-exec-control"]) {
  const c=await read(join(dir03,`${name}-summary.json`), requested("rtt"));
  if(c)rows.push(`| ${name} writes | ${c.n} | ${fmt(c.p50_ns)} | ${fmt(c.p95_ns)} | ${fmt(c.p99_ns)} | Recorded host profile; same-Mac browser deviation applies to keystrokes |`);
}
for(const {transport,data:d} of measuredRuns)rows.push(`| ${transport} keystrokes ${d.workload.name}${d.local_assertions!=="passed"?" FAILED":""}, actual ${Object.entries(d.editors).map(([editor,s])=>`${editor} ${s.achieved_hz.value.toFixed(3)}/s`).join(", ")} | ${d.sample_count.value} | ${d.p50_ms.value.toFixed(3)} | ${d.p95_ms.value.toFixed(3)} | ${d.p99_ms.value.toFixed(3)} | Two headless tabs on this Mac via LAN IPv4; second Mac not run |`);
for(const c of snapshot?.cells??[]) rows.push(`| jj snapshot ${c.load}, ${c.changed_files} files | ${c.stats.n} | ${fmt(c.stats.p50_ns)} | ${fmt(c.stats.p95_ns)} | ${fmt(c.stats.p99_ns)} | Disposable VM; shallow main clone, installed ignored dependencies; 128-byte fixture edits |`);
const text=`${failures.length ? `Incomplete requested measurements:\n${failures.map(f => `- ${f}`).join("\n")}\n\n` : ""}Transport: **${chosen==="undetermined" ? `none qualifies; ${candidate??"no"} candidate requires the lead's scheduling decision` : chosen}**. Host mirror fallback: **${fallback}**.

Disposable T-COL-01 observations on this Mac; C-SPK-03 acceptance requires an isolated reference-host run, and C-SPK-07 is partial because there is no second Mac. Every raw sample, including the first, is retained; no warm-up subset is removed. Guest saves use 200 ms idle / 1 s maximum, fsync and rename.
The bridge 4 KiB idle distribution has a roughly 50 ms plateau while 64 B frames are sub-millisecond. The existing guest bridge helper does not set TCP_NODELAY: delayed ACK/Nagle is a plausible cause, not a confirmed transport limitation. No NODELAY rerun was performed. This recommendation describes the unchanged helpers only; both production topologies remain supported under ADR 0004, and the lead must consider this confounder before choosing a boot setting.
Achieved send rates are shown alongside target workload names; slower injection is another limit on claiming the exact check conditions. p99 tails remain visible even when p95 passes.

| Measurement | n | p50 ms | p95 ms | p99 ms | Deviation beside the numbers |
| --- | ---: | ---: | ---: | ---: | --- |
${rows.join("\n")}

${rtt?.local_gate_passed===false ? "C-SPK-03's executed thresholds failed. The only idle-qualified candidate is recorded above, but it cannot be called a passing transport until loaded scheduling is resolved. Do not start T-COL-03 on a claimed pass." : rtt?.reason??"No RTT transport decision is available in this invocation."}

${measuredRuns.map(({transport,data:d})=>`${transport} ${d.workload.name}: at the actual end-to-end p95 sample, host↔VM share ${(100*d.p95_host_vm_share.value).toFixed(1)}%; calibrated outbound estimate ${(d.p95_browser_to_host_estimate_ms?.value??NaN).toFixed(3)} ms. Same-Mac LAN substitution; HTTP clock calibration assumes symmetric delay and includes automation overhead. See raw calibration, uncertainty, trace and hashes in that run's receipt.`).join("\n\n")}

${snapshot ? `Snapshot idle 12-file gate: ${snapshot.idle_12_file_gate_passed ? "passed locally" : "FAILED"}. Every sample includes jj process startup and full repository scan. Preparation/validation are untimed and warm caches. No-change p95 ≥500 ms requires the lead's fsmonitor decision before T-COL-04. See snapshot preparation/env receipts for the exact public main revision and tool/dependency versions.` : "Snapshot measurements were not requested, or are incomplete as recorded above."}


Reference-host findings (lead ruling 10-03):
- Astra1/Fable1: **moved to T-COL-11 (lead ruling 10-03)**. Prepare a populated Linux ARM64 pnpm 11 store archive for the measured revision, then run the snapshot target on the reference host with \`SPIKE_SNAPSHOT_STORE_ARCHIVE\`; retain all eight 0/1/12/200-file idle/busy cells (100 samples each), dependency identities and the 12-file idle budget result.
- Astra2/Fable3: **moved to T-COL-11 (lead ruling 10-03)**. Run the complete isolated reference-host RTT matrix with no competing VM (both transports, 64 B/4 KiB, idle/busy, 1,000 samples per cell and 20 setup samples), then obtain the second-Mac plain-LAN browser receipt for all three workloads with convergence and disk hashes. Retain the bridge delayed ACK/Nagle confounder and resolve it in the ADR 0003 topology decision; this harness landing claims neither reference-host acceptance nor a second-Mac pass.

Current service control uses two guest execs via the real provider-service path, including SQL and a canonical-path guard. The separate one-exec control uses Runtime.WriteFile and runs second, with warm guest/file state. Neither is a CRDT path or a product gate.

Evidence: ${dir03}, ${dir07}. Strict second-Mac steps: **not run: needs second Mac**. Start \`SPIKE_HTTP_PORT=39041 scripts/spikes/col-01/run.sh serve ${candidate??"relay"}\` on the host; run \`SPIKE_CLIENT_TOPOLOGY=second-mac scripts/spikes/col-01/run.sh remote http://<host-LAN-address>:39041 ${candidate??"relay"}\` from this checkout on the second Mac. No ADR was written.
`;
await Promise.all([writeFile(join(dir03,"result.md"),text),writeFile(join(dir07,"result.md"),text)]);
process.stdout.write(text);
if(failures.length || snapshot?.idle_12_file_gate_passed===false || rtt?.local_gate_passed===false || browser.some(x=>x.data.local_assertions!=="passed")) process.exitCode=2;
