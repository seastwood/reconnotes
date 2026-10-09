# Start here

These notes came with your ReconNotes server. They cover setting it up and connecting your devices. Edit or delete them freely: the server won't put them back.

1. [[Install the server]]: run ReconNotes on a Linux machine (systemd or Docker).
2. [[Connect your devices]]: the iPhone / iPad app and web app, a key per device.
3. HTTPS: browsers and iOS want it for the microphone, offline use and the clipboard. Pick one:
    - [[HTTPS with a private certificate]]: nothing extra needed; install a profile on each device once. Good for WireGuard or a home network.
    - [[HTTPS with your own domain]]: a domain at Cloudflare plus pfSense and HAProxy; nothing to install on devices. Still private.
4. [[AI agents]]: handwriting to text, summaries, search by meaning and transcription, with Ollama on your own GPU or Claude.
    - [[Speech to text with Speaches]]: Whisper on your own GPU, for accurate transcripts of recordings and meetings.
5. [[Backups and offsite copies]]: what's backed up, restoring, and a second copy somewhere else.

In each guide, `<server address>` means the address your devices reach the server at, like `192.168.1.20` or `10.8.0.1`.
