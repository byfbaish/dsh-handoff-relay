# Changelog

All notable changes to `dsh-handoff-relay`. The package ships as an installed DSH
plugin (default export `apply`), so every entry below is described both as a code
change and as what it means if you are using the plugin.

Releases up to `0.6.7` were accumulated locally and published together; `0.5.0`
is the previous npm release. Full evidence and rulings for each version live in
`docs/ledger/`.

## 0.6.7

- Source identity of a delivery is now **never guessed**. When the sending
  session cannot be found in the host's current `state.json` mapping, the message
  header carries `From: UNKNOWN` instead of borrowing a name from `botId` or room
  membership. (Previously a group-segment sender could be labelled with another
  Bot's name, which is worse than "unknown".)
- Only the *current* `bots[].sessionId` and `rooms[].sessions` values are used.
  A stale session id recorded in the mapping is never turned into a name.
- A `mapping-stale` log line marks the same-bot/different-session case; it only
  helps locating the problem and does not change the tier decision.
- Docs: adding or removing a watch is **hot-loaded** — the host does not need a
  restart, but the change can take minutes to be picked up. Do not read "nothing
  happened yet" as a broken config; look for a new `启动 N/N 个 watch` line in
  `relay.log` first. (Installing or uninstalling the plugin itself still needs a
  restart.)

## 0.6.6

- Self-addressed deliveries now carry a notice instead of vanishing quietly.
  `kind=A`: sender and recipient are the same session (`Self-Addressed: same-session`);
  `kind=B`: same Bot, different session, so the notice cannot reach the receiver
  (`Self-Addressed: same-bot-other-session`). The delivery still happens.
- The notice appears in three places — the tool's returned `note`, the message
  header, and the notice block — and is **not** part of the dedupe key, so a
  repeated body still dedupes to the same file.
- The file-watch channel is deliberately unchanged: it has no `exec` context, so
  the tier cannot be judged and no notice is added.

## 0.6.5

- The tool channel now writes the **real sender** into `From:` (session id taken
  from `exec.agent.id`, resolved through the host's current `state.json`). When
  it cannot be resolved, behaviour is byte-for-byte the same as `0.6.4`.
- `Reply-To` is no longer a plain address: the notice states that a delivery is
  one-way and that answering requires a new `relay_deliver` call. If no reply
  address can be derived, the line is omitted rather than printed as "unknown".
- The notice block is delimited and strippable, so turning notices off does not
  change the bytes written to disk.
- Three copy fixes: out-of-date re-delivery hints no longer blame the file name
  (dedupe is by content, not name).

## 0.6.4

- Version-only release. `0.6.3` was installed, then changed again, so the same
  version number would have described two different byte sets; `0.6.4` is that
  build. Nothing changed beyond the version and the fixes already in `0.6.3`.
- Documented that `hash8` (dedupe key) and the mention gate are independent:
  re-running the same body hits the dedupe table first, so a gate experiment must
  use new content.

## 0.6.3

- The file-watch channel and the tool channel now share **one** mention check.
  Previously the file channel used a loose "does the text contain an @ anywhere"
  test, so placeholder text could pass and an unaddressed file was delivered.
- An `@Name` that matches no member of the target room is rejected with
  `E_MENTION_UNKNOWN` (the message lists the room's members and `@所有人`), instead
  of being delivered to nobody in particular.
- Reply notice support (`replyNotice`, on by default) with a strippable block.

## 0.6.2

- `relay_deliver` gained a **mention guard**: a delivery to a room must name at
  least one person in the body.
  - `E_MENTION_FULLWIDTH` — the body uses a full-width `＠`, which the host does
    not recognise.
  - `E_MENTION_REQUIRED` — the target is a room and the body names nobody.
  - `E_MENTION_NOT_IN_BODY` — a `mention` argument was passed but does not appear
    in the body.
- The file-watch channel rejects the same case without delivering: the source file
  stays where it is, a sibling `<name>.rejected.md` explains why, a line is
  written to `rejected.json`, and the file is not retried on the next scan.

## 0.6.1

- Startup log line counts only watches (`启动 9/9 个 watch` instead of `10/9`).
- Per-watch resolution log lines are labelled by kind (`目标=targetIdentity=…`)
  instead of the retired `targetSessionId` wording.
- README examples use addresses that are actually routed by a configured watch,
  so copying them works.
- Install path documented: on the `desktop` profile the CLI refuses to manage the
  profile (`bin.js` rejects it), so install from the app's plugin page with a
  local `.tgz`.

## 0.6.0

- New tool channel: `relay_deliver` with `target` (`<Room>:<Bot>` or `<Bot>@main`),
  `subject`, `body`, and `kind` (`ASK` / `NOTICE` / `REPORT` / `OK` / `RED`, default
  `REPORT`). Arguments are the constraint: an address without a room name is
  rejected instead of guessed.
- Returns `{ ok: true, delivered, deduped, inlined, target }` on success and a
  coded failure otherwise (never throws): `E_ADDR_INVALID`,
  `E_SESSION_UNRECORDED`, `E_ARGS_INVALID`, `E_BODY_TOO_LARGE`, `E_NO_ROUTE`,
  `E_DELIVER_FAILED`.
- `E_NO_ROUTE` means no configured watch accepts that target; the message lists
  up to five routable targets instead of silently creating anything.
- Deliveries dedupe by content (`hash8`), not by file name; the same body
  delivered twice resolves to one file.
- The existing directory watches keep working unchanged and can be mixed with
  tool calls.
