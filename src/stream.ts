import type { Api, Context, Message, Model, SimpleStreamOptions, ToolChoice } from "@oh-my-pi/pi-ai";
import { type GoogleGeminiCliOptions, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
	resolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { GoogleWireCompat } from "./compat";
import { resolveWireCompat } from "./compat";
import { ANTIGRAVITY_DAILY_ENDPOINT, getAntigravityBaseUrl } from "./models";

const MIN_OUTPUT_TOKENS = 1024;
const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
const GOOGLE_THINKING: Readonly<Record<Effort, number>> = {
	[Effort.Minimal]: 1024,
	[Effort.Low]: 4096,
	[Effort.Medium]: 8192,
	[Effort.High]: 16384,
	[Effort.XHigh]: 24575,
	[Effort.Max]: 32768,
};

export interface WireRequest {
	wireModel: Model<"google-gemini-cli">;
	wireOptions: GoogleGeminiCliOptions;
}

function mapToolChoice(choice: ToolChoice | undefined): GoogleGeminiCliOptions["toolChoice"] {
	if (choice === undefined) return undefined;
	if (typeof choice === "string") {
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		if (choice === "required") return "any";
		return undefined;
	}
	const choiceObj = choice as unknown as Record<string, unknown>;
	if (choiceObj.type === "computer") return "any";
	const fnObj = choiceObj.function as { name?: string } | undefined;
	const name = fnObj?.name ?? (typeof choiceObj.name === "string" ? choiceObj.name : undefined);
	return name ? { mode: "ANY", allowedFunctionNames: [name] } : undefined;
}

function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncapped = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncapped, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}

function toWireModel(model: Model<Api>): Model<"google-gemini-cli"> {
	const baseUrl = model.baseUrl?.trim() || getAntigravityBaseUrl();
	const wireModel = {
		...(model as Model<"google-gemini-cli">),
		api: "google-gemini-cli" as const,
		provider: "google-antigravity",
		baseUrl,
	};
	(wireModel as unknown as { compat: GoogleWireCompat }).compat = resolveWireCompat(wireModel);
	return wireModel as unknown as Model<"google-gemini-cli">;
}

export function createWireRequest(model: Model<Api>, options?: SimpleStreamOptions): WireRequest {
	const wireModel = toWireModel(model);
	const { reasoning, disableReasoning, thinkingBudgets, toolChoice, apiKey, ...forwardedOptions } = options ?? {};
	const isCustomEndpoint =
		wireModel.baseUrl !== ANTIGRAVITY_DAILY_ENDPOINT &&
		wireModel.baseUrl !== "https://daily-cloudcode-pa.sandbox.googleapis.com";
	const antigravityEndpointMode = isCustomEndpoint
		? ((forwardedOptions as GoogleGeminiCliOptions).antigravityEndpointMode ?? "auto")
		: "production";
	const baseOptions: GoogleGeminiCliOptions = {
		...forwardedOptions,
		apiKey: typeof apiKey === "string" ? apiKey : undefined,
		toolChoice: mapToolChoice(toolChoice),
		antigravityEndpointMode,
	};

	if (reasoning !== undefined && !disableReasoning && wireModel.reasoning) {
		const effort = requireSupportedEffort(wireModel, reasoning);
		const requestModelId = resolveWireModelId(wireModel, effort);
		if (wireModel.thinking?.mode === "google-level") {
			return {
				wireModel,
				wireOptions: {
					...baseOptions,
					requestModelId,
					thinking: { enabled: true, level: mapEffortToGoogleThinkingLevel(effort) },
				},
			};
		}

		let budget = thinkingBudgets?.[effort] ?? wireModel.thinking?.effortBudgets?.[effort] ?? GOOGLE_THINKING[effort];
		const maxTokens = maxTokensWithThinkingBudget(
			options?.maxTokens ?? wireModel.maxTokens ?? undefined,
			wireModel.maxTokens,
			budget,
		);
		if (maxTokens <= budget) budget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
		if (budget > 0) {
			return {
				wireModel,
				wireOptions: {
					...baseOptions,
					maxTokens,
					requestModelId,
					thinking: { enabled: true, budgetTokens: budget },
				},
			};
		}
	}

	const thinking: NonNullable<GoogleGeminiCliOptions["thinking"]> = { enabled: false };
	if (wireModel.reasoning && wireModel.thinking?.suppressWhenOff) {
		thinking.suppress = wireModel.thinking.mode === "google-level" ? { level: "MINIMAL" } : { budget: 0 };
	}
	return {
		wireModel,
		wireOptions: {
			...baseOptions,
			requestModelId: resolveWireModelId(wireModel, undefined),
			thinking,
		},
	};
}

import { clearAntigravityAuthBlocks } from "./config";

