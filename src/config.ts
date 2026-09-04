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
