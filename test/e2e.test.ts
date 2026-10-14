// End-to-end: real omp binary + extension + mock OpenAI endpoint capturing the system prompt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXT = path.resolve(import.meta.dir, "../src/index.ts");
const OMP = process.env.OMP_BIN ?? path.join(os.homedir(), ".bun/bin/omp");
let server: ReturnType<typeof Bun.spawn>, port = 0, home: string, proj: string, capture: string;

const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const modelsYml = (port: number) => `providers:
  mock:
    baseUrl: http://127.0.0.1:${port}/v1
    api: openai-completions
    apiKey: dummy
    models:
      - {id: mock-small, name: Mock Small, reasoning: false, input: [text], cost: {input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5}, contextWindow: 32000, maxTokens: 4096}
      - {id: mock-big, name: Mock Big, reasoning: true, input: [text, image], cost: {input: 3, output: 6, cacheRead: 0.3, cacheWrite: 1}, contextWindow: 128000, maxTokens: 8192}
  blizo:
    baseUrl: http://127.0.0.1:${port}/v1
    api: openai-completions
    apiKey: dummy
    models:
      - {id: z-ai/glm-5.3, name: GLM 5.3 (gateway), reasoning: false, input: [text], cost: {input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0}, contextWindow: 64000, maxTokens: 2048}
`;
function omp(args: string[]) {
	const env = baseEnv();
	const r = Bun.spawnSync([OMP, ...(args[0] === "models" ? [...args, "-e", EXT] : ["-e", EXT, ...args])], { cwd: proj, stdin: "ignore", env: env as Record<string, string>, timeout: 60000 });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function baseEnv() {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, OMP_SYSTEM_INJECT_NO_WATCH: "1" };
	delete env.PI_CODING_AGENT_DIR;
	delete env.NODE_ENV;
	return env as Record<string, string>;
}
const settingsFile = () => `${home}/.omp/agent/config.yml`;
const readCapture = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l).body);
const sys = (b: any) => b.messages.find((m: any) => m.role === "system")?.content as string;
const lastUserText = (b: any) => JSON.stringify(b.messages.filter((m: any) => m.role === "user").at(-1)?.content ?? "");

/** Minimal JSON-lines RPC client for `omp --mode rpc`. */
async function rpc(model: string, extraEnv: Record<string, string> = {}) {
	const proc = Bun.spawn([OMP, "--mode", "rpc", "--no-session", "-e", EXT, "--model", model], { cwd: proj, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...baseEnv(), ...extraEnv } });
	const waiting = new Map<string, (v: any) => void>();
	(async () => {
		let buf = "";
		for await (const chunk of proc.stdout as any) {
			buf += new TextDecoder().decode(chunk);
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				try { const j = JSON.parse(line); if (j.type === "response" && waiting.has(j.id)) waiting.get(j.id)!(j); } catch {}
			}
		}
	})();
	let n = 0;
	const send = (cmd: object, timeout = 30000) => new Promise<any>((resolve, reject) => {
		const id = `r${++n}`;
		waiting.set(id, resolve);
		setTimeout(() => reject(new Error(`rpc timeout ${JSON.stringify(cmd)}`)), timeout);
		proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n"); proc.stdin.flush();
	});
	const models = async () => ((await send({ type: "get_available_models" })).data.models as any[]).map(m => `${m.provider}/${m.id}`).sort();
	return { send, models, close: () => proc.kill() };
}

function ask(model: string) {
	fs.writeFileSync(capture, "");
	const r = omp(["-p", "--no-session", "--model", model, "hello"]);
	const lines = fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l).body);
	const main = lines.find(b => b.messages?.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("hello")));
	return { ...r, body: main, system: main?.messages?.find((m: any) => m.role === "system")?.content as string };
}
const characters = () => JSON.parse(omp(["models", "character", "--json"]).out || '{"models":[]}').models as any[];

beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-e2e-"));
	proj = path.join(home, "work", "proj");
	fs.mkdirSync(proj, { recursive: true });
	capture = path.join(home, "capture.jsonl");
	port = 20000 + Math.floor(Math.random() * 20000);
	server = Bun.spawn(["bun", path.join(import.meta.dir, "mock-server.ts")], { env: { ...process.env, MOCK_PORT: String(port), MOCK_CAPTURE: capture }, stdout: "ignore", stderr: "inherit" });
	for (let i = 0; i < 100; i++) {
		try { await fetch(`http://127.0.0.1:${port}/v1/models`); break; } catch { await Bun.sleep(100); }
	}
	w(`${home}/.omp/agent/models.yml`, modelsYml(port));
	w(`${home}/.omp/agent/prompts/alice.md`, "I am ALICE (from global md).");
	w(`${home}/.omp/agent/system-inject.yml`, `injects:
  - {injectId: alice, model: mock-small, mode: replace, systemPrompt: prompts/alice.md}
  - {injectId: bob,   model: mock-small, mode: prefix, systemPrompt: "BOB-GLOBAL"}
  - {injectId: carol, model: mock-big,   mode: suffix, systemPrompt: "CAROL"}
  - {injectId: ghost, model: no-such-model, systemPrompt: "x"}
  - {injectId: glm53, model: z-ai/glm-5.3, mode: prefix, systemPrompt: "GLM-PERSONA"}
`);
	w(`${proj}/.omp/system-inject.yml`, `injects:
  - {injectId: bob, systemPrompt: "BOB-PROJECT"}
  - {injectId: dave, model: mock/mock-big, mode: replace, systemPrompt: ./dave.md}
  - {injectId: broken, model: mock-small, mode: sideways, systemPrompt: x}
`);
	w(`${proj}/.omp/dave.md`, "I am DAVE (project-relative md).");
}, 30000);
afterAll(() => server?.kill());

