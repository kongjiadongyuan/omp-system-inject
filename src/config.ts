// Pure config loading / layering / validation for omp-system-inject.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_FILE = "system-inject.yml";
export type Mode = "replace" | "prefix" | "suffix";
const MODES: Mode[] = ["replace", "prefix", "suffix"];

export interface InjectEntry {
	injectId: string;
	model: string; // exact model id, or "provider/id" selector (resolved at match time)
	mode: Mode;
	systemPrompt: string; // resolved text
	source: string; // config file the entry came from
}
export interface LoadResult {
	entries: InjectEntry[]; // final merged, ordered by injectId first appearance
	warnings: string[];
	files: string[]; // config files consulted (existing)
}

/** omp's user agent dir: $PI_CODING_AGENT_DIR or ~/.omp/agent. */
export function userConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
}

/** Nearest <dir>/.omp/system-inject.yml walking up from cwd (like omp's findAllNearestProjectConfigDirs). */
export function projectConfigFile(cwd: string): string | undefined {
	const home = path.resolve(os.homedir());
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, ".omp", CONFIG_FILE);
		// ~/.omp/system-inject.yml is not a project file (user level lives in ~/.omp/agent)
		if (dir !== home && fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Lowest priority first: user, then project. */
export function configFiles(cwd: string): string[] {
	const files: string[] = [];
	const user = path.join(userConfigDir(), CONFIG_FILE);
	if (fs.existsSync(user)) files.push(user);
	const proj = projectConfigFile(cwd);
	if (proj && path.resolve(proj) !== path.resolve(user)) files.push(proj);
	return files;
}

function parseFile(file: string, warnings: string[]): unknown[] {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		warnings.push(`${file}: cannot parse YAML: ${(e as Error).message}`);
		return [];
	}
	if (doc == null) return [];
	const list = Array.isArray(doc) ? doc : (doc as any).injects;
	if (!Array.isArray(list)) {
		warnings.push(`${file}: expected top-level "injects:" list`);
		return [];
	}
	return list;
}

type Partial_ = { injectId: string; model?: string; mode?: string; systemPrompt?: string; systemPromptFile?: string; source: string; index: number };

/** Load all layers, merge by injectId (project fields override global fields), validate. */
export function loadConfig(cwd: string, files = configFiles(cwd)): LoadResult {
	const warnings: string[] = [];
	const merged = new Map<string, Partial_>();
	for (const file of files) {
		const seen = new Set<string>();
		parseFile(file, warnings).forEach((raw, i) => {
			const where = `${file} [injects[${i}]]`;
			if (!raw || typeof raw !== "object") return void warnings.push(`${where}: entry must be a mapping`);
			const r = raw as Record<string, unknown>;
			const id = r.injectId;
			if (typeof id !== "string" || !id.trim()) return void warnings.push(`${where}: "injectId" is required`);
			if (!/^[\w.-]+$/.test(id)) return void warnings.push(`${where}: injectId "${id}" may only contain letters, digits, _ . -`);
			if (seen.has(id)) warnings.push(`${where}: duplicate injectId "${id}" in same file; later entry wins`);
			seen.add(id);
			for (const k of Object.keys(r))
				if (!["injectId", "model", "mode", "systemPrompt"].includes(k)) warnings.push(`${where}: unknown key "${k}"`);
			const prev = merged.get(id);
			const next: Partial_ = { ...(prev ?? { injectId: id, index: merged.size }), source: file };
			if (r.model !== undefined) next.model = String(r.model);
			if (r.mode !== undefined) next.mode = String(r.mode);
			if (r.systemPrompt !== undefined) {
				const sp = String(r.systemPrompt);
				// A value ending in .md is a file reference relative to THIS config file.
				if (/\.md$/i.test(sp.trim()) && !sp.includes("\n")) {
					next.systemPromptFile = path.resolve(path.dirname(file), sp.trim());
					next.systemPrompt = undefined;
				} else {
					next.systemPrompt = sp;
					next.systemPromptFile = undefined;
				}
			}
			merged.set(id, next);
		});
	}
	const entries: InjectEntry[] = [];
	for (const p of [...merged.values()].sort((a, b) => a.index - b.index)) {
		const where = `injectId "${p.injectId}" (${p.source})`;
		if (!p.model) { warnings.push(`${where}: "model" is required`); continue; }
		const mode = (p.mode ?? "prefix") as Mode;
		if (!MODES.includes(mode)) { warnings.push(`${where}: invalid mode "${p.mode}" (replace|prefix|suffix)`); continue; }
		let text = p.systemPrompt;
		if (p.systemPromptFile) {
			try { text = fs.readFileSync(p.systemPromptFile, "utf8"); }
			catch { warnings.push(`${where}: systemPrompt file not found: ${p.systemPromptFile}`); continue; }
		}
		if (text === undefined || !text.trim()) { warnings.push(`${where}: "systemPrompt" is required and must be non-empty`); continue; }
		// Kept verbatim: ids may themselves contain "/" (gateway ids like "z-ai/glm-5.3").
		// "provider/id" vs bare id is resolved against the live catalog (see matchOriginals).
		const model = p.model.trim();
		entries.push({ injectId: p.injectId, model, mode, systemPrompt: text.trim(), source: p.source });
	}
	return { entries, warnings, files };
}
