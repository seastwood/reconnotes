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
- **AI.** *Convert to text* turns a drawing (or just the writing you lasso) into clean typed text.
  *Compile* turns a whole note, handwriting and typing, into a tidy new document. *Ask your notes*
  (or *Ask about this note* in the ⋯ menu) answers from your own notes as it's written, with
  sources and follow-up questions. Under each note, *Related notes* are found by meaning.
- **Meetings.** *New meeting* (the people icon above the note list) makes a meeting note and starts
  recording; when you stop, you get a summary, decisions and action items with due dates.
- **Every day and week.** *Today* opens your daily note, with yesterday's unfinished to-dos carried
  over. *Tasks* lists every checklist item in every note. Your dated to-dos can appear in Apple or
  Google Calendar (*Settings › Calendar & weekly digest*), and a weekly digest note sums up the
  week.
- **Jobs.** Every AI request and processing step is a job in one queue on the server (one at a
  time, so a local GPU isn't overloaded). *Jobs* in the sidebar shows what's running and for how
  long, which model is working on it, what's waiting and what finished – with links to the
  results and full error messages. Cancel, pause, run next, retry, remove a result, or redo a
  job with extra instructions ("it's a shopping list", "keep my bullet points") to replace its
  result. Jobs finish even if you close the app: the server writes the results into the note.
- **Notifications.** *Settings › Notifications*: a notification when a job you started finishes
  or fails, even with the app closed. With a paid Apple developer account your server sends them
  straight through Apple, like any other app's (see *Notifications from your server* below);
  otherwise through the free [ntfy](https://ntfy.sh) app, the Home Assistant companion app, or a
  webhook. Tapping one opens the note (or the answer, for *Ask your notes*).
- **Backups you can restore.** Scheduled snapshots, plus a plain Markdown copy of every note.
  *Settings › Backups* shows what changed since each backup and restores one note or everything;
  each note's current state goes into its version history first. An *offsite copy* of each backup
  can go to another disk or S3-compatible storage (Backblaze B2, Wasabi, R2…), encrypted if you
  like.
- **Never locked in.** *Settings › Export & import*: every note as Markdown in its folders, with
  pictures, files and drawings, in one zip. It imports Markdown or zips back, including from
  Obsidian, Bear and Notion, with folders, checklists, tables and `[[links]]`.
- **A key per device.** *Settings › Devices*: give each device its own key and switch a lost one
  off on its own. Setup links connect a new device in one tap.
- **Quick and versatile.** ⌘K runs any command or opens any note. You can select several notes, or
  swipe a note for Move, Pin or Delete, and Undo is offered after each. Notes can have tables,
  repeating due dates (`!every monday`) and a calendar. Folders can be *kept offline*, and a single
  note can be shared as a **read-only link**. Saved searches can be pinned to the sidebar as
  smart folders, and folders can have a password (opened with Face ID in the app).
- **iPhone and iPad extras.** Scan documents with the camera, and add notes from the Home Screen or
  Lock Screen widget or from Siri and Shortcuts. Tap your handwriting to hear what was being said
  while you wrote it.

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

Step-by-step setup guides (installing, connecting devices, HTTPS with a private certificate or
with your own domain via Cloudflare + pfSense + HAProxy, AI agents, backups) are in
[`docs/setup`](docs/setup). They also come with the server: on first start they're added as notes
in a **ReconNotes Setup** folder (each once; edit or delete them freely).

You need Node.js 20 or newer (or Docker), and `ffmpeg` if you'll transcribe recordings with a
Wyoming (Home Assistant) Whisper server: `sudo apt install ffmpeg`.

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

#### HTTPS over WireGuard (or any private address)

Public certificate authorities won't issue certificates for private addresses like `10.8.0.1`,
so the server can make its own: a private certificate authority (CA) that only your devices trust.

```bash
cd /opt/reconnotes/apps/server
sudo node dist/index.js https-setup   # finds the server's data folder; every address of this machine, WireGuard's first
#   or name them:  … https-setup 10.8.0.1 notes.home
sudo systemctl restart reconnotes      # now also https on port 8443
```

Then, once per device:

1. Open `http://<address>:8787/ca.crt` in Safari and allow the download.
2. *Settings › General › VPN & Device Management ›* **ReconNotes private CA** *› Install*, then
   *Settings › General › About › Certificate Trust Settings* › turn on **ReconNotes private CA**. (Mac: open it in Keychain Access ›
   Trust › Always Trust.)
3. In ReconNotes › Settings, change the server address to `https://<address>:8443`.

The certificate lasts 825 days (Apple's limit). Run `https-setup` again to renew it or add an
address; devices keep trusting the same CA. Keep `/var/lib/reconnotes/tls/ca.key` private: whoever
has it can make certificates your devices trust. Have a domain of your own? Point a name at the
WireGuard address and get a Let's Encrypt certificate by DNS challenge (e.g. Caddy with a DNS
plugin), then set `RECON_TLS_CERT` / `RECON_TLS_KEY` – nothing to install on devices.

### Server commands

```bash
node apps/server/dist/index.js serve      # default
node apps/server/dist/index.js backup     # write a backup now (and its offsite copy)
RECON_BACKUP_PASSPHRASE=… node apps/server/dist/index.js decrypt <folder>  # open an encrypted offsite copy
node apps/server/dist/index.js reindex    # rebuild the search index
node apps/server/dist/index.js gen-token  # print a random token
node apps/server/dist/index.js https-setup [address …]  # https for a private / WireGuard address
```

## AI agents

AI runs on the server and is configured in the app: **Settings › AI agents**. API keys are stored
on the server and never sent back to your devices.

- **Add as many agents as you like:** Claude (Anthropic API key), Ollama models on your network,
  or anything that speaks the OpenAI API (LM Studio, vLLM, llama.cpp server, OpenRouter, OpenAI).
- **Test connection** checks the address and model, lists the installed models to pick from,
  and explains common problems.
- **Enable or disable** an agent with its switch.
- **Choose who does what.** Each task has its own priority list:

| Task | What it does |
| --- | --- |
| Handwriting to text | *Convert to text*, plus automatic recognition so handwriting is searchable |
| Clean up converted text | Second pass: a general model fixes misread words, rejoins wrapped lines and tidies lists and headings. With no agent here, *Convert to text* uses a *Compile notes* text model that isn't also a handwriting reader |
| Text from images | Reads text in photos, screenshots and charts so search finds them |
| Text from PDFs | Extracts PDF text for search (Claude only) |
| Compile notes | Turns a whole note into a clean document |

  The first enabled agent in a list is tried first. If it fails (unreachable, timed out, wrong
  model, refused), the next one takes over automatically. The last error shows on the agent's
  card.
- **Reading style.** OCR models read letters well but lose page layout. With *line by line*
  (the default for non-Claude agents), ReconNotes finds each written line, bullet and indent
  from your pen strokes, reads the lines one at a time and rebuilds the nested lists itself.
  Unchanged lines are not re-read. *Whole page* suits general vision models like Claude.
- Agents that can't read images still work for *Compile*: the server transcribes the
  handwriting with your handwriting agents first and hands them text.

### Connecting your Ollama machine

Ollama only accepts connections from its own machine unless told otherwise. On the Ollama
machine:

```bash
sudo systemctl edit ollama
# add these two lines, then save:
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
```

Then add an **Ollama** agent with the address `http://<ollama-machine-ip>:11434` and press
**Test connection**. If your OCR model works better with a short instruction, set one under
*Advanced › Handwriting prompt*.

### Audio to text

**Already running Home Assistant's Whisper (`wyoming-faster-whisper`)?** Use it: add an agent of
kind **Wyoming speech-to-text**, address `tcp://<whisper-ip>:10300` (find the port with
`ss -tlnp` on that machine) and press **Test connection**. The ReconNotes server converts
recordings with `ffmpeg` (`sudo apt install ffmpeg`), and Home Assistant keeps working as before.

Every recording and audio file has a **Transcribe** button that puts the spoken words into the
note below it. In the iPhone/iPad app Apple's speech recognition does this on the device. The
web app, and the iPad app when Apple can't read a file, use the server's **Audio to text**
agents: any OpenAI-compatible speech-to-text server. Ollama and Claude can't transcribe audio.

**Meetings** are always transcribed by the server's Audio to text agent when there is one (Apple's
recognition is made for dictation, not a room of people – it's only used when the server can't).
The names and terms in *Settings › AI agents › Your words* are passed to Whisper as a hint, so it spells them
right. A long meeting is read in parts of about eight minutes, each written up, then put together –
so the end of a long meeting is covered as well as its start.

A self-hosted Whisper server next to ReconNotes (uses the GPU if Docker has access to it):

```bash
docker run -d --name speaches --restart unless-stopped --gpus all -p 8000:8000 \
  ghcr.io/speaches-ai/speaches:latest-cuda
# download a model once (use the :latest-cpu image instead if there's no NVIDIA GPU)
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small
```

Then add an agent: kind **OpenAI-compatible**, address `http://<server-ip>:8000/v1`, model
`Systran/faster-whisper-small` (or `-medium` / `deepdml/faster-whisper-large-v3-turbo-ct2` for
better accuracy).

Which model: for meetings, use **`deepdml/faster-whisper-large-v3-turbo-ct2`** – far more accurate
than *small* or *medium* on several people talking at a distance, and fast. It needs about 2 GB of
GPU memory (int8), so it fits next to an 8B language model on an 8 GB card. On an older NVIDIA card
(GTX 10-series) start the container with `-e WHISPER__COMPUTE_TYPE=int8`: those cards are slow at
16-bit maths. Without a GPU, use `Systran/faster-whisper-small` – large models are too slow on a CPU
for a long meeting. Agents whose model name contains "whisper" are put on *Audio to text*
automatically. OpenAI itself works too (`https://api.openai.com/v1`, model `whisper-1`).
With an agent set up, new recordings are also transcribed in the background so search finds
them. The old `RECON_TRANSCRIBE_URL` setting is turned into such an agent on start.

Older setups that used `ANTHROPIC_API_KEY` / `RECON_OLLAMA_*` environment variables are imported
as agents on first start; after that the app is in charge.

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

**Apple's on-device handwriting recognition.** In the iOS/iPadOS app, *Convert to text* (for
drawings and pictures) and the background recognition that makes handwriting searchable use
Apple's Vision text recognizer, which runs on the iPad itself: fast, private, free and offline.
ReconNotes still works out the structure (lines, bullets, indentation) from your strokes and only
asks Apple to read each line. The text is synced, so it's searchable on every device, and the
server skips its own recognition for those drawings. Your server's AI agents are used when Apple
finds nothing, or in the web app. Settings › *Handwriting recognition on this device* switches it
off or adds a polish pass with your clean-up agent.

