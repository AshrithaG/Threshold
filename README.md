# Threshold

An AI incident commander for the bystanders standing over a collapsed person.

One person starts a scene and gets a 4-character join code plus a QR. Everyone else in the
room joins on their own phone. Threshold gives each phone a **different** job (compressions,
fetch the AED, call 911, meet the medics, clear space), speaks that job aloud on that
specific phone, watches compression rate through the camera, and reassigns live when someone
walks away or gasses out. Every scene emits a timestamped handoff record for the arriving
paramedic.

**This is a simulation built at a hackathon. It is not a medical device. Call 911.**

---

## The problem, stated honestly

Two things already exist, and Threshold replaces neither.

**Dispatcher-assisted CPR** (telecommunicator CPR, T-CPR) is standard practice in
well-resourced 911 centers: the call taker keeps one caller on the line and talks that
person through compressions. **Crowdsourced responder alerting** also exists and is
deployed at city scale. PulsePoint notifies nearby CPR-trained users when a cardiac arrest
is reported in a public place. GoodSAM dispatches verified responders and can stream video
from the scene back to a control room. Both are real, funded, and integrated with actual
emergency services in a way a hackathon project is not. Pretending otherwise is the fastest
way to lose credibility, so we are naming them up front.

The gap Threshold targets is narrower than either. A dispatcher is **single-threaded on one
caller**: one voice, one phone, one set of hands being coached, while everything else in the
room is unmanaged. A responder-alerting app is optimized for the qualified person who is
**not there yet**. Meanwhile the scene itself almost always has a crowd already standing in
a ring, phones in hand, and nobody has assigned any of them to anything. That is the
failure mode we are attacking: not a shortage of willing people, a shortage of allocation.

Threshold commands the crowd that is already there. One scene, one code, a different job
pushed to every phone in the ring, spoken out loud on that phone so nobody has to read a
screen, and reallocated the moment the roster changes.

---

## Architecture

```
  Phone A (host)      Phone B            Phone C           Laptop (lobby view)
      |                  |                  |                    |
      +---------+--------+---------+--------+----------+---------+
                                   |
            scene transport  -- topic/scene code "<CODE>"
            carries: SceneAction, periodic full SceneState, presence
            tier 1  in-process bus + polling  (no keys, no account)
            tier 2  Supabase Realtime         (used when configured)
                                   |
                                   v
                 HOST DEVICE holds the authoritative SceneState
                 lib/scene.ts   reduce(state, action, now) -> state
                 (pure, no I/O, same code on every device)
                                   |
              +--------------------+---------------------+
              |                                          |
              v                                          v
       POST /api/commander                        lib/roles.ts
       (server route: the only place                deterministicPlan(state)
        IFM_API_KEY is ever read)                        ^
              |                                          |
              v                                          |
       IFM K2 Horizon   (or LOCAL_MODEL_URL)             |
              |                                          |
              |  6s AbortController timeout,             |
              |  any error / bad JSON  ------------------+
              v
       CommanderPlan { assignments[], reasoning, roomAnnouncement, model, degraded }
              |
              v   broadcast as { type: 'apply_plan' }
       every device applies the whole plan to state, renders only ITS OWN assignment
              |
              v
       lib/voice.ts  speak(assignment.spoken)
         grok-realtime  ->  grok-tts  ->  browser speechSynthesis  ->  silent + caption


  COMPRESSION LOOP  (deterministic, local, zero network)
       camera -> <video> -> MediaPipe Pose (CDN) -> lib/cpr-vision.ts
              -> wrist vertical oscillation, peak counting -> (bpm, quality)
              -> { type: 'rate' } into SceneState, and drawn locally
       lib/metronome.ts  WebAudio click, started and stopped on-device.
       No LLM, no fetch, no Supabase sits between a human and the beat.

  AED
       lib/aed.ts -> Mapbox Directions (3s timeout) -> AedRoute { eta, steps }
                  -> on any failure: static demo AED list, no ETA, no routing

  HANDOFF
       SceneState.events[]  (t = ms since scene start, kind, actor, detail)
                  -> handoff card: downtime clock, who did what and when,
                     rate samples, AED status, shock events
```

Two properties are load-bearing and worth saying out loud:

