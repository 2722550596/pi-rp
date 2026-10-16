import { toEpochDays } from "./recall.ts";

export type MemoryClockMode = "world" | "real";

export interface ResolvedMemoryClock {
	readonly mode: MemoryClockMode;
	readonly timezone?: string;
}

export const WORLD_CLOCK: ResolvedMemoryClock = { mode: "world" };

export function resolveMemoryClock(raw: { mode?: unknown; timezone?: unknown } | undefined): ResolvedMemoryClock {
	if (raw?.mode === undefined || raw.mode === "world") return WORLD_CLOCK;
	if (raw.mode !== "real") {
		process.stderr.write("[memory] invalid clock mode; using world\n");
		return WORLD_CLOCK;
	}
	const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (raw.timezone === undefined) return { mode: "real", timezone: local };
	try {
		if (typeof raw.timezone !== "string") throw new Error("invalid timezone");
		new Intl.DateTimeFormat("en-US", { timeZone: raw.timezone });
		return { mode: "real", timezone: raw.timezone };
	} catch {
		process.stderr.write("[memory] invalid clock timezone; using process local timezone\n");
		return { mode: "real", timezone: local };
	}
}

function parts(date: Date, clock: ResolvedMemoryClock): Record<string, string> {
	return Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: clock.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
			timeZoneName: "longOffset",
		})
			.formatToParts(date)
			.map((part) => [part.type, part.value]),
	);
}

export function formatStamp(date: Date, clock: ResolvedMemoryClock): string {
	if (clock.mode === "world") return date.toISOString();
	const p = parts(date, clock);
	const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

export function dayNumber(ts: string, clock: ResolvedMemoryClock): number | null {
	if (clock.mode === "world") return toEpochDays(ts);
	const date = new Date(ts);
	if (!Number.isFinite(date.getTime())) return null;
	const p = parts(date, clock);
	return toEpochDays(`${p.year}-${p.month}-${p.day}`);
}
