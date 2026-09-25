import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BURST_BLOCK_WINDOW_MS,
	clearAntigravityAuthBlocks,
	ensureSafeInlineToolDescriptors,
	updateInlineToolDescriptorsText,
} from "../src/config";

describe("updateInlineToolDescriptorsText", () => {
	test("appends inlineToolDescriptors: off when not present", () => {
		const input = "modelRoles:\n  default: google-antigravity/gemini-3.8-flash:high\n";
		const res = updateInlineToolDescriptorsText(input);
		expect(res.updated).toBe(true);
		expect(res.content).toContain('inlineToolDescriptors: "off"');
	});

	test("replaces auto with off", () => {
		const input = "inlineToolDescriptors: auto\nmodelRoles:\n  default: gemini\n";
		const res = updateInlineToolDescriptorsText(input);
		expect(res.updated).toBe(true);
		expect(res.content).toBe('inlineToolDescriptors: "off"\nmodelRoles:\n  default: gemini\n');
	});

	test("preserves existing off setting", () => {
		const input = 'inlineToolDescriptors: "off"\n';
		const res = updateInlineToolDescriptorsText(input);
		expect(res.updated).toBe(false);
		expect(res.content).toBe(input);
	});

	test("preserves explicit user on setting", () => {
		const input = 'inlineToolDescriptors: "on"\n';
		const res = updateInlineToolDescriptorsText(input);
		expect(res.updated).toBe(false);
		expect(res.content).toBe(input);
	});
});

describe("ensureSafeInlineToolDescriptors", () => {
	test("updates config.yml in specified directory", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "omp-test-"));
		try {
			const configPath = join(tempDir, "config.yml");
			writeFileSync(configPath, "theme: dark\n", "utf-8");

			const updated = ensureSafeInlineToolDescriptors(tempDir);
			expect(updated).toBe(true);

			const content = readFileSync(configPath, "utf-8");
			expect(content).toContain('inlineToolDescriptors: "off"');

			// Second run should be no-op
			const secondRun = ensureSafeInlineToolDescriptors(tempDir);
			expect(secondRun).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("handles missing config.yml by creating it", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "omp-test-"));
		try {
			const configPath = join(tempDir, "config.yml");
			const updated = ensureSafeInlineToolDescriptors(tempDir);
			expect(updated).toBe(true);

			const content = readFileSync(configPath, "utf-8");
			expect(content).toContain('inlineToolDescriptors: "off"');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("clearAntigravityAuthBlocks", () => {
	test("BURST_BLOCK_WINDOW_MS is 10 minutes", () => {
		expect(BURST_BLOCK_WINDOW_MS).toBe(10 * 60 * 1000);
	});

	test("clears burst lockouts while preserving real quota cooldowns", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "omp-auth-test-"));
		const dbPath = join(tempDir, "agent.db");
		try {
			const db = new Database(dbPath);
			db.run(`CREATE TABLE auth_credential_blocks(
				credential_id INTEGER,
				provider_key TEXT,
				block_scope TEXT,
				blocked_until_ms INTEGER,
				updated_at INTEGER
			)`);

			const now = Date.now();
			const insert = db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (:id, :pk, :bs, :bu, :ua)",
			);

			// (a) google-antigravity:oauth + counter:google + 25 min ahead → KEPT
			insert.run({
				":id": 1,
				":pk": "google-antigravity:oauth",
				":bs": "counter:google",
				":bu": now + 25 * 60 * 1000,
				":ua": now,
			});

			// (b) google-antigravity:oauth + empty scope + 5 s ahead → DELETED
			insert.run({
				":id": 2,
				":pk": "google-antigravity:oauth",
				":bs": "",
				":bu": now + 5 * 1000,
				":ua": now,
			});

			// (c) google-antigravity:oauth + counter:google + 60 s ahead → DELETED
			insert.run({
				":id": 3,
				":pk": "google-antigravity:oauth",
				":bs": "counter:google",
				":bu": now + 60 * 1000,
				":ua": now,
			});

			// (d) google-antigravity:oauth + counter:google already expired → DELETED
			insert.run({
				":id": 4,
				":pk": "google-antigravity:oauth",
				":bs": "counter:google",
				":bu": now - 1000,
				":ua": now - 2000,
			});

			// (e) openai-codex:oauth + 25 min ahead → UNTOUCHED
			insert.run({
				":id": 5,
				":pk": "openai-codex:oauth",
				":bs": "counter:openai",
				":bu": now + 25 * 60 * 1000,
				":ua": now,
			});
			insert.finalize();
			db.close();

			const result = clearAntigravityAuthBlocks(tempDir);
			expect(result).toBe(true);

			const checkDb = new Database(dbPath);
			const query = checkDb.query(
				"SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks ORDER BY credential_id ASC",
			);
			const rows = query.all() as {
				credential_id: number;
				provider_key: string;
				block_scope: string;
				blocked_until_ms: number;
				updated_at: number;
			}[];
			query.finalize();
			checkDb.close();

			const remainingIds = rows.map((r) => r.credential_id);

			// (a) google-antigravity:oauth + counter:google + 25 min ahead → KEPT
			expect(remainingIds).toContain(1);
			const rowA = rows.find((r) => r.credential_id === 1);
			expect(rowA?.provider_key).toBe("google-antigravity:oauth");
			expect(rowA?.block_scope).toBe("counter:google");

			// (b) google-antigravity:oauth + empty scope + 5 s ahead → DELETED
			expect(remainingIds).not.toContain(2);

			// (c) google-antigravity:oauth + counter:google + 60 s ahead → DELETED
			expect(remainingIds).not.toContain(3);

			// (d) google-antigravity:oauth + counter:google already expired → DELETED
			expect(remainingIds).not.toContain(4);

			// (e) openai-codex:oauth + 25 min ahead → UNTOUCHED
			expect(remainingIds).toContain(5);
			const rowE = rows.find((r) => r.credential_id === 5);
			expect(rowE?.provider_key).toBe("openai-codex:oauth");
			expect(rowE?.block_scope).toBe("counter:openai");

			expect(rows).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns false when database file does not exist", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "omp-auth-test-nonexistent-"));
		try {
			expect(clearAntigravityAuthBlocks(tempDir)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
