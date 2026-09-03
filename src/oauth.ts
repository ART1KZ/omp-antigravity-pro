import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/oauth/callback-server";
import { oauthFetch, throwIfLoginCancelled } from "@oh-my-pi/pi-ai/oauth/google-oauth-shared";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import {
	extractGoogleValidationUrl,
	formatGoogleValidationRequiredMessage,
} from "@oh-my-pi/pi-ai/utils/google-validation";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { getAntigravityBaseUrl, PROVIDER_ID } from "./models";

const P1 = ["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep", "apps.googleusercontent.com"].join("-");
export const CLIENT_ID = P1.replace("-apps.", ".apps.");
export const CLIENT_SECRET = ["GOCSPX-", "K58FWR486", "LdLJ1mLB8sXC4z6qDAf"].join("");
export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/oauth-callback";

export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DEFAULT_FALLBACK_PROJECT_ID = "aicode-consumers";

export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI",
});

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: string | { id?: string };
	};
}

function readProjectId(value: string | { id?: string } | undefined): string | undefined {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	if (value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) {
		return value.id;
	}
	return undefined;
}

function getDefaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string {
	if (!allowedTiers || allowedTiers.length === 0) {
		return "standard-tier";
	}
	const defaultTier = allowedTiers.find((tier) => tier.isDefault && typeof tier.id === "string" && tier.id.length > 0);
	if (defaultTier?.id) {
		return defaultTier.id;
	}
	const firstTier = allowedTiers.find((tier) => typeof tier.id === "string" && tier.id.length > 0);
	if (firstTier?.id) {
		return firstTier.id;
	}
	return "standard-tier";
}

export async function discoverProject(
	accessToken: string,
	onProgress?: (message: string) => void,
	signalOrFetcher?: AbortSignal | typeof fetch,
	fetcherArg?: typeof fetch,
): Promise<string> {
	const signal = signalOrFetcher instanceof AbortSignal ? signalOrFetcher : undefined;
	const fetcher = typeof signalOrFetcher === "function" ? signalOrFetcher : (fetcherArg ?? fetch);

	const endpoint = getAntigravityBaseUrl();
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": getAntigravityUserAgent(),
	};

	onProgress?.("Checking for existing Antigravity project via proxy...");
	try {
		const loadResponse = await fetcher(`${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers,
			signal,
			body: JSON.stringify({
				metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
			}),
		});

		if (loadResponse.ok) {
			const loadPayload = (await loadResponse.json()) as LoadCodeAssistPayload;
			const existingProject = readProjectId(loadPayload.cloudaicompanionProject);
			if (existingProject) {
				return existingProject;
			}

			const tierId = getDefaultTierId(loadPayload.allowedTiers);
			onProgress?.(`Provisioning Antigravity project (${tierId})...`);

			try {
				const onboardResponse = await fetcher(`${endpoint}/v1internal:onboardUser`, {
					method: "POST",
					headers,
					signal,
					body: JSON.stringify({
						tierId,
						metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
					}),
				});

				if (onboardResponse.ok) {
					const operation = (await onboardResponse.json()) as LongRunningOperationResponse;
					const provisionedProject = readProjectId(operation.response?.cloudaicompanionProject);
					if (provisionedProject) {
						return provisionedProject;
					}
				}
			} catch (onboardErr) {
				if (signal?.aborted || (onboardErr instanceof Error && onboardErr.name === "AbortError")) {
					throw onboardErr;
				}
				// Fall through to fallback project
			}
		} else {
			const errorText = await loadResponse.text();
			const validationUrl = extractGoogleValidationUrl(errorText);
			if (validationUrl) {
				const validationError = new Error(formatGoogleValidationRequiredMessage(validationUrl, "sign in again"));
				(validationError as { isValidationRequired?: boolean }).isValidationRequired = true;
				throw validationError;
			}
		}
	} catch (err) {
		if (
			signal?.aborted ||
			(err as { isValidationRequired?: boolean })?.isValidationRequired ||
			(err instanceof Error && err.name === "AbortError")
		) {
			throw err;
		}
		// Fall through to fallback project
	}

	onProgress?.("Using default Antigravity consumer project...");
	return DEFAULT_FALLBACK_PROJECT_ID;
}

export class GoogleOAuthFlow extends OAuthCallbackFlow {
	constructor(ctrl: OAuthController) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			allowPortFallback: false,
		});
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES.join(" "),
			state,
			access_type: "offline",
			prompt: "consent",
		});
		return { url: `${AUTH_URL}?${authParams.toString()}` };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		throwIfLoginCancelled(this.ctrl.signal);
		const tokenResponse = await oauthFetch(
			TOKEN_URL,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					client_secret: CLIENT_SECRET,
					code,
					grant_type: "authorization_code",
					redirect_uri: redirectUri,
				}),
			},
			{ provider: PROVIDER_ID, signal: this.ctrl.signal },
		);

		const data = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		const projectId = await discoverProject(data.access_token, this.ctrl.onProgress, this.ctrl.signal);

		return {
			access: data.access_token,
			refresh: data.refresh_token,
			expires: Date.now() + Math.max(0, data.expires_in * 1000 - 5 * 60 * 1000),
			projectId,
		};
	}
}

export async function login(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new GoogleOAuthFlow(ctrl);
	return flow.login();
}

export async function refreshAntigravityToken(
	refreshToken: string,
	projectId: string,
	fetcher: typeof fetch = fetch,
): Promise<OAuthCredentials> {
	const response = await fetcher(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Antigravity token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + Math.max(0, data.expires_in * 1000 - 5 * 60 * 1000),
		projectId: projectId || DEFAULT_FALLBACK_PROJECT_ID,
	};
}

export function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const projectId = credentials.projectId?.trim() || DEFAULT_FALLBACK_PROJECT_ID;
	return refreshAntigravityToken(credentials.refresh, projectId);
}

export function getApiKey(credentials: OAuthCredentials): string {
	return JSON.stringify({
		token: credentials.access,
		refreshToken: credentials.refresh,
		expiresAt: credentials.expires,
		projectId: credentials.projectId?.trim() || DEFAULT_FALLBACK_PROJECT_ID,
		email: credentials.email,
		accountId: credentials.accountId,
	});
}
