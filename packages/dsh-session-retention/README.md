# dsh-session-retention

Deletes chat Sessions that have had no activity for N days (default 30), from a page in the Plugins
settings panel.

DeepSeek Harness has **no Session delete**: the persistence service exposes
`create`/`open`/`flush`/`stat`/`list`, the controller has no delete RPC, and the client's Session menu offers
pin, rename, fork, id and archive. `archive` hides a row and blocks model steps but touches no file. This
plugin therefore owns the filesystem work, and with it the safety perimeter.

## Policy

| Field | Default | Meaning |
| --- | --- | --- |
| `autoSweep` | `true` | run the policy on a timer while the Host is up |
| `retentionDays` | `30` | a Session with no durable activity for this long becomes a candidate (1–3650) |
| `sweepIntervalHours` | `24` | minimum gap between two automatic sweeps (1–168) |
| `dryRun` | `true` | an automatic sweep only REPORTS; the page's Delete now always works |
| `trashGraceDays` | `7` | how long a moved Session stays restorable (0 = purge on the next tick) |
| `maxMovesPerRun` | `500` | upper bound on moves per run, oldest first (1–5000) |

All six fields are **volatile**, so the page writes them through the settings service and the running tick
picks a save up without a restart. They are stated again in `cordis.patch.yml` so `--dump-config` shows the
policy a profile actually runs.

Age is `max(header.createdAt, mtime of the materialized artifact at location.path)` — the two durable signals
that exist. `lastPromptAt` is deliberately not used: it advances only on a human prompt, so a Session the
agent kept working on would look idle. `revision` is an opaque token by contract and is never parsed for a
timestamp.

## Deletion is two stages; only the second is irreversible

1. **Move.** The whole Session directory is `rename(2)`d into
   `$DSH_HOME/cache/session-trash/<projectKey>/<sessionId>/`. The rename is atomic on one filesystem, so the
   Session leaves every list at once while staying restorable for the grace window. That path sits under the
   config home's already-ignored `cache/`, so raw transcripts can never be committed to the public home
   repository.
2. **Purge.** Directories older than `trashGraceDays` are removed. This is the only unlink path in the
   plugin, and the purge is not gated by `dryRun`: the move into trash was already the operator's approved
   step, and the grace window is its own gate.

**Restore** is the documented reverse rename, inside the grace window, with both directories on the same
filesystem:

```sh
mv "$DSH_HOME/cache/session-trash/<projectKey>/<sessionId>" "$DSH_HOME/sessions/<projectKey>/<sessionId>"
```

There is no Restore button in 0.1.0.

## Safety model

Applied in this order; anything that trips a guard is skipped **with a counted reason** in the run report:

1. A snapshot without a materialized `location` is never a candidate — there is no directory to move.
2. A Session this process holds an Agent or Session object for is `live`; a pinned Session is `pinned`; a
   Session whose `workspace/session-activity` answer is non-empty is `active`.
3. A subagent child moves only when its `header.parentSession` is itself in the candidate set, so a retained
   parent never keeps references to a moved child (`agentChild` otherwise).
4. Every move re-stats the artifact (a Session resumed since the scan becomes `active`), re-confines the
   directory to exactly `<sessionsRoot>/<projectKey>/<sessionId>`, and claims single-writer ownership with
   `open(id, 'write')` before the rename (`owned` when another holder has it, `exdev` for a cross-device
   rename, `legacyError` when the migration a legacy generation needs fails).
5. The write handle is closed in `finally` on every branch — a leaked handle wedges the id in-process behind
   a lock and leaks a kernel descriptor.
6. Trash directories are created `0700` and checked: the root and its ancestors must be owned by the current
   user and not writable by group or others (a sticky writable ancestor is admitted). A root that fails the
   check refuses both the move and the purge.

The page binds a delete to the review it showed: `Preview cleanup` freezes a scan into a single-use
`previewId` plus a fingerprint over `(retentionDays, sorted ids)` with a 10-minute TTL; `Delete now` presents
that id, and the Host answers `409 PREVIEW_STALE` when the recomputed set differs, `400 PREVIEW_EXPIRED` when
the token is gone or used. So `moved` is always a subset of `reviewed`, and an unchanged config can never
silently widen what is deleted.

Bytes are reported per stage, never conflated: `movedBytes` left the sessions root but still occupies the
trash; `purgedBytes` is what the purge actually reclaimed.

## Known limitations

- **Re-carried state is inert, not repaired.** `workspace.json` `tables.workspaces[*].sessionIds`,
  `session_projcache` rows and `dsh-session-workspaces` labels keep the id of a deleted Session: no service
  exposes detach or prune, and hand-editing those stores races the registry's in-memory state. The archive
  set IS repaired, through the public `unarchiveSession`. Labels are inert because the sidebar renders from
  the Session list, so a label with no Session draws no row.
- **Cross-instance and cross-tab safety is not enforceable from the filesystem.** Another Host instance may
  hold a Session between the ownership probe and the rename, and a browser tab in another instance keeps its
  in-memory copy until its next persistence read.
- **The grace window lives under `cache/`.** A tool that clears `$DSH_HOME/cache` drops restorable trash
  early; the page's trash size makes that visible.
- **`EXDEV` is a skip, never an abort.** A `sessions/` directory that is a symlink or a mount boundary makes
  every move report `exdev`; the run continues and deletes nothing.

## Page

The bundle patch inserts row `dsh-session-retention`, and the browser half registers `plugins.row.config`
under `dsh-session-retention#dsh-session-retention`, which gives that row a **Configure** control whose page
is headed by `locale/en.json`'s `meta.title` / `meta.description`. The page renders the six fields on the
Host-supplied form (`form.state` + `form.mutate`, one atomic write fenced by the revision it read), the last
run's numbers, and the three controls: Preview cleanup, Delete now (two clicks: the first states what it will
do), and Empty trash now (also two clicks).

## Build

```sh
pnpm install && pnpm run check && pnpm run build
```

`lib/index.js` is the Host half; `lib/client.js` carries the `__ModuleLoader__.load` wrapper the shell's
module loader requires.
