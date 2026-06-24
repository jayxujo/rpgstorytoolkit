# RPG Story Toolkit

**Worldbuilding your game engine can read.**

A story and worldbuilding tool for game developers, game masters, and writers.
Write your story, lore, and dialogue, define your characters, items, and
locations as structured data, link the two together, and visualize it all on a
timeline and world map.

- **Web:** [app.rpgstorytoolkit.com](https://app.rpgstorytoolkit.com)
- **Site & desktop download:** [rpgstorytoolkit.com](https://rpgstorytoolkit.com)

---

## Why it's open

I'm a game developer. I built RPG Story Toolkit to help me write and organize my
own RPG, and figured other people might get something out of it too. So it's
here, free and open.

If you've got specific needs for your own game or project, dig in and adapt it
however you like. The license just asks that you don't sell it or run it as a
commercial service (see [License](#license)).

## What it does

- **Write & link** — a clean rich-text editor for story, lore, and dialogue.
  Highlight any passage and link it to a character, item, or location.
- **World database** — define tables (characters, items, locations, calendars,
  anything) with the fields you choose. Your documents reference records
  directly.
- **Timeline & world map** — drop documents and records into ordered timeline
  sections to check continuity, and pin places on your own map images.
- **Dialogue pipeline** — author dialogue once, tag it by speaker and scene, and
  export it as structured, engine-readable JSON.
- **Publish a wiki** — turn your world into a clean, browsable public wiki in one
  click.

## Local-first, engine-readable

This is the part game developers care about. The **desktop app** stores your
whole project as a folder of **plain files on your own computer**:

```
your-project/
  documents/<folder>/<doc>.md        # Markdown, with entity links
  tables/<folder>/<table>.json       # arrays of records
  dialogue/dialogue.json             # self-describing, keyed by speaker + fields
  assets/<table>/<recordId>/<file>   # uploaded images and files
```

Your game engine can read these files **live**, with no exporter and no
copy-paste. Edit a value in the app, save, and it's there on the next run. You
own the files; nothing locks you in.

## Two products, one codebase

- **Web app** — React 19 + TypeScript (Vite), Supabase backend, deployed on
  Vercel.
- **Desktop app** — the same frontend wrapped in [Tauri 2](https://tauri.app)
  (`src-tauri/`), using a local vault folder instead of the cloud. A runtime
  platform abstraction (`src/platform/`) decides storage: Supabase on web, local
  files on desktop.

## Getting started

Requirements: [Node.js](https://nodejs.org) (18+) and npm. For the desktop app
you'll also need [Rust](https://rustup.rs) (for Tauri).

```bash
npm install

npm run dev          # web dev server with hot reload
npm run build        # type-check + production build
npm run lint         # eslint

npm run tauri dev    # run the desktop app (compiles src-tauri)
npm run tauri build  # build a desktop bundle
```

The web app expects a Supabase project. Copy `.env.example` if present, or set:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

The desktop app needs no backend to run, since it stores everything in a local
folder you choose.

## Project layout

```
src/                 React app (editor, database, timeline, world map, wiki)
src/platform/        web (Supabase) vs desktop (local vault) storage
src-tauri/           Tauri 2 desktop shell + Rust file commands
```

## Contributing

This is primarily a one-person project shared in the open. You're welcome to
open issues or PRs, but please keep in mind the license below and that I may not
merge everything. If you build something cool on top of it, I'd love to hear
about it.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE).

You can read, modify, and use this software freely for **noncommercial**
purposes, including personal and hobby projects. You **cannot** use it
commercially, including selling it or running it as a paid or competing service.
See [`LICENSE`](./LICENSE) for the full terms.
