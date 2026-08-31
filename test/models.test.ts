import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	CUSTOM_API_ID,
	fetchDynamicAntigravityModels,
	getAntigravityBaseUrl,
	projectAntigravityModel,
	projectBundledAntigravityModels,
} from "../src/models";

describe("Antigravity model projection", () => {
	test("resolves base endpoint from environment or default", () => {
		expect(typeof getAntigravityBaseUrl()).toBe("string");
		expect(getAntigravityBaseUrl().length).toBeGreaterThan(0);
	});

	test("keeps the complete bundled catalog while selecting the custom transport", () => {
		const source = getBundledModels("google-antigravity");
		const projected = projectBundledAntigravityModels();

		expect(projected.length).toBeGreaterThanOrEqual(source.length);
		expect(projected.every((model) => model.api === CUSTOM_API_ID)).toBe(true);
		expect(projected.slice(0, source.length).map((model) => model.id)).toEqual(source.map((model) => model.id));
	});

	test("preserves a routed model's requestModelId through thinking routes", () => {
		const source = getBundledModels("google-antigravity").find((model) => model.id === "gpt-oss-120b");
		expect(source).toBeDefined();
		if (!source) throw new Error("gpt-oss-120b fixture missing from the bundled catalog");

		const projected = projectAntigravityModel(source);

		expect(projected.thinking?.effortRouting?.off).toBe("gpt-oss-120b-medium");
		for (const effort of projected.thinking?.efforts ?? []) {
			expect(projected.thinking?.effortRouting?.[effort]).toBe("gpt-oss-120b-medium");
		}
	});

	test("uses the captured Gemini 3.6 tier ids and numeric budgets", () => {
		const template = getBundledModels("google-antigravity").find((model) => model.id === "gemini-3.5-flash");
		expect(template).toBeDefined();
		if (!template) throw new Error("gemini-3.5-flash fixture missing from the bundled catalog");
		const discovered = {
			...template,
			id: "gemini-3.6-flash",
			name: "Gemini 3.6 Flash",
			requestModelId: "gemini-3.6-flash-low",
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			},
		} satisfies Model;

		const projected = projectAntigravityModel(discovered);

		expect(projected.thinking).toEqual({
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: { [Effort.Minimal]: 1000, [Effort.Low]: 1000, [Effort.Medium]: 4000, [Effort.High]: 10000 },
			effortRouting: {
				off: "gemini-3.6-flash-low",
				[Effort.Minimal]: "gemini-3.6-flash-low",
				[Effort.Low]: "gemini-3.6-flash-low",
				[Effort.Medium]: "gemini-3.6-flash-medium",
				[Effort.High]: "gemini-3.6-flash-high",
			},
			requiresEffort: true,
			suppressWhenOff: true,
		});
	});

	test("adds Gemini 3.6 Flash and Gemini 3.7 Flash when the installed catalog predates them", () => {
		const source = getBundledModels("google-antigravity");
		const projected = projectBundledAntigravityModels();
		const expectedMinLength = source.length;
		const gemini36 = projected.find((model) => model.id === "gemini-3.6-flash");
		const gemini37 = projected.find((model) => model.id === "gemini-3.7-flash");

		expect(projected.length).toBeGreaterThanOrEqual(expectedMinLength);
		expect(gemini36).toBeDefined();
		expect(gemini36?.contextWindow).toBe(1_048_576);
		expect(gemini36?.maxTokens).toBe(65_536);
		expect(gemini36?.thinking?.requiresEffort).toBe(true);

		expect(gemini37).toBeDefined();
		expect(gemini37?.name).toBe("Gemini 3.7 Flash");
		expect(gemini37?.contextWindow).toBe(1_048_576);
		expect(gemini37?.maxTokens).toBe(65_536);
		expect(gemini37?.thinking?.requiresEffort).toBe(true);
	});

	test("fetchDynamicAntigravityModels falls back to bundled when no token", async () => {
		const models = await fetchDynamicAntigravityModels(undefined);
		expect(models.length).toBeGreaterThan(0);
		expect(models.some((m) => m.id === "gemini-3.6-flash")).toBe(true);
		expect(models.some((m) => m.id === "gemini-3.7-flash")).toBe(true);
	});

	test("fetchDynamicAntigravityModels parses live response and projects custom api", async () => {
		const mockFetcher = (async () => {
			return new Response(
				JSON.stringify({
					models: {
						"gemini-3.9-pro": {
							displayName: "Gemini 3.9 Pro",
							supportsImages: true,
							supportsThinking: true,
							maxTokens: 2000000,
							maxOutputTokens: 65536,
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const models = await fetchDynamicAntigravityModels("mock-token", mockFetcher);
		const dynamicModel = models.find((m) => m.id === "gemini-3.9-pro");
		expect(dynamicModel).toBeDefined();
		expect(dynamicModel?.name).toBe("Gemini 3.9 Pro");
		expect(dynamicModel?.api).toBe(CUSTOM_API_ID);
		expect(dynamicModel?.contextWindow).toBe(2000000);
		expect(dynamicModel?.input).toContain("image");
	});
});
