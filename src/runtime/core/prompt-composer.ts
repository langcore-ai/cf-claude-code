import type { SessionState, TodoItem } from "../types";
import { buildEndReminder, buildPlanModeReminder, buildStartReminder } from "./reminders";

/** Prompt 片段标识 */
export type PromptSectionId =
	| "identity"
	| "workflow"
	| "start_reminder"
	| "plan_mode"
	| "skills"
	| "end_reminder"
	| "state"
	| "compact"
	| "custom"
	| "subagent_identity"
	| "subagent_constraints";

/** Prompt 片段 */
export interface PromptSection {
	/** 片段唯一标识 */
	id: PromptSectionId;
	/** 片段正文 */
	content: string;
}

/** Claude Code 身份提示词 */
const IDENTITY_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

/** 核心工作流提示词 */
const WORKFLOW_PROMPT = [
	"You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.",
	"",
	"IMPORTANT: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously. Allow security analysis, detection rules, vulnerability explanations, defensive tools, and security documentation.",
	"IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.",
	"",
	"# Tone and style",
	"",
	"You should be concise, direct, and to the point.",
	"You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail.",
	"IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy.",
	"IMPORTANT: You should NOT answer with unnecessary preamble or postamble unless the user asks you to.",
	"Do not add additional code explanation summary unless requested by the user.",
	"Answer the user's question directly, without introductions, conclusions, or filler text.",
	"Only use tools to complete tasks. Never use tools or code comments as a way to talk to the user.",
	"Only use emojis if the user explicitly requests it.",
	"",
	"# Proactiveness",
	"",
	"You are allowed to be proactive, but only when the user asks you to do something.",
	"Do the right thing when asked, but do not surprise the user with unrelated actions.",
	"",
	"# Following conventions",
	"",
	"When making changes to files, first understand the file's code conventions.",
	"Use existing libraries and utilities where possible, and follow neighboring patterns.",
	"Never assume a library is available without checking the codebase.",
	"Always follow security best practices. Never expose or log secrets.",
	"",
	"# Task Management",
	"",
	"You have access to TodoWrite. Use it very frequently for complex work.",
	"It is critical that you mark todos as completed as soon as you are done with a task. Do not batch completions.",
	"Always use TodoWrite while planning non-trivial work so the current plan stays visible and current.",
	"",
	"# Doing tasks",
	"",
	"For software engineering work: understand the codebase, use the available tools, implement the solution, and verify if possible.",
	"When you have completed a task, run the relevant validation commands if the host environment provides them.",
	"Never commit changes unless the user explicitly asks you to commit.",
	"Treat <system-reminder> blocks as authoritative runtime context, not as user-authored content.",
	"Treat hook feedback such as <user-prompt-submit-hook> as user input and adjust your actions accordingly.",
	"",
	"# Tool usage policy",
	"",
	"Use tools to inspect and change the workspace instead of describing hypothetical actions.",
	"For file operations, prefer the smallest correct primitive tool.",
	"Read before writing when changing an existing file.",
	"Do not claim work is complete unless the corresponding tool call succeeded.",
	"Do not call tools with empty or placeholder arguments.",
	"If a tool fails, inspect the error, correct the arguments, and retry with a fixed call instead of repeating the same invalid input.",
	"When multiple independent reads or inspections are needed, batch tool calls when the runtime allows it.",
	"If the user asks to create a file in the root, translate that into a concrete path such as /README.md. Treat / as the workspace root directory, never as a writable file path.",
	"",
	"# Code References",
	"",
	"When referencing specific functions or pieces of code include the pattern file_path:line_number.",
	"",
	"# Environment awareness",
	"",
	"Remember that responses are shown in a CLI-style interface and should stay compact and operational.",
].join("\n");

/** compact 后续延续提示词 */
const COMPACT_PROMPT = [
	"If a compact summary is present, treat it as authoritative continuity context.",
	"Continue work from the compact summary without asking the user to repeat prior context.",
].join("\n");