function sanitizeAntigravityError<T extends { errorMessage?: string }>(error: T): T {
	if (error.errorMessage) {
		const msg = error.errorMessage;
		if (/resource has been exhausted|rate.?limit/i.test(msg) && !/exhausted your capacity on this model/i.test(msg)) {
			error.errorMessage = `${msg.replace(/Resource has been exhausted(?:\s*\(e\.g\. check quota\)\.?)?/gi, "Concurrent request limit exceeded (burst rate limit)")} [retry-after-ms: 5000]`;
		}
	}
	return error;
}

export function sanitizePromptText(text: string): string {
	if (!text) return text;
	return text
		.replace(/<system-conventions\b[^>]*>/gi, "<system-rules>")
		.replace(/<\/system-conventions\s*>/gi, "</system-rules>");
}

export function sanitizeAntigravityContext(context: Context): Context {
	let modified = false;

	const newSystemPrompt = context.systemPrompt?.map((s) => {
		const res = sanitizePromptText(s);
		if (res !== s) modified = true;
		return res;
	});

	const newMessages = context.messages.map((msg) => {
		if (typeof msg.content === "string") {
			const res = sanitizePromptText(msg.content);
			if (res !== msg.content) {
				modified = true;
				return { ...msg, content: res } as Message;
			}
			return msg;
		}
		if (Array.isArray(msg.content)) {
			let partsModified = false;
			const newContent = msg.content.map((part) => {
				if (
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					typeof part.text === "string"
				) {
					const res = sanitizePromptText(part.text);
					if (res !== part.text) {
						partsModified = true;
						return { ...part, text: res };
					}
				}
				return part;
			});
			if (partsModified) {
				modified = true;
				return { ...msg, content: newContent } as Message;
			}
		}
		return msg;
	});

	if (!modified) return context;
	return {
		...context,
		systemPrompt: newSystemPrompt,
		messages: newMessages,
	};
}

export function sanitizeAntigravityPayload<T>(payload: T): T {
	if (!payload || typeof payload !== "object") return payload;
	const req = (payload as Record<string, unknown>).request as Record<string, unknown> | undefined;
	if (!req || typeof req !== "object") return payload;

	const sys = req.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;
	if (sys?.parts && Array.isArray(sys.parts)) {
		for (const part of sys.parts) {
			if (typeof part?.text === "string") {
				part.text = sanitizePromptText(part.text);
			}
		}
	}

	const contents = req.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined;
	if (contents && Array.isArray(contents)) {
		for (const content of contents) {
			if (content?.parts && Array.isArray(content.parts)) {
				for (const part of content.parts) {
					if (typeof part?.text === "string") {
						part.text = sanitizePromptText(part.text);
					}
				}
			}
		}
	}

	return payload;
}

export function getAccountLockKey(apiKeyRaw: unknown): string {
	if (typeof apiKeyRaw !== "string") return "default";
	try {
		const parsed = JSON.parse(apiKeyRaw);
		if (parsed.email) return `email:${parsed.email}`;
		if (parsed.projectId) return `project:${parsed.projectId}`;
	} catch {}
	return apiKeyRaw.slice(0, 50);
}

export function streamAntigravityPro(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const sanitizedContext = sanitizeAntigravityContext(context);
	const { wireModel, wireOptions } = createWireRequest(model, options);
	const originalOnPayload = wireOptions.onPayload;
	const activeWireOptions: GoogleGeminiCliOptions = {
		...wireOptions,
		onPayload: async (payload, targetModel) => {
			let result = payload;
			if (originalOnPayload) {
				const res = await originalOnPayload(payload, targetModel);
				if (res !== undefined) result = res as typeof payload;
			}
			return sanitizeAntigravityPayload(result);
		},
	};
	void (async () => {
		try {
			if (options?.signal?.aborted) {
				outer.fail(new Error("Request was aborted"));
				return;
			}

			const inner = streamGoogleGeminiCli(wireModel, sanitizedContext, activeWireOptions);
			outer.forwardLocalWorkFrom(inner);

			for await (const event of inner) {
				if (event.type === "error") {
					clearAntigravityAuthBlocks();
					if (event.error) {
						sanitizeAntigravityError(event.error);
					}
				}
				outer.push(event);
			}
			if (!outer.done) {
				const result = await inner.result();
				if (result.stopReason === "error") {
					clearAntigravityAuthBlocks();
					sanitizeAntigravityError(result);
				}
				outer.end(result);
			}
		} catch (err) {
			clearAntigravityAuthBlocks();
			const sanitizedErr = sanitizeAntigravityError(
				err instanceof Error ? { errorMessage: err.message } : (err as { errorMessage?: string }),
			);
			if (err instanceof Error && sanitizedErr.errorMessage) {
				err.message = sanitizedErr.errorMessage;
			}
			if (!outer.done) outer.fail(err);
		}
	})();

	return outer;
}
