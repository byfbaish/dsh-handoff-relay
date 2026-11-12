# dsh-file-watch

A dependency-free plugin that watches a directory and sends exactly one
notification to a chosen session when a file in it is considered finished.

## What "finished" means

- **Quiet period**: a file that has stopped changing for `stableMs`
  milliseconds (default `5000`) counts as finished. While the file keeps
  being written to, its timer restarts and nothing is sent.
- **Explicit marker**: if the last 2 KB of the file contains `<!-- DONE -->`,
  it counts as finished immediately, without waiting for the quiet period.

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
    watchDir: '/absolute/path/to/watch-directory'
    targetSessionId: 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    stableMs: 5000
```

`watchDir` must be an existing absolute directory. The plugin only reacts to
filesystem events; it never polls.

## Config

| Field | Meaning |
|---|---|
| `watchDir` | Absolute path of the directory to watch. Required. |
| `targetSessionId` | Id of the session to notify. Required. |
| `stableMs` | Quiet period in ms. Default `5000`. |
| `message` | Optional template; supports `{file}`, `{reason}`, `{size}`, `{mtimeMs}`. |
| `doneMarker` | Optional immediate marker. Default `<!-- DONE -->`. |

## Test

```
node index.test.mjs
```

Uses real temporary directories and the real 5-second quiet window; expects
`6/6 PASS`.

## License

MIT
