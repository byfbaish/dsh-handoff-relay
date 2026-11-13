// dsh-handoff-relay · 浏览器半身（手写 lazy-CJS 工厂，无打包器）
// 只 require 宿主播种的 specifier（react / react/jsx-runtime）；不 value import
// dsh-client-ui-settings 的表单模型。
// P22b：新宿主走 configForms.get(entryId) 的三列卡片（plugins.row.config）；
// 旧宿主只有 settingsScope / configForms.bind 时保留 P17 的 settings.plugin.item 卡片。
window.__ModuleLoader__.load({
	id: "dsh-handoff-relay",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const SETTINGS_NS = "dsh-handoff-relay";
		const ROW_ID = "dsh-handoff-relay";
		const ENTRY_ID = ROW_ID;
		const ROW_CONFIG_KEY = "dsh-handoff-relay#dsh-handoff-relay";
		const DEFAULT_DONE_TEXT = "<!-- DONE -->";
		const inject = ["slots"];

		const S = {
			wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" },
			hint: { fontSize: "12px", opacity: 0.72, lineHeight: 1.6 },
			error: { fontSize: "12px", color: "#d33", lineHeight: 1.6 },
			row: { display: "grid", gridTemplateColumns: "1.6fr 1.8fr 1.6fr auto", gap: "8px", alignItems: "start" },
			input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: "13px" },
			select: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: "13px" },
			btn: { padding: "6px 12px", fontSize: "13px", cursor: "pointer" },
			del: { padding: "6px 10px", fontSize: "13px", cursor: "pointer" },
			status: { fontSize: "12px", minHeight: "18px" },
			head: { display: "grid", gridTemplateColumns: "1.6fr 1.8fr 1.6fr auto", gap: "8px", fontSize: "12px", opacity: 0.72 },
			target: { display: "flex", flexDirection: "column", gap: "4px" },
			cwd: { fontSize: "11px", opacity: 0.65, wordBreak: "break-all" },
			picker: { border: "1px solid rgba(128,128,128,.35)", borderRadius: "6px", padding: "8px", display: "flex", flexDirection: "column", gap: "6px" },
			item: { textAlign: "left", padding: "6px 8px", fontSize: "13px", cursor: "pointer", background: "transparent", border: "1px solid rgba(128,128,128,.25)", borderRadius: "4px" },
		};

		function doneKind(done) {
			if (done === undefined) return "default";
			if (done === null) return "off";
			if (done && typeof done.text === "string") return "text";
			if (done && typeof done.regex === "string") return "regex";
			return "default";
		}

		function doneOfKind(kind, current) {
			if (kind === "off") return null;
			if (kind === "text") return { text: (current && current.text) || DEFAULT_DONE_TEXT };
			if (kind === "regex") return { regex: (current && current.regex) || "" };
			return undefined; // 省略 → Host 默认 text: <!-- DONE -->
		}

		/** 旧卡片保存前校验：目录必须是绝对路径、目标会话不能为空、完成规则不能为空值。 */
		function validateRows(rows) {
			const errors = [];
			rows.forEach((row, i) => {
				const where = `第 ${i + 1} 行`;
				if (!row.dir || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(row.dir.trim())) errors.push(`${where}：目录必须是绝对路径`);
				if (!row.targetSessionId || !row.targetSessionId.trim()) errors.push(`${where}：目标会话不能为空`);
				if (row.doneKind === "regex" && (!row.done || !row.done.regex || !row.done.regex.trim())) errors.push(`${where}：正则不能为空`);
				if (row.doneKind === "text" && (!row.done || !row.done.text || !row.done.text.trim())) errors.push(`${where}：完成标记不能为空`);
			});
			return errors;
		}

		function toRows(watches) {
			return (watches || []).map((w) => {
				const kind = doneKind(w && w.done);
				return {
					dir: String((w && w.dir) || ""),
					targetSessionId: String((w && w.targetSessionId) || ""),
					targetTitle: String((w && w.targetTitle) || ""),
					exact: (w && w.exact) === true,
					doneKind: kind,
					done: w && w.done,
				};
			});
		}

		function toSettingsRows(watches) {
			return toRows(watches).map((row) => row.doneKind === "default"
				? { ...row, doneKind: "text", done: { text: DEFAULT_DONE_TEXT } }
				: row);
		}

		function toWatches(rows) {			return rows.map((row) => {
				const out = { dir: row.dir.trim() };
				if (row.targetTitle) out.targetTitle = row.targetTitle.trim();
				if (row.targetSessionId) out.targetSessionId = row.targetSessionId.trim();
				out.exact = row.exact === true;
				const done = doneOfKind(row.doneKind, row.done);
				if (done !== undefined) out.done = done;
				return out;
			});
		}

		// ---------------------------------------------------------- 旧宿主卡片（P22c：只读）
		function relayDoneLabel(row) {
			if (row.doneKind === "text") return `文本：${(row.done && row.done.text) || ""}`;
			if (row.doneKind === "regex") return `正则：${(row.done && row.done.regex) || ""}`;
			if (row.doneKind === "off") return "不使用";
			return "默认（<!-- DONE -->）";
		}

		function RelayCard(props) {
			const scope = props.scope;
			const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());

			React.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);

			const rows = toRows(snapshot.value && snapshot.value.watches);
			const syncText = snapshot.status === "ready"
				? `已同步 Host（revision ${snapshot.revision ?? "?"}）`
				: snapshot.status === "loading" ? "正在读取 Host 设置…" : "Host 未提供该 namespace";
			const readonlyHint = "当前宿主版本较旧，不支持本插件的配置界面。请直接编辑 cordis.patch.yml 里的 dsh-handoff-relay 配置，重启后生效。";

			return h("div", { style: S.wrap },
				h("div", { style: S.hint }, readonlyHint),
				h("div", { style: S.hint },
					"exact 为 true 时标题必须完全相等（缺省 true）；填 false 则按包含匹配。"),
				h("div", { style: S.hint }, "以下为当前 watch 的只读视图；本宿主不提供保存入口。"),
				h("div", { style: S.head },
					h("span", null, "目录"),
					h("span", null, "目标会话"),
					h("span", null, "完成规则"),
					h("span", null, "")),
				rows.length === 0
					? h("div", { style: S.hint }, "还没有 watch。")
					: rows.map((row, i) => h("div", { key: i, style: S.row },
						h("span", null, row.dir || "（未填目录）"),
						h("span", null, row.targetTitle || row.targetSessionId || "（未绑定会话）"),
						h("span", null, `${relayDoneLabel(row)}；${row.exact === false ? "包含匹配" : "完全相等"}`),
						h("span", null, ""))),
				h("div", { style: S.status }, syncText));
		}

		// ---------------------------------------------------------- P22b 三列卡片
		function readService(ctx, name) {
			try {
				return typeof ctx.get === "function" ? ctx.get(name) : undefined;
			} catch {
				return undefined;
			}
		}

		function sessionsOf(ctx) {
			try {
				if (ctx && ctx.sessions && ctx.sessions.list) return ctx.sessions;
				return readService(ctx, "sessions");
			} catch {
				return undefined;
			}
		}

		function sessionMap(ctx) {
			try {
				const sessions = sessionsOf(ctx);
				const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : undefined;
				return snap && snap.byId ? snap.byId : {};
			} catch {
				return {};
			}
		}

		function displayTitleOf(session) {
			if (!session) return "";
			return String(session.displayTitle || session.title || "");
		}

		function sessionById(map, id) {
			if (!id || !map) return undefined;
			return map[id];
		}

		function sessionByTitle(map, title) {
			if (!title || !map) return undefined;
			const wanted = String(title).toLowerCase();
			return Object.values(map).find((session) => displayTitleOf(session).toLowerCase() === wanted);
		}

		function isAbsoluteDir(dir) {
			return !!dir && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(dir).trim());
		}

		function regexProblem(pattern) {
			if (!pattern || !pattern.trim()) return "正则不能为空";
			if (pattern.length > 200) return "正则长度不能超过 200 字符";
			if (/\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d+)/.test(pattern)) return "禁止嵌套量词（如 (a+)+）";
			try {
				new RegExp(pattern, "m");
				return null;
			} catch (err) {
				return `正则编译失败：${String(err && err.message ? err.message : err)}`;
			}
		}

		function validateSettingsRow(row) {
			if (!isAbsoluteDir(row.dir)) return "目录必须是绝对路径";
			if (!(row.targetTitle && row.targetTitle.trim()) && !(row.targetSessionId && row.targetSessionId.trim())) {
				return "目标会话不能为空";
			}
			if (row.doneKind === "text" && (!row.done || !row.done.text || !row.done.text.trim())) return "完成标记不能为空";
			if (row.doneKind === "regex") return regexProblem(row.done && row.done.regex);
			return null;
		}

		function missingSessionText(row, map, mapReady) {
			const byId = sessionById(map, row.targetSessionId);
			if (byId) return "";
			const byTitle = sessionByTitle(map, row.targetTitle);
			if (byTitle) return "";
			if (!mapReady) return "";
			if (!row.targetSessionId && !row.targetTitle) return "";
			const name = row.targetTitle || row.targetSessionId;
			return `目标会话已失效（原名称「${name}」未找到），请重新选择`;
		}

		/** 从 sessions 快照取选择器候选；按 displayTitle 本地过滤，不调用 search（它搜消息内容）。 */
		function pickerItems(ctx, query) {
			const map = sessionMap(ctx);
			const q = String(query || "").trim().toLowerCase();
			return Object.values(map)
				.filter((session) => session && typeof session === "object")
				.filter((session) => !q || displayTitleOf(session).toLowerCase().includes(q))
				.slice()
				.sort((a, b) => Number(!!b.running) - Number(!!a.running) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
				.map((session) => ({
					id: String(session.id || ""),
					title: displayTitleOf(session) || String(session.id || ""),
					cwd: String(session.cwd || ""),
				}));
		}

		function safeSnapshot(controller) {
			try {
				return controller && controller.getSnapshot ? controller.getSnapshot() : { status: "unavailable", value: {}, writable: false };
			} catch {
				return { status: "unavailable", value: {}, writable: false };
			}
		}

		function SettingsCard(props) {
			const controller = props && (props.controller || props.controllerForm);
			const [snapshot, setSnapshot] = React.useState(() => safeSnapshot(controller));
			const [rows, setRows] = React.useState(() => toSettingsRows(snapshot.value && snapshot.value.watches));
			const [stableMs, setStableMs] = React.useState(() => String((snapshot.value && snapshot.value.stableMs) || 5000));
			const [dirty, setDirty] = React.useState(false);
			const [status, setStatus] = React.useState("");
			const [picker, setPicker] = React.useState(null);
			const [query, setQuery] = React.useState("");

			React.useEffect(() => {
				if (!controller || typeof controller.subscribe !== "function") return undefined;
				const dispose = controller.subscribe(() => setSnapshot(safeSnapshot(controller)));
				return typeof dispose === "function" ? dispose : undefined;
			}, [controller]);

			React.useEffect(() => {
				if (dirty) return;
				const next = toSettingsRows(snapshot.value && snapshot.value.watches);
				setRows(next);
				setStableMs(String((snapshot.value && snapshot.value.stableMs) || 5000));
			}, [snapshot]);

			const writable = !!controller && snapshot.writable !== false;
			const map = sessionMap(props && props.ctx);
			const mapReady = Object.keys(map).length > 0;
			const syncText = !controller
				? "当前宿主未提供 configForms，只能查看，不能在界面保存"
				: snapshot.status === "ready"
					? `已同步 Host（revision ${snapshot.revision ?? "?"}）`
					: snapshot.status === "loading" ? "正在读取 Host 设置…" : "Host 未提供该条目";

			const patchRow = (i, patch) => {
				setRows((prev) => prev.map((row, k) => (k === i ? { ...row, ...patch } : row)));
				setDirty(true);
				setStatus("");
			};

			const addRow = () => {
				setRows((prev) => [...prev, {
					dir: "", targetTitle: "", targetSessionId: "", exact: true,
					doneKind: "text", done: { text: DEFAULT_DONE_TEXT },
				}]);
				setDirty(true);
				setStatus("");
			};

			const removeRow = (i) => {
				setRows((prev) => prev.filter((_, k) => k !== i));
				setDirty(true);
				setStatus("");
			};

			const chooseSession = (i, session) => {
				patchRow(i, {
					targetTitle: session.title,
					targetSessionId: session.id,
					exact: true,
				});
				setPicker(null);
				setQuery("");
			};

			const save = async () => {
				const failures = [];
				const nextWatches = [];
				const original = (snapshot.value && snapshot.value.watches) || [];
				rows.forEach((row, i) => {
					const problem = validateSettingsRow(row);
					if (problem) {
						failures.push(`第 ${i + 1} 行：${problem}`);
						if (i < original.length) nextWatches.push(original[i]); // 失效行保留旧值
						return;
					}
					nextWatches.push(toWatches([row])[0]);
				});
				const stable = Number(stableMs);
				if (!Number.isFinite(stable) || stable <= 0) failures.push("stableMs 必须是正数");
				if (!controller || typeof controller.mutate !== "function" && typeof controller.set !== "function") {
					setStatus("当前宿主未提供 configForms，无法保存（未写入）");
					return;
				}
				const stableOk = Number.isFinite(stable) && stable > 0;
				try {
					let accepted = true;
					if (typeof controller.mutate === "function") {
						const ops = [{ op: "set", path: ["watches"], value: nextWatches }];
						if (stableOk) ops.push({ op: "set", path: ["stableMs"], value: stable });
						accepted = await controller.mutate(ops);
					} else {
						accepted = await controller.set("watches", nextWatches);
						if (accepted !== false && stableOk) accepted = await controller.set("stableMs", stable);
					}
					if (accepted === false) throw new Error("宿主拒绝了写入");
					setDirty(failures.length > 0);
					const tail = failures.length ? `；未通过校验：${failures.join("；")}` : "";
					setStatus(`已保存，重启宿主后生效${tail}`);
				} catch (err) {
					setStatus(`保存失败：${String(err && err.message ? err.message : err)}`);
				}
			};

			const reset = () => {
				setRows(toSettingsRows(snapshot.value && snapshot.value.watches));
				setStableMs(String((snapshot.value && snapshot.value.stableMs) || 5000));
				setDirty(false);
				setPicker(null);
				setQuery("");
				setStatus("已放弃修改，恢复到最后一次保存值");
			};

			const pickerNode = picker === null ? null : h("div", { style: S.picker },
				h("input", {
					style: S.input,
					value: query,
					placeholder: "搜索会话标题",
					onChange: (e) => setQuery(e.target.value),
				}),
				pickerItems(props && props.ctx, query).length === 0
					? h("div", { style: S.hint }, "没有匹配的会话")
					: pickerItems(props && props.ctx, query).map((session) => h("button", {
						key: session.id,
						style: S.item,
						onClick: () => chooseSession(picker, session),
					},
						h("div", null, session.title),
						rowCwd(session.cwd))),
				h("button", { style: S.btn, onClick: () => { setPicker(null); setQuery(""); } }, "取消"));

			return h("div", { style: S.wrap },
				h("div", { style: S.hint },
					"配置会写回 cordis.patch.yml；保存后重启宿主生效。目标会话按标题匹配（exact=true 表示完全相等）。"),
				h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
					h("span", { style: S.hint }, "stableMs"),
					h("input", {
						style: { ...S.input, width: "120px" },
						type: "number",
						min: 1,
						value: stableMs,
						disabled: !writable,
						onChange: (e) => { setStableMs(e.target.value); setDirty(true); setStatus(""); },
					})),
				h("div", { style: S.head },
					h("span", null, "目录"),
					h("span", null, "目标会话"),
					h("span", null, "完成规则"),
					h("span", null, "")),
				rows.length === 0
					? h("div", { style: S.hint }, "还没有自定义行。点「新增一行」开始。")
					: rows.map((row, i) => targetRow(i, row, {
						writable, map, mapReady, patchRow, removeRow,
						openPicker: () => { setPicker(i); setQuery(""); },
						invalid: missingSessionText(row, map, mapReady),
						cwd: (sessionById(map, row.targetSessionId) || {}).cwd || "",
					})),
				pickerNode,
				h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
					h("button", { style: S.btn, onClick: addRow, disabled: !writable }, "新增一行"),
					h("button", { style: S.btn, onClick: save, disabled: !writable || !dirty }, "保存"),
					h("button", { style: S.btn, onClick: reset, disabled: !dirty }, "放弃修改"),
					h("span", { style: S.status }, status || syncText)));
		}

		function rowCwd(cwd) {
			return cwd ? h("div", { style: S.cwd }, `《${cwd}》`) : null;
		}

		function targetRow(i, row, opts) {
			const regexBad = row.doneKind === "regex" && !!regexProblem(row.done && row.done.regex);
			const title = row.targetTitle || displayTitleOf(sessionById(opts.map, row.targetSessionId));
			return h("div", { key: i, style: S.row },
				h("input", {
					style: S.input, value: row.dir, disabled: !opts.writable,
					placeholder: "C:\\path\\to\\watch",
					onChange: (e) => opts.patchRow(i, { dir: e.target.value }),
				}),
				h("div", { style: S.target },
					h("button", {
						style: S.btn, disabled: !opts.writable,
						onClick: opts.openPicker,
					}, "选择会话"),
					h("div", { style: S.hint }, title || "未选择"),
					rowCwd(opts.cwd),
					opts.invalid ? h("div", { style: S.error }, opts.invalid) : null),
				h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
					h("select", {
						style: S.select, value: row.doneKind, disabled: !opts.writable,
						onChange: (e) => opts.patchRow(i, { doneKind: e.target.value, done: doneOfKind(e.target.value, row.done) }),
					},
						h("option", { value: "text" }, "文本"),
						h("option", { value: "regex" }, "正则"),
						h("option", { value: "off" }, "不使用")),
					(row.doneKind === "text" || row.doneKind === "regex") && h("input", {
						style: { ...S.input, borderColor: regexBad ? "#d33" : undefined },
						value: (row.done && (row.done.text || row.done.regex)) || "",
						disabled: !opts.writable,
						placeholder: row.doneKind === "text" ? DEFAULT_DONE_TEXT : "正则，如 ^done$",
						onChange: (e) => opts.patchRow(i, { done: row.doneKind === "text" ? { text: e.target.value } : { regex: e.target.value } }),
					}),
					row.doneKind === "regex" ? h("div", { style: S.hint },
						h("div", null, "只扫文件尾部约 4KB"),
						h("div", null, "固定 m 标志，长度 ≤200 字符"),
						h("div", null, "禁止嵌套量词（如 (a+)+）")) : null,
					regexBad ? h("div", { style: S.error }, regexProblem(row.done && row.done.regex)) : null),
				h("button", { style: S.del, disabled: !opts.writable, onClick: () => opts.removeRow(i) }, "删除"));
		}

		function mountLegacy(ctx, service) {
			const scope = service.bind({ namespace: SETTINGS_NS });
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				inject: () => ({ scope }),
			}, RelayCard));
		}

		function mountRowConfig(ctx, forms) {
			const controller = forms.get(ENTRY_ID);
		 if (!controller) throw new Error("configForms 未返回表单控制器");
			const register = () => ctx.slots.register({
				name: "plugins.row.config",
				key: ROW_CONFIG_KEY,
				order: 10,
				locale: SETTINGS_NS,
				inject: () => ({ ctx, controller }),
			}, SettingsCard);
			if (typeof ctx.slots.inject === "function") ctx.slots.inject("plugins.row.config", register);
			else register();
		}

		function apply(ctx) {
			try {
				const forms = readService(ctx, "configForms");
				if (forms && typeof forms.get === "function") {
					mountRowConfig(ctx, forms);
					return;
				}
				const legacy = forms ?? readService(ctx, "settingsScope");
				if (legacy && typeof legacy.bind === "function") {
					mountLegacy(ctx, legacy);
					return;
				}
				// 两个都没有：等服务就绪再挂；apply 本身立即返回，绝不 await。
				if (typeof ctx.inject !== "function") {
					console.warn("宿主无 configForms/settingsScope 服务（跳过设置卡，不影响 watch）");
					return;
				}
				ctx.inject(["configForms"], (c) => {
					try {
						const late = readService(c, "configForms");
						if (!late) {
							console.warn("宿主无 configForms 服务（跳过设置卡，不影响 watch）");
							return;
						}
						if (typeof late.get === "function") mountRowConfig(c, late);
						else if (typeof late.bind === "function") mountLegacy(c, late);
					} catch (err) {
						console.warn(`设置卡延后挂载失败：${String(err && err.message ? err.message : err)}`);
					}
				});
			} catch (err) {
				console.warn(`设置卡挂载失败（跳过，不影响 watch）：${String(err && err.message ? err.message : err)}`);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.ROW_CONFIG_KEY = ROW_CONFIG_KEY;
		exports.SettingsCard = SettingsCard;
		return module.exports;
	}
});
