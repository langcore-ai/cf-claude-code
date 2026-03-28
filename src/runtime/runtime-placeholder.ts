/**
 * Phase 0 runtime 占位对象。
 * Worker 入口只依赖这个常量，避免提前引入尚未实现的 runtime 逻辑。
 */
export const RUNTIME_PLACEHOLDER = {
	name: "edge-agent-runtime",
	stage: "phase-1-runtime-core",
} as const;