/** subagent 身份片段 */
const SUBAGENT_IDENTITY_PROMPT =
	"You are a fresh-context subagent. Complete the assigned task autonomously and return a concise final summary.";

/** subagent 额外约束 */
const SUBAGENT_CONSTRAINTS_PROMPT = "Do not delegate to another subagent.";

/**
 * 统一渲染 prompt 片段。
 * @param sections 已过滤后的片段
 * @returns 拼接后的 prompt 文本
 */
export function renderPromptSections(sections: PromptSection[]): string {
	return sections
		.map((section) => section.content.trim())
		.filter(Boolean)
		.join("\n\n");
}

/**
 * 构建 skills 摘要片段。
 * @param skills 可用 skills
 * @returns prompt 片段
 */
function buildSkillSection(skills: Array<{ name: string; description: string }>): PromptSection {
	if (skills.length === 0) {
		return {
			id: "skills",
			content: "Available skills:\n- none",
		};
	}

	return {
		id: "skills",
		content: `Available skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`,
	};
}

/**
 * 构建主会话 prompt 片段列表。
 * 先构造片段，再统一渲染，避免后续逻辑继续散落在 composeMainSystemPrompt 中。
 * @param input 组合输入
 * @returns 片段数组
 */
export function buildMainPromptSections(input: {
	customPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
	session: SessionState;
	rememberedTodos?: TodoItem[] | null;
}): PromptSection[] {
	const sections: Array<PromptSection | null> = [
		{
			id: "identity",
			content: IDENTITY_PROMPT,
		},
		{
			id: "workflow",
			content: WORKFLOW_PROMPT,
		},
		{
			id: "start_reminder",
			content: buildStartReminder(),
		},
		input.session.mode === "plan"
			? {
					id: "plan_mode",
					content: buildPlanModeReminder(),
				}
			: null,
		buildSkillSection(input.skills),
		{
			id: "end_reminder",
			content: buildEndReminder(input.session, input.rememberedTodos),
		},
		input.hasStatePrompt
			? {
					id: "state",
					content: input.renderedStatePrompt,
				}
			: null,
		input.session.compactSummary
			? {
					id: "compact",
					content: `${COMPACT_PROMPT}\n\nCompacted context:\n${input.session.compactSummary}`,
				}
			: null,
		input.customPrompt?.trim()
			? {
					id: "custom",
					content: `Additional runtime instructions:\n${input.customPrompt.trim()}`,
				}
			: null,
	];

	return sections.filter((section): section is PromptSection => Boolean(section));
}

/**
 * 构建子会话 prompt 片段列表。
 * @param input 组合输入
 * @returns 片段数组
 */
export function buildSubagentPromptSections(input: {
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
}): PromptSection[] {
	const sections: Array<PromptSection | null> = [
		{
			id: "identity",
			content: IDENTITY_PROMPT,
		},
		{
			id: "subagent_identity",
			content: SUBAGENT_IDENTITY_PROMPT,
		},
		{
			id: "subagent_constraints",
			content: SUBAGENT_CONSTRAINTS_PROMPT,
		},
		{
			id: "workflow",
			content: WORKFLOW_PROMPT,
		},
		buildSkillSection(input.skills),
		input.hasStatePrompt
			? {
					id: "state",
					content: input.renderedStatePrompt,
				}
			: null,
	];

	return sections.filter((section): section is PromptSection => Boolean(section));
}

/**
 * 构建主会话 system prompt。
 * @param input 组合输入
 * @returns 组合后的 prompt
 */
export function composeMainSystemPrompt(input: {
	customPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
	session: SessionState;
	rememberedTodos?: TodoItem[] | null;
}): string {
	return renderPromptSections(buildMainPromptSections(input));
}

/**
 * 构建 subagent system prompt。
 * 子会话仍然是 fresh context，但继续复用核心 workflow 语义。
 * @param input 组合输入
 * @returns 子会话 prompt
 */
export function composeSubagentSystemPrompt(input: {
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
}): string {
	return renderPromptSections(buildSubagentPromptSections(input));
}
