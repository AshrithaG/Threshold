// ---------------------------------------------------------------------------
// GET /api/voice/token — tells the browser which voice tier it may use.
//
// IF THE REAL xAI API DIFFERS FROM THE GUESS BELOW, ONLY THESE LINES CHANGE:
//   * REALTIME_PATH  — the session-minting path (default '/realtime/client_secrets')
//   * the request body inside the realtime block  (model / voice fields)
//   * readEphemeralSecret() — where the ephemeral token lives in the response
// Nothing outside this file and app/api/speak/route.ts knows xAI's wire format.
// The realtime block is INERT unless XAI_REALTIME=1, so a wrong guess here
// cannot affect the demo.
//
// SECURITY: XAI_API_KEY must never appear in a response from this route. The
// key is used only as an Authorization header, server-side, and the response
// is explicitly checked below to make sure the key never leaks through.
// ---------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Timeout for the optional realtime session mint. Everything non-reasoning: 3s. */
const MINT_TIMEOUT_MS = 3000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/**
 * Pull the ephemeral client secret out of a session-mint response.
 * Accepts the shapes providers commonly use; returns '' when absent.
 */
function readEphemeralSecret(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload?.client_secret?.value,
    payload?.client_secret,
    payload?.ephemeral_key,
    payload?.token,
    payload?.session?.client_secret?.value,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

export async function GET(): Promise<Response> {
  const apiKey = (process.env.XAI_API_KEY || '').trim();

  // No key -> the browser uses its own speechSynthesis. This is the default
  // path for the hackathon demo and must stay a clean 200.
  if (!apiKey) return json({ mode: 'browser' });

  const voice = (process.env.XAI_TTS_VOICE || 'ember').trim() || 'ember';

  // =========================================================================
  // REALTIME UPGRADE BLOCK — inert unless XAI_REALTIME=1.
  //
  // To pick mode 'grok-realtime', lib/voice.ts needs this exact JSON:
  //   {
  //     mode: 'grok-realtime',
  //     voice: string,          // voice id to speak with
  //     model: string,          // realtime model id
  //     clientSecret: string,   // EPHEMERAL, short-lived — never XAI_API_KEY
  //     expiresAt: number,      // epoch ms; voice.ts re-probes after this
  //     url: string             // wss:// endpoint the client dials
  //   }
  // Any other shape (or any failure) falls through to grok-tts below, so a
  // wrong guess degrades instead of breaking.
  // =========================================================================
  if (process.env.XAI_REALTIME === '1') {
    const base = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
    // Verified against the live docs: client secrets are minted at
    // /v1/realtime/client_secrets, not /realtime/sessions. See docs/API-NOTES.md.
    const REALTIME_PATH = process.env.XAI_REALTIME_PATH || '/realtime/client_secrets';
    const model = (process.env.XAI_VOICE_MODEL || 'grok-realtime').trim();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MINT_TIMEOUT_MS);
    try {
      const res = await fetch(base + REALTIME_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, voice }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        const clientSecret = readEphemeralSecret(payload);
        // Hard guard: refuse to hand the browser anything that is (or contains)
        // the long-lived API key, whatever the upstream returned.
        const leaks = !clientSecret || clientSecret === apiKey || clientSecret.includes(apiKey);
        if (!leaks) {
          const expiresRaw = payload?.client_secret?.expires_at ?? payload?.expires_at;
          const expiresAt =
            typeof expiresRaw === 'number'
              ? expiresRaw > 1e12
                ? expiresRaw
                : expiresRaw * 1000 // seconds -> ms
              : Date.now() + 60_000;
          return json({
            mode: 'grok-realtime',
            voice,
            model,
            clientSecret,
            expiresAt,
            url:
              process.env.XAI_REALTIME_URL ||
              `wss://${base.replace(/^https?:\/\//, '').split('/')[0]}/v1/realtime?model=${encodeURIComponent(model)}`,
          });
        }
      }
    } catch {
      /* timeout / network / bad JSON — fall through to grok-tts */
    } finally {
      clearTimeout(timer);
    }
  }
  // ======================= end realtime upgrade block ======================

  // Server-side TTS through /api/speak. The key stays here.
  return json({ mode: 'grok-tts', voice });
}
