# Threshold: 4-minute run sheet

Written to be executed by a nervous person on a stage. Every beat has a **FALLBACK**: what
to say and what to press if that piece does not fire. Read the fallbacks out loud once
before you go up, so your mouth already knows them.

**The one rule: never stop talking to fix something.** If a beat fails, say the fallback
line, move to the next beat, and come back only if there is time. A demo that keeps moving
with one dead feature beats a demo that stalls on stage.

**Never say:** "detects", "accurate", "validated", "clinically", "saves lives", or any
number we have not measured. If a judge pushes for a number, the answer is "we have not
measured that yet" and then the next sentence. That answer costs nothing. A made-up number
costs the whole demo.

---

## Pre-flight checklist (start 15 minutes before)

Run this top to bottom. Do not skip items because they worked in rehearsal.

- [ ] **Phone hotspot ON**, laptop joined to it. Do not trust venue wifi. Do not trust it
      even if it worked an hour ago.
- [ ] **Tunnel up**: `bash scripts/tunnel.sh`. Copy the HTTPS URL.
- [ ] **Host laptop is on the tunnel URL, not localhost.** Open the tunnel URL in the
      browser you will present from. Confirm the URL bar says `https://`.
- [ ] **Scan your own QR** with your own phone, on cellular, wifi off. It must load. If it
      loads `localhost`, you are on the wrong tab.
- [ ] **Printed backup QR** in your pocket, encoding the same tunnel URL, plus the
      4-character code written large on paper. Tunnels change URL on restart, so print this
      after the tunnel is up, or write the code on a whiteboard.
- [ ] **Voice unlocked on every device**: browsers block audio until the user taps once.
      Tap the "unlock audio" control on the host laptop and on each spare phone you control.
      Judges' phones will unlock when they tap their own join button.
- [ ] **Camera permission pre-granted** on the phone that will do compressions. Open the
      camera view once and accept the prompt before you are on stage.
- [ ] **Laptop volume at max**, and the room's audio confirmed if you are plugged into it.
      Mute all notifications. Close Slack, Mail, and Messages.
- [ ] **Two spare phones already joined** and sitting on the table, logged in as extra
      responders. If no judge scans, you still have a multi-device scene.
- [ ] **Manikin / cushion / rolled jacket** placed where the camera can see it, with the
      light behind the camera, not behind the subject.
- [ ] **Screen mirroring tested**: laptop to projector, and know how you will show a phone
      (hold it up, or have it mirrored).
- [ ] `.env.local` in place if you have keys. Then load the page once and confirm no red
      error banner. If a key expired, do not fix it now. You have a degradation story.
- [ ] **Do not reload the host page after the scene starts.** The scene lives in memory.

---

## The four minutes

### 0:00 to 0:25 | Cold open

**SAY** (do not touch the laptop yet, look at the judges):

> "If someone collapses in this room right now, the problem is not that nobody here knows
> CPR. Statistically some of you do. The problem is that nobody knows who is doing what. So
> everyone takes out a phone, one person starts compressions badly, and eleven people stand
> in a circle. A 911 dispatcher can coach exactly one of you, because they are on the phone
> with one caller. Nobody is commanding the room. That is what we built."

**DO:** Host screen already open on the tunnel URL, scene not yet started.

**FALLBACK:** There is nothing to fail here. This beat is pure voice. If the projector is
dead, deliver the whole cold open anyway and keep going; the phones are the demo, not the
slide.

---

### 0:25 to 1:00 | Start the scene, judges scan the QR

**DO:** Press **START SCENE**. A 4-character code and a QR appear. Turn the laptop toward
the judges, or hold up the printed QR.

**SAY:**

> "One person starts a scene. Everyone else in the room joins on their own phone. Scan this
> now, all three of you, it takes five seconds. Your phone is about to get a job."

**Timing note:** this is the only moment you ask the judges to do something. Ask once,
clearly, and keep talking while they scan. Do not stand in silence watching them.

**FALLBACK, in order:**
1. QR does not scan (glare, angle): read the 4-character code out loud, twice, and say
   "or just type this code at" plus the tunnel URL. Have it written on paper.
2. Their phones will not load the page: "Our tunnel is being a hackathon tunnel. I have two
   phones already in the scene." Pick up the two spare phones and continue the entire demo
   with those plus the laptop. Every later beat works with three devices you control.
3. The app shows the single-device banner (no transport reached): point at the banner and say
   "that banner is the app telling you it lost multiplayer and dropped to single device, on
   purpose, instead of showing you a white screen. Let me show you the same allocation on
   one device." Then run the rest on the laptop with simulated responders. **This is a
   credibility win if you narrate it as a design decision, which it is.**

---

### 1:00 to 1:45 | Different job on every phone, spoken out loud

