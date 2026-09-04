import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSafeInlineToolDescriptors, updateInlineToolDescriptorsText } from "../src/config";

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
