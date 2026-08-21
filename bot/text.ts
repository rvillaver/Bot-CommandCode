/**
 * Pure text/string helpers used by the bot UI. Kept side-effect-free so they're
 * unit-testable without a Discord client.
 */

/**
 * Split long text into ≤maxLen chunks without splitting in the middle of a line
 * where possible (Discord's 2000-char message cap). Never truncates silently.
 */
export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    // Prefer the last newline within the window; else hard-split at maxLen.
    const cut = rest.lastIndexOf('\n', maxLen);
    const at = cut > 0 ? cut + 1 : maxLen;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Discord channel names: lowercase, no spaces (spaces → dashes), strip specials, max 100 chars. */
export function sanitizeChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  if (!slug) throw new Error('channel name invalid after sanitization');
  return slug;
}