**Open in ReconNotes.** Files, Mail and other apps offer *Open in… / Copy to ReconNotes* for
pictures, PDFs, recordings and other files: each becomes a new note. Nothing to set up.

**Share → ReconNotes (share sheet) and the Quick capture widget.** To share links from Safari,
photos from Photos, recordings from Voice Memos and so on, and to get the Home Screen and Lock Screen
widget, add the app extensions once, on the Mac:

```bash
gem install --user-install xcodeproj                      # once (or: sudo gem install xcodeproj)
npm run ios:add-extensions -w @reconnotes/web
```

This adds the *ShareExtension* and *ReconNotesWidget* targets, embeds them in the app, and gives
the app and the share extension the App Group `group.com.reconnotes.app`. Everything is signed with
the App target's team. Then run the app from Xcode as usual. It's safe to run again after updates.

**Notifications from your server (push).** Real iPhone / iPad notifications, sent by your server
straight to Apple's push service – no other service. Needs a paid Apple Developer Program
membership (Apple doesn't allow push for apps signed with a free Apple ID).

1. On developer.apple.com: *Certificates, IDs & Profiles › Keys › ＋*, tick *Apple Push
   Notifications service (APNs)*, and download the `.p8` key. Note its Key ID and your Team ID.
2. On the Mac, switch push on for the app once, then build and run from Xcode:
   ```bash
   npm run ios:enable-push -w @reconnotes/web
   ```
   (Or in Xcode: *App target › Signing & Capabilities › ＋ Capability › Push Notifications*.)
3. In the app: *Settings › Notifications*, enter the Key ID, Team ID and the `.p8` contents (once,
   from any device), then tick *Notify me when a job I started here finishes* on each iPhone / iPad
   and tap *Send a test*.

Each device gets notifications for the jobs it started, and none while it's open on screen (it
shows the result itself). Builds from Xcode and TestFlight builds both work.

