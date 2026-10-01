declare module "sherpa-onnx-node" {
	export interface OnlineStream {
		acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
	}

	export interface VadConfig {
		sileroVad: {
			model: string;
			threshold: number;
			minSpeechDuration: number;
			minSilenceDuration: number;
			windowSize: number;
		};
		sampleRate: number;
		debug: boolean;
		numThreads: number;
	}

	export class Vad {
		constructor(config: VadConfig, bufferSizeInSeconds: number);
		acceptWaveform(samples: Float32Array): void;
		isDetected(): boolean;
		isEmpty(): boolean;
		front(): { start: number; samples: Float32Array };
		pop(): void;
		reset(): void;
	}

	export class CircularBuffer {
		constructor(capacity: number);
		push(samples: Float32Array): void;
		size(): number;
		head(): number;
		get(startIndex: number, length: number): Float32Array;
		pop(length: number): void;
		reset(): void;
	}

	export class KeywordSpotter {
		constructor(config: {
			featConfig: { sampleRate: number; featureDim: number };
			modelConfig: {
				transducer: { encoder: string; decoder: string; joiner: string };
				tokens: string;
				numThreads: number;
				provider: string;
				debug: boolean;
			};
			keywordsFile: string;
			keywordsScore: number;
			keywordsThreshold: number;
		});
		createStream(): OnlineStream;
		isReady(stream: OnlineStream): boolean;
		decode(stream: OnlineStream): void;
		getResult(stream: OnlineStream): { keyword: string; start_time: number; timestamps: number[]; tokens: string[] };
		reset(stream: OnlineStream): void;
	}

	export class LinearResampler {
		constructor(inputRate: number, outputRate: number);
		resample(samples: Float32Array): Float32Array;
	}
}
