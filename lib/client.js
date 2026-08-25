window.__ModuleLoader__.load({ id: "dsh-skin-market", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/api.ts
/** 与 host 半的 API_PREFIX 保持一致。 */
const PREFIX = "/skin-market/api";
async function getJson(path) {
	const response = await fetch(`${PREFIX}${path}`, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return await response.json();
}
/**
* 消费一条 SSE：把 `data:` 行解析成事件推给调用方。
*
* 手写而不用 EventSource，因为这是 POST 且要带 body；EventSource 只能 GET。
*/
async function stream(path, body, onEvent) {
	const response = await fetch(`${PREFIX}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	if (!(response.headers.get("content-type") ?? "").includes("event-stream")) {
		const payload = await response.json().catch(() => ({}));
		onEvent({
			type: "error",
			code: payload.code ?? "PNPM_FAILED",
			message: payload.message ?? `HTTP ${response.status}`
		});
		return;
	}
	const reader = response.body?.getReader();
	if (reader === void 0) throw new Error("响应没有可读流");
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const line = part.split("\n").find((row) => row.startsWith("data:"));
			if (line === void 0) continue;
			try {
				onEvent(JSON.parse(line.slice(5).trim()));
			} catch {}
		}
	}
}
/** 建一个市场客户端。 */
function createApi() {
	return {
		catalog: async ({ q, sort, page }) => {
			const params = new URLSearchParams({
				page: String(page),
				size: "24"
			});
			if (q !== "") params.set("q", q);
			if (sort !== "") params.set("sort", sort);
			return await getJson(`/catalog?${params.toString()}`);
		},
		installed: async () => (await getJson("/installed")).items,
		diagnostics: async () => await getJson("/diagnostics"),
		install: async (spec, onEvent) => {
			await stream("/install", { spec }, onEvent);
		},
		uninstall: async (packageName, onEvent) => {
			await stream("/uninstall", { packageName }, onEvent);
		},
		allowBuilds: async (spec, onEvent) => {
			await stream("/allow-builds", { spec }, onEvent);
		}
	};
}

//#endregion
//#region src/client/appearance.ts
/** 内置主题 id：这几个由 dsh 自己的外观行管，不归市场列。 */
const BUILTIN = new Set(["light", "dark"]);
/** 记住用户选的皮肤主题。ui-theme 不为第三方 id 持久化，只能自己存。 */
const STORAGE_KEY = "skin-market.theme";
const read = () => {
	try {
		return localStorage.getItem(STORAGE_KEY) ?? void 0;
	} catch {
		return;
	}
};
const write = (id) => {
	try {
		if (id === "system") localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, id);
	} catch {}
};
/**
* 把主题快照转成外观区块要渲染的选项。
* @param snapshot - 主题服务快照。
* @returns 跟随系统 + 内置 + 已注册的皮肤主题，按此顺序。
*/
function optionsOf(snapshot) {
	const options = [{
		id: "system",
		builtin: true,
		active: snapshot.preference === "system"
	}];
	for (const theme of snapshot.themes) options.push({
		id: theme.id,
		builtin: BUILTIN.has(theme.id),
		active: snapshot.preference === theme.id
	});
	return options;
}
/**
* 页面加载后重放上次选中的皮肤。
*
* 皮肤的 bundle 是异步加载的，刚启动时它还没注册；所以这里订阅变化，等到那个
* 主题真的出现在注册表里再切过去，切完就不再管（用户之后的选择由 select 负责）。
* @param ctx - 浏览器插件上下文，用来订阅 theme/change。
* @param theme - 主题服务。
* @returns 取消订阅的函数。
*/
function restoreSaved(ctx, theme) {
	const wanted = read();
	if (wanted === void 0 || wanted === "system") return () => {};
	const apply$1 = (snapshot) => {
		if (snapshot.preference === wanted) return true;
		if (!snapshot.themes.some((entry) => entry.id === wanted)) return false;
		theme.setTheme(wanted);
		return true;
	};
	if (apply$1(theme.getTheme())) return () => {};
	let dispose = () => {};
	dispose = ctx.on("theme/change", ((snapshot) => {
		if (apply$1(snapshot)) dispose();
	}));
	return dispose;
}
/**
* 切换外观，并记住这次选择。
* @param theme - 主题服务。
* @param id - 主题 id 或 `system`。
*/
function selectTheme(theme, id) {
	theme.setTheme(id);
	write(id);
}

//#endregion
//#region src/client/card-state.ts
/** 空闲态常量，省得到处新建对象。 */
const IDLE = { kind: "idle" };
/** 日志只留尾部：安装输出可能上百行，界面里没人会往上翻那么多。 */
const LOG_LIMIT = 60;
/**
* 把一条过程事件归约进卡片状态。
* @param state - 当前状态。
* @param event - 收到的事件。
* @param verb - 本次动作。
* @returns 新状态。
*/
function reduce(state, event, verb) {
	const log = state.kind === "working" || state.kind === "error" ? state.log : [];
	switch (event.type) {
		case "log": return {
			kind: "working",
			verb,
			log: [...log, event.line].slice(-LOG_LIMIT)
		};
		case "step": return {
			kind: "working",
			verb,
			log
		};
		case "done": return {
			kind: "done",
			verb
		};
		case "error": return {
			kind: "error",
			code: event.code,
			message: event.message,
			...event.detail !== void 0 ? { detail: event.detail } : {},
			log
		};
	}
}

//#endregion
//#region \0skin-market-css:src/client/market.module.css.mjs
const css = ".v2ZfNW_root{flex-direction:column;gap:4px;height:100%;min-height:0;display:flex}.v2ZfNW_head{align-items:center;gap:10px;display:flex}.v2ZfNW_title{color:var(--dsw-alias-label-primary);margin:0;font-size:19px;font-weight:600}.v2ZfNW_version{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:12px}.v2ZfNW_spacer{flex:auto}.v2ZfNW_subtitle{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:13px}.v2ZfNW_count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.v2ZfNW_stale{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:8px;margin-top:8px;padding:7px 11px;font-size:12.5px}.v2ZfNW_tabs{border-bottom:1px solid var(--dsw-alias-border-l1);gap:22px;margin-top:16px;display:flex}.v2ZfNW_tab{appearance:none;cursor:pointer;font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-bottom:2px solid #0000;margin-bottom:-1px;padding:0 0 10px;font-size:14px}.v2ZfNW_tab:hover{color:var(--dsw-alias-label-secondary)}.v2ZfNW_tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary);font-weight:500}.v2ZfNW_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.v2ZfNW_search{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);border-radius:10px;align-items:center;gap:9px;max-width:560px;margin-top:16px;padding:8px 13px;display:flex}.v2ZfNW_search input{min-width:0;font:inherit;color:var(--dsw-alias-label-primary);background:0 0;border:0;outline:0;flex:1;font-size:14px}.v2ZfNW_search input::placeholder{color:var(--dsw-alias-label-caption)}.v2ZfNW_hits{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}.v2ZfNW_sortbar{align-items:center;gap:6px;margin-top:12px;display:flex}.v2ZfNW_sort{appearance:none;cursor:pointer;font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:1px solid #0000;border-radius:999px;padding:3px 10px;font-size:12.5px}.v2ZfNW_sort[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}.v2ZfNW_sort:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.v2ZfNW_list{flex-direction:column;flex:1;gap:10px;min-height:0;margin-top:12px;padding-right:4px;display:flex;overflow-y:auto}.v2ZfNW_card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;grid-template-columns:44px 1fr auto;gap:2px 13px;padding:14px 15px;display:grid}.v2ZfNW_card:hover{border-color:var(--dsw-alias-border-l2)}.v2ZfNW_icon{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);object-fit:cover;width:44px;height:44px;color:var(--dsw-alias-label-tertiary);border-radius:10px;grid-row:span 2;place-items:center;font-size:18px;display:grid;overflow:hidden}.v2ZfNW_name{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;margin:0;font-size:14.5px;font-weight:500}.v2ZfNW_variant{color:var(--dsw-alias-label-tertiary)}.v2ZfNW_meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex-wrap:wrap;align-items:center;gap:6px;margin:2px 0 0;font-size:12.5px;display:flex}.v2ZfNW_star{color:var(--dsw-alias-label-secondary)}.v2ZfNW_desc{color:var(--dsw-alias-label-secondary);grid-column:2/4;max-width:74ch;margin:8px 0 0;font-size:13.5px;line-height:1.6}.v2ZfNW_foot{flex-wrap:wrap;grid-column:2/4;align-items:center;gap:9px;margin-top:11px;display:flex}.v2ZfNW_tag{color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 8px;font-size:12px}.v2ZfNW_ghost{appearance:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;background:0 0;border-radius:999px;align-items:center;gap:6px;padding:5px 12px;font-size:13px;text-decoration:none;display:inline-flex}.v2ZfNW_ghost:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}.v2ZfNW_primary{appearance:none;cursor:pointer;background:var(--dsw-alias-brand-primary);min-width:92px;color:var(--dsw-alias-label-primary-foreground);font:inherit;border:0;border-radius:999px;padding:6px 20px;font-size:13px;font-weight:500}.v2ZfNW_primary:hover{background:var(--dsw-alias-button-primary-hover)}.v2ZfNW_primary:disabled{cursor:default;background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-caption)}.v2ZfNW_ghost:focus-visible,.v2ZfNW_primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.v2ZfNW_done{border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:0 0}.v2ZfNW_done:hover{background:var(--dsw-alias-interactive-bg-hover)}.v2ZfNW_log{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;border-radius:8px;grid-column:2/4;max-height:190px;margin-top:10px;padding:8px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.7;overflow:auto}.v2ZfNW_error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-secondary);border-radius:8px;grid-column:2/4;margin-top:10px;padding:9px 12px;font-size:13px}.v2ZfNW_errorTitle{color:var(--dsw-alias-state-error-primary);font-weight:500}.v2ZfNW_errorActions{flex-wrap:wrap;gap:8px;margin-top:9px;display:flex}.v2ZfNW_empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:44px 12px;font-size:14px}.v2ZfNW_emptyHint{color:var(--dsw-alias-label-caption);margin-top:6px;font-size:12.5px}.v2ZfNW_diagRow{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;grid-template-columns:170px 1fr auto;align-items:center;gap:12px;padding:10px 14px;font-size:13.5px;display:grid}.v2ZfNW_diagKey{color:var(--dsw-alias-label-tertiary)}.v2ZfNW_diagValue{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.v2ZfNW_statusOk{color:var(--dsw-alias-state-success-primary);font-size:12px}.v2ZfNW_statusWarn{color:var(--dsw-alias-state-warn-primary);font-size:12px}.v2ZfNW_statusError{color:var(--dsw-alias-state-error-primary);font-size:12px}.v2ZfNW_hint{color:var(--dsw-alias-label-caption);grid-column:2/4;margin-top:4px;font-size:12px}@media (width<=640px){.v2ZfNW_card{grid-template-columns:36px 1fr}.v2ZfNW_diagRow{grid-template-columns:1fr}}.v2ZfNW_appearance{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;margin-top:14px;padding:13px 15px}.v2ZfNW_appearanceTitle{color:var(--dsw-alias-label-primary);align-items:baseline;gap:8px;margin:0;font-size:13px;font-weight:500;display:flex}.v2ZfNW_appearanceCount{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:12px;font-weight:400}.v2ZfNW_cubes{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;flex-wrap:wrap;gap:8px;max-height:152px;margin-top:10px;padding-right:4px;display:flex;overflow-y:auto}.v2ZfNW_cubes::-webkit-scrollbar{width:8px}.v2ZfNW_cubes::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);background-clip:content-box;border:2px solid #0000;border-radius:999px}.v2ZfNW_cubes::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);background-clip:content-box}.v2ZfNW_cube{appearance:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;border-radius:9px;padding:6px 14px;font-size:13px}.v2ZfNW_cube:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}.v2ZfNW_cube[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}.v2ZfNW_cube:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.v2ZfNW_appearanceHint{color:var(--dsw-alias-label-caption);margin:9px 0 0;font-size:12px}";
const tagId = "dsh-skin-market/market.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-skin-market";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var market_module_css_default = {
	"errorActions": "v2ZfNW_errorActions",
	"error": "v2ZfNW_error",
	"name": "v2ZfNW_name",
	"variant": "v2ZfNW_variant",
	"diagValue": "v2ZfNW_diagValue",
	"errorTitle": "v2ZfNW_errorTitle",
	"statusWarn": "v2ZfNW_statusWarn",
	"list": "v2ZfNW_list",
	"card": "v2ZfNW_card",
	"done": "v2ZfNW_done",
	"tabs": "v2ZfNW_tabs",
	"ghost": "v2ZfNW_ghost",
	"count": "v2ZfNW_count",
	"tab": "v2ZfNW_tab",
	"version": "v2ZfNW_version",
	"foot": "v2ZfNW_foot",
	"log": "v2ZfNW_log",
	"primary": "v2ZfNW_primary",
	"empty": "v2ZfNW_empty",
	"emptyHint": "v2ZfNW_emptyHint",
	"diagKey": "v2ZfNW_diagKey",
	"stale": "v2ZfNW_stale",
	"title": "v2ZfNW_title",
	"icon": "v2ZfNW_icon",
	"statusOk": "v2ZfNW_statusOk",
	"appearanceTitle": "v2ZfNW_appearanceTitle",
	"appearanceCount": "v2ZfNW_appearanceCount",
	"head": "v2ZfNW_head",
	"search": "v2ZfNW_search",
	"star": "v2ZfNW_star",
	"cubes": "v2ZfNW_cubes",
	"meta": "v2ZfNW_meta",
	"subtitle": "v2ZfNW_subtitle",
	"desc": "v2ZfNW_desc",
	"appearanceHint": "v2ZfNW_appearanceHint",
	"root": "v2ZfNW_root",
	"hint": "v2ZfNW_hint",
	"cube": "v2ZfNW_cube",
	"diagRow": "v2ZfNW_diagRow",
	"appearance": "v2ZfNW_appearance",
	"tag": "v2ZfNW_tag",
	"statusError": "v2ZfNW_statusError",
	"spacer": "v2ZfNW_spacer",
	"sort": "v2ZfNW_sort",
	"sortbar": "v2ZfNW_sortbar",
	"hits": "v2ZfNW_hits"
};

//#endregion
//#region src/client/SkinCard.tsx
/**
* 卡片状态的键。用安装 spec 而不是包名：真实包名要装完才知道
* （`github:LaplaceYoung/dsh-qq2006` 装出来叫 `@dsh-external/dsh-qq2006`），
* 猜出来的名字既对不上已装列表，也没法用来卸载。
*/
function cardKeyOf(entry) {
	return entry.installSpec ?? entry.skinId;
}
/** 主按钮：一个按钮走完 安装 → 安装中 → 刷新生效 / 已装 → 卸载。 */
function actionButton(props) {
	const { entry, installed, state, t, onInstall, onUninstall } = props;
	if (state.kind === "working") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: market_module_css_default.primary,
		type: "button",
		disabled: true,
		children: t(state.verb === "install" ? "card.installing" : "card.uninstalling")
	});
	if (state.kind === "done") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: `${market_module_css_default.primary} ${market_module_css_default.done}`,
		type: "button",
		onClick: () => {
			window.location.reload();
		},
		children: t("card.reload")
	});
	if (installed) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: market_module_css_default.ghost,
		type: "button",
		onClick: () => {
			onUninstall(entry);
		},
		children: t("card.uninstall")
	});
	if (entry.installSpec === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: market_module_css_default.primary,
		type: "button",
		disabled: true,
		title: t("card.noSpecHint"),
		children: t("card.noSpec")
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: market_module_css_default.primary,
		type: "button",
		onClick: () => {
			onInstall(entry);
		},
		children: t("card.install")
	});
}
/**
* 渲染一张卡片。
* @param props - 条目、状态与回调。
* @returns 卡片元素。
*/
function SkinCard(props) {
	const { entry, state, t, onAllowBuilds, onDismiss } = props;
	const title = entry.variant === void 0 ? entry.slug : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [entry.slug, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: market_module_css_default.variant,
		children: ["#", entry.variant]
	})] });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
		className: market_module_css_default.card,
		children: [
			entry.iconUrl === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: market_module_css_default.icon,
				"aria-hidden": "true",
				children: "◆"
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
				className: market_module_css_default.icon,
				src: entry.iconUrl,
				alt: "",
				loading: "lazy"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				className: market_module_css_default.name,
				children: title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: market_module_css_default.meta,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.author }),
					entry.starCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: market_module_css_default.star,
						children: ["★ ", entry.starCount]
					})] }),
					entry.releasedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.releasedAt })] })
				]
			}),
			entry.tagline !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: market_module_css_default.desc,
				children: entry.tagline
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: market_module_css_default.foot,
				children: [
					entry.category !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: market_module_css_default.tag,
						children: entry.category
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: market_module_css_default.spacer }),
					entry.repoUrl !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
						className: market_module_css_default.ghost,
						href: entry.repoUrl,
						target: "_blank",
						rel: "noreferrer noopener",
						children: ["# ", t("card.source")]
					}),
					actionButton(props)
				]
			}),
			state.kind === "working" && state.log.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				className: market_module_css_default.log,
				children: state.log.join("\n")
			}),
			state.kind === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: market_module_css_default.error,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: market_module_css_default.errorTitle,
						children: state.message
					}),
					state.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: state.detail }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: market_module_css_default.errorActions,
						children: [state.code === "BUILD_SCRIPT_BLOCKED" && entry.installSpec !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: market_module_css_default.primary,
							type: "button",
							onClick: () => {
								onAllowBuilds(entry);
							},
							children: t("card.retryAllow")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: market_module_css_default.ghost,
							type: "button",
							onClick: () => {
								onDismiss(entry);
							},
							children: t("card.dismiss")
						})]
					}),
					state.log.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: market_module_css_default.log,
						children: state.log.join("\n")
					})
				]
			})
		]
	});
}

//#endregion
//#region src/client/panels.tsx
/** 内置项有本地化名字；皮肤注册的主题按它自己的 id 显示。 */
const BUILTIN_LABEL = {
	system: "appearance.system",
	light: "appearance.light",
	dark: "appearance.dark"
};
/** 内置项翻译，皮肤主题原样显示自己的 id。 */
function labelOf(id, t) {
	const key = BUILTIN_LABEL[id];
	return key === void 0 ? id : t(key);
}
/**
* 外观选择器 —— 皮肤装上之后真正生效的那一步。
*
* dsh 自己的外观行只渲染三个内置项，皮肤注册进主题服务后没有界面能选中它。
* 这里把注册表里的全部主题列出来。
* @param props - 选项、文案与回调。
* @returns 区块元素。
*/
function AppearancePicker({ options, t, onSelect }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: market_module_css_default.appearance,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
				className: market_module_css_default.appearanceTitle,
				children: [t("appearance.title"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: market_module_css_default.appearanceCount,
					children: options.length
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: market_module_css_default.cubes,
				children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: market_module_css_default.cube,
					type: "button",
					"aria-pressed": option.active,
					onClick: () => {
						onSelect(option.id);
					},
					children: labelOf(option.id, t)
				}, option.id))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: market_module_css_default.appearanceHint,
				children: t("appearance.hint")
			})
		]
	});
}
/**
* 本机已装皮肤。
* @param props - 列表、状态与回调。
* @returns 面板元素。
*/
function InstalledPanel({ items, states, t, onUninstall }) {
	if (items.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: market_module_css_default.empty,
		children: [t("installed.empty"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: market_module_css_default.emptyHint,
			children: t("installed.emptyHint")
		})]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: market_module_css_default.list,
		children: [items.map((item) => {
			const state = states.get(item.packageName) ?? { kind: "idle" };
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: market_module_css_default.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: market_module_css_default.icon,
						"aria-hidden": "true",
						children: "◆"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: market_module_css_default.name,
						children: item.packageName
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: market_module_css_default.meta,
						children: [
							item.version !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", item.version] }),
							item.spec !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.spec })] }),
							item.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("installed.disabled") })] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: market_module_css_default.foot,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: market_module_css_default.spacer }), state.kind === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: `${market_module_css_default.primary} ${market_module_css_default.done}`,
							type: "button",
							onClick: () => {
								window.location.reload();
							},
							children: t("card.reload")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: market_module_css_default.ghost,
							type: "button",
							disabled: state.kind === "working",
							onClick: () => {
								onUninstall(item.packageName);
							},
							children: t(state.kind === "working" ? "card.uninstalling" : "card.uninstall")
						})]
					}),
					state.kind === "working" && state.log.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: market_module_css_default.log,
						children: state.log.join("\n")
					}),
					state.kind === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: market_module_css_default.error,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: market_module_css_default.errorTitle,
							children: state.message
						}), state.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: state.detail })]
					})
				]
			}, item.packageName);
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: market_module_css_default.emptyHint,
			children: t("installed.local")
		})]
	});
}
const STATUS_CLASS = {
	ok: market_module_css_default.statusOk,
	warn: market_module_css_default.statusWarn,
	error: market_module_css_default.statusError
};
/**
* 环境自查：pnpm、profile、集市连通性、上次安装输出。
* @param props - 数据与刷新回调。
* @returns 面板元素。
*/
function DiagnosticsPanel({ data, t, onRefresh }) {
	if (data === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: market_module_css_default.empty,
		children: t("diag.loading")
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: market_module_css_default.list,
		children: [
			data.rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: market_module_css_default.diagRow,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: market_module_css_default.diagKey,
						children: row.key
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: market_module_css_default.diagValue,
						children: row.value
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: STATUS_CLASS[row.status],
						children: row.status === "ok" ? "正常" : row.status === "warn" ? "注意" : "异常"
					}),
					row.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: market_module_css_default.hint,
						children: row.hint
					})
				]
			}, row.key)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: market_module_css_default.sortbar,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: market_module_css_default.ghost,
					type: "button",
					onClick: onRefresh,
					children: t("diag.refresh")
				})
			}),
			data.lastInstallLog !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: market_module_css_default.emptyHint,
				children: t("diag.log")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				className: market_module_css_default.log,
				children: data.lastInstallLog
			})] })
		]
	});
}

//#endregion
//#region src/client/SkinMarketSection.tsx
/** 搜索防抖：边打字边打服务端会把上游打满，也会让列表抖。 */
const SEARCH_DEBOUNCE_MS = 350;
/** 取值由集市定义，不是我们自己起的名字：popular / latest / name。 */
const SORTS = [
	{
		key: "popular",
		label: "sort.popular"
	},
	{
		key: "latest",
		label: "sort.latest"
	},
	{
		key: "name",
		label: "sort.name"
	}
];
/**
* 市场页。
* @param props - 注入的业务面。
* @returns 页面元素。
*/
function SkinMarketSection({ api, t, version, appearance }) {
	const [tab, setTab] = (0, react.useState)("discover");
	const [term, setTerm] = (0, react.useState)("");
	const [query, setQuery] = (0, react.useState)("");
	const [sort, setSort] = (0, react.useState)("popular");
	const [page, setPage] = (0, react.useState)(void 0);
	const [failure, setFailure] = (0, react.useState)(void 0);
	const [loading, setLoading] = (0, react.useState)(true);
	const [installed, setInstalled] = (0, react.useState)([]);
	const [diagnostics, setDiagnostics] = (0, react.useState)(void 0);
	const [states, setStates] = (0, react.useState)(/* @__PURE__ */ new Map());
	const [themes, setThemes] = (0, react.useState)(() => appearance?.options() ?? []);
	(0, react.useEffect)(() => {
		if (appearance === void 0) return;
		setThemes(appearance.options());
		return appearance.subscribe(() => {
			setThemes(appearance.options());
		});
	}, [appearance]);
	const alive = (0, react.useRef)(true);
	(0, react.useEffect)(() => () => {
		alive.current = false;
	}, []);
	(0, react.useEffect)(() => {
		const timer = setTimeout(() => {
			setQuery(term);
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [term]);
	const loadCatalog = (0, react.useCallback)(async () => {
		setLoading(true);
		setFailure(void 0);
		try {
			const result = await api.catalog({
				q: query,
				sort,
				page: 1
			});
			if (alive.current) setPage(result);
		} catch (error) {
			if (alive.current) setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			if (alive.current) setLoading(false);
		}
	}, [
		api,
		query,
		sort
	]);
	const loadInstalled = (0, react.useCallback)(async () => {
		try {
			const items$1 = await api.installed();
			if (alive.current) setInstalled(items$1);
		} catch {}
	}, [api]);
	(0, react.useEffect)(() => {
		loadCatalog();
	}, [loadCatalog]);
	(0, react.useEffect)(() => {
		loadInstalled();
	}, [loadInstalled]);
	(0, react.useEffect)(() => {
		if (tab !== "diagnostics") return;
		setDiagnostics(void 0);
		api.diagnostics().then((data) => {
			if (alive.current) setDiagnostics(data);
		});
	}, [api, tab]);
	const setState = (0, react.useCallback)((key, next) => {
		setStates((prev) => new Map(prev).set(key, next));
	}, []);
	/** 跑一次装/卸，把过程事件归约进那张卡的状态。 */
	const runAction = (0, react.useCallback)(async (key, verb, action) => {
		const box = { state: {
			kind: "working",
			verb,
			log: []
		} };
		setState(key, box.state);
		await action((event) => {
			box.state = reduce(box.state, event, verb);
			if (alive.current) setState(key, box.state);
		});
		if (box.state.kind === "done") loadInstalled();
	}, [loadInstalled, setState]);
	const onInstall = (0, react.useCallback)((entry) => {
		runAction(cardKeyOf(entry), "install", (onEvent) => api.install(entry.installSpec ?? "", onEvent));
	}, [api, runAction]);
	const onAllowBuilds = (0, react.useCallback)((entry) => {
		runAction(cardKeyOf(entry), "install", (onEvent) => api.allowBuilds(entry.installSpec ?? "", onEvent));
	}, [api, runAction]);
	const onUninstallEntry = (0, react.useCallback)((entry) => {
		const match = installed.find((row) => row.spec === entry.installSpec);
		if (match === void 0) return;
		runAction(cardKeyOf(entry), "uninstall", (onEvent) => api.uninstall(match.packageName, onEvent));
	}, [
		api,
		installed,
		runAction
	]);
	const onUninstallName = (0, react.useCallback)((packageName) => {
		runAction(packageName, "uninstall", (onEvent) => api.uninstall(packageName, onEvent));
	}, [api, runAction]);
	const onDismiss = (0, react.useCallback)((entry) => {
		setState(cardKeyOf(entry), IDLE);
	}, [setState]);
	const installedSpecs = (0, react.useMemo)(() => new Set(installed.map((item) => item.spec).filter((spec) => spec !== void 0)), [installed]);
	const items = page?.items ?? [];
	const total = page?.total ?? 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: market_module_css_default.root,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: market_module_css_default.head,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					className: market_module_css_default.title,
					children: t("nav")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: market_module_css_default.version,
					children: ["v", version]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: market_module_css_default.subtitle,
				children: [
					t("subtitle"),
					" · ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: market_module_css_default.count,
						children: total
					}),
					" · ",
					t("source.live")
				]
			}),
			page?.staleReason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: market_module_css_default.stale,
				children: page.staleReason
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: market_module_css_default.tabs,
				role: "tablist",
				children: [
					"discover",
					"installed",
					"diagnostics"
				].map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					className: market_module_css_default.tab,
					type: "button",
					role: "tab",
					"aria-selected": tab === key,
					onClick: () => {
						setTab(key);
					},
					children: [t(`tab.${key}`), key === "installed" && installed.length > 0 ? ` (${installed.length})` : ""]
				}, key))
			}),
			tab === "discover" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: market_module_css_default.search,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							children: "🔍"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "search",
							value: term,
							placeholder: t("search.placeholder"),
							"aria-label": t("search.placeholder"),
							onChange: (event) => {
								setTerm(event.target.value);
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: market_module_css_default.hits,
							children: t("search.hits", {
								shown: items.length,
								total
							})
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: market_module_css_default.sortbar,
					children: SORTS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: market_module_css_default.sort,
						type: "button",
						"aria-pressed": sort === option.key,
						onClick: () => {
							setSort(option.key);
						},
						children: t(option.label)
					}, option.key))
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: market_module_css_default.list,
					children: [
						loading && items.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: market_module_css_default.empty,
							children: t("state.loading")
						}),
						failure !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: market_module_css_default.empty,
							children: [
								t("state.failed"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: market_module_css_default.emptyHint,
									children: failure
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: market_module_css_default.errorActions,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: market_module_css_default.ghost,
										type: "button",
										onClick: () => {
											loadCatalog();
										},
										children: t("state.retry")
									})
								})
							]
						}),
						!loading && failure === void 0 && items.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: market_module_css_default.empty,
							children: [query === "" ? t("empty.none") : t("empty.search", { term: query }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: market_module_css_default.emptyHint,
								children: query === "" ? t("empty.noneHint") : t("empty.searchHint")
							})]
						}),
						items.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkinCard, {
							entry,
							installed: entry.installSpec !== void 0 && installedSpecs.has(entry.installSpec),
							state: states.get(cardKeyOf(entry)) ?? IDLE,
							t,
							onInstall,
							onUninstall: onUninstallEntry,
							onAllowBuilds,
							onDismiss
						}, `${entry.skinId}:${entry.variant ?? ""}`))
					]
				})
			] }),
			tab === "installed" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [appearance !== void 0 && themes.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AppearancePicker, {
				options: themes,
				t,
				onSelect: appearance.select
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InstalledPanel, {
				items: installed,
				states,
				t,
				onUninstall: onUninstallName
			})] }),
			tab === "diagnostics" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnosticsPanel, {
				data: diagnostics,
				t,
				onRefresh: () => {
					setDiagnostics(void 0);
					api.diagnostics().then((data) => {
						if (alive.current) setDiagnostics(data);
					});
				}
			})
		]
	});
}

//#endregion
//#region src/client/locales.ts
/** `settings.skinMarket` 命名空间的文案。中文是键集真源，英文按同一套键补齐。 */
const zh = {
	"nav": "皮肤市场",
	"subtitle": "为 DeepSeek Harness 发现社区皮肤",
	"source.live": "来自 dsh.a2hmarket.ai",
	"tab.discover": "发现",
	"tab.installed": "已安装",
	"tab.diagnostics": "诊断",
	"search.placeholder": "搜索皮肤：暗色、终端、猫、极简…",
	"search.hits": "{shown} / {total}",
	"sort.popular": "最热",
	"sort.latest": "最新",
	"sort.name": "按名称",
	"card.source": "源码",
	"card.install": "安装",
	"card.installing": "安装中…",
	"card.reload": "刷新页面生效",
	"card.installed": "已安装",
	"card.uninstall": "卸载",
	"card.uninstalling": "卸载中…",
	"card.noSpec": "暂不可装",
	"card.noSpecHint": "这条皮肤没有登记安装地址，先去源码仓库看看",
	"card.retryAllow": "我了解风险，授权并重试",
	"card.dismiss": "知道了",
	"empty.none": "集市里还没有皮肤",
	"empty.noneHint": "皮肤会在作者提交并通过审核后出现在这里",
	"empty.search": "没有匹配「{term}」的皮肤",
	"empty.searchHint": "换个词试试，或清空搜索看全部",
	"state.loading": "正在拉取目录…",
	"state.failed": "目录拉取失败",
	"state.retry": "重试",
	"appearance.title": "外观",
	"appearance.hint": "装上的皮肤要在这里选中才生效 —— dsh 自带的外观行只列前三个",
	"appearance.system": "跟随系统",
	"appearance.light": "浅色",
	"appearance.dark": "深色",
	"installed.empty": "还没装过皮肤",
	"installed.emptyHint": "去「发现」里挑一个",
	"installed.disabled": "已停用",
	"installed.local": "读的是本机 profile，断网也能管",
	"diag.refresh": "重新检测",
	"diag.log": "最近一次安装输出",
	"diag.loading": "正在检测…"
};
const en = {
	"nav": "Skin Market",
	"subtitle": "Discover community skins for DeepSeek Harness",
	"source.live": "from dsh.a2hmarket.ai",
	"tab.discover": "Discover",
	"tab.installed": "Installed",
	"tab.diagnostics": "Diagnostics",
	"search.placeholder": "Search skins: dark, terminal, cat, minimal…",
	"search.hits": "{shown} / {total}",
	"sort.popular": "Popular",
	"sort.latest": "Newest",
	"sort.name": "By name",
	"card.source": "Source",
	"card.install": "Install",
	"card.installing": "Installing…",
	"card.reload": "Reload to apply",
	"card.installed": "Installed",
	"card.uninstall": "Uninstall",
	"card.uninstalling": "Removing…",
	"card.noSpec": "Not installable",
	"card.noSpecHint": "This entry has no install target — check its source repository",
	"card.retryAllow": "I understand — allow and retry",
	"card.dismiss": "Dismiss",
	"empty.none": "No skins in the market yet",
	"empty.noneHint": "Skins appear here once authors submit them and they pass review",
	"empty.search": "Nothing matches “{term}”",
	"empty.searchHint": "Try another word, or clear the search to see everything",
	"state.loading": "Loading catalog…",
	"state.failed": "Could not load the catalog",
	"state.retry": "Retry",
	"appearance.title": "Appearance",
	"appearance.hint": "Pick an installed skin here to apply it — dsh's own Appearance row lists only the first three",
	"appearance.system": "System",
	"appearance.light": "Light",
	"appearance.dark": "Dark",
	"installed.empty": "No skins installed yet",
	"installed.emptyHint": "Pick one from Discover",
	"installed.disabled": "Disabled",
	"installed.local": "Read from your local profile — works offline",
	"diag.refresh": "Re-check",
	"diag.log": "Last install output",
	"diag.loading": "Checking…"
};

//#endregion
//#region src/client/index.ts
/** 本插件拥有的词典命名空间。 */
const NS = "settings.skinMarket";
/** 插件版本，页头展示。发版时与 package.json 一起改。 */
const VERSION = "0.1.0";
/** 需要的浏览器侧服务。 */
const inject = ["slots", "locale"];
/**
* 挂载市场页。
* @param ctx - 浏览器插件上下文。
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "skin-market: dictionaries");
	const t = ctx.locale.bind(NS);
	const api = createApi();
	const theme = ctx.get("theme");
	if (theme !== void 0) ctx.effect(() => restoreSaved(ctx, theme), "skin-market: restore selected skin");
	const appearance = theme === void 0 ? void 0 : {
		options: () => optionsOf(theme.getTheme()),
		subscribe: (listener) => ctx.on("theme/change", listener),
		select: (id) => {
			selectTheme(theme, id);
		}
	};
	const injected = () => ({
		api,
		t,
		version: VERSION,
		...appearance === void 0 ? {} : { appearance }
	});
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "skin-market",
		order: 40,
		label: () => t("nav"),
		locale: NS,
		inject: injected
	}, SkinMarketSection));
}

//#endregion
exports.NS = NS;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });