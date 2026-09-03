import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { type GoogleGeminiCliOptions, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
	resolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
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
	if (choice === "auto" || choice === "none" || choice === "any") return choice;
	if (choice === "required" || choice.type === "computer") return "any";
	const name = "function" in choice ? choice.function.name : choice.name;
	return { mode: "ANY", allowedFunctionNames: [name] };
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
	return {
		...(model as Model<"google-gemini-cli">),
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl,
	};
}

export function createWireRequest(model: Model<Api>, options?: SimpleStreamOptions): WireRequest {
	const wireModel = toWireModel(model);
	const { reasoning, disableReasoning, thinkingBudgets, toolChoice, apiKey, ...forwardedOptions } = options ?? {};
	const isCustomEndpoint =
		wireModel.baseUrl !== ANTIGRAVITY_DAILY_ENDPOINT &&
		wireModel.baseUrl !== "https://daily-cloudcode-pa.sandbox.googleapis.com";
	const antigravityEndpointMode =
		(forwardedOptions as GoogleGeminiCliOptions).antigravityEndpointMode ?? (isCustomEndpoint ? "auto" : "production");
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

export function streamAntigravityPro(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const { wireModel, wireOptions } = createWireRequest(model, options);
	return streamGoogleGeminiCli(wireModel, context, wireOptions);
}
