/** "1 file", "3 files", "1 chapter", "2 areas" — count included. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