`npm run ios:setup -w @reconnotes/web` (share extension, widget, push) switches push on only when
your signing team can have it: a free Apple ID (Personal Team) can't, so it's left off (or taken
off again) – use ntfy or the Home Assistant companion app instead (*Settings › Notifications ›
Server notifications*). `npm run ios:disable-push` takes it off by hand.

**Siri and Shortcuts.** *"New note in ReconNotes"*, *"Record a ReconNotes voice note"* and
*"Scan into ReconNotes"* work with Siri, Spotlight, the Action button and the Shortcuts app with no
setup. The links `reconnotes://new?text=…`, `reconnotes://record` and `reconnotes://scan` also work
from anywhere.
(By hand instead: *File › New › Target › Share Extension* named **ShareExtension**, run
`sh apps/web/ios/App/ShareExtension-src/install.sh`, and add the App Group to both targets.)

Shared things land in a new note the next time you open ReconNotes. App Groups need a paid
Apple developer account; with a free Apple ID, use *Open in ReconNotes* instead.

**No Mac?** Serve the web app from your server, open it in Safari on the iPad, and use
*Share › Add to Home Screen*. It works offline and supports Apple Pencil pressure, but Pencil
double-tap and squeeze need the native app. Serve it over HTTPS (e.g. Tailscale); browsers only
allow offline app caching on secure origins.

## Tests

```bash
npm test                 # core + server: CRDT merges, folders, search, attachments, backups, restore, export/import, device keys, share links
npm run build && npm run e2e   # browser test: two devices, offline edits, drawing, undo, search
```

Every push runs these on GitHub Actions, plus an iOS simulator build of the app with its extensions
(`.github/workflows/ci.yml`). Swift mistakes show up there, not only on the Mac.

## License

MIT
