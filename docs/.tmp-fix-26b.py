import io

P = r'C:\develop\workspace\dsh-handoff-relay\docs\relay-tool-0.6.3-mention-file-gate.md'
s = io.open(P, encoding='utf-8', newline='').read()

old = """| **跳过①**（拒绝件自身不投） | `:1525`（`deliver` 入口）、`:1629`（`consider` 入口） | `relName.endsWith(REJECTED_SUFFIX)` ⇒ 直接 return，拒绝件永远不会被当成新件投出去 |
| **跳过②**（同快照不重判） | `:1481` `isRejectedSnapshot`，调用点 `:1525`、`:1638` | 按 `fingerOf(watchDir, relName, mtimeMs, size)` 命中 `rejected.json` 即跳过 ⇒ 源件 mtime/size 不会被改写、拒绝件不会每轮重写 |
| **目录过滤**（拒绝件不进候选） | `:1666` `listFiles()` | `.filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))` |"""
new = """| **跳过①**（拒绝件自身不投） | `:1629`（`consider` 入口）、`:1666`（`listFiles()` 过滤） | 后缀两道**都在 `consider` 侧**：候选生成时就过滤掉、进来后再按后缀挡一次。`deliver()` 入口**没有**后缀判断 |
| **跳过②**（同快照不重判） | `:1481` `isRejectedSnapshot`，调用点 `:1523`（`deliver` 入口）、`:1638`（`consider`） | `deliver()` 入口只按 `rejected.json` 台账判快照（`:1522 isFailedSnapshot`、`:1523 isRejectedSnapshot`），不按后缀；命中即跳过 ⇒ 源件 mtime/size 不会被改写、拒绝件不会每轮重写 |"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

anchor = """| **目录过滤**（拒绝件不进候选） | `:1666` `listFiles()` | `.filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))` |
"""
assert s.count(anchor) == 0
tail = """**拒绝件为什么不会自己再投一次**：后缀拦在 `consider`（`:1629`）与 `listFiles`（`:1666`）两道；即便有人把 `.rejected.md` 直接递给 `deliver()`，`:1523` 的台账快照判定也会兜住（`fingerOf` 命中即 return）——三道叠起来覆盖了「拒绝件进投递队列」的所有路径。给 `deliver()` 入口补一行后缀判断属于改代码、要重打包，本轮不做（缺口 G-063-2）。
"""
# 插在三道表格之后、下一段说明之前
old2 = """| **目录过滤**（拒绝件不进候选） | `:1666` `listFiles()` | `.filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))` |
"""
new2 = """| **目录过滤**（拒绝件不进候选） | `:1666` `listFiles()` | `.filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))` |

**拒绝件为什么不会自己再投一次**：后缀拦在 `consider`（`:1629`）与 `listFiles`（`:1666`）两道；即便有人把 `.rejected.md` 直接递给 `deliver()`，`:1523` 的台账快照判定也会兜住（`fingerOf` 命中即 return）——三道叠起来覆盖了「拒绝件进投递队列」的所有路径。给 `deliver()` 入口补一行后缀判断属于改代码、要重打包，本轮不做（缺口 G-063-2）。
"""
assert s.count(old2) == 1
s = s.replace(old2, new2, 1)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('ok', len(s.encode('utf-8')))
