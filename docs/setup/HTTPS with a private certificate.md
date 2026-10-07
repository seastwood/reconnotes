# HTTPS with a private certificate

Your server makes its own private certificate authority (CA) and a certificate for its private address, then serves ReconNotes at `https://<server address>:8443`. Public authorities like Let's Encrypt won't issue certificates for private addresses such as `10.8.0.1`, so each device trusts your CA once instead.

- Plain `http://<server address>:8787` keeps working, so nothing breaks while you switch over.
- Sync runs over secure websockets automatically.
- The certificate lasts 825 days, the most Apple devices accept.

**Your server address.** Use the address your devices reach the server at. If WireGuard runs on the server itself, that's its WireGuard address (often `10.x.x.x`). If WireGuard runs on your router, it's the server's home-network address (often `192.168.x.x`). The setup command prints the one it chose.

## 1. On the server

```bash
cd /opt/reconnotes/apps/server
sudo node dist/index.js https-setup
sudo systemctl restart reconnotes
```

The command finds the server's data folder itself and covers every address of the machine, WireGuard's first. To name the addresses, add them at the end: `https-setup 10.8.0.1 192.168.1.20`. Check its "Saved in" line says `/var/lib/reconnotes/tls`, and after the restart `journalctl -u reconnotes -n 20` shows a line starting "HTTPS on https://".

## 2. On each iPhone and iPad

1. In **Safari**, open `http://<server address>:8787/ca.crt` and tap **Allow**.
2. Go to **Settings › General › VPN & Device Management**, tap **ReconNotes private CA** under Downloaded Profile, then **Install** (top right). Enter your passcode and tap Install again.
3. Go to **Settings › General › About › Certificate Trust Settings** and turn on **ReconNotes private CA**. The switch only appears once the profile is installed.
4. In **ReconNotes › Settings**, change the server address to `https://<server address>:8443` and tap **Save & connect**.

## 3. On a Mac or other devices

| Device | How to trust the certificate |
| --- | --- |
| Mac | Open `ca.crt` to add it to Keychain Access, double-click **ReconNotes private CA** › Trust › **Always Trust**. |
| Windows | Double-click `ca.crt` › Install Certificate › Local Machine › Trusted Root Certification Authorities. |
| Android | Settings › Security › Encryption & credentials › Install a certificate › CA certificate. |

## Later

- **Renew or add an address:** run step 1 again. The same CA signs the new certificate, so devices need nothing new.
- **Keep the CA key private:** `/var/lib/reconnotes/tls/ca.key` can make certificates all your devices trust. Only `ca.crt` goes to devices.

| Problem | What to check |
| --- | --- |
| Safari says the connection isn't private | Certificate Trust Settings (iPhone step 3) isn't turned on. |
| The app can't connect to `:8443` | The "HTTPS on" log line is missing, or a firewall blocks port 8443. |
| `/ca.crt` says no private CA yet | Step 1's "Saved in" line didn't show `/var/lib/reconnotes/tls`. |
| The certificate name doesn't match | The address you use isn't in it: run step 1 again naming it. |

Prefer nothing to install on devices? See [[HTTPS with your own domain]].
