[中文](README.zh-CN.md)

# dsh-handoff-relay

A dependency-free plugin that watches one or more directories and sends exactly
one notification to each directory's target session when a file in it is
considered finished.

Each entry in `watches` starts its own `fs.watch` and keeps its own
`(size, mtimeMs)` snapshot and marker state, so targets never interfere with
one another.

The name **relay** reflects what the plugin actually does: point-to-point
forwarding of a ready signal to a target session. It deliberately avoids any
wording that suggests builds or commands — a `trigger`-style name would imply
the plugin can start actions, which it cannot.

## What "finished" means

- **Quiet period**: a file that has stopped changing for `stableMs`
  milliseconds (default `5000`) counts as finished. While the file keeps
  being written to, its timer restarts and nothing is sent.
- **Completion rule (per watch)**: each watch may define a `done` rule. When the
  rule matches the last 4 KB of the file, the file is delivered immediately,
  without waiting for the quiet period. If it does not match, the file is still
  delivered once `stableMs` elapses — a `done` hit only accelerates delivery; it
  is never required.

`done` has four states, distinguished by the key/value alone:

| `done` value | Behaviour |
|---|---|
| omitted | default text rule `{ text: '<!-- DONE -->' }` |
| `{ text: '...' }` | deliver early when the text appears in the last 4 KB |
| `{ regex: '...' }` | deliver early when the pattern matches the last 4 KB |
| `null` | completion rule off; deliver only after `stableMs` |

Regex rules are compiled with the `m` flag and only ever see the last 4 KB.
Patterns are capped at 200 characters, and patterns with nested quantifiers
(such as `(a+)+`) are rejected. A pattern that is too long, uses nested
quantifiers, or fails to compile disables the rule **for that watch only** — a
warning naming the watch's `dir` is logged, that watch then delivers on
`stableMs` alone, and other watches are unaffected.

The stability check is exact: on every filesystem event the plugin records
`(size, mtimeMs)` and resets a `stableMs` silence timer. When the timer fires
it stats the file once more and delivers only if **both** values are unchanged.
If either changed, it restarts the timer — no delivery, no queue.

Each file is delivered at most once for the same content snapshot; repeated
filesystem events do not produce duplicate notifications.

## Who gets notified

The session whose id is given by `targetSessionId` receives one user message
containing the file name and the reason (`stable` or `DONE`). If that session
is not loaded, a warning is written and nothing is sent.

## Install

`dsh-handoff-relay` is a plugin bundle for a DSH profile (the host that loads
cordis-based bundles). It has no runtime dependencies, so installing it is just
linking a local directory into a profile.

1. Put this repository in a local directory, for example
   `/srv/dsh-handoff-relay` on macOS/Linux or `C:/plugins/dsh-handoff-relay`
   on Windows (clone it, or copy the checkout there).
2. In the profile directory, add a `file:` dependency pointing at that
   directory in `package.json`, and register the package name in
   `dsh.profile.bundles`. Keep the other entries already present in both
   lists — only add these two:

   ```json
   {
     "dependencies": {
       "dsh-handoff-relay": "file:/srv/dsh-handoff-relay"
     },
     "dsh": {
       "profile": {
         "bundles": ["dsh-handoff-relay"]
       }
     }
   }
   ```

   The `file:` value must be an absolute path to the directory containing this
   package's `package.json`. Use forward slashes on every platform: on Windows
   that means a drive-letter path such as `file:C:/plugins/dsh-handoff-relay`;
   on macOS/Linux a POSIX path such as `file:/srv/dsh-handoff-relay`.
3. Run `pnpm install` in the profile directory (or the equivalent install
   command of your package manager) so the local package is linked into the
   profile's `node_modules`. Re-run it after changing the package's source.
4. Add a row with the same `id` to the profile's `cordis.patch.yml` and set the
   config there. The bundle ships its own patch layer (`dsh.bundle.patch` in
   `package.json`) that inserts the plugin row; the profile patch layer
   overrides that row's config by matching its `id`:

   ```yaml
   - id: dsh-handoff-relay
     name: dsh-handoff-relay
     config:
       watches:
         - dir: '/absolute/path/to/first-outbox'
           targetSessionId: 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
           done: { text: '<!-- DONE -->' }
         - dir: '/absolute/path/to/second-outbox'
           targetSessionId: 'session-yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy'
           done: { regex: '^## 章末' }
         - dir: '/absolute/path/to/third-outbox'
           targetSessionId: 'session-zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'
           done: null
       stableMs: 5000
   ```

5. Restart the host so the new bundle and its config are loaded.

### Config fields

- `watches` — a non-empty array of watch entries; each entry needs `dir` and
  `targetSessionId`. Each `dir` must be an existing absolute directory. An
  entry missing either field, or whose directory cannot be read, is skipped
  with a warning naming the entry; the remaining watches still start. The
  plugin only reacts to filesystem events; it never polls.
- `stableMs` — silence window in milliseconds, shared by all watches (default
  `5000`). A file counts as finished once `(size, mtimeMs)` has been unchanged
  for this long. Per-entry overrides are not supported.
- `watches[].done` — per-watch completion rule, one of four states:
  - omitted → default text rule `{ text: '<!-- DONE -->' }`;
  - `{ text: '...' }` → text match in the last 4 KB;
  - `{ regex: '...' }` → regex match in the last 4 KB (`m` flag, ≤ 200 chars,
    nested quantifiers rejected; an invalid pattern disables the rule for this
    watch only and logs a warning);
  - `null` → completion rule off, deliver only after `stableMs`.

  `done` is the only completion setting.

At load time each watch's `targetSessionId` is validated: if a session title can
be resolved, the watch starts normally; otherwise a warning naming that watch's
`dir` is logged and the watch still starts, so the remaining watches keep
working.

**`targetSessionId` must point to a session that currently exists. Session ids
change when the host restarts, so re-wire `targetSessionId` after every
restart.**

## Config

| Field | Meaning |
|---|---|
| `watches` | Non-empty array of watch entries. Required. |
| `watches[].dir` | Absolute path of the directory to watch. Required. |
| `watches[].targetSessionId` | Id of the session to notify. Required. |
| `stableMs` | Silence window in ms, shared by all watches. Default `5000`. |
| `message` | Optional template; supports `{file}`, `{reason}`, `{size}`, `{mtimeMs}`. |
| `watches[].done` | Per-watch completion rule: omitted = default text, `{ text }`, `{ regex }`, or `null` (off). |

## Test

```
node index.test.mjs
```

Uses real temporary directories and the real silence window; expects every
case to report `PASS` and the summary to end with `RESULT: PASS`.

## License

MIT — see [LICENSE](LICENSE).
