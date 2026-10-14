// Pure system-prompt composition.
import type { Mode } from "./config";

// omp's default template (src/prompts/system/system-prompt.md) has a "§ Role" persona
// section that ends where "§ Runtime" (built-in tool/skill/runtime docs) begins.
const ROLE = /^§ Role\s*$/m;
const RUNTIME = /^§ Runtime\s*$/m;

/** Split block 0 into the user-facing base (persona) and omp's built-in remainder. */
export function splitBase(block0: string): { base: string; builtin: string } {
	const r = ROLE.exec(block0);
	const rt = RUNTIME.exec(block0);
	if (!r || !rt || rt.index < r.index) return { base: "", builtin: block0 };
	const base = block0.slice(r.index, rt.index).trim();
	const builtin = (block0.slice(0, r.index).trim() + "\n\n" + block0.slice(rt.index).trim()).trim();
	return { base, builtin };
}

/**
 * Returns the new systemPrompt blocks:
 *   [ composed-base, ...omp built-in blocks (untouched, always last) ]
 */
export function compose(blocks: string[], mode: Mode, inject: string): string[] {
	if (blocks.length === 0) return [inject];
	const { base, builtin } = splitBase(blocks[0]);
	const parts =
		mode === "replace" ? [inject] : mode === "prefix" ? [inject, base] : [base, inject];
	const head = parts.filter(s => s.trim()).join("\n\n");
	return [head, builtin, ...blocks.slice(1)].filter(s => s.trim().length > 0);
}
