import { describe, expect, test } from "bun:test";
import type { Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai/auth-retry";
import { buildRequest, type GoogleGeminiCliOptions } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { CUSTOM_API_ID } from "../src/models";
import { createWireRequest, streamAntigravityPro } from "../src/stream";

const context: Context = {
	systemPrompt: ["Keep this exact prefix."],
	messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
	tools: [],
};

function model(id: string): Model<"google-gemini-cli"> {
	const found = getBundledModels("google-antigravity").find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Missing bundled model ${id}`);
	return found as Model<"google-gemini-cli">;
}

function credential(token: string): string {
	return JSON.stringify({ token, projectId: "project" });
}

/**
 * Mirrors what the OMP host does with extension-registered models: the custom
 * `api` is unknown to the catalog compat engine, so the rebuild produces a
 * model whose `compat` is undefined even when the bundled source carried one.
 */
function hostRebuilt(id: string): Model {
	const source = model(id);
	return buildModel({
		...source,
		provider: "google-antigravity",
		api: CUSTOM_API_ID,
	} as never) as unknown as Model;
}

function successfulSse(): Response {
	const data = {
		response: {
			candidates: [{ content: { parts: [{ text: "hello", thoughtSignature: "signature-1" }] }, finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: 10,
				candidatesTokenCount: 2,
				thoughtsTokenCount: 3,
				cachedContentTokenCount: 4,
				totalTokenCount: 15,
			},
		},
	};
	return new Response(`data: ${JSON.stringify(data)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Antigravity wire request", () => {
	test("uses a numeric budget and the routed model id", () => {
		const { wireModel, wireOptions } = createWireRequest(model("gemini-3.5-flash"), {
			reasoning: Effort.Medium,
			apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		});
		const payload = buildRequest(wireModel, context, "project", wireOptions, true);

		expect(payload.model).toBe("gemini-3.5-flash-low");
		expect(payload.request.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 4000,
		});
		expect(payload.request.generationConfig?.thinkingConfig).not.toHaveProperty("thinkingLevel");
	});

	test("preserves prompt, messages, tools and diagnostic callbacks", () => {
		const onPayload = () => undefined;
		const onResponse = () => undefined;
		const onSseEvent = () => undefined;
		const options: SimpleStreamOptions = { onPayload, onResponse, onSseEvent };
		const { wireModel, wireOptions } = createWireRequest(model("gpt-oss-120b"), options);
		const payload = buildRequest(wireModel, context, "project", wireOptions, true);

		expect(context.systemPrompt).toEqual(["Keep this exact prefix."]);
		expect(context.messages[0]?.content).toEqual([{ type: "text", text: "hello" }]);
		expect(context.tools).toEqual([]);
		expect(wireOptions.onPayload).toBe(onPayload);
		expect(wireOptions.onResponse).toBe(onResponse);
		expect(wireOptions.onSseEvent).toBe(onSseEvent);
		expect(payload.model).toBe("gpt-oss-120b-medium");
	});

	test("uses production endpoint mode by default", () => {
		const { wireOptions } = createWireRequest(model("gpt-oss-120b"));

		expect((wireOptions as GoogleGeminiCliOptions).antigravityEndpointMode).toBe("production");
	});

	test("respects custom proxy baseUrl and routes via auto endpoint mode", () => {
		const customModel = {
			...model("gpt-oss-120b"),
			baseUrl: "https://my-cf-worker.workers.dev",
		};
		const { wireModel, wireOptions } = createWireRequest(customModel);

		expect(wireModel.baseUrl).toBe("https://my-cf-worker.workers.dev");
		expect((wireOptions as GoogleGeminiCliOptions).antigravityEndpointMode).toBe("auto");
	});

	test("delegates SSE parsing, signatures and usage to the stock transport", async () => {
		const seenSse: unknown[] = [];
		const stream = streamAntigravityPro(model("gpt-oss-120b"), context, {
			apiKey: credential("token"),
			fetch: async () => successfulSse(),
			onSseEvent: (event) => seenSse.push(event),
		});
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "hello", textSignature: "signature-1" }]);
		expect(result.usage).toMatchObject({ input: 6, output: 5, cacheRead: 4, reasoningTokens: 3, totalTokens: 15 });
		expect(seenSse).toHaveLength(1);
	});

	test("uses OMP replay-safe credential refresh after a 401", async () => {
		const source = model("gpt-oss-120b");
		const customModel: Model = { ...source, api: CUSTOM_API_ID };
		const resolutions: ApiKeyResolveContext[] = [];
		const authorization: Array<string | null> = [];
		const resolver = (ctx: ApiKeyResolveContext): string => {
			resolutions.push(ctx);
			return credential(resolutions.length === 1 ? "expired" : "refreshed");
		};
		registerCustomApi(CUSTOM_API_ID, streamAntigravityPro, "test");
		try {
			const stream = streamSimple(customModel, context, {
				apiKey: resolver,
				fetch: async (_input, init) => {
					const bearer = new Headers(init?.headers).get("authorization");
					authorization.push(bearer);
					return bearer === "Bearer expired" ? new Response("expired", { status: 401 }) : successfulSse();
				},
			});
			const result = await stream.result();

			expect(result.stopReason).toBe("stop");
			expect(authorization).toEqual(["Bearer expired", "Bearer refreshed"]);
			expect(resolutions.map((ctx) => ctx.lastChance)).toEqual([false, false]);
			expect(resolutions[1]?.error).toBeDefined();
		} finally {
			clearCustomApis();
		}
	});

	test("restores the google compat record dropped by the host custom-api rebuild", () => {
		const hostBuilt = hostRebuilt("claude-sonnet-4-6");
		expect(hostBuilt.compat).toBeUndefined();

		const { wireModel } = createWireRequest(hostBuilt);

		expect(wireModel.compat).toBeDefined();
		expect(wireModel.compat?.ccaLegacyParametersSchema).toBe(true);
		expect(wireModel.compat?.supportsFunctionPartId).toBe(true);
		expect(wireModel.compat?.antigravityClaudeToolMode).toBe(true);
	});

	test("does not force legacy parameters onto gemini tool schemas", () => {
		const hostBuilt = hostRebuilt("gemini-3.7-flash");
		expect(hostBuilt.compat).toBeUndefined();

		const { wireModel } = createWireRequest(hostBuilt);

		expect(wireModel.compat).toBeDefined();
		expect(wireModel.compat?.ccaLegacyParametersSchema).toBe(false);
	});

	test("tool conversion does not crash when the host stripped compat", () => {
		const hostBuilt = hostRebuilt("claude-sonnet-4-6");
		const { wireModel, wireOptions } = createWireRequest(hostBuilt);
		const tool: Tool = {
			name: "lookup",
			description: "Look something up",
			parameters: { type: "object", properties: { q: { type: "string" } } },
		};
		const payload = buildRequest(wireModel, { ...context, tools: [tool] }, "project", wireOptions, true);

		expect(payload.request.tools).toBeDefined();
	});

	test("uses OMP sibling failover directly after a quota response", async () => {
		const source = model("gpt-oss-120b");
		const customModel: Model = { ...source, api: CUSTOM_API_ID };
		const resolutions: ApiKeyResolveContext[] = [];
		let quotaAttempts = 0;
		const resolver = (ctx: ApiKeyResolveContext): string => {
			resolutions.push(ctx);
			return credential(resolutions.length === 1 ? "limited" : "sibling");
		};
		registerCustomApi(CUSTOM_API_ID, streamAntigravityPro, "test");
		try {
			const stream = streamSimple(customModel, context, {
				apiKey: resolver,
				maxRetryDelayMs: 0,
				fetch: async (_input, init) => {
					const bearer = new Headers(init?.headers).get("authorization");
					if (bearer === "Bearer limited") {
						quotaAttempts += 1;
						return new Response("quota exceeded", { status: 429 });
					}
					return successfulSse();
				},
			});
			const result = await stream.result();

			expect(result.stopReason).toBe("stop");
			expect(quotaAttempts).toBeGreaterThan(0);
			expect(resolutions.map((ctx) => ctx.lastChance)).toEqual([false, true]);
		} finally {
			clearCustomApis();
		}
	});
});
