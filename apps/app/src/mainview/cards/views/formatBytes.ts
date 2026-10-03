/** Compact binary counts by default; file and diff cards retain decimal labels. */
export function formatBytes(bytes: number, convention: "binary" | "decimal" = "binary"): string {
  if (convention === "decimal") {
    const index = bytes >= 1_000_000 ? 2 : bytes >= 1_000 ? 1 : 0
    return `${index === 0 ? bytes : (bytes / 1000 ** index).toFixed(1)} ${["B", "kB", "MB"][index]}`
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0
  return `${Number((bytes / 1024 ** index).toFixed(1))} ${units[index]}`
}
