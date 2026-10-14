# omp-system-inject

oh-my-pi (omp 18.10.4) extension: adds a `character` model group; each model `[injectId] <name>`
(id `<injectId>--<origId>`, selector `character/<injectId>--<origId>`) inherits the original model
and injects a system prompt (replace / prefix / suffix) into omp's persona section. omp's built-in
content (preamble, § Runtime tools/skills/rules, eval preludes, <project-context>/AGENTS.md) is never
edited and always follows the injected head.

- Install: `omp plugin install github:<user>/omp-system-inject` (or `https://github.com/<user>/omp-system-inject`;
  `--scope project` for per-project). Dev: `omp plugin link /path/to/omp-system-inject` or `omp -e src/index.ts`.
  Update: `omp plugin upgrade`; remove: `omp plugin uninstall omp-system-inject`.
- Config: see `examples/system-inject.yml`
- Tests: `bun test` (unit + e2e against a real omp and the mock OpenAI endpoint in `test/mock-server.ts`)
- Sandbox: `./dev-sandbox.sh` (interactive) / `./dev-sandbox.sh -p --model character/alice--mock-small hi`;
  captured requests in `.sandbox/capture.jsonl`
- Reload: auto on config file change (fs.watch), or `/inject-reload`

## Availability (follows omp)
A character model exists only while its original is selectable: credentialed, provider not in
`disabledProviders`, and (if set) matched by `enabledModels`. Changes are followed live
(settings change listener + re-check before each turn + config file watch).
Note: with an `enabledModels` allow-list, omp's picker only shows listed models, so add
`"character/*"` to it (a startup warning says so).

## Injection scope
Injection happens inside the `character` provider's stream function, so EVERY request made with a
character model is injected: main turns, compaction/summaries, subagents that inherit the model,
session-title generation, etc.

## Sandbox first run
`dev-sandbox.sh` seeds `.sandbox/.omp/agent/config.yml` from `examples/sandbox-config.yml`
(`setupVersion: 2`, `startup.setupWizard: false`, `modelRoles.default: mock/mock-small`), so omp skips
the first-run provider setup and opens straight at the prompt on the mock model. `rm -rf .sandbox` to reset.
