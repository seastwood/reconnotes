# AI agents

AI runs on your server and is set up in the app under **Settings › AI agents**: handwriting to text, cleaning up converted text, text in pictures and PDFs, summaries, *Ask your notes*, search by meaning, and transcribing recordings. Keys stay on the server.

## Ollama on your own machine

On the Ollama machine, let other machines connect:

```bash
sudo systemctl edit ollama
# add:
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
```

Then in **Settings › AI agents**, add an **Ollama** agent with the address `http://<ollama address>:11434` and press **Test connection**: it lists the installed models to choose from.

| Job | A good local model |
| --- | --- |
| Handwriting, pictures | a vision model, e.g. `qwen2.5vl:7b` |
| Summaries, Ask your notes, cleaning up text | a text model, e.g. `qwen2.5:3b` or larger |
| Search by meaning | `nomic-embed-text` |

## Claude

Add a **Claude** agent with an Anthropic API key. Set a monthly spending limit on its card if you like.

## Who does what

Each task has its own list of agents: the first enabled one is tried first, and if it fails the next takes over. An agent's card shows its last error. A GPU with 8 GB holds one vision model at a time; ReconNotes unloads and loads models as jobs need them, and the **Jobs** view shows what's running.

## Recordings

- In the iPhone / iPad app, Apple's speech recognition transcribes on the device.
- On the server, use any OpenAI-compatible speech-to-text server (e.g. a self-hosted Whisper), or a Home Assistant Whisper (**Wyoming**) agent at `tcp://<address>:10300`, which needs `ffmpeg` on the ReconNotes server.

For the best transcripts, run Whisper on your own GPU: [[Speech to text with Speaches]] sets it up step by step. The README's "AI agents" section covers running it with Docker instead.
