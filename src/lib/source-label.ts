// Plain-text display only. React still escapes the result; this never creates HTML.
export function sourceLabel(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    '#39': "'",
    nbsp: ' ',
    lt: '<',
    gt: '>',
  };
  return value.replace(/&(amp|quot|apos|#39|nbsp|lt|gt);/g, (_, name: string) => entities[name]);
}