1. **The safety-critical path is local.** Pacing compressions is a WebAudio metronome and a
   pure function. It does not call an LLM, a router, or a database. If every network
   dependency in this repo dies, the beat keeps going.
2. **The LLM is an allocator, not a coach.** K2 Horizon decides *who does what* given the
   current roster. It never generates the compression rate, and its output is bounded by
   the same `RoleId` set the deterministic planner uses. If it fails or is slow, the
   deterministic planner produces a valid plan and the UI marks it `degraded`.

### Why the transport polls instead of streaming

Server-sent events were the first implementation and they work perfectly on a
local network. They deliver **nothing** through a Cloudflare quick tunnel: the
tunnel buffers the response, hands back a 200, and reports no error on either
end. That is exactly the path between a judge's phone and the laptop, and the
failure is invisible until the room silently fails to sync.

So the downstream is an ordinary GET on a short loop. There is no stream for a
proxy to hold open, nothing to buffer, and no upgrade to negotiate, which means
it also survives captive portals and locked-down campus wifi. At ~900ms the room
still feels immediate, because roles change on the order of seconds.

`/api/scene/stream` is still there and still works locally. It is simply not
what the demo depends on.

### Module map

| File | Runs on | Responsibility |
| --- | --- | --- |
| `lib/types.ts` | both | The shared contract. Do not change a field name without updating everything. |
| `lib/scene.ts` | both | Pure reducer, join code generation, clock formatting. No I/O. |
| `lib/realtime.ts` | client | Picks a transport: Supabase if configured, else the local bus. |
| `lib/local-transport.ts` | client | Keyless transport: POST up, poll down. What the demo runs on. |
| `lib/server-bus.ts` | server | In-process fan-out and frame ring buffer, one room per scene code. |
| `lib/roles.ts` | both | `deterministicPlan(state)`. The floor under everything. |
| `lib/commander.ts` | client | Calls `/api/commander`, falls back to `deterministicPlan`. |
| `app/api/commander/route.ts` | server | The only reader of `IFM_API_KEY` / `LOCAL_MODEL_URL`. |
| `lib/voice.ts` | client | Tiered speech, per-device. |
| `lib/metronome.ts` | client | WebAudio click. Local, always available. |
| `lib/cpr-vision.ts` | client | MediaPipe Pose -> compression rate estimate. |
| `lib/aed.ts` | client | Mapbox route to the nearest demo AED. |

---

## Environment variables

Copy `.env.local.example` to `.env.local`. **Every one of these is optional.** Nothing in
this app throws, blanks the screen, or blocks the demo because a key is absent. The
degradation path is a designed feature, not an accident, and it is the thing to demo if a
key expires on stage.

Only `NEXT_PUBLIC_*` variables are readable in the browser. Everything else is read solely
inside `app/api/*` route handlers.

| Variable | Scope | What it enables | Exactly what happens when it is missing |
| --- | --- | --- | --- |
| `XAI_API_KEY` | server | Grok realtime voice and Grok TTS for spoken assignments. | `lib/voice.ts` falls through to the browser's `speechSynthesis`. If that is unavailable or blocked, `voiceMode()` returns `'silent'` and the assignment is shown as an on-screen caption. Nothing throws. |
| `XAI_BASE_URL` | server | Override the xAI API base. | Defaults to `https://api.x.ai/v1`. |
| `XAI_VOICE_MODEL` | server | Which realtime voice surface to request. | Defaults to `grok-realtime`. If the realtime handshake fails, voice drops one tier to Grok TTS, then to the browser. |
| `XAI_TTS_VOICE` | server | Voice identity for TTS. | Provider default. |
| `IFM_API_KEY` | server | Commander reasoning by K2 Horizon: who gets which job and why. | `/api/commander` skips the model call entirely and returns `deterministicPlan(state)` with `model: 'deterministic'`, `degraded: true`. Roles are still assigned, still spoken, still reassigned. The UI shows the deterministic reasoning string instead of model reasoning. |
| `IFM_BASE_URL` | server | K2 Horizon endpoint (OpenAI-compatible). | Treated the same as a missing `IFM_API_KEY`: deterministic plan. |
| `IFM_MODEL` | server | Model id sent in the request body. | Treated the same as a missing key: deterministic plan. |
| `LOCAL_MODEL_URL` | server | Offline commander: an OpenAI-compatible endpoint on a GPU box (see `scripts/local-model.sh`). Tried when the hosted call fails, or preferred if you want the demo fully local. | Skipped. Falls through to the hosted model, then to the deterministic plan. |
| `LOCAL_MODEL_NAME` | server | Model id to send to that local endpoint. | Defaults to `k2-horizon-0.9b`. Only meaningful with `LOCAL_MODEL_URL` set. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | **browser** | Walking route and ETA to the nearest AED, with turn-by-turn steps. | `aedRoute()` returns `null` after its 3s timeout. The AED screen shows the static demo AED list with location names only: no route line, no ETA, no steps. The AED role is still assigned and still spoken. |
| `NEXT_PUBLIC_SUPABASE_URL` | **browser** | *Optional.* Uses Supabase Realtime for cross-device sync instead of this app's own bus. Worth setting only if you deploy across more than one server process. | Falls back to `lib/local-transport.ts`: multi-device still works, coordinated through the one server every phone already loaded the page from. No banner, no loss of function. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **browser** | Same as above. | Same as above. |

