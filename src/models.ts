import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model, ThinkingConfig } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchAntigravityDiscoveryModels } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { resolveWireCompat } from "./compat";

export const PROVIDER_ID = "google-antigravity";
export const CUSTOM_API_ID = "antigravity-pro";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

function readEnvVarFromFile(filePath: string, keys: string[]): string | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const idx = trimmed.indexOf("=");
			if (idx > 0) {
				const key = trimmed.slice(0, idx).trim();
				if (keys.includes(key)) {
					let val = trimmed.slice(idx + 1).trim();
					if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
						val = val.slice(1, -1);
					}
					if (val) return val;
				}
			}
		}
	} catch {
		// Ignore file read errors
	}
	return undefined;
}

export function getAntigravityBaseUrl(): string {
	const keys = ["ANTIGRAVITY_BASE_URL", "GOOGLE_ANTIGRAVITY_BASE_URL", "CLOUD_CODE_URL"];
	if (typeof process !== "undefined" && process.env) {
		for (const key of keys) {
			const envVal = process.env[key];
			if (envVal?.trim()) return envVal.trim();
		}
	}

	try {
		const home = os.homedir();
		const candidateFiles = [path.join(home, ".omp", "agent", ".env"), path.join(home, ".omp", ".env")];
		for (const file of candidateFiles) {
			const val = readEnvVarFromFile(file, keys);
			if (val?.trim()) return val.trim();
		}
	} catch {
		// Ignore os/path errors
	}

	return ANTIGRAVITY_DAILY_ENDPOINT;
}

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

const GEMINI_37_FLASH_ID = "gemini-3.7-flash";
const GEMINI_38_FLASH_ID = "gemini-3.8-flash";

const DEFAULT_GEMINI_FALLBACK: Model<Api> = {
	id: "gemini-3.5-flash",
	name: "Gemini 3.5 Flash",
	api: "google-gemini-cli",
	provider: PROVIDER_ID,
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	compat: undefined,
};

function findGeminiTemplate(bundled: readonly Model<Api>[]): Model<Api> {
	return (
		bundled.find((model) => model.id === "gemini-3.5-flash") ||
		bundled.find((model) => model.id === "gemini-3-flash") ||
		bundled.find((model) => model.id === "gemini-2.5-flash") ||
		bundled[0] ||
		DEFAULT_GEMINI_FALLBACK
	);
}

function createGemini36FlashFallback(bundled: readonly Model<Api>[]): Model<Api> {
	const template = findGeminiTemplate(bundled);
	return {
		...template,
		id: GEMINI_36_FLASH_ID,
		name: "Gemini 3.6 Flash",
		baseUrl: getAntigravityBaseUrl(),
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

function createGemini37FlashFallback(bundled: readonly Model<Api>[]): Model<Api> {
	const template = bundled.find((model) => model.id === GEMINI_36_FLASH_ID) || findGeminiTemplate(bundled);
	return {
		...template,
		id: GEMINI_37_FLASH_ID,
		name: "Gemini 3.7 Flash",
		baseUrl: getAntigravityBaseUrl(),
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		requestModelId: "gemini-3.7-flash-low",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: GEMINI_36_FLASH_BUDGETS,
			effortRouting: {
				off: "gemini-3.7-flash-low",
				[Effort.Minimal]: "gemini-3.7-flash-low",
				[Effort.Low]: "gemini-3.7-flash-low",
				[Effort.Medium]: "gemini-3.7-flash-medium",
				[Effort.High]: "gemini-3.7-flash-high",
			},
			requiresEffort: true,
			suppressWhenOff: true,
		},
	};
}

function createGemini38FlashFallback(bundled: readonly Model<Api>[]): Model<Api> {
	const template =
		bundled.find((model) => model.id === GEMINI_37_FLASH_ID) ||
		bundled.find((model) => model.id === GEMINI_36_FLASH_ID) ||
		findGeminiTemplate(bundled);
	return {
		...template,
		id: GEMINI_38_FLASH_ID,
		name: "Gemini 3.8 Flash",
		baseUrl: getAntigravityBaseUrl(),
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		requestModelId: "gemini-3.8-flash-low",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: GEMINI_36_FLASH_BUDGETS,
			effortRouting: {
				off: "gemini-3.8-flash-low",
				[Effort.Minimal]: "gemini-3.8-flash-low",
				[Effort.Low]: "gemini-3.8-flash-low",
				[Effort.Medium]: "gemini-3.8-flash-medium",
				[Effort.High]: "gemini-3.8-flash-high",
			},
			requiresEffort: true,
			suppressWhenOff: true,
		},
	};
}

export interface ProjectedAntigravityModel extends ProviderModelConfig {
	api: typeof CUSTOM_API_ID;
	baseUrl?: string;
}

