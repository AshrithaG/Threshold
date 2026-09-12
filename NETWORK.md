# Getting judges' phones onto your laptop

The honest summary: **use the tunnel.** Everything else on campus is a coin flip.

---

## Why not CMU wifi directly

`CMU-SECURE` and `CMU-GUEST` both isolate clients from each other. Two devices on
the same SSID generally cannot open a socket to one another, so pointing a phone
at `http://172.x.x.x:3000` usually just hangs. It sometimes works, on some
subnets, which is worse than never working, because it will have worked in
rehearsal.

There is a second, independent reason, and this one is absolute:

> **The camera-based compression coach requires HTTPS.** `getUserMedia` is gated
> behind a secure context. `http://localhost` counts as secure *only on the
> machine serving it*. Every other phone on `http://<lan-ip>:3000` gets no camera
> and no microphone, silently.

So even if client isolation were off, a plain LAN IP costs you the camera beat.

---

## What to actually do

`cloudflared` is installed. Two terminals:

```bash
cd ~/Desktop/Threshold && npm run dev
```

```bash
cd ~/Desktop/Threshold && bash scripts/tunnel.sh
```

The script prints an `https://<words>.trycloudflare.com` URL in a large banner.

**Then the one step people get wrong:** open that HTTPS URL on the host laptop
and start the scene *from there*. The join QR is built from the origin the host
page was served from. Start the scene on `localhost` and the QR encodes
`localhost`, and every phone that scans it loads its own phone's port 3000.

Sanity check before anyone else touches it: scan your own QR with your own phone,
**wifi off, on cellular**. If it loads, the tunnel is genuinely public. If it only
works on wifi, you are still on a LAN address.

---

## Known-good properties of this setup

- Verified end to end over a live tunnel: two devices in one scene, each holding
  a different job, K2 Horizon answering in ~5s.
- Scene sync is a POST up and a short GET on a ~900ms loop, so it passes through
  the tunnel, through proxies, and through captive portals.

## Known-bad, already worked around

- **Server-sent events do not survive the tunnel.** Cloudflare buffers the
  stream: the client gets a 200 and zero frames, with no error on either side.
  This is why the transport polls. Do not "optimise" it back to SSE before the
  demo. `/api/scene/stream` still exists and still works on a local network.
- **A restarted tunnel gets a different URL.** Print the backup QR *after* the
  tunnel is up, not before.
- **Do not run `npm run build` while `npm run dev` is running.** The build
  rewrites `.next` underneath the dev server and every page starts 500ing with
  `Cannot find module './vendor-chunks/...'`. Fix: stop both, `rm -rf .next`,
  start dev again.

---

## Fallbacks, in the order you should reach for them

1. **Phone hotspot.** Laptop joins your phone's hotspot, tunnel over that. This
   also sidesteps any venue filtering of `trycloudflare.com`. Best single
   insurance policy; set it up before you walk in.
2. **Two spare phones already in the scene.** If judges' phones will not join,
   you still have a three-device demo you control. Every later beat works.
3. **Single device.** The host console alone still assigns, speaks, coaches
   compressions on camera, and emits the EMS handoff record. The banner that
   appears is the app reporting the degradation on purpose. Narrate it.
