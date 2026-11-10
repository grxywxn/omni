import { comingSoon } from './placeholder';

export function mount(el: HTMLElement): void {
  comingSoon(el, {
    icon: 'notes',
    title: 'Notes',
    phase: 'the next update',
    points: [
      'Plain Markdown files in a folder you pick — works side by side with Obsidian',
      'Obsidian: [[links]], backlinks, graph view, tags, daily notes',
      'Notion: slash commands, databases, kanban boards, toggles',
      'Word: rich formatting, comments, page layout, export to .docx / PDF',
      'Scrivener: binder, corkboard, split editor, word targets, snapshots',
      'Campfire: character sheets, timelines, maps, relationship webs',
    ],
  });
}
