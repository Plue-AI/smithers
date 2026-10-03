// Oracles: C-SPK-07 steps 1–5: 1000 edits at 10/30 Hz, disjoint 200-line regions, 1.5 s flush wait, p95 <1000 ms.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

const topology = process.env.SPIKE_CLIENT_TOPOLOGY ?? "same-mac";
const deviation = topology === "second-mac"
  ? "Second-Mac browser runner on the same network, asserted by SPIKE_CLIENT_TOPOLOGY=second-mac; verify host/client profiles. One-way split is a clock/automation estimate, so strict C-SPK-07 remains partial."
  : "Same-Mac headless Chromium tabs through the Mac LAN address; no second Mac/network hop. Strict C-SPK-07 remains partial.";
const origin = process.env.SPIKE_ORIGIN ?? "";
const evidence = process.env.SPIKE_EVIDENCE ?? "";
const transport = process.env.SPIKE_TRANSPORT ?? "relay";
const measured = (value: number) => ({ value, deviation });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Receipt = { seq: number; inserted: string; host_in: string; host_out: string; host_vm_ns: string; host_in_elapsed_ns?: string };
type Send = { seq: number; run: string; sender: "A" | "B"; t_send: string; expected: string };
type Sample = Receipt & Send & { t_recv: string; latency_ms: number; browser_to_host_estimate_ms: number; host_queue_dispatch_ms: number; receive_estimate_ms: number; clock_uncertainty_ms: number };
type ClockSample = { index: number; t0: string; t1: string; host_ns: string; rtt_ns: string; offset_ns: string; deviation: string };
const clockCaveat = "Offset uses the minimum-RTT HTTP midpoint, assuming a symmetric request. Bounds are +/- half that RTT at calibration; subsequent clock drift is unmeasured. Send estimate includes Playwright page.evaluate dispatch and browser→host. Receive estimate includes fan-out, browser apply and binding overhead. Negative estimates are retained; exact one-way shares are not claimed.";
type SpikePage = Window & { spike: { ready: boolean; errors: string[]; content(): string; type(seq: number, character: string, firstLine: number, lastLine: number, random: number): void } };

// Every workload resets its own document; keep collecting independent evidence
// after a preceding workload fails. The config's single worker orders runs.
test.describe.configure({ mode: "default" });
test.setTimeout(180_000);

