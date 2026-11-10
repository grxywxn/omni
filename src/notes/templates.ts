// Built-in templates (Campfire, Scrivener, Notion-style) plus any notes in the vault's Templates folder.
import { vault } from './vault';
import { notesPrefs } from './prefs';
import { noteName } from './fs';

export interface Template {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Default note name. */
  title: string;
  content: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export const BUILT_IN: Template[] = [
  { id: 'blank', name: 'Blank note', icon: '📄', description: 'An empty page.', title: 'Untitled', content: '' },
  {
    id: 'daily', name: 'Daily note', icon: '📅', description: 'Plan and journal your day.', title: '{{date}}',
    content: `# {{weekday}}, {{longdate}}\n\n## Today's focus\n- [ ] \n\n## Notes\n\n\n## Done\n`,
  },
  {
    id: 'meeting', name: 'Meeting notes', icon: '🗓️', description: 'Agenda, notes and action points.', title: 'Meeting {{date}}',
    content: `---\ntype: meeting\ndate: {{date}}\nattendees: []\n---\n# {{title}}\n\n## Agenda\n1. \n\n## Notes\n\n\n## Decisions\n- \n\n## Action points\n- [ ] Who — what — by when\n`,
  },
  {
    id: 'research', name: 'Research / source note', icon: '📚', description: 'Summarise a book, article or paper.', title: 'Source — ',
    content: `---\ntype: source\nauthor: \nyear: \ntitle: \npublisher: \nurl: \ntags:\n  - source\n---\n# {{title}}\n\n> [!summary] Summary\n> \n\n## Key arguments\n- \n\n## Useful quotes\n> “” (p. )\n\n## How it relates to my work\n\n`,
  },
  {
    id: 'character', name: 'Character sheet', icon: '🧑', description: 'Campfire-style character profile.', title: 'New character',
    content: `---\ntype: character\nrole: \nage: \npronouns: \nimage: \naliases: []\nrelations: []\ntags:\n  - character\n---\n# {{title}}\n\n> [!quote] In one line\n> Who are they, really?\n\n## Appearance\n\n\n## Personality\n- Strengths: \n- Flaws: \n- Quirks: \n\n## Backstory\n\n\n## Goals & motivation\n\n\n## Character arc\n\n\n## Relationships\nAdd lines like \`- [[Name]] — sister\` here, and the same in the \`relations\` property to show them on the relationship web.\n`,
  },
  {
    id: 'location', name: 'Location', icon: '🏙️', description: 'A place in your world.', title: 'New location',
    content: `---\ntype: location\nregion: \nimage: \ntags:\n  - location\n---\n# {{title}}\n\n## Description\n\n\n## History\n\n\n## Notable people\n- \n\n## Story moments here\n- \n`,
  },
  {
    id: 'item', name: 'Item / artefact', icon: '🗝️', description: 'Objects, magic, technology.', title: 'New item',
    content: `---\ntype: item\nowner: \nimage: \ntags:\n  - item\n---\n# {{title}}\n\n## What it is\n\n\n## Origin\n\n\n## Powers / significance\n\n`,
  },
  {
    id: 'event', name: 'Timeline event', icon: '⏳', description: 'Shows on the Timeline view (needs a date).', title: 'New event',
    content: `---\ntype: event\ndate: {{date}}\nlocation: \ninvolved: []\ntags:\n  - event\n---\n# {{title}}\n\n## What happens\n\n\n## Consequences\n\n`,
  },
  {
    id: 'scene', name: 'Chapter / scene', icon: '✍️', description: 'Scrivener-style document with synopsis, status and word target.', title: 'New scene',
    content: `---\ntype: scene\nstatus: to do\nsynopsis: \npov: \ntarget: 1500\n---\n`,
  },
  {
    id: 'map', name: 'Map', icon: '🗺️', description: 'An image you can drop pins on that link to notes.', title: 'New map',
    content: `---\ntype: map\nimage: \npins: []\n---\n# {{title}}\n\nSet the **image** property to a picture in your vault (paste or drag an image into any note first), then click **Add pin** on the map.\n`,
  },
  {
    id: 'project', name: 'Project tracker', icon: '📋', description: 'Notion-style task board page.', title: 'New project',
    content: `---\ntype: project\nstatus: in progress\ndue: \n---\n# {{title}}\n\n> [!info] Tip\n> Open this note's folder as a database (Board layout) to drag tasks between columns.\n\n## Goal\n\n\n## Tasks\n- [ ] \n`,
  },
];

export function fill(text: string, title: string): string {
  const d = new Date();
  return text
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, today())
    .replace(/\{\{time\}\}/g, d.toTimeString().slice(0, 5))
    .replace(/\{\{weekday\}\}/g, d.toLocaleDateString(undefined, { weekday: 'long' }))
    .replace(/\{\{longdate\}\}/g, d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }));
}

/** Built-in templates plus notes in the vault's Templates folder. */
export function allTemplates(): Template[] {
  const folder = notesPrefs.get().templatesFolder;
  const user: Template[] = [...vault.get().notes.values()]
    .filter((n) => folder && (n.folder === folder || n.folder.startsWith(`${folder}/`)))
    .map((n) => ({ id: `vault:${n.path}`, name: noteName(n.path), icon: '🧩', description: 'From your Templates folder', title: noteName(n.path), content: n.text }));
  return [...BUILT_IN, ...user];
}
