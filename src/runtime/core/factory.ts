import type { SqlSource } from "@cloudflare/shell";

import {
	D1SessionStore,
	D1SubagentStore,
	D1TranscriptStore,
	InMemorySessionStore,
	InMemorySubagentStore,
	InMemoryTranscriptStore,
} from "../adapters";
import { MemoryStateExecutor, WorkspaceStateExecutor } from "./state-executor";
import { MemoryAgentRuntime, type RuntimeDependencies } from "./runtime";
import { InMemorySkillProvider, MergedSkillProvider, type InMemorySkillSeed, WorkspaceSkillProvider } from "../skills";
import { DEFAULT_TOOLS, type RuntimeTool } from "../tools";
import { DurableWorkspaceAdapter, InMemoryWorkspaceAdapter } from "../workspace";
import type { AIClient } from "../types";

/** memory runtime 配置 */
export interface CreateMemoryRuntimeOptions {
	aiClient: AIClient;
	workspaceName?: string;
	files?: Record<string, string>;
	skills?: InMemorySkillSeed[];
	tools?: RuntimeTool[];
}

/** durable runtime 配置 */
export interface CreateDurableRuntimeOptions {
	aiClient: AIClient;
	sql: SqlSource;
	namespace?: string;
	workspaceName: string;
	skills?: InMemorySkillSeed[];
	tools?: RuntimeTool[];
}

/**
 * 创建 memory runtime。
 * 主要给本地测试和最小闭环用。
 * @param options runtime 配置
 * @returns runtime 实例
 */
export function createMemoryRuntime(options: CreateMemoryRuntimeOptions): MemoryAgentRuntime {
	const workspace = new InMemoryWorkspaceAdapter(options.workspaceName ?? "memory-runtime", options.files);
	const deps: RuntimeDependencies = {
		aiClient: options.aiClient,
		workspace,
		skillProvider: new InMemorySkillProvider(options.skills ?? []),
		sessionStore: new InMemorySessionStore(),
		transcriptStore: new InMemoryTranscriptStore(),
		subagentStore: new InMemorySubagentStore(),
		stateExecutor: new MemoryStateExecutor(workspace),
		tools: options.tools ?? DEFAULT_TOOLS,
	};

	return new MemoryAgentRuntime(deps);
}

/**
 * 创建 durable runtime。
 * 这里统一装配 D1-backed workspace 和三类 durable stores。
 * @param options runtime 配置
 * @returns runtime 实例
 */
export function createDurableRuntime(options: CreateDurableRuntimeOptions): MemoryAgentRuntime {
	const workspace = new DurableWorkspaceAdapter({
		sql: options.sql,
		namespace: options.namespace,
		name: options.workspaceName,
	});

	const deps: RuntimeDependencies = {
		aiClient: options.aiClient,
		workspace,
		skillProvider: new MergedSkillProvider({
			providers: [
				new WorkspaceSkillProvider({
					workspace,
				}),
				new InMemorySkillProvider(options.skills ?? []),
			],
		}),
		sessionStore: new D1SessionStore(options.sql, {
			namespace: options.namespace,
		}),
		transcriptStore: new D1TranscriptStore(options.sql, {
			namespace: options.namespace,
		}),
		subagentStore: new D1SubagentStore(options.sql, {
			namespace: options.namespace,
		}),
		stateExecutor: new WorkspaceStateExecutor(workspace),
		tools: options.tools ?? DEFAULT_TOOLS,
	};

	return new MemoryAgentRuntime(deps);
}
