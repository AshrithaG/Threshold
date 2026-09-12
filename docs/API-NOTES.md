# Verified API surfaces (fetched from vendor docs 2026-09-12)

These were checked against the live docs, not assumed. If something 404s, this file is
where to look first.

## xAI / Grok voice  — base https://api.x.ai/v1

### Text to speech  (used for per-device role announcements)
POST https://api.x.ai/v1/tts
  Authorization: Bearer $XAI_API_KEY
  {
    "text": "...",              // required, max 15000 chars
    "language": "en",           // REQUIRED. BCP-47 or "auto"
    "voice_id": "eve",          // default "eve"; also "ara", "rex", ...
    "speed": 1.0,               // 0.7 - 1.5
    "output_format": { "codec": "mp3" }   // mp3|wav|pcm|mulaw|alaw
  }
Response: docs disagree between raw audio bytes and
{ audio: <base64>, content_type, duration }. HANDLE BOTH — sniff Content-Type.
GET /v1/tts/voices lists voices.

### Realtime speech-to-speech  (used for the live compression coach channel)
Ephemeral token for the browser:
  POST https://api.x.ai/v1/realtime/client_secrets
    { "expires_after": { "seconds": 600 }, "session": { "model": "grok-voice-latest" } }
  -> { "value": "<token>", "expires_at": <unix> }

Browser (WebSocket headers are impossible, so the token rides in the subprotocol):
  new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest",
                [`xai-client-secret.${token}`])

Protocol is OpenAI-Realtime-compatible: send
  { "type": "session.update", "session": { voice, instructions, turn_detection: {type:"server_vad"} } }
Models: grok-voice-latest | grok-voice-think-fast-2.0 | grok-voice-think-fast-1.0

NOTE: /v1/audio/speech does NOT exist on xAI. It is /v1/tts.

## IFM K2 Horizon
OpenAI-compatible /chat/completions. Model ids are namespaced:
  IFM/K2-Horizon-375B-A23B   <- flagship, the commander
  IFM/K2-Horizon-36B-A4B
  IFM/K2-Horizon-32B
  IFM/K2-Horizon-7B
  IFM/K2-Horizon-3.7B
  IFM/K2-Horizon-0.9B        <- offline brain
GGUF builds exist for 0.9B / 3.7B / 7B (IFM/K2-Horizon-<size>-GGUF) which makes the
offline path runnable on llama.cpp or ollama, not just vLLM.
Hosted base URL comes from the hackathon key at platform.ifm.ai (auth-walled, so paste
whatever the quickstart shows into IFM_BASE_URL).

## Offline mode — what was actually tested on this laptop (2026-09-12)

TESTED AND WORKING: deterministic offline path. No model, no network, no keys.
This is tier 1 and it is the correct answer for the safety-critical path anyway.

TESTED AND FAILING: `ollama pull hf.co/IFM/K2-Horizon-0.9B-GGUF` downloads fine (2.2 GB,
file K2-Horizon-1B-BF16.gguf) but will not load:
    error loading model: unknown model architecture: 'k2-horizon'
on ollama 0.31.1. The bundled llama.cpp has no converter for the k2-horizon arch yet.
Do NOT budget demo time on this. If IFM ships llama.cpp support, revisit.

TESTED AND WORKING as the tier-2 offline brain: ollama llama3.1:8b, already on this
laptop, returns valid commander JSON.
    LOCAL_MODEL_URL=http://127.0.0.1:11434/v1
    LOCAL_MODEL_NAME=llama3.1:8b
Use this if you want "an LLM is still reasoning with the wifi off" rather than just
deterministic rules. Be honest on stage about which model it is.

STILL AVAILABLE for the IFM story (but NOT for the wifi-cut beat, since it is remote):
K2-Horizon-0.9B / 3.7B via vLLM on the GPU box — vLLM recipes exist at
recipes.vllm.ai/IFM/K2-Horizon-0.9B. A remote box dies when you cut the wifi, so if you
demo the offline beat, tier 1 or tier 2 above is what is actually running.
