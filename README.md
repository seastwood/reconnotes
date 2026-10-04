# ReconNotes

Offline-first notes for **iPhone, iPad and the web**, with **Apple Pencil** drawing, a
**self-hosted Linux server** for sync and backups, and **AI handwriting recognition**
(Claude or your own local Ollama model).

It's built for one person's daily notes, and anyone can run it.

- **Always works offline.** Every note lives on the device first. When the device reaches your
  server, it syncs automatically.
- **No lost edits.** If you edit the same note on your iPhone and iPad while offline, both
  sets of changes are kept when they sync. Notes are CRDTs ([Yjs](https://yjs.dev)), so merging
  never throws work away. That includes ink: strokes drawn on two devices are merged stroke by
  stroke.
- **Folders inside folders.** Drag and drop to nest and reorder them. Each folder can sort by
  manual order, title, date created or date edited.
- **Apple Pencil.** Pressure-sensitive pen, pencil, marker and highlighter. Eraser that removes
  whole strokes or pixels. Lasso to select, move, recolour or delete ink. Palm rejection (once a
  Pencil is used, fingers scroll). Pencil **double-tap** follows your iPad setting (switch to
  eraser, previous tool, or palette). **Squeeze** on Apple Pencil Pro opens a palette with
  undo/redo, tools, colours and sizes. The Pencil can start a drawing anywhere in a note, or you
  can use iPadOS Scribble instead.
- **Typing.** Title, Heading, Subheading, Body and Monospaced styles; bold, italic, underline and
  strikethrough; bulleted, numbered and **checklist** items (type `[ ] ` to start one), and block
  quotes.
- **Pictures, screenshots, audio and files.** Paste, drag in, pick from Photos or Files, take a
  photo, or record audio. Attachments are stored offline and uploaded later.
- **Undo** is always one tap away, in the toolbar and in the drawing tools. Text and ink share one
  undo history.
- **Search everything.** One search covers typed text, handwriting (recognised automatically),
  text in images, screenshots and charts, PDFs, and audio transcripts. Search works offline too.
- **AI.** *Convert to text* turns a drawing into clean typed text. *Compile* turns a whole note,
  handwriting and typing, into a tidy new document.
- **Backups.** Scheduled snapshots of the database, plus a plain **Markdown export** of every note
  in its folder structure, readable without ReconNotes.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  iPhone app  │  │   iPad app   │  │ Web browser  │   each keeps a full local copy
│ (IndexedDB)  │  │ (IndexedDB)  │  │ (IndexedDB)  │   in IndexedDB and works offline
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │  Yjs updates over one WebSocket, when online
       └─────────────────┼─────────────────┘
                ┌────────▼─────────┐        ┌──────────────────────┐
                │ ReconNotes server│───────▶│ Claude API (optional)│
                │  (your Linux box)│        └──────────────────────┘
                │  SQLite + files  │        ┌──────────────────────┐
                │  search, backups │───────▶│ Ollama (optional)    │
                └──────────────────┘        └──────────────────────┘
```

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/core` | Shared data model: folder tree, notes, ink, text/Markdown extraction (used by the server and the app) |
| `apps/server` | The self-hosted sync, backup, search and AI server (Node.js, SQLite) |
| `apps/web` | The app (React + TipTap). Runs in a browser, installs as a PWA, and is wrapped for iOS |
| `apps/web/ios` | The native iOS/iPadOS project (Capacitor), including the Apple Pencil side-button bridge |
| `deploy/` | systemd unit |
| `docs/ARCHITECTURE.md` | How sync, conflict handling, ink, search and AI work |

## Quick start (development)

```bash
npm install
npm test                       # unit + integration tests

# terminal 1: the server
export RECON_TOKEN=$(npx tsx apps/server/src/index.ts gen-token)
echo "token: $RECON_TOKEN"
npm run dev:server             # http://localhost:8787

# terminal 2: the app
npm run dev:web                # http://localhost:5173
```

Open the app, go to **Settings**, enter `http://<your-machine>:8787` and the token, then press
**Save & connect**. Without a server, everything works and stays on that device.

## Running the server on Linux

You need Node.js 20 or newer (or Docker).

### Option A: Docker

```bash
cp apps/server/.env.example .env      # set RECON_TOKEN (and the AI options you want)
docker compose up -d
```

The image also serves the web app, so `http://your-server:8787` is the app itself.

### Option B: systemd

```bash
npm ci && npm run build
sudo useradd --system --home /var/lib/reconnotes --create-home reconnotes
sudo mkdir -p /opt/reconnotes && sudo cp -r . /opt/reconnotes
sudo cp apps/server/.env.example /etc/reconnotes.env && sudo nano /etc/reconnotes.env
sudo cp deploy/reconnotes.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now reconnotes
```

### Reaching the server from your phone

Use HTTPS anywhere outside your home network. The easiest options:

- **Tailscale** (recommended): install it on the server and your devices, then use
  `https://<machine>.<tailnet>.ts.net` (`tailscale serve 8787`).
- Or put it behind a reverse proxy such as Caddy:
  `notes.example.com { reverse_proxy localhost:8787 }`.

On your home LAN, plain `http://192.168.x.x:8787` also works.

### Server commands

```bash
node apps/server/dist/index.js serve      # default
node apps/server/dist/index.js backup     # write a backup now
node apps/server/dist/index.js reindex    # rebuild the search index
node apps/server/dist/index.js gen-token  # print a random token
```

## AI: Claude and/or a local Ollama model

All AI runs on the server, so the token for Claude and the connection to Ollama never live on
your devices. Each task can use a different backend:

| Task | What it does | Backends |
| --- | --- | --- |
| Handwriting | *Convert to text*, plus automatic recognition so handwriting is searchable | Claude or Ollama |
| Images | OCR and a short description of photos, screenshots and charts, for search | Claude or Ollama |
| PDFs | Text extraction for search | Claude |
| Compile | Turns a whole note into a clean document | Claude or Ollama |
| Audio | Transcripts for search | Any OpenAI-compatible speech-to-text server (e.g. a local Whisper server) |

### Using your Ollama model (e.g. `HSR-DeepThink/strike-ocr`)

1. On the Ollama machine, let Ollama listen on the network (by default it only accepts local
   connections):

   ```bash
   sudo systemctl edit ollama
   # add:
   # [Service]
   # Environment="OLLAMA_HOST=0.0.0.0:11434"
   sudo systemctl restart ollama
   ```

   Check it from the ReconNotes server: `curl http://ollama-handwriting-to-text:11434/api/tags`.

2. In the server's `.env`:

   ```bash
   RECON_OLLAMA_URL=http://ollama-handwriting-to-text:11434
   RECON_OLLAMA_MODEL=HSR-DeepThink/strike-ocr:latest   # reads handwriting and images
   # An OCR model is not good at writing documents; for "Compile" use a general model…
   RECON_OLLAMA_TEXT_MODEL=qwen3:8b
   # …or use Claude for compile and keep handwriting local:
   # ANTHROPIC_API_KEY=sk-ant-...
   # RECON_HANDWRITING_PROVIDER=ollama
   # RECON_IMAGE_PROVIDER=ollama
   # RECON_COMPILE_PROVIDER=anthropic
   ```

3. Restart the server. The startup log shows which backend handles each task, and the app's
   **Settings › Test connection** shows which AI features are on.

If your OCR model works better with a short instruction, set
`RECON_OLLAMA_HANDWRITING_PROMPT="Transcribe the handwritten text in this image."`. Reasoning
output in `<think>` blocks is stripped automatically.

### Using Claude

Set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5` (change it with
`RECON_AI_MODEL`, and the depth with `RECON_AI_EFFORT=low|medium|high`).

Automatic handwriting recognition runs after you stop writing for 90 seconds, and only when a
drawing has changed. Turn it off with `RECON_AUTO_HANDWRITING=false` to control costs.

## The iPhone and iPad app

The iOS app is the same web app in a native shell
([Capacitor](https://capacitorjs.com)), plus a small Swift bridge that forwards Apple Pencil
double-tap and squeeze to the app. You need a Mac with Xcode 16+ and an Apple ID.

```bash
npm install
npm run ios:sync -w @reconnotes/web    # build the app and copy it into the Xcode project
npm run ios:open -w @reconnotes/web    # opens Xcode
```

In Xcode, select the **App** target › *Signing & Capabilities*, choose your team, plug in your
iPad, and press Run. A free Apple ID works, but the app must be re-installed every 7 days; a paid
developer account removes that limit and allows TestFlight.

**No Mac?** Serve the web app from your server, open it in Safari on the iPad, and use
*Share › Add to Home Screen*. It works offline and supports Apple Pencil pressure, but Pencil
double-tap and squeeze need the native app. Serve it over HTTPS (e.g. Tailscale); browsers only
allow offline app caching on secure origins.

## Tests

```bash
npm test                 # core + server: CRDT merges, folders, search, attachments, backups, Ollama
npm run build && npm run e2e   # browser test: two devices, offline edits, drawing, undo, search
```

## License

MIT
