// A note body is edited as "blocks": paragraphs, headings, lists, code fences, tables…
// separated by blank lines. Each block renders formatted until you click into it.

/** Split Markdown into blocks. Fenced code / math blocks are kept whole even if they contain blank lines. */
export function splitBlocks(body: string): string[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (cur.length) blocks.push(cur.join('\n'));
    cur = [];
  };
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const f = /^\s*(```|~~~|\$\$)/.exec(line);
    if (f && !(f[1] === '$$' && line.trim().length > 2 && line.trim().endsWith('$$'))) {
      flush();
      cur.push(line);
      fence = f[1];
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // A heading or a horizontal rule is always its own block.
    if (/^#{1,6}\s/.test(line) || /^(\*\*\*+|---+|___+)\s*$/.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

export function joinBlocks(blocks: string[]): string {
  return blocks.filter((b) => b.trim() !== '').join('\n\n') + '\n';
}

/** Index of the n-th task checkbox line in a block, toggled. */
export function toggleTask(block: string, n: number): string {
  let i = 0;
  return block
    .split('\n')
    .map((l) => {
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(l);
      if (!m) return l;
      if (i++ !== n) return l;
      return `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}`;
    })
    .join('\n');
}

export function countTasks(block: string): number {
  return block.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(l)).length;
}
