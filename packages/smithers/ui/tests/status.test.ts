import { describe, expect, test } from "bun:test";
import {
  formatStatus,
  isTerminalRunStatus,
  normalizeStatus,
  statusClass,
  statusColor,
  statusColors,
} from "../src/status";

describe("normalizeStatus", () => {
  test("lowercases, trims, and normalizes underscores", () => {
    expect(normalizeStatus(" Waiting_Approval ")).toBe("waiting-approval");
    expect(normalizeStatus(undefined)).toBe("");
  });
});

describe("statusClass", () => {
  test("buckets finished / failed / in-flight / neutral", () => {
    expect(statusClass("ok")).toBe("ok");
    expect(statusClass("completed")).toBe("ok");
    expect(statusClass("failed")).toBe("bad");
    expect(statusClass("blocked")).toBe("bad");
    expect(statusClass("running")).toBe("run");
    expect(statusClass("in-progress")).toBe("run");
    expect(statusClass("waiting-approval")).toBe("warn");
    expect(statusClass("waiting-quota")).toBe("warn");
    expect(statusClass("continued")).toBe("ok");
    expect(statusClass("succeeded")).toBe("ok");
    expect(statusClass("succeeded-with-failures")).toBe("warn");
    expect(statusClass("produced")).toBe("ok");
    // A user cancel is a neutral outcome, not a failure -- muted, matching
    // the styleguide badge vocabulary and gateway-ui's RunEventLog.
    expect(statusClass("cancelled")).toBe("muted");
    expect(statusClass("canceled")).toBe("muted");
    expect(statusClass("stale")).toBe("bad");
    expect(statusClass("orphaned")).toBe("bad");
    expect(statusClass("denied")).toBe("bad");
    expect(statusClass("recovering")).toBe("warn");
    expect(statusClass("something-new")).toBe("muted");
  });
});

describe("status colors", () => {
  test("uses one token color per shared status class", () => {
    expect(statusColors.ok).toBe("var(--success, #0b5b57)");
    expect(statusColors.warn).toBe("var(--warning, #8c5a08)");
    expect(statusColors.bad).toBe("var(--danger, #a4442a)");
    expect(statusColors.muted).toBe("var(--text-muted, #665f54)");
    expect(statusColors.run).toBe("var(--brand, #0f766e)");
    expect(statusColors.running).toBe(statusColors.run);
    expect(statusColors.cancelled).toBe(statusColors.muted);
  });

  test("routes aliases through statusClass before choosing a color", () => {
    expect(statusColor("RUNNING")).toBe(statusColors.run);
    expect(statusColor("in_progress")).toBe(statusColors.run);
    expect(statusColor("produced")).toBe(statusColors.ok);
    expect(statusColor("cancelled")).toBe(statusColors.muted);
    expect(statusColor("something-new")).toBe(statusColors.muted);
  });
});

describe("formatStatus", () => {
  test("maps known statuses and title-cases unknowns", () => {
    expect(formatStatus("waiting-approval")).toBe("Waiting for approval");
    expect(formatStatus("waiting-quota")).toBe("Waiting on quota");
    expect(formatStatus("continued")).toBe("Continued");
    expect(formatStatus("succeeded")).toBe("Complete");
    expect(formatStatus("succeeded-with-failures")).toBe("Completed with failures");
    expect(formatStatus("stale")).toBe("Stale");
    expect(formatStatus("orphaned")).toBe("Orphaned");
    expect(formatStatus("recovering")).toBe("Recovering");
    expect(formatStatus("denied")).toBe("Denied");
    expect(formatStatus("ok")).toBe("Complete");
    expect(formatStatus("some-new-state")).toBe("Some New State");
    expect(formatStatus(undefined)).toBe("Unknown");
  });
});

describe("isTerminalRunStatus", () => {
  test("finished, failed, and cancelled are terminal", () => {
    expect(isTerminalRunStatus("ok")).toBe(true);
    expect(isTerminalRunStatus("finished")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true);
    expect(isTerminalRunStatus("skipped")).toBe(true);
    expect(isTerminalRunStatus("continued")).toBe(true);
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("succeeded-with-failures")).toBe(true);
  });

  test("pins terminality across the DB run vocabulary", () => {
    // The canonical DB_RUN_ALLOWED_STATUSES (packages/db) — hardcoded here to
    // avoid a ui->db dependency-boundary violation. Only the finished/failed/
    // cancelled/continued end-states are terminal; every waiting/paused/running
    // status is still in-flight.
    const dbRunStatuses = [
      "running",
      "waiting-approval",
      "waiting-event",
      "waiting-timer",
      "waiting-quota",
      "paused",
      "finished",
      "failed",
      "cancelled",
      "continued",
    ];
    const terminal = new Set(["finished", "failed", "cancelled", "continued"]);
    for (const status of dbRunStatuses) {
      expect(isTerminalRunStatus(status)).toBe(terminal.has(status));
    }
  });

  test("in-flight and unknown statuses are not terminal", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("waiting-approval")).toBe(false);
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("recovering")).toBe(false);
    expect(isTerminalRunStatus("stale")).toBe(false);
    expect(isTerminalRunStatus("orphaned")).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
    expect(isTerminalRunStatus("")).toBe(false);
  });
});