describe("e2e", () => {
	test("character group: one model per entry, originals untouched, params inherited, missing model skipped", () => {
		const ms = characters();
		expect(ms.map(m => m.id).sort()).toEqual(["alice--mock-small", "bob--mock-small", "carol--mock-big", "dave--mock-big", "glm53--z-ai/glm-5.3"]);
		const byId = Object.fromEntries(ms.map(m => [m.id, m]));
		expect(byId["alice--mock-small"].name).toBe("[alice] Mock Small");
		const orig = JSON.parse(omp(["models", "mock", "--json"]).out).models;
		expect(orig.length).toBe(2);
		const big = orig.find((m: any) => m.id === "mock-big");
		for (const k of ["contextWindow", "maxTokens", "reasoning", "thinking", "input", "cost"]) expect(byId["carol--mock-big"][k]).toEqual(big[k]);
	}, 30000);

	test("baseline (original model) prompt unchanged", () => {
		const r = ask("mock/mock-small");
		expect(r.system).toContain("You are omp's trusted coding assistant.");
		expect(r.system).not.toContain("BOB");
	}, 60000);

	test("replace (file ref, global): persona gone, built-ins remain after", () => {
		const r = ask("character/alice--mock-small");
		expect(r.body.model).toBe("mock-small"); // routed to the original model
		expect(r.system.startsWith("I am ALICE (from global md).\n\n")).toBe(true);
		expect(r.system).not.toContain("You are omp's trusted coding assistant.");
		expect(r.system).toContain("§ Runtime");
		expect(r.system.indexOf("§ Runtime")).toBeGreaterThan(r.system.indexOf("ALICE"));
	}, 60000);

	test("prefix (project overrides global prompt for same injectId)", () => {
		const r = ask("character/bob--mock-small");
		expect(r.system.startsWith("BOB-PROJECT\n\n§ Role\nYou are omp's trusted coding assistant.")).toBe(true);
		expect(r.system).not.toContain("BOB-GLOBAL");
	}, 60000);

	test("suffix: after persona, before built-ins", () => {
		const r = ask("character/carol--mock-big");
		const i = r.system.indexOf("CAROL");
		expect(r.body.model).toBe("mock-big");
		expect(i).toBeGreaterThan(r.system.indexOf("You are omp's trusted"));
		expect(i).toBeLessThan(r.system.indexOf("§ Runtime"));
		expect(r.system).toContain("\n\nCAROL\n\n");
	}, 60000);

	test("project-only entry with project-relative md + provider prefix ignored", () => {
		const r = ask("character/dave--mock-big");
		expect(r.system.startsWith("I am DAVE (project-relative md).")).toBe(true);
	}, 60000);

	test("startup warnings for config errors and missing model", () => {
		const r = ask("character/alice--mock-small");
		const all = r.out + r.err;
		expect(all).toContain('[system-inject] injectId "ghost": model "no-such-model" is not available');
		expect(all).toContain('invalid mode "sideways"');
	}, 60000);

	// ---- (b) availability follows omp's own enable/disable mechanisms ----
	test("disabledProviders hides derived character models", () => {
		fs.writeFileSync(settingsFile(), "disabledProviders: [mock, blizo]\n");
		try { expect(characters()).toEqual([]); } finally { fs.rmSync(settingsFile()); }
	}, 30000);

	test("enabledModels: character model only if its original is enabled (+ character/* to show)", () => {
		fs.writeFileSync(settingsFile(), 'enabledModels: [mock/mock-big, "character/*"]\n');
		try {
			expect(characters().map(m => m.id).sort()).toEqual(["carol--mock-big", "dave--mock-big"]);
		} finally { fs.rmSync(settingsFile()); }
	}, 30000);

	test("enabledModels without character/* -> warning that the group is hidden", () => {
		fs.writeFileSync(settingsFile(), "enabledModels: [mock/mock-big]\n");
		try {
			const r = ask("mock/mock-big");
			expect(r.out + r.err).toContain('add "character/**" to enabledModels');
		} finally { fs.rmSync(settingsFile()); }
	}, 60000);

	test("regression: character/* + enabled original -> NO hidden-group warning (startup)", () => {
		fs.writeFileSync(settingsFile(), 'enabledModels: [mock/mock-big, "character/*"]\n');
		try {
			const r = ask("mock/mock-big");
			expect(r.code).toBe(0);
			expect(r.out + r.err).not.toContain("matches no character model");
		} finally { fs.rmSync(settingsFile()); }
	}, 60000);

	test("regression: character/* also silent when starting ON a character model", () => {
		fs.writeFileSync(settingsFile(), 'enabledModels: [mock/mock-big, "character/*"]\n');
		try {
			const r = ask("character/carol--mock-big");
			expect(r.system.includes("CAROL")).toBe(true);
			expect(r.out + r.err).not.toContain("matches no character model");
		} finally { fs.rmSync(settingsFile()); }
	}, 60000);

	test("slash-containing original id: character model listed, selectable, injected on the wire", () => {
		const m = characters().find(x => x.id === "glm53--z-ai/glm-5.3");
		expect(m?.name).toBe("[glm53] GLM 5.3 (gateway)");
		expect(m?.contextWindow).toBe(64000);
		const r = ask("character/glm53--z-ai/glm-5.3");
		expect(r.code).toBe(0);
		expect(r.body.model).toBe("z-ai/glm-5.3");
		expect(r.system.startsWith("GLM-PERSONA\n\n§ Role")).toBe(true);
	}, 60000);

	test("slash id + enabledModels (exact original selector, character/**): no warning, visible", () => {
		fs.writeFileSync(settingsFile(), 'enabledModels: ["blizo/z-ai/glm-5.3", "character/**"]\n');
		try {
			expect(characters().map(x => x.id)).toEqual(["glm53--z-ai/glm-5.3"]);
			const r = ask("character/glm53--z-ai/glm-5.3");
			expect(r.system.startsWith("GLM-PERSONA")).toBe(true);
			expect(r.out + r.err).not.toContain("matches no character model");
		} finally { fs.rmSync(settingsFile()); }
	}, 60000);

	test("slash id + character/* (single star): targeted hint to use character/**", async () => {
		fs.writeFileSync(settingsFile(), 'enabledModels: [mock/mock-big, "blizo/z-ai/glm-5.3", "character/*"]\n');
		try {
			const r = ask("mock/mock-big");
			expect(r.out + r.err).toContain('"character/*" does not match ids containing "/" (character/glm53--z-ai/glm-5.3); use "character/**"');
			// Registered (original is enabled) but omp's picker scope hides the slash id under "*".
			const c = await rpc("mock/mock-big");
			try {
				expect((await c.models()).filter(m => m.startsWith("character/"))).toEqual(["character/carol--mock-big", "character/dave--mock-big"]);
			} finally { c.close(); }
		} finally { fs.rmSync(settingsFile()); }
	}, 60000);

	test("live: settings edits while running add/remove character models", async () => {
		const c = await rpc("mock/mock-big");
		try {
			expect(await c.models()).toContain("character/alice--mock-small");
			fs.writeFileSync(settingsFile(), 'enabledModels: [mock/mock-big, "character/*"]\n');
			await Bun.sleep(2500);
			let ms = await c.models();
			expect(ms).toContain("character/carol--mock-big");
			expect(ms).not.toContain("character/alice--mock-small");
			fs.writeFileSync(settingsFile(), "disabledProviders: [mock, blizo]\n");
			await Bun.sleep(2500);
			ms = await c.models();
			expect(ms.filter(m => m.startsWith("character/"))).toEqual([]);
			fs.rmSync(settingsFile());
			await Bun.sleep(2500);
			expect(await c.models()).toContain("character/alice--mock-small");
		} finally { c.close(); if (fs.existsSync(settingsFile())) fs.rmSync(settingsFile()); }
	}, 60000);

	// ---- (c) every call path through a character model is injected ----
	test("compaction / summarization requests carry the injection", async () => {
		fs.writeFileSync(settingsFile(), "compaction:\n  keepRecentTokens: 1\n");
		fs.writeFileSync(capture, "");
		const c = await rpc("character/bob--mock-small");
		try {
			for (const m of ["one", "two", "three"]) {
				const r = await c.send({ type: "prompt", message: `hello ${m}` });
				expect(r.error ?? "").toBe("");
				await Bun.sleep(1500); // let the turn finish before the next prompt
			}
			await Bun.sleep(1500);
			const res = await c.send({ type: "compact" }, 45000);
			expect(res.success).toBe(true);
		} finally { c.close(); fs.rmSync(settingsFile()); }
		const summaries = readCapture().filter(b => sys(b)?.includes("Summarize"));
		expect(summaries.length).toBeGreaterThan(0);
		for (const b of summaries) expect(sys(b).startsWith("BOB-PROJECT\n\n")).toBe(true);
	}, 90000);

	test("subagent spawned by a character-model session is injected", () => {
		fs.writeFileSync(capture, "");
		const r = omp(["-p", "--no-session", "--model", "character/alice--mock-small", "SPAWN_SUBAGENT now"]);
		expect(r.code).toBe(0);
		const sub = readCapture().filter(b => lastUserText(b).includes("SUBTASK_PLEASE_REPLY"));
		expect(sub.length).toBeGreaterThan(0);
		for (const b of sub) expect(sys(b).startsWith("I am ALICE (from global md).")).toBe(true);
	}, 90000);

	test("hot reload: editing system-inject.yml while running updates prompt and group", async () => {
		const file = `${proj}/.omp/system-inject.yml`;
		const orig = fs.readFileSync(file, "utf8");
		const c = await rpc("character/bob--mock-small", { OMP_SYSTEM_INJECT_NO_WATCH: "" });
		try {
			fs.writeFileSync(file, orig.replace("BOB-PROJECT", "BOB-RELOADED") + "  - {injectId: erin, model: mock-small, systemPrompt: ERIN}\n");
			await Bun.sleep(1500);
			expect(await c.models()).toContain("character/erin--mock-small");
			fs.writeFileSync(capture, "");
			await c.send({ type: "prompt", message: "after reload" });
			await Bun.sleep(500);
			const b = readCapture().find(x => lastUserText(x).includes("after reload"));
			expect(sys(b).startsWith("BOB-RELOADED\n\n")).toBe(true);
		} finally { c.close(); fs.writeFileSync(file, orig); }
	}, 60000);
});
