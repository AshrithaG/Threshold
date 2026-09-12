// ---------------------------------------------------------------------------
// POST /api/speak  { text: string }  ->  audio bytes, or 204.
//
// Wire format verified against the live xAI API, not guessed:
//
//   POST https://api.x.ai/v1/tts
//   { "text": "...", "language": "en", "voice_id": "eve",
//     "output_format": { "codec": "mp3" } }
//
// `language` is REQUIRED; omitting it is a 4xx. There is no /v1/audio/speech on
// xAI -- that is the OpenAI path, and an earlier draft of this file used it,
// which is why every phone fell back to browser speech. Every piece of that
// shape stays env-overridable so a vendor change needs no code edit.
//
// The response is documented inconsistently: some surfaces return raw audio
// bytes, others a JSON envelope with base64. Both are handled below by sniffing
// the content type.
//
// CONTRACT: this route NEVER returns 500 and never returns an error body. Any
// missing key, non-200, wrong content type, timeout or crash returns 204 so the
// client silently drops to browser speechSynthesis and the responder still
// hears their instruction.
// ---------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Upstream abort budget. Beyond this the client is better served by local TTS. */
const TTS_TIMEOUT_MS = 5000;
/** Spoken lines are one instruction. Anything longer is a bug upstream. */
const MAX_CHARS = 400;

/** 204 = "no audio for you, use the browser". The only failure mode we emit. */
function noAudio(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Map a requested response_format to a Content-Type the browser can play. */
function contentTypeFor(format: string): string {
  switch (format.toLowerCase()) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'pcm':
      return 'audio/wav';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const apiKey = (process.env.XAI_API_KEY || '').trim();
    if (!apiKey) return noAudio();

    let text = '';
    try {
      const body = await req.json();
      text = typeof body?.text === 'string' ? body.text : '';
    } catch {
      return noAudio();
    }

    text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!text) return noAudio();

    const base = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
    const TTS_PATH = process.env.XAI_TTS_PATH || '/tts';
    const voice = (process.env.XAI_TTS_VOICE || 'eve').trim() || 'eve';
    const format = (process.env.XAI_TTS_FORMAT || 'mp3').trim() || 'mp3';
    const language = (process.env.XAI_TTS_LANGUAGE || 'en').trim() || 'en';

    const payload = {
      text,
      language,
      voice_id: voice,
      output_format: { codec: format },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(base + TTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'audio/*',
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch {
      // Timeout, DNS failure, TLS failure, offline venue wifi.
      clearTimeout(timer);
      return noAudio();
    }
    // Headers are in; the body may still be streaming. Stop the abort clock so
    // a slow-but-working stream is not killed mid-sentence.
    clearTimeout(timer);

    if (!res.ok || !res.body) return noAudio();

    const upstreamType = (res.headers.get('content-type') || '').toLowerCase();

    // JSON envelope variant: { audio: "<base64>", content_type, duration }.
    // Decode it here so lib/voice.ts only ever deals in playable bytes.
    if (upstreamType.includes('application/json')) {
      try {
        const data: any = await res.json();
        const b64 = typeof data?.audio === 'string' ? data.audio : '';
        if (!b64) return noAudio();
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length === 0) return noAudio();
        const declared =
          typeof data?.content_type === 'string' && data.content_type.startsWith('audio/')
            ? data.content_type
            : contentTypeFor(format);
        return new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': declared, 'Cache-Control': 'no-store' },
        });
      } catch {
        return noAudio();
      }
    }

    const looksLikeAudio =
      upstreamType.startsWith('audio/') ||
      upstreamType.includes('octet-stream') ||
      upstreamType.includes('mpeg');
    // An error body with a 200 status is a real thing. Treat it as failure.
    if (!looksLikeAudio) return noAudio();

    const outType = upstreamType.startsWith('audio/') ? upstreamType : contentTypeFor(format);

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': outType,
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    // Belt and braces: this route must never surface a 500 to the client.
    return noAudio();
  }
}
