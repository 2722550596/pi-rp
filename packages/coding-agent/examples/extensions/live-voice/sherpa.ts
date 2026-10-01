import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as sherpa from "sherpa-onnx-node";
import type { PcmFrame } from "./audio.ts";

const SAMPLE_RATE = 16_000;
const VAD_WINDOW_SIZE = 512;
const VAD_SILENCE_SECONDS = 1.5;
const TARGET_WAKE_WORD = "话说";

interface ModelManifest {
	sampleRate: number;
	kws: {
		name: string;
		source: string;
		sha256: string;
		license: string;
		licenseEvidence: string;
		licenseSource: string;
		archiveDirectory: string;
		encoder: string;
		decoder: string;
		joiner: string;
		tokens: string;
		keywords: string;
		targetKeyword: string;
		targetKeywordTokens: string;
	};
	vad: {
		name: string;
		source: string;
		sha256: string;
		license: string;
		licenseEvidenceSource: string;
		licenseSource: string;
		licenseSha256: string;
		licenseEvidence: string;
		model: string;
	};
}

function getModelRoot(): string {
	const configured = process.env.PI_LIVE_VOICE_MODEL_DIR;
	if (configured) return resolve(configured);
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cacheRoot, "pi", "live-voice", "models");
}

async function resolveModelPaths(): Promise<{ manifest: ModelManifest; kws: Record<string, string>; vad: string }> {
	const manifest = JSON.parse(
		await readFile(new URL("./model-manifest.json", import.meta.url), "utf8"),
	) as ModelManifest;
	const root = getModelRoot();
	const kws = {
		encoder: join(root, manifest.kws.encoder),
		decoder: join(root, manifest.kws.decoder),
		joiner: join(root, manifest.kws.joiner),
		tokens: join(root, manifest.kws.tokens),
		keywords: join(root, manifest.kws.keywords),
	};
	const vad = join(root, manifest.vad.model);
	await Promise.all(
		[...Object.values(kws), vad].map(async (path) => {
			try {
				await stat(path);
			} catch (error) {
				throw new Error(`Missing local live-voice model asset ${path}; run the package's scripts/fetch-models.sh`, {
					cause: error,
				});
			}
		}),
	);
	return { manifest, kws, vad };
}

export interface VadResult {
	speechActive: boolean;
	completedSegments: readonly Float32Array[];
}

export interface VoiceActivityDetector {
	accept(frame: PcmFrame): VadResult;
	reset(): void;
	dispose(): void;
}

export interface WakeWordDetector {
	accept(frame: PcmFrame): boolean;
	reset(): void;
	dispose(): void;
}

class SherpaVad implements VoiceActivityDetector {
	private vad: sherpa.Vad | undefined;
	private window: sherpa.CircularBuffer | undefined;
	private disposed = false;

	constructor(modelPath: string) {
		this.vad = new sherpa.Vad(
			{
				sileroVad: {
					model: modelPath,
					threshold: 0.5,
					minSpeechDuration: 0.25,
					minSilenceDuration: VAD_SILENCE_SECONDS,
					windowSize: VAD_WINDOW_SIZE,
				},
				sampleRate: SAMPLE_RATE,
				debug: false,
				numThreads: 1,
			},
			30,
		);
		this.window = new sherpa.CircularBuffer(VAD_WINDOW_SIZE * 2);
	}

	accept(frame: PcmFrame): VadResult {
		const vad = this.vad;
		const window = this.window;
		if (this.disposed || !vad || !window) throw new Error("VAD has been disposed");
		if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1)
			throw new Error("Sherpa VAD requires mono 16 kHz PCM");
		window.push(frame.samples);
		const completedSegments: Float32Array[] = [];
		while (window.size() >= VAD_WINDOW_SIZE) {
			const samples = window.get(window.head(), VAD_WINDOW_SIZE);
			window.pop(VAD_WINDOW_SIZE);
			vad.acceptWaveform(samples);
			while (!vad.isEmpty()) {
				completedSegments.push(vad.front().samples);
				vad.pop();
			}
		}
		return { speechActive: vad.isDetected(), completedSegments };
	}

	reset(): void {
		this.window?.reset();
		this.vad?.reset();
	}

	dispose(): void {
		if (this.disposed) return;
		this.reset();
		this.window = undefined;
		this.vad = undefined;
		this.disposed = true;
	}
}

class SherpaWakeWordDetector implements WakeWordDetector {
	private spotter: sherpa.KeywordSpotter | undefined;
	private stream: sherpa.OnlineStream | undefined;
	private disposed = false;

	constructor(paths: Record<string, string>) {
		this.spotter = new sherpa.KeywordSpotter({
			featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
			modelConfig: {
				transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
				tokens: paths.tokens,
				numThreads: 1,
				provider: "cpu",
				debug: false,
			},
			keywordsFile: paths.keywords,
			keywordsScore: 1.0,
			keywordsThreshold: 0.25,
		});
		this.stream = this.spotter.createStream();
	}

	accept(frame: PcmFrame): boolean {
		const spotter = this.spotter;
		const stream = this.stream;
		if (this.disposed || !spotter || !stream) throw new Error("Keyword spotter has been disposed");
		if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1)
			throw new Error("Sherpa KWS requires mono 16 kHz PCM");
		stream.acceptWaveform({ samples: frame.samples, sampleRate: SAMPLE_RATE });
		let detected = false;
		while (spotter.isReady(stream)) {
			spotter.decode(stream);
			if (spotter.getResult(stream).keyword === TARGET_WAKE_WORD) detected = true;
		}
		if (detected) spotter.reset(stream);
		return detected;
	}

	reset(): void {
		if (!this.disposed && this.spotter && this.stream) this.spotter.reset(this.stream);
	}

	dispose(): void {
		if (this.disposed) return;
		this.reset();
		this.stream = undefined;
		this.spotter = undefined;
		this.disposed = true;
	}
}

export interface LocalSpeechModels {
	vad: VoiceActivityDetector;
	wakeWord: WakeWordDetector;
	resample(samples: Float32Array): Float32Array;
	dispose(): void;
}

/** Loads installed local models and the native Sherpa runtime before live mode is enabled. */
export async function loadLocalSpeechModels(): Promise<LocalSpeechModels> {
	const { manifest, kws, vad } = await resolveModelPaths();
	let resampler: sherpa.LinearResampler | undefined;
	let vadDetector: SherpaVad | undefined;
	let wakeWordDetector: SherpaWakeWordDetector | undefined;
	try {
		resampler = new sherpa.LinearResampler(44_100, manifest.sampleRate);
		vadDetector = new SherpaVad(vad);
		wakeWordDetector = new SherpaWakeWordDetector(kws);
	} catch (error) {
		vadDetector?.dispose();
		wakeWordDetector?.dispose();
		resampler = undefined;
		throw new Error("Unable to initialize the Sherpa-ONNX VAD/KWS models", { cause: error });
	}
	let disposed = false;
	return {
		vad: vadDetector,
		wakeWord: wakeWordDetector,
		resample(samples) {
			const activeResampler = resampler;
			if (disposed || !activeResampler) throw new Error("Sherpa resampler has been disposed");
			return activeResampler.resample(samples);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			vadDetector?.dispose();
			wakeWordDetector?.dispose();
			resampler = undefined;
			vadDetector = undefined;
			wakeWordDetector = undefined;
		},
	};
}
