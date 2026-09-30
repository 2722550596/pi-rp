/**
 * Browser-bundle stand-in for the `./node` subexport, selected via the package `browser` export condition.
 *
 * Browser builds never execute these classes: profile entries must inject the OPFS implementations from `./web`
 * instead. Reaching for a node implementation in a browser bundle is an assembly error (storage is an existence
 * premise, contract §7.4), so construction throws a typed, instructive error rather than failing later on a missing
 * fs module.
 */
class NodeOnlyInBrowserError extends Error {
	constructor(className: string) {
		super(
			`${className} is the node-profile implementation and cannot run in a browser bundle. ` +
				"Assemble the browser profile with the OPFS implementations from '@earendil-works/pi-agent-core/web'.",
		);
		this.name = "NodeOnlyInBrowserError";
	}
}

export class NodeExecutionEnv {
	constructor() {
		throw new NodeOnlyInBrowserError("NodeExecutionEnv");
	}
}

export class NodeStorageBackend {
	static get shared(): never {
		throw new NodeOnlyInBrowserError("NodeStorageBackend");
	}

	constructor() {
		throw new NodeOnlyInBrowserError("NodeStorageBackend");
	}
}

export class NodeStateLocks {
	static get shared(): never {
		throw new NodeOnlyInBrowserError("NodeStateLocks");
	}

	constructor() {
		throw new NodeOnlyInBrowserError("NodeStateLocks");
	}
}

export class NodeStatePaths {
	constructor() {
		throw new NodeOnlyInBrowserError("NodeStatePaths");
	}
}
