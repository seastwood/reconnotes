# Install the server

ReconNotes runs on any Linux machine with Node.js 20 or newer, or with Docker. Every device syncs through it, and the AI runs on it.

## Option A: systemd (recommended)

1. Get the code and build it:

```bash
sudo git clone https://github.com/seastwood/reconnotes /opt/reconnotes
cd /opt/reconnotes && sudo npm ci && sudo npm run build
```

2. Create the service user and the settings file:

```bash
sudo useradd --system --home /var/lib/reconnotes --create-home reconnotes
sudo cp apps/server/.env.example /etc/reconnotes.env
sudo nano /etc/reconnotes.env
```

Set `RECON_TOKEN` to a long random secret (make one with `node apps/server/dist/index.js gen-token`). Every device needs it once, to connect.

3. Start it, now and at every boot:

```bash
sudo cp deploy/reconnotes.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now reconnotes
```

4. Check it's running: `journalctl -u reconnotes -n 20` shows "listening on http://0.0.0.0:8787". Open `http://<server address>:8787` in a browser: that's the app.

## Option B: Docker

```bash
cp apps/server/.env.example .env      # set RECON_TOKEN
docker compose up -d
```

## Updating

```bash
cd /opt/reconnotes && sudo git pull && sudo npm ci && sudo npm run build
sudo systemctl restart reconnotes
```

Your notes live in `/var/lib/reconnotes` (Docker: the `reconnotes-data` volume) and are untouched by updates.

If you'll transcribe recordings with a Home Assistant Whisper server, also install ffmpeg: `sudo apt install ffmpeg`.

Next: [[Connect your devices]].
