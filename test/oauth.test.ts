import { describe, expect, test } from "bun:test";
import { DEFAULT_FALLBACK_PROJECT_ID, discoverProject, refreshAntigravityToken } from "../src/oauth";

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
});
