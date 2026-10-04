# Architecture

## Data model

Everything that syncs is a [Yjs](https://yjs.dev) document. Yjs is a CRDT: any two copies of a
document can always be merged, the result is the same on every device, and no edit is dropped.

| Document | Contents |
| --- | --- |
| `workspace` | `folders` and `notes` maps: one nested `Y.Map` per folder or note (name, parent, order, sort mode, pinned, trashed…) and a `settings` map |
| `note:<id>` | `content`: the rich text (a ProseMirror tree in a `Y.XmlFragment`) · `ink:<drawingId>`: one top-level `Y.Array` of strokes per drawing · `drawings`: per-drawing height · `transcripts`: recognised handwriting and text extracted from attachments |

Design decisions that make concurrent offline editing safe:

- **One nested map per folder and note.** Renaming a folder on one device while moving it on
  another merges field by field, so both changes land.
- **Ink in top-level arrays, keyed by drawing id.** Top-level Yjs types are created by name, so
  two devices touching a drawing for the first time can't create competing copies. Strokes are
  immutable values, so concurrent drawing on two devices keeps every stroke. Erasing deletes
  strokes; the pixel eraser replaces a stroke with its remaining pieces.
- **Fractional indexes for manual order** (`order` keys between neighbours), with the id as a
  tie-breaker, so concurrent reorders never need renumbering and every device shows the same
  order.
- **Cycle-safe folder tree.** If two devices move folders into each other while offline, the
  parent pointers form a cycle. `buildTree` detects it and shows one folder of the cycle at the
  top level, so no folder ever becomes unreachable. Folders whose parent was deleted are shown at
  the top level, and so are notes whose folder was deleted.
- **Trash, not delete.** Deleting sets `trashedAt`. Permanent deletion only removes the metadata
  entry, and the note's document stays in the server database and in backups.

## Sync

```
device:  Y.Doc ── y-indexeddb (always) ── HocuspocusProvider ──┐
                                                                ├─ one WebSocket (multiplexed)
server:  Hocuspocus ── onLoadDocument / onStoreDocument ── SQLite (documents table)
```

- Each document is persisted locally in IndexedDB first. The app never waits for the network.
- When a server is configured, every open document is attached to a single multiplexed WebSocket
  (`/sync`). On connect, devices and server exchange state vectors and send only what the other
  side is missing.
- Notes that aren't open are synced in the background (on connect and every 10 minutes, four at a
  time), so every note is available offline on every device.
- Authentication is one shared token (`RECON_TOKEN`), checked for every document on the socket
  and for every HTTP request.
- The server stores the full merged Yjs state per document in SQLite. Storing is debounced
  (1.5–10 s).

## Undo

Each open note has one `Y.UndoManager` scoped to the text fragment and all of the note's ink
arrays. It tracks only local origins (the editor binding and the ink tools), so undo reverts your
last action, typed or drawn, and never another device's edits. Each stroke is its own undo step.

## Ink input

- Coordinates are stored in a fixed 1000-unit-wide space, so drawings scale with the screen.
- Pointer events with `getCoalescedEvents()` capture full-rate Apple Pencil samples, including
  pressure. Strokes are rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand),
  shared with the server so recognised images match the screen.
- Palm rejection: once a pen pointer is seen, touch pointers scroll instead of drawing (unless
  *Draw with finger* is enabled). A non-passive `touchstart` handler stops the Pencil from
  scrolling the page on iOS.
- Pencil side-button gestures arrive from the native shell (`UIPencilInteraction`) as a
  `reconnotes:pencil` DOM event.

## Attachments

Files are stored in IndexedDB with a random id and an `uploaded` flag, then `PUT
/api/attachments/:id` when online. Uploads are idempotent, since attachments are immutable.
Other devices fetch attachments on first view and cache them. On upload the server queues text
extraction (OCR and description for images, text for PDFs, a transcript for audio). The text is
written into each referencing note's `transcripts` map as `att:<id>`, so it syncs and the
offline search finds it.

## Search

- **On device:** a MiniSearch index over each note's extracted text (typed text, transcripts,
  attachment text), persisted in IndexedDB and updated whenever a note changes locally or
  remotely.
- **Server:** an SQLite FTS5 index (porter stemming, diacritic folding), updated whenever a note
  is stored. The app merges server hits with local hits when online.

## AI

The server has a small backend abstraction with two implementations:

- **Claude** (`@anthropic-ai/sdk`, streaming, adaptive thinking, server-side refusal fallback).
- **Ollama** (`/api/chat` with base64 images; `<think>` blocks stripped).

Handwriting, image text and compile can each use a different backend. Drawings are rasterised on
the server (perfect-freehand → SVG → PNG via resvg), cropped to the ink. With Ollama, *compile*
first transcribes each drawing with the OCR model, then gives the text model plain text in
reading order.

Automatic handwriting recognition is debounced per drawing (`RECON_HANDWRITING_DEBOUNCE_MS`) and
skipped when the set of strokes hasn't changed since the last run (tracked by hash in
`drawing_ocr`). AI jobs run one at a time.

## Backups

`runBackup` writes `backups/<timestamp>/reconnotes.db` (SQLite online backup) and
`markdown/…` (every note exported in its folder structure). Attachments are hard-linked or copied
into a shared `backups/blobs/` once. The newest `RECON_BACKUP_KEEP` snapshots are kept. To
restore, stop the server and copy `reconnotes.db` (and `blobs/`) back into the data directory.
