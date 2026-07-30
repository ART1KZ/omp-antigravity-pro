import type { Api, Model, ThinkingConfig } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "google-antigravity";
export const CUSTOM_API_ID = "antigravity-pro";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

const GEMINI_36_FLASH_BUDGETS = {
	[Effort.Minimal]: 1000,
	[Effort.Low]: 1000,
	[Effort.Medium]: 4000,
	[Effort.High]: 10000,
} as const;

const GEMINI_36_FLASH_ROUTING = {
	off: "gemini-3.6-flash-low",
	[Effort.Minimal]: "gemini-3.6-flash-low",
	[Effort.Low]: "gemini-3.6-flash-low",
	[Effort.Medium]: "gemini-3.6-flash-medium",
	[Effort.High]: "gemini-3.6-flash-high",
} as const;

const GEMINI_36_FLASH_ID = "gemini-3.6-flash";

function createGemini36FlashFallback(bundled: readonly Model<Api>[]): Model<Api> {
	const template = bundled.find((model) => model.id === "gemini-3.5-flash");
	if (!template) {
		throw new Error("Bundled Antigravity catalog has neither gemini-3.6-flash nor a gemini-3.5-flash template");
	}
	return {
		...template,
		id: GEMINI_36_FLASH_ID,
		name: "Gemini 3.6 Flash",
		baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		requestModelId: "gemini-3.6-flash-low",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: GEMINI_36_FLASH_BUDGETS,
			effortRouting: GEMINI_36_FLASH_ROUTING,
			requiresEffort: true,
			suppressWhenOff: true,
		},
	};
}

export interface ProjectedAntigravityModel extends ProviderModelConfig {
	api: typeof CUSTOM_API_ID;
}

function requireLimit(value: number | null, modelId: string, field: "contextWindow" | "maxTokens"): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Bundled Antigravity model ${modelId} has no valid ${field}`);
	}
	return value;
}

function projectThinking(model: Model<Api>): ThinkingConfig | undefined {
	if (model.id === "gemini-3.6-flash") {
		return {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: GEMINI_36_FLASH_BUDGETS,
			effortRouting: GEMINI_36_FLASH_ROUTING,
			requiresEffort: true,
			suppressWhenOff: true,
		};
	}

	const thinking = model.thinking;
	if (!thinking || model.requestModelId === undefined || thinking.effortRouting !== undefined) {
		return thinking;
	}

	const effortRouting: Partial<Record<Effort | "off", string>> = { off: model.requestModelId };
	for (const effort of thinking.efforts) {
		effortRouting[effort] = model.requestModelId;
	}
	return { ...thinking, effortRouting };
}

export function projectAntigravityModel(model: Model<Api>): ProjectedAntigravityModel {
	return {
		id: model.id,
		name: model.name,
		api: CUSTOM_API_ID,
		reasoning: model.reasoning,
		thinking: projectThinking(model),
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: requireLimit(model.contextWindow, model.id, "contextWindow"),
		maxTokens: requireLimit(model.maxTokens, model.id, "maxTokens"),
		headers: model.headers ? { ...model.headers } : undefined,
		premiumMultiplier: model.premiumMultiplier,
	};
}

export function projectBundledAntigravityModels(): ProjectedAntigravityModel[] {
	const bundled = getBundledModels(PROVIDER_ID);
	const models = bundled.some((model) => model.id === GEMINI_36_FLASH_ID)
		? bundled
		: [...bundled, createGemini36FlashFallback(bundled)];
	return models.map(projectAntigravityModel);
}