A quick way to sanity check the degradation story before a demo: rename `.env.local`, reload,
and walk the whole flow. It should be fully usable with zero keys. If anything hard-fails,
that is a bug in the module that owns it.

---

## Setup

```bash
npm install
cp .env.local.example .env.local     # then fill in whatever you have; blanks are fine
npm run dev                          # binds 0.0.0.0:3000
```

Open `http://localhost:3000` on the laptop. That is enough to see the host screen, but it is
**not** enough for phones. See the next section.

---

## HTTPS is not optional for the phones

Camera and microphone are gated behind a **secure context**. `http://localhost` counts as
secure on the machine that is serving it, but `http://192.168.x.x:3000` does not. So a
joiner's phone on plain HTTP will:

- refuse `getUserMedia`, so no camera compression tracking,
- refuse microphone access,
- and on iOS Safari, silently give you nothing useful.

You need a public HTTPS URL. Two paths, in order of reliability.

### (a) Cloudflare Tunnel (preferred)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://<random-words>.trycloudflare.com` URL. No account, no config file. This
is the more reliable of the two and the one to use if a judge is going to scan the QR.

### (b) localtunnel (zero install)

```bash
npm run tunnel                    # npx --yes localtunnel --port 3000
```

Prints `your url is: https://<subdomain>.loca.lt`.

**Known friction:** localtunnel often shows an interstitial page before it will pass traffic,
asking for a "tunnel password", which is your public IP address. Get it with:

```bash
curl https://loca.lt/mytunnelpassword
```

Every judge's phone has to clear that page once. That is 20 seconds of your 4 minutes, on
five phones at once. Prefer cloudflared on stage; keep localtunnel as the backup.

### Either way, use the wrapper

```bash
bash scripts/tunnel.sh
```

Picks `cloudflared` if it is on `PATH`, otherwise falls back to `npx localtunnel`, and prints
the resulting URL in a banner you can read from across a room.

### The QR must encode the tunnel URL, not localhost

The host screen builds the join QR from the origin it is currently being served from. So
**open the tunnel URL on the host laptop too**, not `http://localhost:3000`. If you start the
scene from localhost, the QR encodes `localhost:3000`, every phone that scans it fails, and
you will burn a minute of stage time finding out why. Check the QR's URL text under the code
before you invite anyone to scan it. Test it by scanning with your own phone first, on
cellular data, with wifi off.

---

## Safety

- **This is a simulation.** It is a hackathon demo of a coordination interface, built in a
  weekend, and every screen that shows guidance carries a persistent "SIMULATION, CALL 911"
  affordance for that reason.
- **Call 911.** In a real emergency call emergency services and follow the dispatcher. The
  dispatcher is a trained human with a radio to the ambulance. This app is neither.
- **Not a medical device.** Not registered, not cleared, not submitted to any regulator, and
  not intended for clinical use.
- **No clinical validation.** No study, no trial, no expert review, no comparison against
  any standard of care.
- **The compression rate number is an estimate from a webcam, and we have not measured its
  accuracy.** Do not present it as a measurement, and do not put an error bar on a slide,
  because we have not computed one.
- **AED locations are demo data.** Hand-entered points for the demo venue. They are not a
  verified AED registry, not synced with any national or municipal database, and may be
  wrong or absent for any real location.
