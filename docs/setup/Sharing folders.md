# Sharing folders

Share a folder with someone, and they can read everything in it, read-only and always up to date. That includes its subfolders, notes, pictures, drawings, recordings and files. Nobody else on your server, and nothing else on it, can be reached through their link. Each person gets a link of their own, with an optional passcode, and you can stop each link on its own at any time.

## What they see, and what they can't

- **They see** the folder and its subfolders, every note in them, and the notes' pictures, drawings, recordings (with transcripts) and files, exactly as they are now. A link from one shared note to another works.
- **Recipes have cook mode**: a 🍳 **Cook mode** button on any recipe note (one with *Ingredients* and *Steps*) opens the same view as in the app. It shows all the steps as tiles with the ingredients to tick off, or one step at a time with Next and Back. Tap a tile to see it big. Over `https://` the screen stays on while it's open. Ticks are for that visit and change nothing in your note.
- **They can't** edit anything (cook mode's ticks stay on their screen), search your library, use Ask or the AI, or see version history.
- **They can't reach** notes outside the folder. A link from a shared note to one outside it shows only its words, not the note. Folders with a password (and everything in them) are left out, and so are deleted notes and templates.
- Move a note out of the folder, and it's no longer shared. What's in a shared folder is what's shared, so keep in it only what you mean to share.

## Share a folder

1. In the sidebar, open the folder's **⋯** menu › **Share folder…**
2. Type who it's for (e.g. *Sydney*), and a passcode if you want one. They're asked for it once on each of their devices.
3. **Make their link**. It's copied, ready to send.

The folder shows a 👥 mark in the sidebar. Its **⋯ › Sharing…** shows each person's link and when they last opened it. That's also where you add or change a passcode (a new passcode asks again on every device) and **Stop sharing**, which ends that link at once. **Settings › Data › Shared with others** lists everything that's shared, folders and single notes.

## The share port

Shared links are served on a port of their own, **8790**, which serves shared folders and notes and nothing else. It has no app, no API and no sync, and it never accepts a device key. This is the port to make reachable for the people you share with. Your server's own port (`8787`, or HAProxy's `notes.yourdomain.com`) stays yours alone.

- Change the port with `RECON_SHARE_PORT` (`0` turns it off; links then use the server's own port).
- If the server machine has its own firewall (e.g. `ufw`), allow the port: `sudo ufw allow 8790/tcp`.

Links start with the address you set in the folder's Share dialog (**Change**, under the links), or `RECON_SHARE_URL`. Otherwise they use this server's address on port 8790. Every address that reaches the share port works with the same link: only the start differs. So someone can use `http://192.168.1.20:8790/s/…` at your place and `https://notes-sydney.yourdomain.com/s/…` away from it.

Pick one or more of the ways below.

## On your network

Nothing to set up. On your Wi-Fi, the link is `http://<server LAN address>:8790/s/…`. Set that as the address in the Share dialog if it's the one you'll send.

## Over WireGuard (nothing public)

The safest way: nothing is open to the internet.

1. In pfSense, add a WireGuard peer just for them (*VPN › WireGuard › Peers*), with its own tunnel address (e.g. `10.8.0.50/32`). Send them the config (QR code) for the WireGuard app.
2. *Firewall › Rules › WireGuard*, at the top:
    - **Pass**: source `10.8.0.50`, destination `<server address>`, TCP port `8790`.
    - **Block**: source `10.8.0.50`, any destination.
3. Their link: `http://<server address>:8790/s/…`. WireGuard already encrypts it.

If you'd like them to use a name instead, add a host override in pfSense's DNS resolver (e.g. `share.yourdomain.com`), and give their peer `DNS = <pfSense address>` with a pass rule for DNS (port 53) to pfSense.

## On a domain of its own, through HAProxy (public)

For someone without WireGuard: `https://notes-sydney.yourdomain.com`, with a real certificate. This follows the same setup as [[HTTPS with your own domain]], but this one is reachable from the internet, so it only ever points at the share port.

1. **DNS**: at Cloudflare, an `A` record `notes-sydney` → your WAN address. Either proxied (orange cloud) or DNS only works.
2. **Certificate**: the `*.yourdomain.com` certificate covers it.
3. **HAProxy › Backend** `reconnotes-share`: server `<server address>`, port **`8790`**. Never `8787`.
    - Advanced, *Backend pass thru*: `http-request set-header X-Forwarded-Proto https`. The passcode cookie is then marked secure.
4. **HAProxy › Frontend** on the **WAN** address, port `443`, SSL offloading, the wildcard certificate:
    - ACL: *Host matches* `notes-sydney.yourdomain.com` → backend `reconnotes-share`.
    - Extra safety, in *Advanced pass thru*: `http-request deny unless { path_beg /s/ } || { path /robots.txt }`.
    - Use a **separate** frontend from your private one (which listens on LAN and WireGuard only). Never point the WAN frontend at the `reconnotes` backend.
5. **Firewall › Rules › WAN**: pass TCP `443` to *This firewall*. No port forward is needed: HAProxy runs on pfSense.
6. In a folder's Share dialog, **Change** the address to `https://notes-sydney.yourdomain.com`.

## Check it

```bash
curl -I http://<server address>:8790/s/<link>     # 200
curl -I http://<server address>:8790/api/health   # 404: nothing but shares here
```

| Problem | What to check |
| --- | --- |
| "This isn't shared any more" | The link was stopped, the folder was deleted or given a password, or the note was moved out. |
| Asks for the passcode again | The passcode was changed, or the browser cleared its cookies (or it's a private window). |
| "Too many wrong tries" | 6 wrong passcodes from one address pause it for 15 minutes; 30 on the link from anywhere, for an hour. |
| Connection refused on 8790 | The log line "share links on …" is missing (port in use? set `RECON_SHARE_PORT`), or a firewall blocks it. |
| Links start with the wrong address | Set it in a folder's Share dialog (**Change**), or `RECON_SHARE_URL`. |