function requireLimit(value: number | null, modelId: string, field: "contextWindow" | "maxTokens"): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Bundled Antigravity model ${modelId} has no valid ${field}`);
	}
	return value;
}

function isGeminiFlashNumbered(id: string): boolean {
	return /^gemini-(?:[3-9]|\d{2,})(?:\.\d+)?-flash$/.test(id);
}

function projectThinking(model: Model<Api>): ThinkingConfig | undefined {
	if (isGeminiFlashNumbered(model.id)) {
		return {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: GEMINI_36_FLASH_BUDGETS,
			effortRouting: {
				off: `${model.id}-low`,
				[Effort.Minimal]: `${model.id}-low`,
				[Effort.Low]: `${model.id}-low`,
				[Effort.Medium]: `${model.id}-medium`,
				[Effort.High]: `${model.id}-high`,
			},
			requiresEffort: true,
			suppressWhenOff: true,
		};
	}

	const thinking = model.thinking;
	if (!thinking) {
		return undefined;
	}

	if (thinking.mode === "google-level" && thinking.efforts && thinking.efforts.length > 0) {
		const effortRouting: Partial<Record<Effort | "off", string>> = {
			off: model.requestModelId ?? model.id,
		};
		for (const effort of thinking.efforts) {
			effortRouting[effort] = thinking.effortRouting?.[effort] ?? model.requestModelId ?? model.id;
		}
		return {
			mode: "budget",
			efforts: [...thinking.efforts],
			effortBudgets: GEMINI_36_FLASH_BUDGETS,
			effortRouting,
			requiresEffort: true,
			suppressWhenOff: true,
		};
	}

	if (model.requestModelId === undefined || thinking.effortRouting !== undefined) {
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
		// Spread first: omp 18's google wire transport reads `model.compat`
		// (ccaLegacyParametersSchema, dropUnsignedThinking, antigravityUsageLabel,
		// ...) and `model.identity.class` directly off the model object, so the
		// projection must not whittle the bundled entry down to a field list.
		...model,
		api: CUSTOM_API_ID,
		baseUrl: getAntigravityBaseUrl(),
		thinking: projectThinking(model),
		contextWindow: requireLimit(model.contextWindow, model.id, "contextWindow"),
		maxTokens: requireLimit(model.maxTokens, model.id, "maxTokens"),
		headers: model.headers ? { ...model.headers } : undefined,
		premiumMultiplier: model.premiumMultiplier,
		compat: resolveWireCompat(model) as unknown as ProviderModelConfig["compat"],
	};
}

export function projectBundledAntigravityModels(): ProjectedAntigravityModel[] {
	const bundled = getBundledModels(PROVIDER_ID);
	let models = bundled.some((model) => model.id === GEMINI_36_FLASH_ID)
		? [...bundled]
		: [...bundled, createGemini36FlashFallback(bundled)];
	if (!models.some((model) => model.id === GEMINI_37_FLASH_ID)) {
		models = [...models, createGemini37FlashFallback(models)];
	}
	if (!models.some((model) => model.id === GEMINI_38_FLASH_ID)) {
		models = [...models, createGemini38FlashFallback(models)];
	}
	return models.map(projectAntigravityModel);
}

export async function fetchDynamicAntigravityModels(
	token: string | undefined,
	fetcher?: typeof fetch,
): Promise<ProjectedAntigravityModel[]> {
	if (!token) {
		return projectBundledAntigravityModels();
	}

	try {
		const endpoint = getAntigravityBaseUrl();
		const discovered = await fetchAntigravityDiscoveryModels({
			token,
			endpoint,
			fetcher,
		});

		if (discovered && discovered.length > 0) {
			// Discovery returns bare ModelSpecs (no identity/compat); materialize
			// them the same way the ModelManager does, or the google wire transport
			// crashes reading model.compat off the projected models.
			const models: Model<Api>[] = discovered.map((spec) => buildModel({ ...spec, provider: PROVIDER_ID }));
			if (!models.some((model) => model.id === GEMINI_36_FLASH_ID)) {
				const bundled = getBundledModels(PROVIDER_ID);
				models.push(createGemini36FlashFallback(bundled));
			}
			if (!models.some((model) => model.id === GEMINI_37_FLASH_ID)) {
				const bundled = getBundledModels(PROVIDER_ID);
				models.push(createGemini37FlashFallback(bundled));
			}
			if (!models.some((model) => model.id === GEMINI_38_FLASH_ID)) {
				const bundled = getBundledModels(PROVIDER_ID);
				models.push(createGemini38FlashFallback(bundled));
			}
			return models.map(projectAntigravityModel);
		}
	} catch {
		// Fallback gracefully to bundled models on network error
	}

	return projectBundledAntigravityModels();
}
