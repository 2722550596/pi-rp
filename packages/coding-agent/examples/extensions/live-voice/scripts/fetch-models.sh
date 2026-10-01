#!/usr/bin/env bash
set -euo pipefail

KWS_URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2'
KWS_SHA256='b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f'
KWS_DIR='sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
VAD_URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
VAD_SHA256='9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
VAD_LICENSE_URL='https://raw.githubusercontent.com/snakers4/silero-vad/867c2aa692646a1f1de3e94a15c9dd9f614c0acb/LICENSE'
VAD_LICENSE_SHA256='2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b'

if [[ -n "${PI_LIVE_VOICE_MODEL_DIR:-}" ]]; then
  MODEL_ROOT="$PI_LIVE_VOICE_MODEL_DIR"
else
  CACHE_ROOT="${XDG_CACHE_HOME:-${HOME:?HOME must be set}/.cache}"
  MODEL_ROOT="$CACHE_ROOT/pi/live-voice/models"
fi
mkdir -p "$MODEL_ROOT/kws" "$MODEL_ROOT/vad"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl --fail --location --silent --show-error "$KWS_URL" --output "$TMP_DIR/kws.tar.bz2"
printf '%s  %s\n' "$KWS_SHA256" "$TMP_DIR/kws.tar.bz2" | sha256sum --check --status
for asset in \
  encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
  decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
  joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
  tokens.txt \
  README.md; do
  tar -xjf "$TMP_DIR/kws.tar.bz2" --directory "$MODEL_ROOT/kws" --strip-components=1 "$KWS_DIR/$asset"
done
mv "$MODEL_ROOT/kws/README.md" "$MODEL_ROOT/kws/MODEL-README.md"
printf 'h uà sh uō @话说\n' > "$MODEL_ROOT/kws/keywords.txt"

curl --fail --location --silent --show-error "$VAD_URL" --output "$TMP_DIR/silero_vad.onnx"
printf '%s  %s\n' "$VAD_SHA256" "$TMP_DIR/silero_vad.onnx" | sha256sum --check --status
curl --fail --location --silent --show-error "$VAD_LICENSE_URL" --output "$TMP_DIR/VAD-LICENSE"
printf '%s  %s\n' "$VAD_LICENSE_SHA256" "$TMP_DIR/VAD-LICENSE" | sha256sum --check --status
install -m 0644 "$TMP_DIR/silero_vad.onnx" "$MODEL_ROOT/vad/silero_vad.onnx"
install -m 0644 "$TMP_DIR/VAD-LICENSE" "$MODEL_ROOT/vad/LICENSE"
printf 'Verified Sherpa-ONNX KWS and Silero VAD assets installed to %s\n' "$MODEL_ROOT"
