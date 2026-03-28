import { createMemoryStateBackend, createWorkspaceStateBackend, type StateBackend } from "@cloudflare/shell";

import type { Workspace } from "../workspace";

/** `state_exec` 返回结果 */
export interface StateExecutionResult {
	/** 原始返回值 */
	value: unknown;
	/** 返回值类型 */
	resultType: string;
}

/** runtime 内部的结构化 state 执行器 */
export interface StateExecutor {
	/**
	 * 执行一段以 `async () => {}` 形式编写的 JavaScript。
	 * @param code JavaScript 源码
	 */
	execute(code: string): Promise<StateExecutionResult>;
}

/** AsyncFunction 构造器 */
const AsyncFunction = Object.getPrototypeOf(async function noop() {
	return undefined;
}).constructor as new (...args: string[]) => (...runtimeArgs: unknown[]) => Promise<unknown>;

/**
 * 将 StateBackend 暴露为 sandbox 可见的 `state` 对象。
 * @param backend shell state backend
 * @returns 绑定后的 state 对象
 */
function createStateApi(backend: StateBackend): Record<string, (...args: unknown[]) => Promise<unknown>> {
	const state: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
	let cursor: object | null = backend as object;

	while (cursor && cursor !== Object.prototype) {
		for (const key of Object.getOwnPropertyNames(cursor)) {
			if (key === "constructor" || key in state) {
				continue;
			}

			const value = Reflect.get(backend as object, key);
			if (typeof value === "function") {
				state[key] = value.bind(backend) as (...args: unknown[]) => Promise<unknown>;
			}
		}
		cursor = Object.getPrototypeOf(cursor);
	}

	return state;
}

/**
 * 规范化 LLM 生成的代码。
 * 当前只接受 async arrow function，避免把任意脚本直接塞进执行器。
 * @param code 原始代码
 * @returns 可执行代码
 */
function normalizeStateCode(code: string): string {
	const trimmed = code.trim();
	if (!trimmed) {
		throw new Error("state_exec code is required");
	}

	if (/\bimport\s/.test(trimmed)) {
		throw new Error("state_exec does not allow import statements");
	}

	if (!/^async\s*\(\s*\)\s*=>/.test(trimmed) && !/^async\s*function/.test(trimmed)) {
		throw new Error("state_exec code must be an async function");
	}

	return trimmed;
}

/**
 * 基于 shell StateBackend 的通用执行器。
 */
class BackendStateExecutor implements StateExecutor {
	/**
	 * @param backend shell backend
	 */
	constructor(private readonly backend: StateBackend) {}

	/**
	 * 执行 JavaScript 代码并注入 `state`
	 * @param code JavaScript 源码
	 * @returns 执行结果
	 */
	async execute(code: string): Promise<StateExecutionResult> {
		const normalized = normalizeStateCode(code);
		const state = createStateApi(this.backend);
		const execute = new AsyncFunction("state", `return (${normalized})();`);
		const value = await execute(state);
		return {
			value,
			resultType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
		};
	}
}

/**
 * memory workspace 的结构化 `state.*` 执行器。
 */
export class MemoryStateExecutor extends BackendStateExecutor {
	/**
	 * @param workspace 运行时工作区
	 */
	constructor(workspace: Workspace) {
		super(createMemoryStateBackend({ fs: workspace.backend.shellFileSystem }));
	}
}

/**
 * durable workspace 的结构化 `state.*` 执行器。
 */
export class WorkspaceStateExecutor extends BackendStateExecutor {
	/**
	 * @param workspace 运行时工作区
	 */
	constructor(workspace: Workspace) {
		if (!workspace.backend.shellWorkspace) {
			throw new Error("WorkspaceStateExecutor requires a durable shell workspace");
		}
		super(createWorkspaceStateBackend(workspace.backend.shellWorkspace));
	}
}
