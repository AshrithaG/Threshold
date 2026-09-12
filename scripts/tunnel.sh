#!/usr/bin/env bash
#
# Threshold: bring up a public HTTPS tunnel to the local dev server.
#
# Phones need a secure context (https) for camera and microphone. http://localhost is a
# secure context only on the machine serving it, so a joiner's phone on http://192.168.x.x
# gets no camera and no mic. Hence this script.
#
# Usage:   bash scripts/tunnel.sh            # port 3000
#          PORT=4000 bash scripts/tunnel.sh  # some other port
#
# Prefers cloudflared (more reliable, no interstitial). Falls back to npx localtunnel.
#
set -euo pipefail

PORT="${PORT:-3000}"
WAIT_SECS="${WAIT_SECS:-60}"
LOG="$(mktemp -t threshold-tunnel.XXXXXX)"
CHILD_PID=""

cleanup() {
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

rule() { printf '%s\n' "======================================================================"; }

banner() {
  local url="$1" flavor="$2"
  printf '\n\n'
  rule
  rule
  printf '\n'
  printf '   THRESHOLD TUNNEL IS UP   (%s)\n' "$flavor"
  printf '\n'
  printf '        %s\n' "$url"
  printf '\n'
  rule
  printf '\n'
  printf '   >> POINT THE QR AT THIS URL, NOT AT localhost. <<\n'
  printf '\n'
  printf '   1. Open %s on the HOST laptop.\n' "$url"
  printf '      The host page builds the join QR from the origin it is served from.\n'
  printf '      Start the scene from localhost and every phone that scans will fail.\n'
  printf '\n'
  printf '   2. Scan your own QR with your own phone, on cellular, wifi OFF,\n'
  printf '      before you invite anybody else to scan it.\n'
  printf '\n'
  printf '   3. This URL dies when you Ctrl-C this window, and a restart gives you a\n'
  printf '      DIFFERENT URL. Print the backup QR after the tunnel is up, not before.\n'
  printf '\n'
  rule
  rule
  printf '\n'
}

# --- is anything actually serving on that port? non-fatal, just a warning -----------------
if command -v curl >/dev/null 2>&1; then
  if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}" 2>/dev/null; then
    printf '\n[warn] Nothing answered on http://127.0.0.1:%s\n' "$PORT"
    printf '[warn] Start the dev server in another window first:  npm run dev\n'
    printf '[warn] Bringing the tunnel up anyway; it will start working once the server does.\n\n'
  fi
fi

# --- path (a): cloudflared ----------------------------------------------------------------
if command -v cloudflared >/dev/null 2>&1; then
  printf '[tunnel] cloudflared found. Starting quick tunnel to port %s ...\n' "$PORT"
  cloudflared tunnel --url "http://localhost:${PORT}" >"$LOG" 2>&1 &
  CHILD_PID=$!

  URL=""
  i=0
  while [ "$i" -lt "$WAIT_SECS" ]; do
    if ! kill -0 "$CHILD_PID" 2>/dev/null; then
      printf '\n[error] cloudflared exited. Its output:\n\n'
      cat "$LOG"
      printf '\n[error] Falling back to localtunnel is manual: npm run tunnel\n'
      exit 1
    fi
    URL="$(grep -Eo 'https://[a-zA-Z0-9._-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -n 1 || true)"
    if [ -n "$URL" ]; then
      break
    fi
    sleep 1
    i=$((i + 1))
  done

  if [ -z "$URL" ]; then
    printf '\n[error] cloudflared did not print a URL within %ss. Its output:\n\n' "$WAIT_SECS"
    cat "$LOG"
    exit 1
  fi

  banner "$URL" "cloudflared"
  printf '[tunnel] Live log below. Ctrl-C to tear the tunnel down.\n\n'
  tail -f "$LOG" &
  TAIL_PID=$!
  wait "$CHILD_PID" || true
  kill "$TAIL_PID" 2>/dev/null || true
  exit 0
fi

# --- path (b): localtunnel via npx --------------------------------------------------------
printf '[tunnel] cloudflared not on PATH.\n'
printf '[tunnel] For a more reliable tunnel:  brew install cloudflared\n'
printf '[tunnel] Falling back to localtunnel via npx ...\n\n'

npx --yes localtunnel --port "$PORT" >"$LOG" 2>&1 &
CHILD_PID=$!

URL=""
i=0
while [ "$i" -lt "$WAIT_SECS" ]; do
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    printf '\n[error] localtunnel exited. Its output:\n\n'
    cat "$LOG"
    exit 1
  fi
  URL="$(grep -Eo 'https://[a-zA-Z0-9._-]+\.loca\.lt' "$LOG" 2>/dev/null | head -n 1 || true)"
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
  i=$((i + 1))
done

if [ -z "$URL" ]; then
  printf '\n[error] localtunnel did not print a URL within %ss. Its output:\n\n' "$WAIT_SECS"
  cat "$LOG"
  exit 1
fi

banner "$URL" "localtunnel"

# localtunnel usually shows an interstitial asking for a "tunnel password", which is the
# public IP of this machine. Every phone has to clear that page once. Fetch it up front so
# the operator is not googling it on stage.
TUNNEL_PW=""
if command -v curl >/dev/null 2>&1; then
  TUNNEL_PW="$(curl -s --max-time 5 https://loca.lt/mytunnelpassword 2>/dev/null || true)"
fi
printf '   HEADS UP: localtunnel shows an interstitial before it passes traffic.\n'
printf '   Each phone must enter the tunnel password ONCE. It is this machine'"'"'s public IP:\n\n'
if [ -n "$TUNNEL_PW" ]; then
  printf '        %s\n\n' "$TUNNEL_PW"
else
  printf '        (could not fetch it) run:  curl https://loca.lt/mytunnelpassword\n\n'
fi
printf '   That costs ~20 seconds per phone. On stage, prefer cloudflared.\n\n'
rule
printf '\n[tunnel] Live log below. Ctrl-C to tear the tunnel down.\n\n'

tail -f "$LOG" &
TAIL_PID=$!
wait "$CHILD_PID" || true
kill "$TAIL_PID" 2>/dev/null || true
