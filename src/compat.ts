import { createRequire } from "node:module";
import type { Api, Model } from "@oh-my-pi/pi-ai";

export interface GoogleWireCompat {
	supportsFunctionPartId: boolean;
	requiresSkipThoughtSignature: boolean;
	dropUnsignedThinking: boolean;
	ccaLegacyParametersSchema: boolean;
	multimodalFunctionResponse: boolean;
	flashStreamLeakWorkaround: boolean;
	antigravityClaudeToolMode?: boolean;
	claudeThinkingBetaHeader?: boolean;
	antigravityUsageLabel?: string;
}

type PolicyResolver = (model: unknown) => { compat?: Partial<GoogleWireCompat> } | undefined;

let resolveModelPolicy: PolicyResolver | undefined;

try {
	const require_ = createRequire(import.meta.url);
	const resolvedPath = import.meta.resolve?.("@oh-my-pi/pi-catalog/compat/resolve");
	if (resolvedPath) {
		const engine = require_(resolvedPath) as { resolveModelPolicy?: PolicyResolver };
		resolveModelPolicy = engine.resolveModelPolicy;
	}
} catch {
	// pi-catalog < 18 or environment without compat/resolve
}

export function createDefaultWireCompat(modelId: string): GoogleWireCompat {
	const lower = modelId.toLowerCase();
	const isClaude = lower.startsWith("claude");
	const isGemini = lower.startsWith("gemini");

	if (isClaude) {
		return {
			supportsFunctionPartId: true,
			requiresSkipThoughtSignature: false,
			dropUnsignedThinking: true,
			ccaLegacyParametersSchema: true,
			multimodalFunctionResponse: true,
			flashStreamLeakWorkaround: false,
			antigravityClaudeToolMode: true,
			claudeThinkingBetaHeader: true,
		};
	}

	if (isGemini) {
		const versionMatch = lower.match(/gemini-(\d+)(?:\.(\d+))?/);
		const major = versionMatch ? Number.parseInt(versionMatch[1], 10) : 0;
		const minor = versionMatch?.[2] ? Number.parseInt(versionMatch[2], 10) : 0;
		const isOldGemini = major < 3 || (major === 3 && minor < 5 && !lower.includes("flash"));
		const requiresSkipThought = !isOldGemini;

		return {
			supportsFunctionPartId: true,
			requiresSkipThoughtSignature: requiresSkipThought,
			dropUnsignedThinking: false,
			ccaLegacyParametersSchema: false,
			multimodalFunctionResponse: true,
			flashStreamLeakWorkaround: false,
			antigravityClaudeToolMode: false,
		};
	}

	return {
		supportsFunctionPartId: false,
		requiresSkipThoughtSignature: false,
		dropUnsignedThinking: false,
		ccaLegacyParametersSchema: false,
		multimodalFunctionResponse: false,
		flashStreamLeakWorkaround: false,
		antigravityClaudeToolMode: false,
	};
}

export function resolveWireCompat(model: Model<Api> | { id: string; [key: string]: unknown }): GoogleWireCompat {
	const defaults = createDefaultWireCompat(model.id);
	const existing = (model as { compat?: Partial<GoogleWireCompat> }).compat;

	let dynamicPolicy: Partial<GoogleWireCompat> | undefined;
	if (resolveModelPolicy) {
		try {
			const policy = resolveModelPolicy({
				...model,
				api: "google-gemini-cli",
				provider: "google-antigravity",
			});
			dynamicPolicy = policy?.compat;
		} catch {
			// Fallback gracefully
		}
	}

	return {
		...defaults,
		...(existing ?? {}),
		...(dynamicPolicy ?? {}),
	};
}
