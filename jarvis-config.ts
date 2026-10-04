import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type JarvisModelSelectionScope = "global" | "project";

export type JarvisThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type StoredJarvisModelSelection =
	| { mode: "follow-main" }
	| { mode: "pinned"; provider: string; modelId: string };

export type StoredJarvisThinkingSelection =
	| { mode: "auto" }
	| { mode: "follow-main" }
	| { mode: "pinned"; thinkingLevel: JarvisThinkingLevel };

type JarvisConfigFile = Record<string, unknown> & {
	modelSelection?: StoredJarvisModelSelection;
	thinkingSelection?: StoredJarvisThinkingSelection;
};

export function getJarvisConfigPath(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): string {
	return scope === "global" ? join(agentDir, "extensions", "pi-jarvis.json") : join(cwd, ".pi", "jarvis.json");
}

export function loadJarvisModelSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): StoredJarvisModelSelection | undefined {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	const config = readJarvisConfigFileIfPresent(path);
	if (!config) return undefined;
	if (config.modelSelection === undefined) {
		return undefined;
	}

	const selection = parseStoredJarvisModelSelection(config.modelSelection);
	if (!selection) {
		throw new MalformedJarvisConfigError(`Invalid modelSelection in ${path}.`);
	}
	return selection;
}

export function saveJarvisModelSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	selection: StoredJarvisModelSelection,
	agentDir: string = getAgentDir(),
): void {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	const config = readExistingJarvisConfigFileForWrite(path);
	config.modelSelection = selection;
	writeJarvisConfigFile(path, config);
}

export function clearJarvisModelSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): void {
	clearJarvisConfigSetting(cwd, scope, "modelSelection", agentDir);
}

export function loadJarvisThinkingSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): StoredJarvisThinkingSelection | undefined {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	const config = readJarvisConfigFileIfPresent(path);
	if (!config) return undefined;
	if (config.thinkingSelection === undefined) {
		return undefined;
	}

	const selection = parseStoredJarvisThinkingSelection(config.thinkingSelection);
	if (!selection) {
		throw new MalformedJarvisConfigError(`Invalid thinkingSelection in ${path}.`);
	}
	return selection;
}

export function saveJarvisThinkingSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	selection: StoredJarvisThinkingSelection,
	agentDir: string = getAgentDir(),
): void {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	const config = readExistingJarvisConfigFileForWrite(path);
	config.thinkingSelection = selection;
	writeJarvisConfigFile(path, config);
}

export function clearJarvisThinkingSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): void {
	clearJarvisConfigSetting(cwd, scope, "thinkingSelection", agentDir);
}

function clearJarvisConfigSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	setting: "modelSelection" | "thinkingSelection",
	agentDir: string,
): void {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	const config = readJarvisConfigFileIfPresent(path);
	if (!config) return;

	delete config[setting];
	if (Object.keys(config).length === 0) {
		rmSync(path, { force: true });
		return;
	}

	writeJarvisConfigFile(path, config);
}

export class MalformedJarvisConfigError extends Error {}

function readJarvisConfigFileIfPresent(path: string): JarvisConfigFile | undefined {
	try {
		return readJarvisConfigFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
}

function readJarvisConfigFile(path: string): JarvisConfigFile {
	// Keep I/O errors distinct from malformed content; neither permits overwriting existing settings.
	const text = readFileSync(path, "utf-8");
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		// Parser messages can contain private input snippets; expose only safe repair guidance.
		throw new MalformedJarvisConfigError(
			`Invalid JSON in ${path}. Repair this file manually before changing settings to preserve memory/privacy settings.`,
			{ cause: error },
		);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new MalformedJarvisConfigError(
			`Expected ${path} to contain a JSON object. Repair this file manually before changing settings to preserve memory/privacy settings.`,
		);
	}

	return { ...(raw as Record<string, unknown>) };
}

function readExistingJarvisConfigFileForWrite(path: string): JarvisConfigFile {
	// Shared files can contain memory kill switches and unknown settings. Never recover by discarding them.
	return readJarvisConfigFileIfPresent(path) ?? {};
}

function writeJarvisConfigFile(path: string, config: JarvisConfigFile): void {
	mkdirSync(dirname(path), { recursive: true });
	let mode = 0o600;
	try {
		mode = statSync(path).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(temporaryPath, "wx", mode);
		created = true;
		writeFileSync(fd, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// Same-directory rename means readers see either the old or complete new file.
		renameSync(temporaryPath, path);
		created = false;
	} finally {
		// Cleanup is best effort after a failed operation; never mask its error.
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* Keep the original write/close failure. */ }
		}
		if (created) {
			try { rmSync(temporaryPath, { force: true }); } catch { /* Keep the original failure. */ }
		}
	}
}

function parseStoredJarvisModelSelection(data: unknown): StoredJarvisModelSelection | undefined {
	if (!data || typeof data !== "object") {
		return undefined;
	}

	const candidate = data as { mode?: unknown; provider?: unknown; modelId?: unknown };
	if (candidate.mode === "follow-main") {
		return { mode: "follow-main" };
	}
	if (
		candidate.mode === "pinned" &&
		typeof candidate.provider === "string" &&
		candidate.provider.length > 0 &&
		typeof candidate.modelId === "string" &&
		candidate.modelId.length > 0
	) {
		return {
			mode: "pinned",
			provider: candidate.provider,
			modelId: candidate.modelId,
		};
	}
	return undefined;
}

function parseStoredJarvisThinkingSelection(data: unknown): StoredJarvisThinkingSelection | undefined {
	if (!data || typeof data !== "object") {
		return undefined;
	}

	const candidate = data as { mode?: unknown; thinkingLevel?: unknown };
	if (candidate.mode === "auto") {
		return { mode: "auto" };
	}
	if (candidate.mode === "follow-main") {
		return { mode: "follow-main" };
	}
	if (candidate.mode === "pinned" && isJarvisThinkingLevel(candidate.thinkingLevel)) {
		return { mode: "pinned", thinkingLevel: candidate.thinkingLevel };
	}
	return undefined;
}

function isJarvisThinkingLevel(value: unknown): value is JarvisThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
