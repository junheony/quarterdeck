/** Claude Code's project directory name: every non-alphanumeric code unit → '-'. NFC and NFD spellings differ. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * macOS paths arrive as NFC (typed) or NFD (filesystem, some transcripts): `작업` has two spellings.
 * Compare, group and key paths by this; hand the filesystem/CLI the original string.
 */
export function pathKey(p: string): string {
  return p.normalize('NFC');
}
