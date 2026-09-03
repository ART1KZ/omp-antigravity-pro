import { describe, expect, test } from "bun:test";
import {
	DEFAULT_FALLBACK_PROJECT_ID,
	discoverProject,
	GoogleOAuthFlow,
	type login,
	refreshAntigravityToken,
} from "../src/oauth";

describe("OAuth discovery and fallback", () => {
	test("discoverProject uses existing project from loadCodeAssist", async () => {
		const mockFetcher = (async () => {
			return new Response(JSON.stringify({ cloudaicompanionProject: "custom-proj-123" }), { status: 200 });
		}) as unknown as typeof fetch;

		const projectId = await discoverProject("test-token", undefined, mockFetcher);
		expect(projectId).toBe("custom-proj-123");
	});

	test("discoverProject falls back to aicode-consumers on ineligible location or failed load", async () => {
		const mockFetcher = (async () => {
			return new Response(
				JSON.stringify({
					ineligibleTiers: [{ reasonCode: "UNSUPPORTED_LOCATION" }],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const projectId = await discoverProject("test-token", undefined, mockFetcher);
		expect(projectId).toBe(DEFAULT_FALLBACK_PROJECT_ID);
	});

	test("refreshAntigravityToken refreshes access token and retains projectId", async () => {
		const mockFetcher = (async () => {
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					expires_in: 3600,
					refresh_token: "new-refresh-token",
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const creds = await refreshAntigravityToken("old-refresh", "my-proj", mockFetcher);
		expect(creds.access).toBe("new-access-token");
		expect(creds.refresh).toBe("new-refresh-token");
		expect(creds.projectId).toBe("my-proj");
	});

	test("discoverProject propagates cancellation when AbortSignal is triggered", async () => {
		const controller = new AbortController();
		controller.abort();

		const mockFetcher = (async () => {
			const err = new Error("The operation was aborted");
			err.name = "AbortError";
			throw err;
		}) as unknown as typeof fetch;

		expect(discoverProject("test-token", undefined, controller.signal, mockFetcher)).rejects.toThrow();
	});

	test("discoverProject surfaces Google validation error", async () => {
		const mockFetcher = (async () => {
			return new Response(
				JSON.stringify({
					error: {
						details: [
							{
								reason: "VALIDATION_REQUIRED",
								metadata: {
									validation_url: "https://accounts.google.com/signin/v2/challenge",
								},
							},
						],
					},
				}),
				{ status: 403 },
			);
		}) as unknown as typeof fetch;

		expect(discoverProject("test-token", undefined, mockFetcher)).rejects.toThrow("Account verification required");
	});

	test("refreshAntigravityToken calculates safe non-negative expires", async () => {
		const mockFetcher = (async () => {
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					expires_in: 10,
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const now = Date.now();
		const creds = await refreshAntigravityToken("old-refresh", "my-proj", mockFetcher);
		expect(creds.expires).toBeGreaterThanOrEqual(now);
	});

	test("GoogleOAuthFlow creates valid authorization url", async () => {
		const ctrl = { signal: new AbortController().signal } as unknown as Parameters<typeof login>[0];
		const flow = new GoogleOAuthFlow(ctrl);
		const { url } = await flow.generateAuthUrl("state-123", "http://localhost:51121/oauth-callback");
		expect(url).toContain("accounts.google.com");
		expect(url).toContain("state=state-123");
		expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback");
	});
});
