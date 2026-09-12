# Recording the demo video

Different problem from `DEMO.md`. On stage, judges scan the QR and supply the
other phones. On video there is nobody to scan, so **you** have to produce a
room full of devices, and the whole point of the project is that there is more
than one.

Target **2 to 3 minutes**. Nobody watches more.

---

## The one trick that makes this recordable

A device is identified by a uuid in `localStorage`, and `localStorage` is
**per origin**. Two tabs on the same origin are therefore the *same* device: the
second inherits the first's id and host flag and opens as host again, and the
roster never leaves one.

But several different origins can point at the **same dev server**, and each one
gets its own storage. So one laptop gives you four independent participants:

| Window | URL | Role on camera |
| --- | --- | --- |
| 1 | `http://localhost:3000` | **host** — the commander console |
| 2 | `http://127.0.0.1:3000` | responder |
| 3 | `http://172.26.43.73:3000` | responder |
| 4 | the `trycloudflare.com` tunnel URL | responder |

All four hit the same `npm run dev`, so they share one scene. Get your LAN IP
with `ipconfig getifaddr en0`.

Private/incognito windows and a second browser (Safari, Firefox) work the same
way if you want more.

**Only window 1 gets `?host=1`.** The others open `/scene/<CODE>` plain.

---

## Setup, in order

1. `npm run dev` in one terminal. `bash scripts/tunnel.sh` in another.
2. Open the four windows above. Tile them: host large on the left, the three
   responders stacked on the right. The shot you want is **four different jobs
   appearing at once**.
3. **Click once in every window.** Browsers block audio until the page has been
   interacted with. A silent demo is a dead demo, and this is the single most
   common way it fails.
4. Mute notifications: Focus mode on, quit Slack, Mail and Messages. A banner
   sliding in over your commander console is the one thing you cannot edit out.
5. Do a throwaway take. Always. The first one is always rough.

---

## Recording it

**Screen + system audio (recommended).** The phones speaking their own jobs is
the demo, so you must capture system audio, not just the mic. QuickTime's screen
recording captures the **mic only** — it will not record what your speakers are
playing.

Easiest paths:

- **Zoom or Google Meet**: start a meeting alone, Share Screen with **Share
  sound** ticked, hit Record. Captures screen, system audio and your voice-over
  together. No installs, and you probably already have it.
- **OBS** (free): add a Display Capture source plus a macOS Audio Capture
  source. More control, more setup.
- **Cmd+Shift+5** (built-in): fine for a silent screen capture, but it will not
  get the spoken assignments. Use only if you narrate over it instead.

Either way: record the **full screen**, not a window, so the four tiled windows
are all in frame.

---

## Shot list

### 0:00–0:20 — The problem
Static on the host screen, scene not started. Say it plainly:

> If someone collapses here, the problem is not that nobody knows CPR. It is
> that nobody knows who is doing what. A 911 dispatcher can coach one caller.
> Nobody is commanding the room.

### 0:20–0:40 — Start the scene
Press **Start a scene**. The code and QR appear. Say that anyone in earshot
joins on their own phone, no install, no account.

### 0:40–1:20 — The money shot
Bring up windows 2, 3 and 4 on `/scene/<CODE>`. Let the audio play.

Four screens, four different jobs, four phones speaking at once. **Do not talk
over this.** Let it run. This is the only part of the video nobody else has.

Then point at **COMMANDER REASONING** and read K2's actual sentence aloud — the
one naming people and explaining the trade-off.

### 1:20–1:50 — It reacts
Two beats, pick either or both:

- On a responder window, hit **swap me out**. The host reassigns; that person is
  taken off the chest.
- **Close a responder window entirely.** About ten seconds later the host
  notices the phone is gone and backfills the job. That is the bystander
  problem solving itself on camera.

### 1:50–2:20 — Degradation, on purpose
Host → **Simulate network loss**. The plan goes on-device, the metronome keeps
its beat, the banner says what happened.

> When the network dies, it does not show you a spinner. It keeps counting.

### 2:20–2:45 — The handoff
Host → **EMS handoff**. Scroll the timestamped record slowly enough to read.

> The first five minutes of an emergency are the last uninstrumented part of
> medicine. After the medics arrive, everything is logged. Before they arrive,
> nothing. This is that window, recorded.

### Close
Say the disclaimer out loud, once: a simulation, not a medical device, always
call 911. Judges notice when you volunteer it.

---

## Things that will ruin a take

- **No sound.** Click in each window first. Check with headphones before the
  real take.
- **A notification banner.** Focus mode.
- **Reloading the host window mid-scene.** The scene lives in memory. Reloading
  the host ends it.
- **K2 answering slowly.** It takes 5 to 13 seconds and sometimes falls back to
  the deterministic planner. Do not cut the take. Either wait and let `PLAN BY`
  flip to the model id on camera, or narrate it: the instant plan is on-device
  and the model upgrades it, so nobody ever waits on a model to start
  compressions. That is true and it is a better line than a clean take.
- **Recording the tunnel URL on screen.** It dies when you close the laptop.
  Prefer the Render URL in any shot where the address bar is readable.
