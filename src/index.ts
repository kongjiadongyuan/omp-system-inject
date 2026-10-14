// omp extension: adds a "character" model group whose models inject system prompts.
import * as fs from "node:fs";
import { discoverAuthStorage, ModelRegistry, settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { filterAvailableModelsByEnabledPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDisabledProviders, cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { createAssistantMessageEventStream, streamSimple, type Api, type Context, type Model } from "@oh-my-pi/pi-ai";
import { loadConfig, type InjectEntry } from "./config";
import { compose } from "./compose";

export const PROVIDER = "character";
const API = "character-inject" as Api;
const SEP = "--"; // character model id = <injectId>--<original id>

interface Target { entry: InjectEntry; original: Model<Api> }
type Reg = ExtensionContext["modelRegistry"];

/** Originals the user can actually pick: credentialed, provider not in disabledProviders, inside enabledModels scope. */
export function selectableOriginals(reg: Reg): Model<Api>[] {
	const available = reg.getAvailable().filter(m => m.provider !== PROVIDER);
	const patterns = cfgEnabledModels.get(settings) ?? [];
	const disabled = new Set(cfgDisabledProviders.get(settings) ?? []);
	const enabled = available.filter(m => !disabled.has(m.provider));
	return patterns.length ? filterAvailableModelsByEnabledPatterns(enabled, patterns, settings) : enabled;
}

export default async function systemInject(pi: ExtensionAPI) {
	let targets = new Map<string, Target>();
	let registry: Reg | undefined;
	let signature = "";
	let watchers: fs.FSWatcher[] = [];
	let lastCtx: ExtensionContext | undefined;

	const warn = (ctx: ExtensionContext | undefined, msg: string) => {
		if (ctx?.hasUI) ctx.ui.notify(msg, "warning");
		else process.stderr.write(`${msg}\n`);
	};

	function sync(cwd: string, reg: Reg) {
		registry = reg;
		const { entries, warnings, files } = loadConfig(cwd);
		const selectable = selectableOriginals(reg);
		const next = new Map<string, Target>();
		for (const entry of entries) {
			const matches = selectable.filter(m => m.id === entry.model);
			if (matches.length === 0) {
				warnings.push(`injectId "${entry.injectId}": model "${entry.model}" is not available/enabled in omp; skipped`);
				continue;
			}
			for (const original of matches) {
				const id = matches.length > 1 ? `${entry.injectId}${SEP}${original.provider}${SEP}${original.id}` : `${entry.injectId}${SEP}${original.id}`;
				next.set(id, { entry, original });
			}
		}
		targets = next;
		const models = [...next.entries()].map(([id, { entry, original }]) => {
			const dup = [...next.values()].filter(t => t.entry === entry).length > 1;
			const { provider: _p, api: _a, baseUrl: _b, id: _i, name: _n, ...inherited } = original as any;
			return { ...inherited, id, name: `[${entry.injectId}] ${original.name}${dup ? ` (${original.provider})` : ""}`, api: API };
		});
		const sig = JSON.stringify(models);
		let changed = false;
		if (sig !== signature) {
			signature = sig;
			changed = true;
			pi.unregisterProvider(PROVIDER);
			if (models.length > 0) {
				pi.registerProvider(PROVIDER, {
					baseUrl: "character://inject",
					apiKey: "character-inject-noauth",
					api: API,
					models: models as any,
					streamSimple: characterStream,
				});
			}
		}
		const patterns = cfgEnabledModels.get(settings) ?? [];
		if (patterns.length && models.length) {
			const visible = filterAvailableModelsByEnabledPatterns(reg.getAvailable().filter(m => m.provider === PROVIDER), patterns, settings);
			if (visible.length === 0) warnings.push(`enabledModels is set but matches no character model; add "${PROVIDER}/*" to enabledModels to show them`);
		}
		return { files, warnings, changed };
	}

	// Every call that targets a character model (main turns, compaction/summaries, subagents,
	// title generation, …) funnels through this stream function, so injection happens here.
	function characterStream(model: Model<Api>, context: Context, options?: any) {
		const out = createAssistantMessageEventStream();
		(async () => {
			try {
				const t = targets.get(model.id);
				if (!t) throw new Error(`character model ${model.id} is not enabled (original model unavailable/disabled or entry removed)`);
				const injected: Context = { ...context, systemPrompt: compose(context.systemPrompt ?? [], t.entry.mode, t.entry.systemPrompt) };
				const opts = { ...(options ?? {}) };
				opts.apiKey = await registry!.getApiKey(t.original);
				const inner = streamSimple(t.original, injected, opts);
				for await (const ev of inner) out.push(ev as any);
				out.end(await inner.result());
			} catch (err) {
				const msg = { role: "assistant", content: [], api: API, provider: PROVIDER, model: model.id, stopReason: "error", errorMessage: String(err), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
				out.push({ type: "error", reason: "error", error: msg } as any);
				out.end(msg as any);
			}
		})();
		return out;
	}

	function resync(ctx: ExtensionContext | undefined, announce: boolean) {
		const c = ctx ?? lastCtx;
		if (!c) return;
		const { files, warnings, changed } = sync(c.cwd, c.modelRegistry);
		if (announce) for (const w of warnings) warn(c, `[system-inject] ${w}`);
		if (changed && c.hasUI && announce) c.ui.notify(`[system-inject] ${targets.size} character models`, "info");
		watch(files);
		return changed;
	}

	function watch(files: string[]) {
		for (const w of watchers) w.close();
		watchers = [];
		if (process.env.OMP_SYSTEM_INJECT_NO_WATCH) return;
		const dirs = new Set(files.map(f => f.replace(/\/[^/]+$/, "")));
		for (const f of files) {
			try {
				let timer: ReturnType<typeof setTimeout> | undefined;
				watchers.push(fs.watch(f, () => { clearTimeout(timer); timer = setTimeout(() => resync(undefined, true), 150); }));
			} catch {}
		}
		void dirs;
	}

	// 1) Load time: omp resolves --model / default model BEFORE session_start, so the group must exist now.
	let startupWarnings: string[] = [];
	try {
		const snapshot = new ModelRegistry(await discoverAuthStorage());
		await snapshot.refresh("offline");
		startupWarnings = sync(process.cwd(), snapshot as unknown as Reg).warnings;
	} catch (e) {
		startupWarnings = [`failed to read model catalog at load: ${(e as Error).message}`];
	}
	// 2) Follow omp settings changes (disabledProviders / enabledModels) live.
	// (Guarded: `omp plugin install` validates extensions without initialized Settings.)
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = (settings as any).onEffectiveChange?.([cfgEnabledModels, cfgDisabledProviders], () => resync(undefined, true));
	} catch {}

	pi.on("session_start", async (_e, ctx) => {
		lastCtx = ctx;
		const { files, warnings } = sync(ctx.cwd, ctx.modelRegistry);
		// Subagent sessions rebind this extension; only the main session reports config warnings.
		if ((ctx as any).agent?.kind !== "sub") for (const w of new Set([...startupWarnings, ...warnings])) warn(ctx, `[system-inject] ${w}`);
		startupWarnings = [];
		watch(files);
	});
	// Cheap re-check (signature compare) before each turn: catches login/logout and other registry changes.
	pi.on("before_agent_start", async (_e, ctx) => { lastCtx = ctx; resync(ctx, false); return undefined; });
	pi.on("session_shutdown", async () => { for (const w of watchers) w.close(); watchers = []; unsubscribe?.(); });

	pi.registerCommand("inject-reload", {
		description: "Reload system-inject.yml and rebuild the character model group",
		handler: async (_args, ctx) => { resync(ctx as ExtensionContext, true); ctx.ui.notify(`[system-inject] ${targets.size} character models`, "info"); },
	});
}