**DO:** As joins land, the host screen shows the roster. Hit the control that requests a
plan (or let it fire automatically on the join). Each phone speaks its own job.

**SAY:**

> "Watch your screens. You did not all get the same instruction. One of you is on
> compressions, one is getting the AED, one is on the phone with 911, one is meeting the
> medics at the door. Your phone says it out loud, because nobody in that room is going to
> read a screen. And on the host you can see the reasoning: this is the model deciding who
> gets what, given who is actually here."

Point at the reasoning line on the host screen. Point at the model badge.

**FALLBACK:**
- Voice does not speak on the judges' phones: "Audio needs one tap on iOS before a page can
  make a sound. Tap the big button." If it still does not fire: "Their phone is muted; mine
  is not," and hold up your own phone with the spoken job. The caption text is on screen
  either way, so point at that.
- The badge says `deterministic` and `degraded`: **do not hide it, lead with it.**
  > "That badge is honest: the model call did not come back inside six seconds, so this
  > allocation came from our deterministic planner instead. That is the whole point. The
  > model makes it smarter, it is never load-bearing. Nobody's chest compressions wait on
  > an API."
  This is a strong moment. It is arguably better than the happy path.
- Everyone got the same role, or roles look wrong: say "roles are recomputed on every roster
  change, let me force one," and trigger a replan. If it is still wrong, move on to the
  reassign beat, which will recompute anyway.

---

### 1:45 to 2:25 | The reassign beat (the proof it is reasoning, not a script)

**This is the most important 40 seconds of the demo. Protect this beat.** If you are running
long, cut the camera beat, not this one.

**DO:** Point at whichever judge holds the AED role. Ask them to physically **walk away** or
close the tab.

**SAY:**

> "Here is the thing a script cannot do. You have the AED. Walk away. Leave. In a real scene
> people leave constantly, they get overwhelmed, they go outside to flag the ambulance and
> never come back."

Pause. Let the roster update. Then:

> "The AED job just moved. It did not go to a random phone, it went to the person who was
> standing by, and the compressions phone was left alone, because you never pull the person
> doing compressions. That reallocation is happening live against the roster that exists
> right now, not against a demo script."

**FALLBACK:**
- Nothing reassigns within about 8 seconds: use the host's manual "drop" or "replan" control
  and say "let me force the roster change so you can see it in one shot." A forced replan
  demonstrates the same thing. Do not stand there waiting silently.
- Nothing reassigns at all: pick up a spare phone, close its tab in front of the judges, and
  narrate the presence drop on the host roster: "presence sees it leave, and here is the new
  allocation." If even that fails, point at the event log: "every one of these lines is a
  roster change and a reallocation, timestamped."
- The judge does not actually walk away (they will hesitate): do it yourself with a spare
  phone. Do not spend 15 seconds negotiating with a judge.

---

### 2:25 to 3:00 | The camera watches the compressions

**DO:** Kneel at the manikin, phone or laptop camera pointed at the hands, start
compressions. Compress to the metronome.

**SAY:**

> "The compressions phone opens its camera and tracks the hands with on-device pose
> estimation. It is counting the rate and pushing it back into the scene, so the commander
> knows whether the person doing compressions is still keeping up, and can stage a swap
> before they gas out. That is the reassignment trigger you cannot get from a dispatcher on
> a phone call. I want to be straight with you: we have not measured the accuracy of this
> estimate. It runs, it produces a rate, we have not validated it against anything."

**FALLBACK:**
- Camera permission prompt appears on stage: accept it and keep talking. This is why it is
  in the pre-flight.
- Pose model does not load (CDN blocked by venue wifi): "MediaPipe loads from a CDN and this
  wifi is not having it." Then immediately: "the part that actually matters does not need
  the network at all," and start the metronome. Go straight into the offline beat early.
- Rate reads wildly wrong (300 bpm, or nothing): **say the number is wrong out loud.**
  > "That number is garbage right now, and I would rather show you that than cut away from
  > it. Lighting and camera angle both wreck it, and we have not tuned any of that. What is
  > solid is the beat, which is local code."
  Then start the metronome. Judges forgive an unvalidated estimate. They do not forgive
  being told a wrong number is right.

---

### 3:00 to 3:25 | Kill the wifi

**DO:** Turn off wifi on the compressions device (or turn off the hotspot) **while the
metronome is running**. Hold the device up so they can hear it.

**SAY:**

> "Watch. Wifi off. The metronome does not stop, because the metronome is WebAudio running
> on the device, and the pacing logic is a pure function. There is no model, no server, and
> no database between a human being and the beat they are compressing to. The banner tells
> you the scene went offline, the event log records it, and the local job keeps running. If
> our whole backend died mid-scene, the person doing compressions would not know."

