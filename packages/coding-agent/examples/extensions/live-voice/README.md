# Live Voice: local audio runtime

The versioned source stays under `packages/coding-agent/examples/extensions/live-voice/`. It contains only the local audio/model runtime primitives; it is not currently registered or installable as a Pi extension. The `/live` controller and global link are withheld until a real provider configuration is available.

## Explicit setup

Requirements: Linux/WSL2 with PulseAudio/WSLg, Node/npm, `curl`, `sha256sum`, `tar`, and the `parec`/`paplay` commands. The implementation uses PulseAudio's default source at 44.1 kHz mono, converts signed 16-bit PCM to float32, and uses Sherpa's streaming linear resampler to 16 kHz mono. The expected WSL devices are `RDPSource` and `RDPSink`; no Windows-native audio path is provided.

From this package directory:

```sh
npm ci
./scripts/fetch-models.sh
```

The model setup is deliberately explicit and downloads only required model files, not example WAVs. It verifies the archive/model SHA-256 before extracting/installing. Default model root: `$XDG_CACHE_HOME/pi/live-voice/models`, or `~/.cache/pi/live-voice/models` if `XDG_CACHE_HOME` is unset. Set `PI_LIVE_VOICE_MODEL_DIR` to use another root (the same environment variable must be present when Pi starts).

## Model provenance

The exact model records are in `model-manifest.json`; the fetch script pins and verifies these artifacts:

- **KWS:** `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`, from the official Sherpa-ONNX release URL in the manifest; SHA-256 `b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f`. The exact downloaded archive's own model `README.md` declares `license: Apache License 2.0`; the [exact ModelScope model card](https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01) independently declares the same license and identifies WenetSpeech L training data. This evidence applies only to this exact model/archive, not the Sherpa inference engine or other Sherpa models. The custom keyword config is `h uà sh uō @话说`.
- **VAD:** Silero VAD `silero_vad.onnx`, from the exact official Sherpa-ONNX release URL in the manifest; SHA-256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`. An unmodified byte-for-byte mirror's [source metadata](https://huggingface.co/onemira/silero-vad-onnx/resolve/main/source-metadata.json) records that original URL and hash, declares the pretrained weight MIT-licensed, pins the upstream [Silero LICENSE revision](https://github.com/snakers4/silero-vad/blob/867c2aa692646a1f1de3e94a15c9dd9f614c0acb/LICENSE), and records its SHA-256 `2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b`. The fetch script verifies and installs that license beside the downloaded model.
- **Native runtime:** npm `sherpa-onnx-node` version `1.13.8`, pinned by package manifest and lock; npm metadata declares Apache-2.0 and its Linux x64 native package is resolved through its pinned optional dependency.

The model hashes above were calculated from the exact downloaded official URLs and are also checked by the setup script. The KWS upstream references are the [official Node keyword spotter API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/keyword_spotter.html), [KWS model catalog](https://k2-fsa.github.io/sherpa/onnx/kws/), and [custom-keyword model instructions](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/kws/pretrained_models/index.rst). VAD API reference: [official Node VAD API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_vad.html).

## Audio and model code

- `audio.ts`: `PulseCapture` reads PulseAudio raw PCM via a child process and emits 16 kHz mono float32 frames; `PulsePlayer` streams in-memory PCM via `paplay`; wake cue is generated as a short, low-volume tone in memory. Stop is idempotent and terminates child processes, escalating to SIGKILL after a bounded grace period.
- `sherpa.ts`: real Sherpa-ONNX Silero VAD (512-sample windows and 1.5-second silence segmentation), streaming KWS targeting exactly `话说`, and a LinearResampler. `loadLocalSpeechModels()` fails on missing assets or native initialization errors; there is no KWS/VAD fallback.
- `scripts/fetch-models.sh`: explicit, hash-checked local model setup; no automatic runtime downloads.

Microphone PCM, VAD/KWS rolling state, cue samples, and utterance PCM remain process memory only. The fetcher does not extract model example WAVs. No capture data is written to disk. This package does not implement `/live`, preset APIs, transcript/reply LLM calls, or remote API adapters, and must not be manually symlinked into Pi's extension directory. A WSL device smoke has confirmed model loading, silence behavior, capture and cue playback; positive `话说` recognition and the full extension runtime remain unverified.
