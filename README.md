# dsh-plugins

Monorepo for custom [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugins.

Every plugin here is an ordinary Cordis **bundle**: a package whose `dsh.bundle.patch` points at a
`cordis.patch.yml` that inserts a stable row id, plus a `dsh.client` half when it renders in the Web GUI.
A DSH profile installs it from a `file:` path, exactly like the single-repo plugins this monorepo
replaces. Nothing here is published to npm.

## Layout

```
dsh-plugins/
├── package.json                  # private root; pnpm scripts fan out with `-r`
├── pnpm-workspace.yaml           # packages/*
├── README.md                     # this file
└── packages/
    └── dsh-session-retention/    # first package: age-based chat Session retention
```

Each package keeps its own toolchain and build outputs, so a package can be read on its own:

| Path | Owns |
| --- | --- |
| `package.json` | name, version, `exports`, `files`, `dsh.bundle` / `dsh.client`, peer/dev deps |
| `cordis.patch.yml` | the single `insert` row the Loader materializes |
| `locale/en.json` | `meta.title` / `meta.description` shown by the Plugins panel |
| `tsconfig.json` / `tsconfig.client.json` | Host program and Client declarations |
| `tsdown.config.ts` | the hand-rolled Client bundle (`lib/client.js`, `__ModuleLoader__.load`) |
| `src/` | Host half (`index.ts`, `schema.ts`, …) and `src/client/` browser half |
| `.gitignore` | an ANCHORED `/lib/` — never site-wide |

`@deepseek-ai/*` and `tsdown` resolve through `link:` into a sibling `deepseek-harness` checkout, so the
types always match the harness the plugin is installed into. The depth assumes this layout:

```
<workspaces>/k/dsh/dsh-plugins/packages/<pkg>   ->   ../../../deepseek-harness
```

## Build

```sh
cd workspaces/k/dsh/deepseek-harness && pnpm install && pnpm run build   # once: plugins link into it
cd workspaces/k/dsh/dsh-plugins && pnpm install && pnpm run check && pnpm run build
```

`pnpm run check` type-checks every package; `pnpm run build` emits `lib/index.js` and `lib/client.js`.

## Install into a profile

Build FIRST, then install: a `file:` install hardlinks the files that exist at install time, so a
`lib/client.js` produced afterwards never reaches the profile and the browser half silently never mounts
(`resources/workspaces/k/dsh/_lessons/261011-file-install-drops-rebuilt-client-bundle.md`).

```sh
dsh plugin --profile web add file:<abs path>/dsh-plugins/packages/dsh-session-retention
dsh --profile web --dump-config | grep -A 8 'dsh-session-retention'
```

Verify both `dependencies` and `dsh.profile.bundles` grew in `$DSH_HOME/profiles/web/package.json`, then
restart the host.

## Add a plugin

1. Copy an existing package directory to `packages/<new-name>` and rename it everywhere: `package.json`
   `name`, the `PLUGIN_ID` in `tsdown.config.ts`, the row id and `name` in `cordis.patch.yml`, and the
   `locale/en.json` meta.
2. Keep the packaging triple intact — `tsc` for the Host program, `tsc` for the Client declarations, and the
   hand-rolled `tsdown` bundle for the browser half. The bundle must keep the `__ModuleLoader__.load`
   banner, the platform externals, and the `process.env.NODE_ENV` define; without the define an inlined
   dependency throws `ReferenceError: process is not defined` and the whole client half fails to activate.
3. Keep the package's `.gitignore` anchored (`/lib/`). An unanchored `lib/` also excludes a source
   directory of that name, and the working tree hides the loss until a fresh clone cannot build.
4. Register the plugin on the host: a bullet in `resources/workspaces/k/dsh/OVERVIEW.md` and a row in
   `resources/workspaces/k/dsh/_documentations/260911-dsh-core-change-and-plugin-index.md` § 2.
5. Build, install into your own profile, and verify at the level the change deserves. A browser-facing page
   is not verified by a green type-check.

## Design rules

- **A plugin depends on the harness through `link:`, never through a published version.** Types then track
  the running baseline.
- **No test files unless the Human asked for them.** Verification is a build, a type-check, a boot, and a
  probe — not a new suite.
- **Secrets never enter this repository.** Every repo in this domain is public.
