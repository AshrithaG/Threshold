#!/usr/bin/env bash
#
# Threshold: serve a small K2 Horizon model from a GPU box as an OpenAI-compatible
# endpoint, so the commander can reason with no internet at all (offline mode).
#
# WHY THIS EXISTS
#   /api/commander normally calls IFM's hosted K2 Horizon. On conference wifi that call is
#   the single most likely thing to time out. With LOCAL_MODEL_URL set, the route can talk
#   to a model running on a box you control, on your own hotspot or a cable. If that also
#   fails, lib/roles.ts deterministicPlan() still runs and the demo still works. This
#   script is an optimization, never a dependency.
#
# WHERE IT RUNS
#   On the GPU box, NOT on the presenting laptop. vLLM needs an NVIDIA GPU and Linux. It
#   does not run on Apple Silicon. See the llama.cpp note at the bottom if all you have is
#   a Mac.
#
# USAGE
#   bash scripts/local-model.sh <HF_REPO_ID>
#   PORT=8000 bash scripts/local-model.sh <HF_REPO_ID>
#
#   <HF_REPO_ID> is a Hugging Face repo id, e.g. "some-org/some-model".
#
#   >>> YOU MUST SUBSTITUTE THE REAL K2 HORIZON SMALL-MODEL REPO ID FROM IFM'S OWN DOCS. <<<
#   This script deliberately does NOT ship a default repo id, because we do not know the
#   real one and guessing produces a plausible-looking string that 404s at exactly the
#   wrong moment. Look it up in IFM's documentation or model card, paste it as $1, and
#   set LOCAL_MODEL_NAME in .env.local to whatever id this server ends up reporting.
#
set -euo pipefail

REPO="${1:-}"
PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
VENV="${VENV:-$HOME/.threshold-vllm}"

if [ -z "$REPO" ]; then
  cat <<'USAGE'
usage: bash scripts/local-model.sh <HF_REPO_ID>

  <HF_REPO_ID>  Hugging Face repo id of the small K2 Horizon model.
                Get the real id from IFM's docs. This script will not invent one.

  env overrides:
    PORT=8000            port to serve on
    HOST=0.0.0.0         bind address (0.0.0.0 so the laptop can reach the GPU box)
    VENV=~/.threshold-vllm   where the python venv lives

example:
    bash scripts/local-model.sh <org>/<k2-horizon-small>
USAGE
  exit 1
fi

echo "=============================================================="
echo " Threshold local model server"
echo " repo : $REPO"
echo " bind : $HOST:$PORT"
echo " venv : $VENV"
echo "=============================================================="
echo

# --- sanity: platform ----------------------------------------------------------------------
UNAME_S="$(uname -s)"
if [ "$UNAME_S" = "Darwin" ]; then
  cat <<'MACWARN'
[warn] This is macOS. vLLM has no supported CUDA path here and the install will most
[warn] likely fail or produce a CPU-only build that is far too slow to be useful in a
[warn] 4-minute demo. Run this on the GPU box instead, or use the llama.cpp fallback
[warn] documented at the bottom of this script. Continuing anyway in 5 seconds.
MACWARN
  sleep 5
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[info] GPU:"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || true
  echo
else
  echo "[warn] nvidia-smi not found. If this box has no NVIDIA GPU, vLLM will not serve"
  echo "[warn] this model at any usable speed. Use the llama.cpp fallback instead."
  echo
fi

if command -v nvcc >/dev/null 2>&1; then
  echo "[info] nvcc: $(nvcc --version | tail -n 1)"
  echo "[info] Note: vLLM wheels are built against a specific CUDA version. If the box has"
  echo "[info] several toolchains installed, make sure the one on PATH matches the wheel."
  echo "[info] CUDA 12.x is the safe target for current wheels; a 13.x toolchain on PATH is"
  echo "[info] a common cause of an install that appears to succeed and then fails at load."
  echo
fi

PY="${PY:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[error] $PY not found. Install Python 3.9+ and re-run." >&2
  exit 1
fi
echo "[info] python: $("$PY" --version 2>&1)"

# --- venv + install ------------------------------------------------------------------------
if [ ! -d "$VENV" ]; then
  echo "[info] creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
. "$VENV/bin/activate"

if python -c "import vllm" >/dev/null 2>&1; then
  echo "[info] vllm already installed: $(python -c 'import vllm; print(vllm.__version__)' 2>/dev/null || echo unknown)"
else
  echo "[info] installing vllm (this is a large download, several minutes)"
  python -m pip install --upgrade pip
  python -m pip install vllm
fi
echo

# --- how to wire it into the app -------------------------------------------------------------
# Work out a reachable address for the laptop. If HOST is 0.0.0.0 the laptop cannot use
# that literally, it needs this box's LAN IP.
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
[ -z "$LAN_IP" ] && LAN_IP="<this-box-ip>"

echo "=============================================================="
echo " PASTE THIS INTO .env.local ON THE LAPTOP RUNNING NEXT.JS"
echo "--------------------------------------------------------------"
if [ "$HOST" = "0.0.0.0" ] || [ "$HOST" = "::" ]; then
  echo "   LOCAL_MODEL_URL=http://$LAN_IP:$PORT/v1"
else
  echo "   LOCAL_MODEL_URL=http://$HOST:$PORT/v1"
fi
echo "   LOCAL_MODEL_NAME=$REPO"
echo "--------------------------------------------------------------"
echo " LOCAL_MODEL_URL is read SERVER-SIDE ONLY, inside app/api/commander."
echo " It is not a NEXT_PUBLIC_ var and the browser never calls this endpoint,"
echo " so the GPU box only has to be reachable from the laptop, not from the phones."
echo
echo " Verify once it is up, from the laptop:"
echo "   curl -s http://$LAN_IP:$PORT/v1/models"
echo "=============================================================="
echo

# --- serve ------------------------------------------------------------------------------------
echo "[info] starting vLLM OpenAI-compatible server. Ctrl-C to stop."
echo
exec python -m vllm.entrypoints.openai.api_server \
  --model "$REPO" \
  --served-model-name "$REPO" \
  --host "$HOST" \
  --port "$PORT" \
  --dtype auto

# ------------------------------------------------------------------------------------------
# FALLBACK: llama.cpp, if vLLM will not install in time
# ------------------------------------------------------------------------------------------
# vLLM is a heavy install with real CUDA-version coupling. If it is fighting you and the
# demo is in two hours, stop and use llama.cpp instead. It builds in minutes, runs on
# Apple Silicon via Metal, and ships its own OpenAI-compatible server.
#
#   git clone https://github.com/ggerganov/llama.cpp
#   cd llama.cpp && cmake -B build && cmake --build build --config Release -j
#
#   # you need a GGUF quantization of the model. If IFM does not publish one, convert it:
#   python convert_hf_to_gguf.py /path/to/downloaded/hf/model --outfile model.gguf
#   ./build/bin/llama-quantize model.gguf model-q4_k_m.gguf Q4_K_M
#
#   # serve, OpenAI-compatible, same shape of endpoint as vLLM:
#   ./build/bin/llama-server -m model-q4_k_m.gguf --host 0.0.0.0 --port 8000
#
#   # then in .env.local:
#   LOCAL_MODEL_URL=http://<box-ip>:8000/v1
#   LOCAL_MODEL_NAME=<whatever /v1/models reports>
#
# And if neither one comes up: do nothing. Leave LOCAL_MODEL_URL empty. The commander
# falls back to the hosted model, and then to deterministicPlan(), and the demo runs.
# Do not spend the last hour before a demo compiling CUDA kernels.
# ------------------------------------------------------------------------------------------
