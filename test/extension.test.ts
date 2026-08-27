import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { getBundledModels } from "@oh-my-pi/pi-catalog";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import antigravityProExtension from "../src/index";
import { ANTIGRAVITY_DAILY_ENDPOINT, CUSTOM_API_ID, PROVIDER_ID } from "../src/models";
import { streamAntigravityPro } from "../src/stream";

function register(): { name: string; config: ProviderConfig } {
	const captured: Array<{ name: string; config: ProviderConfig }> = [];
	const pi = {
		setLabel: () => {},
		registerProvider: (name: string, config: ProviderConfig) => {
			captured.push({ name, config });
		},
	} as unknown as ExtensionAPI;

	antigravityProExtension(pi);

	const entry = captured[0];
	expect(captured).toHaveLength(1);
	if (!entry) throw new Error("extension registered no provider");
	return entry;
}

describe("extension registration", () => {
	test("replaces the stock Antigravity transport without renaming the provider", () => {
		const { name, config } = register();

		expect(name).toBe(PROVIDER_ID);
		expect(config.api).toBe(CUSTOM_API_ID);
		expect(config.baseUrl).toBe(ANTIGRAVITY_DAILY_ENDPOINT);
		expect(config.streamSimple).toBe(streamAntigravityPro);
		expect(config.authHeader).toBeUndefined();
	});

	test("registers the full bundled catalog on the custom transport", () => {
		const { config } = register();
		const bundled = getBundledModels(PROVIDER_ID);

		expect(config.models?.length).toBeGreaterThanOrEqual(bundled.length);
		expect(config.models?.slice(0, bundled.length).map((model) => model.id)).toEqual(bundled.map((model) => model.id));
		expect(config.models?.some((model) => model.id === "gemini-3.6-flash")).toBe(true);
		expect(config.models?.every((model) => model.api === CUSTOM_API_ID)).toBe(true);
	});

	test("keeps stock Google OAuth and emits the structured Cloud Code credential", () => {
		const { config } = register();
		const oauth = config.oauth;
		expect(oauth).toBeDefined();
		if (!oauth) throw new Error("oauth registration missing");
		expect(typeof oauth.login).toBe("function");
		expect(typeof oauth.refreshToken).toBe("function");

		const apiKey = oauth.getApiKey?.({
			access: "access-token",
			refresh: "refresh-token",
			expires: 1_800_000_000_000,
			projectId: "project-42",
			email: "user@example.com",
			accountId: "account-7",
		});
		expect(apiKey).toBeDefined();

		expect(JSON.parse(apiKey ?? "{}")).toEqual({
			token: "access-token",
			refreshToken: "refresh-token",
			expiresAt: 1_800_000_000_000,
			projectId: "project-42",
			email: "user@example.com",
			accountId: "account-7",
		});
	});

	test("refuses credentials without a projectId instead of sending a broken envelope", () => {
		const { config } = register();
		const getApiKey = config.oauth?.getApiKey;
		expect(getApiKey).toBeDefined();

		expect(() => getApiKey?.({ access: "access-token", refresh: "refresh-token", expires: 1_800_000_000_000 })).toThrow(
			/projectId/,
		);
	});
});

describe("published package contract", () => {
	test("declares every runtime OMP package as a production dependency", async () => {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};

		expect(packageJson.dependencies).toEqual(
			expect.objectContaining({
				"@oh-my-pi/pi-ai": expect.any(String),
				"@oh-my-pi/pi-catalog": expect.any(String),
			}),
		);
	});
});
