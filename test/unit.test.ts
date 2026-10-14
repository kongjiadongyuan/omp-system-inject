import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, configFiles } from "../src/config";
import { compose, splitBase } from "../src/compose";

let root: string, user: string, proj: string;
const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "inj-"));
	user = path.join(root, "agent"); proj = path.join(root, "proj");
	process.env.PI_CODING_AGENT_DIR = user;
	fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
});

describe("layering & merge", () => {
	test("user only / project walk-up", () => {
		w(`${user}/system-inject.yml`, "injects: [{injectId: a, model: m, systemPrompt: U}]");
		w(`${proj}/.omp/system-inject.yml`, "injects: [{injectId: b, model: m, systemPrompt: P}]");
		expect(configFiles(path.join(proj, "sub"))).toEqual([`${user}/system-inject.yml`, `${proj}/.omp/system-inject.yml`]);
		expect(loadConfig(path.join(proj, "sub")).entries.map(e => e.injectId)).toEqual(["a", "b"]);
	});
	test("project overrides global field-by-field, merged by injectId", () => {
		w(`${user}/system-inject.yml`, "injects:\n  - {injectId: a, model: m1, mode: suffix, systemPrompt: U}\n  - {injectId: keep, model: m1, systemPrompt: K}");
		w(`${proj}/.omp/system-inject.yml`, "injects:\n  - {injectId: a, systemPrompt: P}");
		const r = loadConfig(proj);
		expect(r.warnings).toEqual([]);
		const a = r.entries.find(e => e.injectId === "a")!;
		expect([a.model, a.mode, a.systemPrompt]).toEqual(["m1", "suffix", "P"]);
		expect(r.entries.find(e => e.injectId === "keep")!.systemPrompt).toBe("K");
	});
	test("provider prefix ignored", () => {
		w(`${proj}/.omp/system-inject.yml`, "injects: [{injectId: a, model: openai/gpt-x, systemPrompt: P}]");
		expect(loadConfig(proj).entries[0].model).toBe("gpt-x");
	});
	test("default mode is prefix", () => {
		w(`${proj}/.omp/system-inject.yml`, "injects: [{injectId: a, model: m, systemPrompt: P}]");
		expect(loadConfig(proj).entries[0].mode).toBe("prefix");
	});
});

describe("file refs", () => {
	test("markdown path relative to the config file that declared it", () => {
		w(`${user}/prompts/u.md`, "USER FILE\n");
		w(`${user}/system-inject.yml`, "injects: [{injectId: a, model: m, systemPrompt: prompts/u.md}]");
		w(`${proj}/.omp/p.md`, "PROJ FILE");
		w(`${proj}/.omp/system-inject.yml`, "injects: [{injectId: b, model: m, systemPrompt: ./p.md}]");
		const r = loadConfig(proj);
		expect(r.entries.map(e => e.systemPrompt)).toEqual(["USER FILE", "PROJ FILE"]);
	});
	test("missing file -> warning, entry dropped", () => {
		w(`${proj}/.omp/system-inject.yml`, "injects: [{injectId: a, model: m, systemPrompt: nope.md}]");
		const r = loadConfig(proj);
		expect(r.entries).toEqual([]);
		expect(r.warnings[0]).toContain("file not found");
	});
});

describe("errors", () => {
	test("each error type produces a warning", () => {
		w(`${proj}/.omp/system-inject.yml`, `injects:
  - {model: m, systemPrompt: x}
  - {injectId: "bad id", model: m, systemPrompt: x}
  - {injectId: nomodel, systemPrompt: x}
  - {injectId: badmode, model: m, mode: wrap, systemPrompt: x}
  - {injectId: noprompt, model: m}
  - {injectId: extra, model: m, systemPrompt: x, colour: red}
  - {injectId: dup, model: m, systemPrompt: x}
  - {injectId: dup, model: m, systemPrompt: y}
`);
		const r = loadConfig(proj);
		const all = r.warnings.join("\n");
		for (const s of ['"injectId" is required', "may only contain", '"model" is required', 'invalid mode "wrap"', '"systemPrompt" is required', 'unknown key "colour"', 'duplicate injectId "dup"'])
			expect(all).toContain(s);
		expect(r.entries.map(e => e.injectId)).toEqual(["extra", "dup"]);
		expect(r.entries[1].systemPrompt).toBe("y");
	});
	test("bad YAML", () => {
		w(`${proj}/.omp/system-inject.yml`, "injects: [unclosed");
		expect(loadConfig(proj).warnings[0]).toContain("cannot parse YAML");
	});
});

describe("compose", () => {
	const block0 = "PREAMBLE\n\n§ Role\nYou are omp.\n\n# Engineering\nE\n\n§ Runtime\nTOOLS";
	test("split", () => {
		expect(splitBase(block0)).toEqual({ base: "§ Role\nYou are omp.\n\n# Engineering\nE", builtin: "PREAMBLE\n\n§ Runtime\nTOOLS" });
	});
	test("modes; built-ins untouched and last", () => {
		const base = "§ Role\nYou are omp.\n\n# Engineering\nE";
		expect(compose([block0, "CTX"], "replace", "X")).toEqual(["X", "PREAMBLE\n\n§ Runtime\nTOOLS", "CTX"]);
		expect(compose([block0, "CTX"], "prefix", "X")).toEqual([`X\n\n${base}`, "PREAMBLE\n\n§ Runtime\nTOOLS", "CTX"]);
		expect(compose([block0, "CTX"], "suffix", "X")).toEqual([`${base}\n\nX`, "PREAMBLE\n\n§ Runtime\nTOOLS", "CTX"]);
	});
	test("no persona markers (custom SYSTEM.md) -> inject placed in front of everything", () => {
		expect(compose(["CUSTOM", "CTX"], "replace", "X")).toEqual(["X", "CUSTOM", "CTX"]);
	});
});
