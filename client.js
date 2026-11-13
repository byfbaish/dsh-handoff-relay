// dsh-handoff-relay · 浏览器半身（手写 lazy-CJS 工厂，无打包器）
// 只 require 宿主播种的 specifier（react / react/jsx-runtime）；不 value import
// dsh-client-ui-settings-plugins 的表单模型。卡片只作编辑通道：保存走
// ctx.settingsScope.bind({ namespace }).set('watches', ...)，Host observe 后回写
// cordis.patch.yml；relay 运行期仍只读 config.watches。
window.__ModuleLoader__.load({
	id: "dsh-handoff-relay",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const SETTINGS_NS = "dsh-handoff-relay";
		const DEFAULT_DONE_TEXT = "<!-- DONE -->";
		const inject = ["slots", "settingsScope"];

		const S = {
			wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" },
			hint: { fontSize: "12px", opacity: 0.72, lineHeight: 1.6 },
			row: { display: "grid", gridTemplateColumns: "2fr 2fr 1.4fr auto", gap: "8px", alignItems: "center" },
			input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: "13px" },
			select: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: "13px" },
			btn: { padding: "6px 12px", fontSize: "13px", cursor: "pointer" },
			del: { padding: "6px 10px", fontSize: "13px", cursor: "pointer" },
			status: { fontSize: "12px", minHeight: "18px" },
			head: { display: "grid", gridTemplateColumns: "2fr 2fr 1.4fr auto", gap: "8px", fontSize: "12px", opacity: 0.72 },
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

		/** 保存前校验：目录必须是绝对路径、目标会话不能为空、完成规则不能为空值。 */
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

		function toWatches(rows) {
			return rows.map((row) => {
				const out = { dir: row.dir.trim() };
				if (row.targetTitle) out.targetTitle = row.targetTitle.trim();
				else out.targetSessionId = row.targetSessionId.trim();
				if (row.exact) out.exact = true;
				const done = doneOfKind(row.doneKind, row.done);
				if (done !== undefined) out.done = done;
				return out;
			});
		}

		function RelayCard(props) {
			const scope = props.scope;
			const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
			const [rows, setRows] = React.useState(() => toRows(snapshot.value && snapshot.value.watches));
			const [dirty, setDirty] = React.useState(false);
			const [status, setStatus] = React.useState("");

			React.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);

			React.useEffect(() => {
				if (dirty) return; // 本地有未保存编辑时不用远端覆盖
				const next = toRows(snapshot.value && snapshot.value.watches);
				setRows(next);
			}, [snapshot]);

			const writable = snapshot.writable !== false;
			const syncText = snapshot.status === "ready"
				? `已同步 Host（revision ${snapshot.revision ?? "?"}）`
				: snapshot.status === "loading" ? "正在读取 Host 设置…" : "Host 未提供该 namespace";

			const patchRow = (i, patch) => {
				setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
				setDirty(true);
				setStatus("");
			};

			const addRow = () => {
				setRows((prev) => [...prev, {
					dir: "", targetSessionId: "", targetTitle: "", exact: false,
					doneKind: "default", done: undefined,
				}]);
				setDirty(true);
			};

			const removeRow = (i) => {
				setRows((prev) => prev.filter((_, k) => k !== i));
				setDirty(true);
				setStatus("");
			};

			const save = async () => {
				const errors = validateRows(rows);
				if (errors.length) { setStatus("未保存：" + errors.join("；")); return; }
				try {
					await scope.set("watches", toWatches(rows));
					setDirty(false);
					setStatus("已保存（Host 会回写 cordis.patch.yml，重启 DSH 后生效）");
				} catch (err) {
					setStatus("保存失败：" + String(err && err.message ? err.message : err));
				}
			};

			const reset = () => {
				setRows(toRows(snapshot.value && snapshot.value.watches));
				setDirty(false);
				setStatus("已丢弃未保存的编辑");
			};

			return h("div", { style: S.wrap },
				h("div", { style: S.hint },
					"watches 的运行时真相是 cordis.patch.yml；这里只做编辑通道。保存会回写 yml，重启 DSH 后生效。exact 表示标题完全相等（缺省为包含匹配）。"),
				h("div", { style: S.head },
					h("span", null, "目录（绝对路径）"),
					h("span", null, "目标会话（session id）"),
					h("span", null, "完成规则"),
					h("span", null, "")),
				rows.length === 0
					? h("div", { style: S.hint }, "还没有 watch。点「新增一行」开始。")
					: rows.map((row, i) => h("div", { key: i, style: S.row },
						h("input", {
							style: S.input, value: row.dir, disabled: !writable,
							placeholder: "C:\\path\\to\\watch",
							onChange: (e) => patchRow(i, { dir: e.target.value }),
						}),
						h("input", {
							style: S.input, value: row.targetSessionId, disabled: !writable,
							placeholder: "session-xxxxxxxx",
							onChange: (e) => patchRow(i, { targetSessionId: e.target.value }),
						}),
						h("select", {
							style: S.select, value: row.doneKind, disabled: !writable,
							onChange: (e) => patchRow(i, { doneKind: e.target.value, done: doneOfKind(e.target.value, row.done) }),
						},
							h("option", { value: "default" }, "默认（<!-- DONE -->）"),
							h("option", { value: "text" }, "文本标记"),
							h("option", { value: "regex" }, "正则"),
							h("option", { value: "off" }, "关闭（只看 stableMs）")),
						h("button", { style: S.del, disabled: !writable, onClick: () => removeRow(i) }, "删除"),
						(row.doneKind === "text" || row.doneKind === "regex") && h("div", { style: S.row },
							h("input", {
								style: S.input,
								value: (row.done && (row.done.text || row.done.regex)) || "",
								disabled: !writable,
								placeholder: row.doneKind === "text" ? DEFAULT_DONE_TEXT : "正则，如 ^done$",
								onChange: (e) => patchRow(i, { done: row.doneKind === "text" ? { text: e.target.value } : { regex: e.target.value } }),
							}),
							h("span", null, ""), h("span", null, ""), h("span", null, "")),
						h("div", { style: S.row },
							h("label", { style: S.hint },
								h("input", {
									type: "checkbox", checked: row.exact, disabled: !writable,
									onChange: (e) => patchRow(i, { exact: e.target.checked }),
								}),
								" exact（标题完全相等）"),
							h("span", null, ""), h("span", null, ""), h("span", null, "")))),
				h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
					h("button", { style: S.btn, onClick: addRow, disabled: !writable }, "新增一行"),
					h("button", { style: S.btn, onClick: save, disabled: !writable || !dirty }, "保存"),
					h("button", { style: S.btn, onClick: reset, disabled: !dirty }, "放弃修改"),
					h("span", { style: S.status }, status || syncText)));
		}

		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				inject: () => ({ scope }),
			}, RelayCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.SETTINGS_NS = SETTINGS_NS;
		return module.exports;
	}
});
