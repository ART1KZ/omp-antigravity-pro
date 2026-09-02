import { createRequire } from "node:module";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { type GoogleGeminiCliOptions, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type * as CatalogCompat from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
	resolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
import { ANTIGRAVITY_DAILY_ENDPOINT, getAntigravityBaseUrl } from "./models";

/**
 * OMP 18 resolves wire compat through the catalog compat engine keyed by model
 * identity. Extension models are registered under the private CUSTOM_API_ID,
 * which the engine does not recognize, so the host rebuild leaves `compat`
 * undefined and the stock google wire crashes on the first tool request
 * (`model.compat.ccaLegacyParametersSchema` in google-shared). Re-resolve the
 * record with the canonical `google-gemini-cli` api when the host did not
 * attach one. pi-catalog 17 has no google compat engine (its wire keys the
 * tool schema off model ids), so this stays a no-op there.
 */
let resolveModelPolicy: typeof CatalogCompat.resolveModelPolicy | undefined;

try {
	const require_ = createRequire(import.meta.url);
	const engine = require_(import.meta.resolve("@oh-my-pi/pi-catalog/compat/resolve")) as {
		resolveModelPolicy?: typeof CatalogCompat.resolveModelPolicy;
	};
	resolveModelPolicy = engine.resolveModelPolicy;
} catch {
	// pi-catalog <18: no compat/resolve subpath; nothing to restore.
}

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
	if (choice === "required") return "any";
	const name = choice.type === "computer" ? undefined : "function" in choice ? choice.function.name : choice.name;
	return name === undefined ? undefined : { mode: "ANY", allowedFunctionNames: [name] };
}

function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncapped = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncapped, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}

function resolveWireCompat(model: Model<Api>): Model<"google-gemini-cli">["compat"] | undefined {
	const inherited = (model as Model<"google-gemini-cli">).compat;
	if (inherited) return inherited;
	if (!resolveModelPolicy) return undefined;
	const policy = resolveModelPolicy({
		...model,
		api: "google-gemini-cli",
		provider: "google-antigravity",
	} as unknown as Parameters<typeof CatalogCompat.resolveModelPolicy>[0]);
	return policy?.compat as Model<"google-gemini-cli">["compat"] | undefined;
}

function toWireModel(model: Model<Api>): Model<"google-gemini-cli"> {
	const baseUrl = model.baseUrl?.trim() || getAntigravityBaseUrl();
	const wireModel: Model<"google-gemini-cli"> = {
		...(model as Model<"google-gemini-cli">),
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl,
	};
	if (!wireModel.compat) {
		const compat = resolveWireCompat(model);
		if (compat) wireModel.compat = compat;
	}
	return wireModel;
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
