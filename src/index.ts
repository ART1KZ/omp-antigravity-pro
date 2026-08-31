import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	CUSTOM_API_ID,
	fetchDynamicAntigravityModels,
	getAntigravityBaseUrl,
	PROVIDER_ID,
	projectBundledAntigravityModels,
} from "./models";
import { getApiKey, login, refreshToken } from "./oauth";
import { streamAntigravityPro } from "./stream";

/**
 * Replaces the stock `google-antigravity` transport in place: same provider id,
 * so existing logins, `/usage`, session stickiness and multi-account failover
 * in AuthStorage keep working. Only the wire shaping changes — Gemini 3.6 sends
 * a numeric `thinkingBudget` with tier-specific wire ids (captured from `agy`
 * 1.1.8) instead of `thinkingLevel`, and routing defaults to the daily
 * endpoint that the real client uses (or ANTIGRAVITY_BASE_URL if configured).
 */
export default function antigravityProExtension(pi: ExtensionAPI): void {
	pi.setLabel("Antigravity Pro (daily endpoint, budget thinking)");

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: getAntigravityBaseUrl(),
		api: CUSTOM_API_ID,
		streamSimple: streamAntigravityPro,
		models: projectBundledAntigravityModels(),
		fetchDynamicModels: (apiKey) => fetchDynamicAntigravityModels(apiKey),
		oauth: {
			name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
			login,
			refreshToken,
			getApiKey,
		},
	});
}
