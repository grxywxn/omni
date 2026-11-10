// Notes created in a brand-new vault: a hands-on tour plus a small example project.

const welcome = `---
tags:
  - omni
---
# Welcome to your notes ✨

Everything here is a plain **Markdown** file in your *Omni Notes* folder: private, offline, and readable by Obsidian or any text editor.

> [!tip] How editing works
> Click any paragraph to edit it. Click away and it turns back into formatted text.
> Press **Enter** at the end of a paragraph to start a new one, and **Shift+Enter** for a new line.

## Try these
- [ ] Type \`/\` at the start of a line to insert headings, to-dos, callouts, tables, maths…
- [ ] Type \`[[\` to link to another note, e.g. [[Amaka Obi]]. Links work both ways (see **Backlinks** on the right).
- [ ] Select some text and use the toolbar for **bold**, ==highlight==, <u>underline</u> or <span style="color:#e03e3e">colour</span>.
- [ ] Select text and click 💬 to leave a **comment**, like in Word.
- [ ] Drag a paragraph by its ⋮⋮ handle to move it.
- [ ] Paste a screenshot straight into a note (Ctrl+V).
- [ ] Add a tag like #idea and find it in the **Tags** tab.

## Shortcuts
| Keys | What it does |
| --- | --- |
| Ctrl N | New note |
| Ctrl Shift N | New note from a template (characters, scenes, events, maps…) |
| Ctrl O | Jump to any note |
| Ctrl Shift F | Search everything |
| Ctrl Shift D | Today's daily note |
| Ctrl G | Graph view |
| Ctrl \\\\ | Split view: two notes side by side |
| Ctrl E | Switch between editing and reading |
| Ctrl Shift Enter | Focus mode |

## The example project
Open the **Story example** folder, then right-click it to try:
- **Open as database**: a table, a Kanban **board** and a **gallery** of your notes (like Notion).
- **Open corkboard**: index cards for each chapter. Drag them to reorder, then **Compile** them into one Word document (like Scrivener).
- **Open timeline**: events in date order (like Campfire).
- **Graph view → Relationship web**: how the characters are connected.

When you're done, delete the example folder (right-click → Move to trash).

$$E = mc^2$$
`;

const amaka = `---
type: character
role: Protagonist
age: 29
pronouns: she/her
aliases:
  - Amaka
relations:
  - "[[Tunde Bello]] — best friend"
  - "[[Mama Nkechi]] — mother"
tags:
  - character
---
# Amaka Obi

> [!quote] In one line
> A city planner who believes Lagos can be fixed one street at a time.

## Personality
- Strengths: stubborn, funny, organised
- Flaws: can't say no

## Backstory
Grew up in Surulere with [[Mama Nkechi]]. Met [[Tunde Bello]] at university.
`;

const tunde = `---
type: character
role: Best friend
age: 30
relations:
  - "[[Amaka Obi]] — best friend"
tags:
  - character
---
# Tunde Bello

Runs a small studio in Yaba. Always has a plan, rarely a backup plan.
`;

const mama = `---
type: character
role: Mother
relations:
  - "[[Amaka Obi]] — daughter"
tags:
  - character
---
# Mama Nkechi

Owns a fabric stall at the market in [[Lagos]].
`;

const lagos = `---
type: location
region: Lagos State
tags:
  - location
---
# Lagos

## Notable places
- The market where [[Mama Nkechi]] trades
- Tunde's studio in Yaba
`;

const ev1 = `---
type: event
date: 2019-09-14
location: "[[Lagos]]"
tags:
  - event
---
# Amaka meets Tunde

At the university entrance, during a power cut.
`;

const ev2 = `---
type: event
date: 2026-03-01
tags:
  - event
---
# The planning commission job

[[Amaka Obi]] gets the job she always wanted, with a catch.
`;

const ch1 = `---
type: scene
status: draft
synopsis: Amaka gets the job. Tunde throws a terrible party.
target: 1500
---
The rain arrived the way bad news does in Lagos: all at once, and with an audience.
`;

const ch2 = `---
type: scene
status: to do
synopsis: The first site visit goes wrong.
target: 1500
---
`;

const order = JSON.stringify({ 'Story example/Chapters': ['Chapter 1.md', 'Chapter 2.md'] }, null, 2);

export const WELCOME_NOTES: Array<[string, string]> = [
  ['Welcome to Omni Notes.md', welcome],
  ['Story example/Characters/Amaka Obi.md', amaka],
  ['Story example/Characters/Tunde Bello.md', tunde],
  ['Story example/Characters/Mama Nkechi.md', mama],
  ['Story example/Places/Lagos.md', lagos],
  ['Story example/Timeline/Amaka meets Tunde.md', ev1],
  ['Story example/Timeline/The planning commission job.md', ev2],
  ['Story example/Chapters/Chapter 1.md', ch1],
  ['Story example/Chapters/Chapter 2.md', ch2],
  ['.omni/order.json', order],
];
