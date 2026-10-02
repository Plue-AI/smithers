const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Deterministic human timestamp for the page chrome: "Jul 2, 2026, 07:39 UTC".
 * Always UTC and locale-independent so the same run renders the same bytes on
 * any machine. Invalid input is returned unchanged rather than rendered as NaN.
 */
export function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
