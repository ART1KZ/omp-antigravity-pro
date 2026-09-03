import { describe, expect, test } from "bun:test";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai/auth-retry";
import { buildRequest, type GoogleGeminiCliOptions } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { GoogleWireCompat } from "../src/compat";
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

	test("restores and guarantees compat record on wireModel even when source model has undefined compat", () => {
		const bareModel = {
			...model("gpt-oss-120b"),
			compat: undefined,
		} as unknown as Model;

		const { wireModel } = createWireRequest(bareModel);
		const compat = (wireModel as unknown as { compat?: GoogleWireCompat }).compat;

		expect(compat).toBeDefined();
		expect(compat?.dropUnsignedThinking).toBe(false);
		expect(compat?.ccaLegacyParametersSchema).toBe(false);
	});

	test("sets appropriate compat flags for Claude models on antigravity wire", () => {
		const claudeModel = {
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: CUSTOM_API_ID,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as unknown as Model;

		const { wireModel } = createWireRequest(claudeModel);
		const compat = (wireModel as unknown as { compat?: GoogleWireCompat }).compat;

		expect(compat).toBeDefined();
		expect(compat?.dropUnsignedThinking).toBe(true);
		expect(compat?.ccaLegacyParametersSchema).toBe(true);
		expect(compat?.antigravityClaudeToolMode).toBe(true);
		expect(compat?.supportsFunctionPartId).toBe(true);
	});

	test("sets appropriate compat flags for Gemini models including 3.8", () => {
		const geminiModel = {
			id: "gemini-3.8-flash",
			name: "Gemini 3.8 Flash",
			api: CUSTOM_API_ID,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		} as unknown as Model;

		const { wireModel } = createWireRequest(geminiModel);
		const compat = (wireModel as unknown as { compat?: GoogleWireCompat }).compat;

		expect(compat).toBeDefined();
		expect(compat?.dropUnsignedThinking).toBe(false);
		expect(compat?.ccaLegacyParametersSchema).toBe(false);
		expect(compat?.requiresSkipThoughtSignature).toBe(true);
		expect(compat?.supportsFunctionPartId).toBe(true);
	});

	test("buildRequest succeeds without compat TypeError when tools are provided", () => {
		const bareModel = {
			...model("gemini-3.5-flash"),
			compat: undefined,
		} as unknown as Model;

		const tool = {
			name: "lookup",
			description: "Look something up",
			parameters: { type: "object", properties: { q: { type: "string" } } },
		};

		const { wireModel, wireOptions } = createWireRequest(bareModel);
		const payload = buildRequest(wireModel, { ...context, tools: [tool] }, "project", wireOptions, true);

		expect(payload.request.tools).toBeDefined();
	});

	test("handles computer tool choice without crashing", () => {
		const bareModel = model("gemini-3.5-flash");
		const { wireOptions } = createWireRequest(bareModel, {
			toolChoice: { type: "computer" } as unknown as SimpleStreamOptions["toolChoice"],
		});

		expect(wireOptions.toolChoice).toBe("any");
	});
});
