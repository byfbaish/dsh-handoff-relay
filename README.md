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

Each watch names exactly one target: `targetSessionId` (the session id) or
`targetTitle` (part of the session title). Writing both, or neither, skips that
watch with a warning — the plugin does not guess which one wins.

`targetTitle` matches by substring, case-sensitively: `简报` also matches
`周简报`. It is resolved again before every delivery and never cached. If it
matches no session, or more than one, nothing is sent: a warning naming the
watch, the wanted title, and the number of matches (with candidates when it is
ambiguous) is logged. There is no `cwd` fallback — the plugin never guesses a
"most recently active" session.

The notification is one user message. Its default text is
`文件 <absolute path> 已就绪（触发=stable|DONE），请继续。`, so the receiver can
open the file straight from that path. If the target session is not loaded, a
warning is written and nothing is sent.

## Why "relay"

Until I wanted it to reach me at any time, I did not see it.

One assistant on screen, two sessions underneath — two different session ids, no shared context, only shared memory. And the notification tool lets only the private-chat side send messages.

So I built two bridges. The first: details go into an external Markdown note, the core memory keeps only an index. The second: the plugin we were building that same night. One directory maps to one session; when a file is finished, the plugin carries a single line across.

I only meant to remind it that this could work. That message was eaten by the network. It did not wait — it found the plugin itself, designed its own test, and ran the chain end to end.

Then its first line carried a file name but no path. The receiving side could not find the file and concluded that something had been put into its input — at the time we called it being possessed. It did not act; it asked what had happened.

Hence the name: a relay does not produce messages and does not decide who should speak. It delivers the signal to the context that should wake up — now with an absolute path.

The full design rationale is in [`docs/why-relay.md`](./docs/why-relay.md).

## Install

`dsh-handoff-relay` is a plugin bundle for a DSH profile. It has no runtime
dependencies, so it installs with one CLI command — there is no need to hand-edit
the profile's `package.json` or its bundle list.

### Install from the marketplace

`dsh-handoff-relay` is published to npm (current release `0.3.2`), so the in-app
marketplace finds it by name: search for `dsh-handoff-relay` and install it
there. From the command line, the same package name works directly:

```bash
dsh plugin --profile desktop add dsh-handoff-relay
```

### Install with the CLI

`dsh plugin` forwards its arguments to `pnpm` inside the profile directory, so
the profile name is required (`desktop`, `web`, … — the same one you boot):

```bash
# from a local checkout: give the absolute path of the directory that holds package.json
git clone https://github.com/byfbaish/dsh-handoff-relay.git D:/plugins/dsh-handoff-relay
dsh plugin --profile desktop add D:/plugins/dsh-handoff-relay

# or straight from GitHub
dsh plugin --profile desktop add github:byfbaish/dsh-handoff-relay
```

Both forms work on macOS/Linux and Windows; keep the path absolute, because the
command runs inside the profile directory.

Then set the config. The bundle ships its own patch layer (`dsh.bundle.patch` in
`package.json`) that inserts the plugin row; the profile's `cordis.patch.yml`
overrides that row's `config` by matching the same `id`:

```yaml
stableMs: 5000
watches:
  - dir: 'D:\path\to\inbox'
    targetSessionId: '<session id>'
    done: { text: '<!-- DONE -->' }
```

Put that block under the row's `config:` key:

```yaml
- id: dsh-handoff-relay
  name: dsh-handoff-relay
  config:
    # the block above goes here
```

Restart the host so the bundle and its config are loaded. A watch's target must
resolve to a session that currently exists: with `targetSessionId` this means
re-wiring it after every restart, because session ids change when the host
restarts. `targetTitle` avoids that — its title survives restarts.

### Update

Re-run the install command, then restart the host:

```bash
dsh plugin --profile desktop add github:byfbaish/dsh-handoff-relay
```

For a local checkout, `git pull` in that checkout and restart; if the change
does not show up, re-run the `add` command once. Pin a release by appending a
ref:

```bash
dsh plugin --profile desktop add github:byfbaish/dsh-handoff-relay#v0.3.2
```

### Uninstall and check status

```bash
dsh plugin --profile desktop remove dsh-handoff-relay
```

Restart the host, then delete the plugin's row from the profile's
`cordis.patch.yml` — a config row whose package is gone is simply ignored, so
removing it only keeps the file readable.

Check what a profile has installed, and what the composed plugin tree looks like:

```bash
dsh plugin --profile desktop list --depth 0
dsh --dump-config --profile desktop
```

The first prints the profile's dependencies; the second prints the composed
profile tree and exits without booting the app.

### Config fields

- `watches` — a non-empty array of watch entries; each entry needs `dir` plus
  exactly one of `targetSessionId` and `targetTitle`. Each `dir` must be an
  existing absolute directory. An entry missing `dir` or giving both target
  fields (or neither), or whose directory cannot be read, is skipped with a
  warning naming the entry; the remaining watches still start. The plugin only
  reacts to filesystem events; it never polls.
- `watches[].targetSessionId` — id of the session to notify. Mutually exclusive
  with `targetTitle`; ids change when the host restarts, so it has to be
  re-wired after every restart.
- `watches[].targetTitle` — part of the target session's title, matched by
  substring (case-sensitive; `简报` hits `周简报`). Mutually exclusive with
  `targetSessionId`: writing both or neither skips that watch with a warning.
  Resolved afresh before each delivery; zero matches or more than one match
  means nothing is delivered, only a warning. There is no `cwd` fallback.
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

At load time each watch's target (id or title) is checked: if it resolves right
now, the watch starts normally; otherwise a warning naming that watch's `dir`
and target is logged and the watch still starts, so the remaining watches keep
working. Nothing is cached — every delivery resolves the target again.

**`targetSessionId` must point to a session that currently exists. Session ids
change when the host restarts, so re-wire `targetSessionId` after every
restart; a `targetTitle` watch needs no re-wiring.**

## Config

| Field | Meaning |
|---|---|
| `watches` | Non-empty array of watch entries. Required. |
| `watches[].dir` | Absolute path of the directory to watch. Required. |
| `watches[].targetSessionId` | Id of the session to notify. Exactly one of this and `targetTitle` is required. |
| `watches[].targetTitle` | Substring of the target session's title (case-sensitive); resolved before every delivery; zero or multiple matches mean no delivery. Exactly one of this and `targetSessionId` is required. |
| `stableMs` | Silence window in ms, shared by all watches. Default `5000`. |
| `message` | Optional template; supports `{path}` (absolute path of the delivered file), `{file}` (file name), `{reason}`, `{size}`, `{mtimeMs}`. |
| `watches[].done` | Per-watch completion rule: omitted = default text, `{ text }`, `{ regex }`, or `null` (off). |

## Test

```
node index.test.mjs
```

Uses real temporary directories and the real silence window; expects every
case to report `PASS` and the summary to end with `RESULT: PASS`.

## License

MIT — see [LICENSE](LICENSE).
