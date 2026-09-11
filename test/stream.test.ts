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
import {
	createWireRequest,
	getAccountLockKey,
	sanitizeAntigravityContext,
	sanitizeAntigravityPayload,
	sanitizePromptText,
	streamAntigravityPro,
} from "../src/stream";

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

	test("handles unexpected strings and missing names in toolChoice safely", () => {
		const bareModel = model("gemini-3.5-flash");
		const { wireOptions: o1 } = createWireRequest(bareModel, {
			toolChoice: "custom-unsupported-string" as unknown as SimpleStreamOptions["toolChoice"],
		});
		expect(o1.toolChoice).toBeUndefined();

		const { wireOptions: o2 } = createWireRequest(bareModel, {
			toolChoice: { type: "function", function: { name: "myTool" } } as unknown as SimpleStreamOptions["toolChoice"],
		});
		expect(o2.toolChoice).toEqual({ mode: "ANY", allowedFunctionNames: ["myTool"] });

		const { wireOptions: o3 } = createWireRequest(bareModel, {
			toolChoice: { type: "function" } as unknown as SimpleStreamOptions["toolChoice"],
		});
		expect(o3.toolChoice).toBeUndefined();
	});

	test("sanitizes Cloud Code 429 burst errors to prevent synthetic 30-minute lockout", async () => {
		const bareModel = model("gemini-3.8-flash");
		const stream = streamAntigravityPro(bareModel, context, {
			apiKey: credential("token"),
			maxRetryDelayMs: 0,
			fetch: async () => {
				return new Response(
					JSON.stringify({
						error: {
							code: 429,
							message: "Resource has been exhausted (e.g. check quota).",
							status: "RESOURCE_EXHAUSTED",
						},
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			},
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("[retry-after-ms: 5000]");
		expect(result.errorMessage).toContain("(burst rate limit)");
		expect(result.errorMessage).not.toContain("check quota");
	});

	test("forces production endpoint mode even when caller passes auto", () => {
		const { wireOptions } = createWireRequest(model("gemini-3.8-flash"), {
			antigravityEndpointMode: "auto",
		} as unknown as SimpleStreamOptions);

		expect((wireOptions as GoogleGeminiCliOptions).antigravityEndpointMode).toBe("production");
	});

	test("sanitizePromptText replaces system-conventions tags", () => {
		const input = "<system-conventions>\nRule 1\n</system-conventions>";
		const output = sanitizePromptText(input);
		expect(output).toBe("<system-rules>\nRule 1\n</system-rules>");
		expect(output).not.toContain("system-conventions");

		const whitespaceInput = "Testing <system-conventions >whitespace</system-conventions >";
		const whitespaceOutput = sanitizePromptText(whitespaceInput);
		expect(whitespaceOutput).toBe("Testing <system-rules>whitespace</system-rules>");
		expect(whitespaceOutput).not.toContain("system-conventions");
	});

	test("sanitizeAntigravityContext sanitizes both systemPrompt and messages", () => {
		const ctx: Context = {
			systemPrompt: ["<system-conventions>rules</system-conventions>"],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "query with <system-conventions>bad</system-conventions>" }],
					timestamp: 1,
				},
				{
					role: "user",
					content: "plain string <system-rules>tag</system-rules>",
					timestamp: 2,
				},
			],
		};
		const sanitized = sanitizeAntigravityContext(ctx);
		expect(sanitized.systemPrompt?.[0]).toBe("<system-rules>rules</system-rules>");
		const firstContent = sanitized.messages[0].content as Array<{ type: string; text: string }>;
		expect(firstContent[0].text).toBe("query with <system-rules>bad</system-rules>");
		expect(sanitized.messages[1].content).toBe("plain string <system-rules>tag</system-rules>");
	});

	test("sanitizeAntigravityPayload sanitizes systemInstruction and contents", () => {
		const payload = {
			project: "test-proj",
			model: "gemini-3.8-flash",
			request: {
				systemInstruction: {
					parts: [{ text: "<system-conventions>sys</system-conventions>" }],
				},
				contents: [
					{
						role: "user",
						parts: [{ text: "<system-conventions>user</system-conventions>" }],
					},
				],
			},
		};
		const sanitized = sanitizeAntigravityPayload(payload);
		expect(sanitized.request.systemInstruction.parts[0].text).toBe("<system-rules>sys</system-rules>");
		expect(sanitized.request.contents[0].parts[0].text).toBe("<system-rules>user</system-rules>");
	});

	test("getAccountLockKey extracts email or projectId", () => {
		expect(getAccountLockKey(JSON.stringify({ email: "user@example.com" }))).toBe("email:user@example.com");
		expect(getAccountLockKey(JSON.stringify({ projectId: "proj-123" }))).toBe("project:proj-123");
		expect(getAccountLockKey("plain-key")).toBe("plain-key");
		expect(getAccountLockKey(undefined)).toBe("default");
	});

	test("streamAntigravityPro cleans system-conventions before calling fetch", async () => {
		let receivedBody: { request: { systemInstruction: { parts: Array<{ text?: string }> } } } | undefined;
		const stream = streamAntigravityPro(
			model("gemini-3.8-flash"),
			{
				systemPrompt: ["<system-conventions>OMP conventions</system-conventions>"],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
			},
			{
				apiKey: credential("token"),
				fetch: async (_url, init) => {
					receivedBody = JSON.parse(init?.body as string);
					return successfulSse();
				},
			},
		);

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(receivedBody).toBeDefined();
		const sysText = receivedBody!.request.systemInstruction.parts[0].text;
		expect(sysText).toContain("<system-rules>");
		expect(sysText).not.toContain("system-conventions");
	});

	test("allows parallel streamAntigravityPro requests concurrently without queuing", async () => {
		const gate = Promise.withResolvers<void>();
		let reachedGateCount = 0;

		const barrierFetch = async () => {
			reachedGateCount++;
			if (reachedGateCount === 2) {
				gate.resolve();
			}
			await gate.promise;
			return successfulSse();
		};

		const ctx: Context = {
			systemPrompt: ["prompt"],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};

		const stream1 = streamAntigravityPro(model("gemini-3.8-flash"), ctx, {
			apiKey: credential("token"),
			fetch: barrierFetch,
		});
		const stream2 = streamAntigravityPro(model("gemini-3.8-flash"), ctx, {
			apiKey: credential("token"),
			fetch: barrierFetch,
		});

		const [res1, res2] = await Promise.all([stream1.result(), stream2.result()]);
		expect(res1.stopReason).toBe("stop");
		expect(res2.stopReason).toBe("stop");
		expect(reachedGateCount).toBe(2);
	});
});
