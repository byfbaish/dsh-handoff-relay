[中文](README.zh-CN.md)

# dsh-file-watch

A dependency-free plugin that watches one or more directories and sends exactly
one notification to each directory's target session when a file in it is
considered finished.

Each entry in `watches` starts its own `fs.watch` and keeps its own
`(size, mtimeMs)` snapshot and marker state, so targets never interfere with
one another.

## What "finished" means

- **Quiet period**: a file that has stopped changing for `stableMs`
  milliseconds (default `5000`) counts as finished. While the file keeps
  being written to, its timer restarts and nothing is sent.
- **Explicit marker**: if the last 2 KB of the file contains `<!-- DONE -->`,
  it counts as finished immediately, without waiting for the quiet period.

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

Register the package as a bundle in a profile, then set its config in that
profile's patch layer:

```yaml
- id: dsh-file-watch
  name: dsh-file-watch
  config:
    watches:
      - dir: '/absolute/path/to/first-outbox'
        targetSessionId: 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
      - dir: '/absolute/path/to/second-outbox'
        targetSessionId: 'session-yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy'
    stableMs: 5000
    doneMarker: '<!-- DONE -->'
```

`watches` must contain at least one entry, and every entry needs both `dir`
and `targetSessionId`. Each `dir` must be an existing absolute directory.
An entry that is missing either field, or whose directory cannot be read, is
skipped with a warning naming which entry it was; the remaining watches still
start. The plugin only reacts to filesystem events; it never polls.

`stableMs` and `doneMarker` are global values shared by all watches. Per-entry
overrides are not supported.

## Config

| Field | Meaning |
|---|---|
| `watches` | Non-empty array of watch entries. Required. |
| `watches[].dir` | Absolute path of the directory to watch. Required. |
| `watches[].targetSessionId` | Id of the session to notify. Required. |
| `stableMs` | Silence window in ms, shared by all watches. Default `5000`. |
| `message` | Optional template; supports `{file}`, `{reason}`, `{size}`, `{mtimeMs}`. |
| `doneMarker` | Immediate-delivery marker, shared by all watches. Default `<!-- DONE -->`. |

## Test

```
node index.test.mjs
```

Uses real temporary directories and the real silence window; expects
`8/8 PASS`.

## License

MIT
