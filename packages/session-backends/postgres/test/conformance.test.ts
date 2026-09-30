import type { SessionRepo } from "@earendil-works/pi-agent-core";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "@earendil-works/pi-agent-core/session/testing";
import { describe, it } from "vitest";
import { PostgresSessionRepository } from "../src/index.ts";
import { createPool, databaseUrl, uniqueId } from "./test-utils.ts";

const conformance = createSessionBackendConformance(async () => {
	const pool = createPool();
	const postgres = new PostgresSessionRepository({ pool });
	const cwd = `/pi-rp-postgres-conformance/${uniqueId("cwd")}`;
	const repository: SessionRepo = {
		create: (options = {}) => postgres.create({ ...options, cwd }),
		open: (metadata) => postgres.open(metadata),
		list: (options) => postgres.list(options),
		delete: (metadata) => postgres.delete(metadata),
		fork: (source, options = {}) => postgres.fork(source, { ...options, cwd }),
	};
	return {
		repository,
		async [Symbol.asyncDispose]() {
			try {
				for (const metadata of await postgres.list({ cwd })) await postgres.delete(metadata);
			} finally {
				await postgres.close();
			}
		},
	} satisfies SessionBackendFixture;
});

const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgresSessionRepository conformance", () => {
	if (!databaseUrl) it.skip("requires PI_TEST_DATABASE_URL (real PostgreSQL integration)", () => {});
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});