- **`trained` is a self-declared checkbox.** It is never verified. It is displayed as a
  claim, not a credential, and the allocator treats it as a weak preference only.
- **No medical instruction is authored by the model.** The model chooses who does what. Role
  text comes from `ROLE_LABEL` and the fixed instruction set.

---

## What is real vs stubbed

Honest status of every piece. "Not measured" means exactly that: we ran it by hand and it
did something, and we have not tested, benchmarked, or validated it.

| Piece | Status | Detail |
| --- | --- | --- |
| Pure scene state machine (`lib/scene.ts`) | **Real** | Deterministic reducer, no I/O, identical on every device. |
| Deterministic role allocation (`lib/roles.ts`) | **Real** | Runs with zero keys and whenever the model is slow or wrong. This is the floor under the whole demo. |
| Multi-device join, presence, live sync | **Real, no keys required** | An in-process bus with a frame ring buffer; clients POST actions up and poll down every ~900ms. Verified with two devices in one scene over a public tunnel. Supabase Realtime is used instead when configured. |
| Commander latency | **Measured** | `IFM/K2-Horizon-375B-A23B` answers the allocation contract in roughly 5-13s on the hackathon endpoint. `deterministicPlan()` is applied synchronously first, so the model is never on the critical path to someone starting compressions. |
| Commander reasoning (K2 Horizon) | **Real when `IFM_*` is set** | 6s timeout, JSON-validated against `RoleId`, any failure falls back to deterministic. |
| Per-device job assignment and speech | **Real** | Each phone renders and speaks only its own assignment. |
| Voice tiering | **Real** | Grok realtime, Grok TTS, browser `speechSynthesis`, silent captions. Browsers require one user gesture before audio, which is why "tap once on every device" is in the pre-flight. |
| Metronome | **Real** | WebAudio, local, no network dependency at all. Works with wifi off. |
| Compression rate from camera | **Real code, accuracy not measured** | MediaPipe Pose from CDN, wrist vertical oscillation, peak counting. It produces a bpm. We have not evaluated it against any ground truth, in any lighting, at any camera angle, on any body. Treat the number as a demo signal, not a measurement. |
| Offline mode | **Real** | Metronome, deterministic plan, and local state survive losing the network. A banner shows the degraded state and an `offline` event is written to the log. |
| AED routing and ETA | **Real when Mapbox token is set** | 3s timeout, then the static list. |
| AED locations | **Demo data** | Hand-entered for the venue. Not a registry. |
| EMS ETA (`emsEtaSec`) | **Not real** | A field in scene state, set by the demo operator. There is no CAD, 911, or ambulance-tracking integration, and there is no path to one in this repo. |
| EMS handoff record | **Real as a screen, not as a transmission** | It renders the actual event log with real timestamps. Nothing sends it anywhere. No EMS system receives it. Handing it over means showing a paramedic your phone. |
| Local K2 small model (`LOCAL_MODEL_URL`) | **Optional path, lightly exercised** | `scripts/local-model.sh` sets it up. Not run under demo load. |
| Persistence across a host reload | **Not built** | The scene lives in memory on the host device. Reloading the host page loses the scene. Do not reload the host mid-demo. |
| Accounts, auth, roles-by-identity | **Not built** | Anyone with the 4-character code can join. |
| Automated tests | **None** | There is no test suite in this repo. |
| Measured latency, accuracy, or outcome numbers | **None** | We have measured nothing. There are no metrics to quote, and inventing one would be the worst possible move in front of judges who work on this. |

---

## Repo layout

```
app/                 Next.js App Router pages and API routes
  api/commander/     server-side K2 Horizon call, the only reader of IFM_API_KEY
components/          UI: host console, joiner card, handoff card
lib/                 types, scene reducer, realtime, roles, voice, metronome, vision, aed
scripts/
  tunnel.sh          public HTTPS tunnel (cloudflared, else localtunnel)
  local-model.sh     serve a small K2 Horizon model with vLLM for offline mode
DEMO.md              the 4-minute run sheet, with a fallback for every beat
```

## Demo

See **[DEMO.md](DEMO.md)**. Read it before you go on stage, including the pre-flight
checklist and the failure fallback for every beat.