**FALLBACK:**
- Metronome stops: this should not happen, and if it does, do not pretend. "That should not
  have stopped, and I am not going to tell you it did not." Then turn wifi back on, restart
  the metronome, and say "the design intent is that this path has no network dependency, and
  we clearly have a bug in the teardown." Honesty here costs one beat. Bluffing costs the
  room.
- You cannot get wifi off fast enough on stage: use airplane mode, it is one swipe. Practice
  the swipe. If you are on the hotspot, turning the hotspot off on your own phone is faster
  and more visible.
- Turning wifi off kills your screen mirroring: **know this in advance.** Kill wifi on the
  phone, never on the laptop that is driving the projector.

---

### 3:25 to 3:50 | The handoff card

**DO:** Open the handoff card on the host screen. Turn the laptop to the judges.

**SAY:**

> "Last thing, and it is the part a paramedic actually asked us for. Every scene writes a
> timestamped record: when the scene started, so downtime, who was doing compressions and
> when they swapped, the rate samples, whether an AED was attached and when. Right now the
> medic walking in gets a shrug and 'uh, a few minutes?'. This is a screen you hand them.
> To be clear: it is a screen. Nothing transmits to any EMS system. There is no integration
> and we are not claiming one."

**FALLBACK:**
- The card is empty or wrong: fall back to the raw event log view. "Here is the underlying
  log the card renders. Same timestamps, uglier." The event log is the substance; the card
  is the packaging.
- Both are broken: say the sentence about the paramedic anyway and point at the running scene
  clock. "Every state change in this scene is already timestamped against that clock. The
  handoff view is the read-out of that log."

---

### 3:50 to 4:00 | Close

**SAY** (laptop down, look at them, no clicking):

> "Threshold does not replace the dispatcher, and it does not replace PulsePoint or GoodSAM
> alerting the trained responder who is three blocks away. It commands the crowd that is
> already standing over the patient, which nobody is doing today. One scene, every phone in
> the ring gets a different job, spoken out loud, reallocated live when the room changes,
> and a timestamped handoff for the medic. It is a simulation, we have measured nothing yet,
> and everything you just saw ran on your own phones."

**Then stop talking.** Do not add a feature list. Do not say "and in the future". The last
sentence should be the honest one.

---

## The three questions judges will ask

Short answers. Do not ramble. Every one of these is expanded in the README if they push.

### 1. "How is this different from a 911 operator?"

> "A dispatcher is single-threaded. They are on the line with one caller, coaching one set of
> hands, and they cannot see or address the other ten people in the room. Telecommunicator
> CPR is standard practice and it is good, and it is one-to-one. Threshold is one-to-many at
> the scene: it assigns a different job to every phone, speaks it on that phone, and
> reallocates when someone leaves. We are not competing with the dispatcher, we are
> commanding the people the dispatcher cannot reach. In a real deployment the dispatcher's
> caller is one of our participants, and the call911 role exists exactly so we never
> interfere with that line."

### 2. "How does it get initiated? Nobody opens an app during a cardiac arrest."

> "Correct, and that is the honest hard part. Today one person starts a scene and everyone
> else joins by QR or a 4-character code, so it needs exactly one person to act, and the rest
> of the crowd joins in five seconds with no install. The realistic path to zero-friction
> initiation is not us building an app people open in a panic, it is riding an alert that
> already fires: PulsePoint and GoodSAM already push to nearby responders, and dispatch
> already sends SMS links for video triage. A scene link is one more payload in an alert that
> is already being sent. We have not built that integration and we are not claiming it. What
> we have proven is the part after initiation, which nobody has built: allocating the crowd."

### 3. "What about false alarms and untrained people doing harm?"

> "Three answers. First, this is a simulation and every screen says call 911, because the
> emergency system stays the authority, not us. Second, we never expand who acts: Threshold
> assigns jobs to people who already stopped and are already standing there, and most of the
> roles are logistics that carry no risk at all: meet the medics at the door, clear the space,
> go get the AED, stay on the line with the dispatcher. Third, the only clinically loaded
> role is compressions, and for that we pace with a fixed local metronome rather than letting
> a model improvise instructions. `trained` is a self-declared checkbox we treat as a weak
> preference, never as a credential, and we display it as a claim. A false scene costs a few
> people looking at their phones. And we should say clearly: none of this is clinically
> validated, so today it is a coordination demo, not a care intervention."

---

## If everything is broken

You still have a demo. In this order:

1. Run the whole thing single-device on the laptop, narrating the degradation banners as
   deliberate. The fallback architecture **is** the interesting engineering.
2. If the app will not load at all: talk through the architecture diagram in the README, and
   spend your time on the reassign idea and the handoff record. The idea survives a dead
   laptop; a bluff does not.
3. Whatever happens, land the closing paragraph. It is the honest one, and honesty is the
   only thing in this deck that cannot crash.
