// The "/" menu: insert any kind of block (Notion-style), using Obsidian-compatible Markdown.

export interface SlashCommand {
  id: string;
  label: string;
  icon: string;
  keywords: string;
  /** Text to insert; `|` marks where the cursor goes. */
  text: string;
}

export const SLASH: SlashCommand[] = [
  { id: 'h1', label: 'Heading 1', icon: 'H1', keywords: 'title big', text: '# |' },
  { id: 'h2', label: 'Heading 2', icon: 'H2', keywords: 'subtitle', text: '## |' },
  { id: 'h3', label: 'Heading 3', icon: 'H3', keywords: 'small heading', text: '### |' },
  { id: 'bullet', label: 'Bulleted list', icon: '•', keywords: 'ul unordered', text: '- |' },
  { id: 'number', label: 'Numbered list', icon: '1.', keywords: 'ol ordered', text: '1. |' },
  { id: 'todo', label: 'To-do list', icon: '☑', keywords: 'task checkbox', text: '- [ ] |' },
  { id: 'quote', label: 'Quote', icon: '❝', keywords: 'blockquote', text: '> |' },
  { id: 'note', label: 'Callout: note', icon: '💡', keywords: 'callout info box', text: '> [!note] |\n> ' },
  { id: 'tip', label: 'Callout: tip', icon: '✅', keywords: 'callout success hint', text: '> [!tip] |\n> ' },
  { id: 'warning', label: 'Callout: warning', icon: '⚠️', keywords: 'callout caution', text: '> [!warning] |\n> ' },
  { id: 'toggle', label: 'Toggle (collapsible)', icon: '▸', keywords: 'details fold collapse', text: '> [!note]- |\n> Hidden content' },
  { id: 'table', label: 'Table', icon: '▦', keywords: 'grid columns', text: '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |' },
  { id: 'code', label: 'Code block', icon: '</>', keywords: 'snippet', text: '```\n|\n```' },
  { id: 'math', label: 'Math equation', icon: '∑', keywords: 'latex katex formula', text: '$$\n|\n$$' },
  { id: 'divider', label: 'Divider', icon: '—', keywords: 'hr line separator', text: '---\n|' },
  { id: 'link', label: 'Link to note', icon: '🔗', keywords: 'wikilink page', text: '[[|]]' },
  { id: 'embed', label: 'Embed note', icon: '⧉', keywords: 'transclude include', text: '![[|]]' },
  { id: 'image', label: 'Image', icon: '🖼', keywords: 'picture photo', text: '![[|]]' },
  { id: 'date', label: 'Today’s date', icon: '📅', keywords: 'now', text: '' },
  { id: 'comment', label: 'Hidden comment', icon: '%%', keywords: 'private note', text: '%% | %%' },
  { id: 'highlight', label: 'Highlight', icon: '🖍', keywords: 'mark', text: '==|==' },
];
