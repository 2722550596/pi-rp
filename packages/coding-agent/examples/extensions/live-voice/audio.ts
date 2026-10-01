import { type ChildProcess, spawn } from "node:child_process";

export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;

export interface PcmFrame {
	sampleRate: number;
	channels: 1;
	samples: Float32Array;
}

export type AudioSegment = PcmFrame;
export type AudioFrameHandler = (frame: PcmFrame) => void;
export type AudioFailureHandler = (error: Error) => void;
export type PcmResampler = (samples: Float32Array) => Float32Array;

const TERMINATE_TIMEOUT_MS = 1_000;

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let terminateTimer: ReturnType<typeof setTimeout> | undefined;
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill("SIGTERM");
	await Promise.race([
		exited,
		new Promise<void>((resolve) => {
			terminateTimer = setTimeout(resolve, TERMINATE_TIMEOUT_MS);
		}),
	]);
	clearTimeout(terminateTimer);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}

function processFailure(command: string, error: Error): Error {
	return new Error(`${command} failed: ${error.message}`, { cause: error });
}

/** Captures signed 16-bit PCM from the default PulseAudio source, converting it to mono float32/16 kHz. */
export class PulseCapture {
	private child?: ChildProcess;
	private stopping = false;
	private pendingByte?: number;
	private readonly resample: PcmResampler;
	private readonly device?: string;

	constructor(resample: PcmResampler, device?: string) {
		this.resample = resample;
		this.device = device;
	}

	async start(onFrame: AudioFrameHandler, onError?: AudioFailureHandler): Promise<void> {
		if (this.child) throw new Error("PulseAudio capture is already running");
		this.stopping = false;
		const args = ["--raw", "--format=s16le", "--rate=44100", "--channels=1"];
		if (this.device) args.push(`--device=${this.device}`);
		const child = spawn("parec", args, { stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		let started = false;
		child.stderr?.resume();
		child.once("error", (error) => {
			if (!this.stopping && started) onError?.(processFailure("parec", error));
		});
		child.once("close", (code, signal) => {
			if (!this.stopping && started) {
				onError?.(new Error(`parec exited unexpectedly (code=${code}, signal=${signal ?? "none"})`));
			}
			if (this.child === child) this.child = undefined;
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (this.stopping) return;
			const byteCount = chunk.length + (this.pendingByte === undefined ? 0 : 1);
			const sampleCount = byteCount >> 1;
			if (sampleCount === 0) {
				this.pendingByte = chunk[0];
				return;
			}
			const pcm = new Float32Array(sampleCount);
			let outputIndex = 0;
			let inputIndex = 0;
			if (this.pendingByte !== undefined) {
				const sample = ((this.pendingByte | (chunk[0] << 8)) << 16) >> 16;
				pcm[outputIndex++] = sample / 32768;
				this.pendingByte = undefined;
				inputIndex = 1;
			}
			for (; inputIndex + 1 < chunk.length; inputIndex += 2) {
				const sample = chunk.readInt16LE(inputIndex);
				pcm[outputIndex++] = sample / 32768;
			}
			if (inputIndex < chunk.length) this.pendingByte = chunk[inputIndex];
			try {
				const resampled = this.resample(pcm);
				for (let offset = 0; offset < resampled.length; offset += 512) {
					onFrame({
						sampleRate: AUDIO_SAMPLE_RATE,
						channels: AUDIO_CHANNELS,
						samples: resampled.subarray(offset, Math.min(offset + 512, resampled.length)),
					});
				}
			} catch (error) {
				onError?.(error instanceof Error ? error : new Error(String(error)));
				void this.stop();
			}
		});
		await new Promise<void>((resolve, reject) => {
			const onSpawnError = (error: Error) => reject(processFailure("parec", error));
			child.once("spawn", () => {
				started = true;
				resolve();
			});
			child.once("error", onSpawnError);
			child.once("close", (code, signal) => {
				reject(new Error(`parec exited during startup (code=${code}, signal=${signal ?? "none"})`));
			});
		}).catch(async (error: Error) => {
			await this.stop();
			throw error;
		});
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.pendingByte = undefined;
		const child = this.child;
		if (!child) return;
		await stopProcess(child);
		if (this.child === child) this.child = undefined;
	}
}

/** Plays in-memory float32 PCM via paplay. No audio file or temporary file is created. */
export class PulsePlayer {
	private child?: ChildProcess;

	async playPcm(samples: Float32Array, sampleRate: number, signal: AbortSignal): Promise<void> {
		if (sampleRate <= 0 || samples.length === 0)
			throw new Error("Audio playback requires non-empty PCM and a positive sample rate");
		if (this.child) throw new Error("PulseAudio playback is already running");
		if (signal.aborted) throw signal.reason ?? new Error("Playback aborted");
		const child = spawn("paplay", ["--raw", "--format=float32le", `--rate=${sampleRate}`, "--channels=1"], {
			stdio: ["pipe", "ignore", "pipe"],
		});
		this.child = child;
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (text: string) => {
			stderr += text;
		});
		let stdinError: Error | undefined;
		child.stdin?.on("error", (error: Error) => {
			stdinError = error;
		});
		const abort = () => child.stdin?.destroy();
		signal.addEventListener("abort", abort, { once: true });
		try {
			await new Promise<void>((resolve, reject) => {
				child.once("error", (error) => reject(processFailure("paplay", error)));
				child.once("close", (code, childSignal) => {
					if (signal.aborted) reject(signal.reason ?? new Error("Playback aborted"));
					else if (stdinError) reject(processFailure("paplay stdin", stdinError));
					else if (code !== 0)
						reject(new Error(`paplay exited (code=${code}, signal=${childSignal ?? "none"}): ${stderr.trim()}`));
					else resolve();
				});
				child.once("spawn", () => {
					const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
					child.stdin?.end(bytes);
				});
			});
		} finally {
			signal.removeEventListener("abort", abort);
			await stopProcess(child);
			if (this.child === child) this.child = undefined;
		}
	}

	async playWakeCue(signal: AbortSignal): Promise<void> {
		const sampleRate = AUDIO_SAMPLE_RATE;
		const durationSeconds = 0.14;
		const samples = new Float32Array(sampleRate * durationSeconds);
		const frequency = 660;
		const amplitude = 0.12;
		for (let i = 0; i < samples.length; i++) {
			const envelope = Math.min(1, i / 160, (samples.length - i) / 640);
			samples[i] = amplitude * envelope * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
		}
		await this.playPcm(samples, sampleRate, signal);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.stdin?.destroy();
		await stopProcess(child);
		if (this.child === child) this.child = undefined;
	}
}

export { stopProcess as stopAudioProcess };
