# HTTPS with your own domain

ReconNotes gets a normal Let's Encrypt certificate for a name like `notes.yourdomain.com` while staying private: reachable only on your network and over your VPN, with nothing open to the internet and nothing to install on devices. This guide uses Cloudflare for the domain's DNS and pfSense with HAProxy in front of the server.

**Why nothing is exposed:** Let's Encrypt checks you own the domain by looking up a temporary DNS record that pfSense creates through Cloudflare's API (a DNS-01 challenge). It never connects to your network. The name itself is only answered by your own DNS, and no port is forwarded on the WAN.

## What you need

- A domain whose DNS is at Cloudflare.
- pfSense with the **acme** and **haproxy** packages (*System › Package Manager*).
- WireGuard (or another VPN) that ends on pfSense, with VPN clients using pfSense as their DNS server.
- ReconNotes running at `http://<server address>:8787`.

## 1. A Cloudflare API token

In Cloudflare, go to *My Profile › API Tokens › Create Token › Edit zone DNS*. Limit it to your domain under Zone Resources and create it. Copy the token: pfSense uses it to create the challenge records.

## 2. The certificate (pfSense ACME)

1. *Services › ACME Certificates › Account keys*: add a key for the **Let's Encrypt Production** server and register it.
2. *Certificates › Add*:
    - Domain SAN list: `*.yourdomain.com`, method **DNS-Cloudflare**, with your token and Cloudflare account ID.
    - Add an action: *Shell command* `/usr/local/etc/rc.d/haproxy.sh restart`, so HAProxy picks up each renewal.
3. Save and press **Issue**. Renewal is automatic (every 60 days by default).

A wildcard (`*.yourdomain.com`) keeps "notes" out of the public certificate logs and covers other internal services later.

## 3. The name, answered only inside your network

In *Services › DNS Resolver › Host Overrides*, add host `notes`, domain `yourdomain.com`, IP = **pfSense's LAN address** (where HAProxy listens, often `192.168.1.1`), **not** the ReconNotes server's address. Save and apply. Create no record for it in Cloudflare.

If you do add the record at Cloudflare instead, make it **DNS only** (grey cloud), never proxied: the orange cloud routes traffic through Cloudflare, which needs the site public. pfSense's DNS rebinding protection also blocks public names that point to private addresses, so the host override is the simpler route.

## 4. HAProxy

1. *Services › HAProxy › Backend*, add `reconnotes`:
    - Server: address `<server address>`, port `8787`, Encrypt (SSL) off, and **no client certificate** (the certificate goes on the frontend).
    - Advanced settings, *Backend pass thru*: `timeout tunnel 1h` (keeps the sync connection open) and `http-request set-header X-Forwarded-Proto https` (correct links, such as the calendar feed's).
2. *Frontend*, add one (or add to an existing one):
    - Listen on **LAN address** and the **WireGuard interface address**, port `443`, SSL offloading. **Never WAN.**
    - Certificate: the `*.yourdomain.com` one from step 2.
    - ACL: *Host matches* `notes.yourdomain.com` → backend `reconnotes`.
3. *Settings*: if you attach large recordings or files, raise the max upload size (ReconNotes accepts up to 200 MB by default).
4. If pfSense's own web interface is on port 443, move it first (*System › Advanced › TCP port*, e.g. `8443`).

## 5. Firewall

- *Firewall › Rules › WireGuard* (and LAN): allow TCP to *This firewall* or the LAN address on port `443`.
- Add **no** WAN rules and **no** port forwards.
- To make HAProxy the only way in, allow port `8787` on the ReconNotes server only from pfSense.

## 6. Devices

In **ReconNotes › Settings**, set the server address to `https://notes.yourdomain.com` and tap **Save & connect**. Let's Encrypt is trusted everywhere, so there's nothing to install. If you used [[HTTPS with a private certificate]] before, you can delete its profile (*Settings › General › VPN & Device Management*).

## Check it

From a computer on your network:

```bash
nslookup notes.yourdomain.com                  # answers pfSense's LAN address
curl -v https://notes.yourdomain.com/api/health  # {"ok":true…}
```

- On the VPN: `https://notes.yourdomain.com` opens ReconNotes with a padlock.
- Off the VPN, on mobile data: the name doesn't resolve, or doesn't connect.

| Problem | What to check |
| --- | --- |
| The name doesn't resolve on the VPN | The WireGuard client's DNS isn't pfSense, or the host override is missing. |
| Connection refused or times out | The host override points at the ReconNotes server instead of pfSense, or pfSense's own web interface is still on port 443. |
| 503 Service Unavailable | HAProxy can't reach the backend: check `<server address>:8787` and *Status › HAProxy Stats* (the backend should be UP). |
| Certificate error | The HAProxy frontend isn't using the ACME certificate, or the certificate hasn't been issued yet. |
| Notes don't sync, or sync drops every minute | `timeout tunnel 1h` is missing in the backend. |
| Uploads of big recordings fail | HAProxy's max upload size (step 4.3). |
