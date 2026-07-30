import { loginAntigravity, refreshAntigravityToken } from "@oh-my-pi/pi-ai/oauth/google-antigravity";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";

/** Stock Google Antigravity login flow — same client, scopes and callback port as OMP. */
export function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	return loginAntigravity(callbacks);
}

/** Stock refresh; `projectId` is part of the Cloud Code credential and must survive rotation. */
export function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const projectId = requireProjectId(credentials);
	return refreshAntigravityToken(credentials.refresh, projectId);
}

/**
 * Cloud Code Assist authenticates with a structured credential, not a bare
 * bearer: the transport reads `token` and `projectId` out of this JSON.
 */
export function getApiKey(credentials: OAuthCredentials): string {
	return JSON.stringify({
		token: credentials.access,
		refreshToken: credentials.refresh,
		expiresAt: credentials.expires,
		projectId: requireProjectId(credentials),
		email: credentials.email,
		accountId: credentials.accountId,
	});
}

function requireProjectId(credentials: OAuthCredentials): string {
	const projectId = credentials.projectId?.trim();
	if (!projectId) {
		throw new Error("Antigravity credentials are missing projectId — run /login to re-authenticate.");
	}
	return projectId;
}