for (const workload of [{ name: "10hz", hz: 10, concurrent: false }, { name: "30hz", hz: 30, concurrent: false }, { name: "concurrent-10hz", hz: 10, concurrent: true }]) {
  test(`${transport}: ${workload.name} applies exact tagged updates and converges to VM disk`, async ({ browser, request }) => {
    expect(origin, "SPIKE_ORIGIN is required").toMatch(/^http:\/\//);
    const url = new URL(origin);
    expect(["localhost", "127.0.0.1", "::1", "[::1]"], "Use the Mac LAN address").not.toContain(url.hostname);
    expect(evidence, "SPIKE_EVIDENCE is required").not.toBe("");
    expect(["relay", "bridge"]).toContain(transport);
    expect(["same-mac", "second-mac"]).toContain(topology);
    const run = `${transport}-${workload.name}-${Date.now()}`;
    const dir = join(evidence, run);
    await mkdir(dir, { recursive: true });
    const samples: Sample[] = [];
    const sends = new Map<number, Send>();
    const clockSamples: ClockSample[] = [];
    let calibration: ClockSample | undefined;
    const counts = new Map<number, number>();
    const errors: string[] = [];
    let context: BrowserContext | undefined;
    let final: Record<string, unknown> | undefined;
    try {
      const reset = await request.post(`${origin}/reset?room=${run}&transport=${transport}`);
      expect(reset.ok(), await reset.text()).toBe(true);
      for (let index = 0; index < 20; index++) {
        const t0 = process.hrtime.bigint();
        const clockResponse = await request.get(`${origin}/clock`);
        const t1 = process.hrtime.bigint();
        expect(clockResponse.ok(), await clockResponse.text()).toBe(true);
        const { host_ns } = await clockResponse.json() as { host_ns: string };
        expect(host_ns).toMatch(/^\d+$/);
        const rtt = t1 - t0;
        const offset = BigInt(host_ns) - (t0 + t1) / 2n;
        clockSamples.push({ index, t0: t0.toString(), t1: t1.toString(), host_ns, rtt_ns: rtt.toString(), offset_ns: offset.toString(), deviation });
      }
      calibration = clockSamples.reduce((best, sample) => BigInt(sample.rtt_ns) < BigInt(best.rtt_ns) ? sample : best);
      const clockOffset = BigInt(calibration.offset_ns);
      const clockUncertaintyMs = Number(BigInt(calibration.rtt_ns)) / 2e6;
      context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      await context.exposeBinding("__spikeReceipt", ({ page }, receipt: Receipt) => {
        const t_recv = process.hrtime.bigint();
        const sent = sends.get(receipt.seq);
        if (!sent) { errors.push(`Unsent sequence ${receipt.seq}`); return; }
        const receiver = new URL(page.url()).searchParams.get("client");
        if (receiver === sent.sender) { errors.push(`Sender observer counted its own sequence ${receipt.seq}`); return; }
        counts.set(receipt.seq, (counts.get(receipt.seq) ?? 0) + 1);
        if (receipt.inserted !== sent.expected) errors.push(`Sequence ${receipt.seq} inserted ${JSON.stringify(receipt.inserted)} instead of ${JSON.stringify(sent.expected)}`);
        const hostIn = BigInt(receipt.host_in);
        const hostOut = BigInt(receipt.host_out);
        samples.push({ ...sent, ...receipt, t_recv: t_recv.toString(), latency_ms: Number(t_recv - BigInt(sent.t_send)) / 1e6, browser_to_host_estimate_ms: Number(hostIn - (BigInt(sent.t_send) + clockOffset)) / 1e6, host_queue_dispatch_ms: Number(hostOut - hostIn - BigInt(receipt.host_vm_ns)) / 1e6, receive_estimate_ms: Number(t_recv - (hostOut - clockOffset)) / 1e6, clock_uncertainty_ms: clockUncertaintyMs });
      });
      const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
      await Promise.all([a.goto(`${origin}/?room=${run}&transport=${transport}&client=A`), b.goto(`${origin}/?room=${run}&transport=${transport}&client=B`)]);
      for (const page of [a, b]) {
        await page.waitForFunction(() => (window as SpikePage).spike?.ready === true);
        expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
        expect((await page.evaluate(() => (window as SpikePage).spike.content())).split("\n")).toHaveLength(400);
      }
      async function type(page: Page, sender: "A" | "B") {
        let randomState = sender === "A" ? 3441 : 3442;
        const start = process.hrtime.bigint();
        for (let index = 0; index < 1_000; index++) {
          const target = start + BigInt(Math.round(index * 1e9 / workload.hz));
          const left = Number(target - process.hrtime.bigint()) / 1e6;
          if (left > 0) await sleep(left);
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
          const random = randomState / 2 ** 32;
          const seq = index + 1 + (sender === "B" ? 1_000 : 0);
          const character = String.fromCharCode(33 + index % 94);
          sends.set(seq, { seq, run, sender, t_send: process.hrtime.bigint().toString(), expected: character });
          await page.evaluate(({ seq, character, random, sender }) => (window as SpikePage).spike.type(seq, character, sender === "A" ? 1 : 201, sender === "A" ? 200 : 400, random), { seq, character, random, sender });
        }
      }
      await Promise.all([type(a, "A"), ...(workload.concurrent ? [type(b, "B")] : [])]);
      await sleep(1_500);
      const [textA, textB, diskResponse] = await Promise.all([a.evaluate(() => (window as SpikePage).spike.content()), b.evaluate(() => (window as SpikePage).spike.content()), request.get(`${origin}/disk?room=${run}&transport=${transport}`)]);
      expect(diskResponse.ok(), await diskResponse.text()).toBe(true);
      const disk = await diskResponse.text();
      await Promise.all([writeFile(join(dir, "A.txt"), textA), writeFile(join(dir, "B.txt"), textB), writeFile(join(dir, "disk.txt"), disk)]);
      const expectedCount = workload.concurrent ? 2_000 : 1_000;
      expect(samples).toHaveLength(expectedCount);
      expect(counts.size).toBe(expectedCount);
      expect([...counts.values()]).toEqual(Array(expectedCount).fill(1));
      expect(errors).toEqual([]);
      expect(await a.evaluate(() => (window as SpikePage).spike.errors)).toEqual([]);
      expect(await b.evaluate(() => (window as SpikePage).spike.errors)).toEqual([]);
      expect(textA).toBe(textB);
      expect(textA).toBe(disk);
      const sorted = [...samples].sort((x, y) => x.latency_ms - y.latency_ms);
      const at = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
      const p95 = at(.95);
      const vmMs = Number(p95.host_vm_ns) / 1e6;
      const editors = Object.fromEntries((workload.concurrent ? ["A", "B"] : ["A"]).map((sender) => {
        const edits = sorted.filter((sample) => sample.sender === sender);
        const bySend = [...edits].sort((x, y) => Number(BigInt(x.t_send) - BigInt(y.t_send)));
        const duration = Number(BigInt(bySend.at(-1)!.t_send) - BigInt(bySend[0].t_send)) / 1e9;
        const percentile = (p: number) => edits[Math.ceil(edits.length * p) - 1].latency_ms;
        return [sender, { samples: measured(edits.length), achieved_hz: measured((edits.length - 1) / duration), p50_ms: measured(percentile(.5)), p95_ms: measured(percentile(.95)), p99_ms: measured(percentile(.99)) }];
      }));
      final = { status: "partial", local_assertions: "passed", strict_C_SPK_07: "partial", deviation, workload: { name: workload.name, hz: measured(workload.hz), concurrent: workload.concurrent }, sample_count: measured(samples.length), first_sample_included: true, p50_ms: measured(at(.5).latency_ms), p95_ms: measured(p95.latency_ms), p99_ms: measured(at(.99).latency_ms), editors, p95_sample_seq: measured(p95.seq), p95_host_vm_ms: measured(vmMs), p95_host_vm_share: measured(vmMs / p95.latency_ms), p95_residual_browser_host_runner_ms: measured(p95.latency_ms - vmMs), p95_browser_to_host_estimate_ms: measured(p95.browser_to_host_estimate_ms), p95_browser_to_host_estimate_share: measured(p95.browser_to_host_estimate_ms / p95.latency_ms), p95_browser_to_host_lower_bound_ms: measured(p95.browser_to_host_estimate_ms - clockUncertaintyMs), p95_browser_to_host_upper_bound_ms: measured(p95.browser_to_host_estimate_ms + clockUncertaintyMs), p95_host_queue_dispatch_ms: measured(p95.host_queue_dispatch_ms), p95_receive_estimate_ms: measured(p95.receive_estimate_ms), clock_calibration_samples: measured(clockSamples.length), clock_uncertainty_ms: measured(clockUncertaintyMs), split_limitation: clockCaveat, hashes: { A: sha256(textA), B: sha256(textB), disk: sha256(disk) } };
      expect(p95.latency_ms).toBeLessThan(1_000);
      for (const sender of Object.keys(editors)) expect(editors[sender].p95_ms.value).toBeLessThan(1_000);
    } catch (error) {
      final = { ...final, status: "failed", local_assertions: "failed", strict_C_SPK_07: "partial", deviation, error: String(error), observed_samples: measured(samples.length), errors };
      throw error;
    } finally {
      const cell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
      const header = "run,seq,sender,t_send,t_recv,host_in,host_out,host_vm_ns,host_in_elapsed_ns,latency_ms,browser_to_host_estimate_ms,host_queue_dispatch_ms,receive_estimate_ms,clock_uncertainty_ms,expected,inserted,deviation\n";
      await writeFile(join(dir, "keystrokes.csv"), header + samples.map((sample) => [sample.run, sample.seq, sample.sender, sample.t_send, sample.t_recv, sample.host_in, sample.host_out, sample.host_vm_ns, sample.host_in_elapsed_ns ?? "", sample.latency_ms, sample.browser_to_host_estimate_ms, sample.host_queue_dispatch_ms, sample.receive_estimate_ms, sample.clock_uncertainty_ms, sample.expected, sample.inserted, deviation].map(cell).join(",")).join("\n") + "\n");
      await writeFile(join(dir, "clock-calibration.json"), JSON.stringify({ deviation, method: clockCaveat, selected: calibration, samples: clockSamples }, null, 2) + "\n");
      await writeFile(join(dir, "summary.json"), JSON.stringify(final, null, 2) + "\n");
      const envResponse = await request.get(`${origin}/env`).catch(() => undefined);
      const host = envResponse?.ok() ? await envResponse.json() : { unavailable: true };
      await writeFile(join(dir, "env.json"), JSON.stringify({ deviation, topology, topology_source: "SPIKE_CLIENT_TOPOLOGY caller assertion; inspect host and runner profiles", origin, transport, browser_version: browser.version(), runner_hostname: hostname(), runner_network: networkInterfaces(), host }, null, 2) + "\n");
      if (context) {
        await context.tracing.stop({ path: join(dir, "trace.zip") });
        await context.close();
      }
    }
  });
}
