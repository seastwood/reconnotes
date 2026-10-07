# Connect your devices

Each device connects with the server's address and a key. Notes are kept on the device too, so it works offline and syncs when it's back.

## The first device

1. Open the app: the iPhone / iPad app, or `http://<server address>:8787` in a browser.
2. In **Settings**, enter the server address (`http://<server address>:8787`, or the `https://` address once you've set up HTTPS) and the `RECON_TOKEN` from `/etc/reconnotes.env`.
3. Tap **Save & connect**. The cloud icon in the sidebar turns green.

## More devices: a key each

In **Settings › Devices**, tap **Add a device**. It gets its own key and a **setup link**: open the link on the new device (the key is only shown then) and it's connected in one tap. A lost device can be switched off on its own there, without changing the others.

## The iPhone and iPad app

The app is built from the repo with Xcode on a Mac (a free Apple account works). The README's "The iPhone and iPad app" section has the steps. After pulling updates: `npm run ios:sync` in `apps/web`, then build in Xcode.

## Away from home

Connect over a VPN such as WireGuard or Tailscale rather than opening the server to the internet. Then set up HTTPS: [[HTTPS with a private certificate]] or [[HTTPS with your own domain]].
