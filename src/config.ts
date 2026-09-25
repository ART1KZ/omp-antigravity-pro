import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConfigUpdateResult {
	updated: boolean;
	content: string;
}

/**
 * Updates config content string to ensure inlineToolDescriptors is set to "off".
 * If already "off" or explicitly set to "on", preserves the existing content.
 * If set to "auto" or missing, updates it to "off".
 */
export function updateInlineToolDescriptorsText(content: string): ConfigUpdateResult {
	const match = content.match(/^([ \t]*inlineToolDescriptors\s*:\s*["']?)([^"'\r\n]+)(["']?)/m);
	if (match) {
		const currentVal = match[2].trim().toLowerCase();
		if (currentVal === "off" || currentVal === "on") {
			return { updated: false, content };
		}
		const updatedContent = content.replace(/^([ \t]*inlineToolDescriptors\s*:\s*["']?)[^"'\r\n]+(["']?)/m, '$1"off"$2');
		return { updated: true, content: updatedContent };
	}

	const separator = content.endsWith("\n") || content.length === 0 ? "" : "\n";
	return {
		updated: true,
		content: `${content}${separator}inlineToolDescriptors: "off"\n`,
	};
}

/**
 * Ensures ~/.omp/agent/config.yml has inlineToolDescriptors: "off" to prevent
 * subagent crashes under Gemini models on OMP 18.1.10+.
 * Does not block execution and silently catches any filesystem errors.
 */
export function ensureSafeInlineToolDescriptors(customAgentDir?: string): boolean {
	try {
		const agentDir = customAgentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
		const configPath = join(agentDir, "config.yml");

		if (!existsSync(configPath)) {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(configPath, 'inlineToolDescriptors: "off"\n', "utf-8");
			return true;
		}

		const existing = readFileSync(configPath, "utf-8");
		const result = updateInlineToolDescriptorsText(existing);
		if (result.updated) {
			writeFileSync(configPath, result.content, "utf-8");
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export const BURST_BLOCK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Clears artificial burst/TPM lockout blocks placed on Google Antigravity credentials
 * while preserving real quota cooldowns.
 *
 * Semantics:
 * A counter:<group> block longer than the burst window is a real quota cooldown carrying
 * the reset time (OMP reconciles it against live usage itself) and must survive;
 * unscoped blocks, and any block shorter than the burst window, are the artificial lockout
 * this helper exists to remove; already-expired rows go too.
 */
export function clearAntigravityAuthBlocks(customAgentDir?: string): boolean {
	try {
		const agentDir = customAgentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
		const dbPath = join(agentDir, "agent.db");
		if (!existsSync(dbPath)) return false;

		const now = Date.now();
		const query =
			"DELETE FROM auth_credential_blocks WHERE (provider_key LIKE '%antigravity%' OR provider_key LIKE '%google%') AND (blocked_until_ms <= :now OR (block_scope NOT LIKE 'counter:%' OR blocked_until_ms - :now <= :burstWindowMs))";
		const params = {
			":now": now,
			":burstWindowMs": BURST_BLOCK_WINDOW_MS,
		};

		try {
			const mod = "bun:sqlite";
			const { Database } = require(mod);
			const db = new Database(dbPath);
			db.run(query, params);
			db.close();
			return true;
		} catch {
			try {
				const { DatabaseSync } = require("node:sqlite");
				const db = new DatabaseSync(dbPath);
				db.prepare(query).run(params);
				db.close();
				return true;
			} catch {
				return false;
			}
		}
	} catch {
		return false;
	}
}
