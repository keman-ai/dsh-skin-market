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
/** Kept in sync with the host half's API_PREFIX. */
const PREFIX = "/skin-market/api";
async function getJson(path) {
	const response = await fetch(`${PREFIX}${path}`, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return await response.json();
}
/**
* Consume an SSE stream, parsing `data:` lines into events for the caller.
*
* Hand-written rather than EventSource because this is a POST with a body; EventSource is GET-only.
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
	if (reader === void 0) throw new Error("response has no readable stream");
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
/** Create a market client. */
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
/** Built-in theme ids: dsh's own appearance row owns these; the market does not list them. */
const BUILTIN = new Set(["light", "dark"]);
/** Remembers the chosen skin theme. ui-theme does not persist third-party ids, so we store it ourselves. */
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
* Turn a theme snapshot into the options the appearance section renders.
* @param snapshot - Theme service snapshot.
* @returns Follow-system, then built-ins, then registered skin themes, in that order.
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
* Replay the previously selected skin after the page loads.
*
* A skin's bundle loads asynchronously and is not registered at startup, so this
* subscribes to changes, switches once that theme actually appears in the registry, and
* then stops (later choices belong to select).
* @param ctx - Browser plugin context, used to subscribe to theme/change.
* @param theme - Theme service.
* @returns The unsubscribe function.
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
* Switch appearance and remember the choice.
* @param theme - Theme service.
* @param id - A theme id, or `system`.
*/
function selectTheme(theme, id) {
	theme.setTheme(id);
	write(id);
}

//#endregion
//#region src/client/card-state.ts
/** Idle constant, so we do not allocate a new object everywhere. */
const IDLE = { kind: "idle" };
/** Keep only the tail of the log: install output can run to hundreds of lines and nobody scrolls that far. */
const LOG_LIMIT = 60;
/**
* Reduce one progress event into the card state.
* @param state - Current state.
* @param event - The event received.
* @param verb - The action being performed.
* @returns The new state.
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
const css = ".dshmkt-market-module_root{flex-direction:column;gap:4px;height:100%;min-height:0;display:flex}.dshmkt-market-module_head{align-items:center;gap:10px;display:flex}.dshmkt-market-module_title{color:var(--dsw-alias-label-primary);margin:0;font-size:19px;font-weight:600}.dshmkt-market-module_version{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:12px}.dshmkt-market-module_spacer{flex:auto}.dshmkt-market-module_subtitle{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:13px}.dshmkt-market-module_count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.dshmkt-market-module_stale{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:8px;margin-top:8px;padding:7px 11px;font-size:12.5px}.dshmkt-market-module_tabs{border-bottom:1px solid var(--dsw-alias-border-l1);gap:22px;margin-top:16px;display:flex}.dshmkt-market-module_tab{appearance:none;cursor:pointer;font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-bottom:2px solid #0000;margin-bottom:-1px;padding:0 0 10px;font-size:14px}.dshmkt-market-module_tab:hover{color:var(--dsw-alias-label-secondary)}.dshmkt-market-module_tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary);font-weight:500}.dshmkt-market-module_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.dshmkt-market-module_search{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);border-radius:10px;align-items:center;gap:9px;max-width:560px;margin-top:16px;padding:8px 13px;display:flex}.dshmkt-market-module_search input{min-width:0;font:inherit;color:var(--dsw-alias-label-primary);background:0 0;border:0;outline:0;flex:1;font-size:14px}.dshmkt-market-module_search input::placeholder{color:var(--dsw-alias-label-caption)}.dshmkt-market-module_hits{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}.dshmkt-market-module_sortbar{align-items:center;gap:6px;margin-top:12px;display:flex}.dshmkt-market-module_sort{appearance:none;cursor:pointer;font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:1px solid #0000;border-radius:999px;padding:3px 10px;font-size:12.5px}.dshmkt-market-module_sort[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}.dshmkt-market-module_sort:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.dshmkt-market-module_list{flex-direction:column;flex:1;gap:10px;min-height:0;margin-top:12px;padding-right:4px;display:flex;overflow-y:auto}.dshmkt-market-module_card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;grid-template-columns:44px 1fr auto;gap:2px 13px;padding:14px 15px;display:grid}.dshmkt-market-module_card:hover{border-color:var(--dsw-alias-border-l2)}.dshmkt-market-module_icon{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);object-fit:cover;width:44px;height:44px;color:var(--dsw-alias-label-tertiary);border-radius:10px;grid-row:span 2;place-items:center;font-size:18px;display:grid;overflow:hidden}.dshmkt-market-module_name{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;margin:0;font-size:14.5px;font-weight:500}.dshmkt-market-module_variant{color:var(--dsw-alias-label-tertiary)}.dshmkt-market-module_meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex-wrap:wrap;align-items:center;gap:6px;margin:2px 0 0;font-size:12.5px;display:flex}.dshmkt-market-module_star{color:var(--dsw-alias-label-secondary)}.dshmkt-market-module_desc{color:var(--dsw-alias-label-secondary);grid-column:2/4;max-width:74ch;margin:8px 0 0;font-size:13.5px;line-height:1.6}.dshmkt-market-module_foot{flex-wrap:wrap;grid-column:2/4;align-items:center;gap:9px;margin-top:11px;display:flex}.dshmkt-market-module_tag{color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 8px;font-size:12px}.dshmkt-market-module_kind{white-space:nowrap;border-style:dashed}.dshmkt-market-module_ghost{appearance:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;background:0 0;border-radius:999px;align-items:center;gap:6px;padding:5px 12px;font-size:13px;text-decoration:none;display:inline-flex}.dshmkt-market-module_ghost:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}.dshmkt-market-module_primary{appearance:none;cursor:pointer;background:var(--dsw-alias-brand-primary);min-width:92px;color:var(--dsw-alias-label-primary-foreground);font:inherit;border:0;border-radius:999px;padding:6px 20px;font-size:13px;font-weight:500}.dshmkt-market-module_primary:hover{background:var(--dsw-alias-button-primary-hover)}.dshmkt-market-module_primary:disabled{cursor:default;background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-caption)}.dshmkt-market-module_ghost:focus-visible,.dshmkt-market-module_primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.dshmkt-market-module_done{border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:0 0}.dshmkt-market-module_done:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshmkt-market-module_log{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;border-radius:8px;grid-column:2/4;max-height:190px;margin-top:10px;padding:8px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.7;overflow:auto}.dshmkt-market-module_error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-secondary);border-radius:8px;grid-column:2/4;margin-top:10px;padding:9px 12px;font-size:13px}.dshmkt-market-module_errorTitle{color:var(--dsw-alias-state-error-primary);font-weight:500}.dshmkt-market-module_errorActions{flex-wrap:wrap;gap:8px;margin-top:9px;display:flex}.dshmkt-market-module_empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:44px 12px;font-size:14px}.dshmkt-market-module_emptyHint{color:var(--dsw-alias-label-caption);margin-top:6px;font-size:12.5px}.dshmkt-market-module_diagRow{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;grid-template-columns:170px 1fr auto;align-items:center;gap:12px;padding:10px 14px;font-size:13.5px;display:grid}.dshmkt-market-module_diagKey{color:var(--dsw-alias-label-tertiary)}.dshmkt-market-module_diagValue{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.dshmkt-market-module_statusOk{color:var(--dsw-alias-state-success-primary);font-size:12px}.dshmkt-market-module_statusWarn{color:var(--dsw-alias-state-warn-primary);font-size:12px}.dshmkt-market-module_statusError{color:var(--dsw-alias-state-error-primary);font-size:12px}.dshmkt-market-module_hint{color:var(--dsw-alias-label-caption);grid-column:2/4;margin-top:4px;font-size:12px}@media (width<=640px){.dshmkt-market-module_card{grid-template-columns:36px 1fr}.dshmkt-market-module_diagRow{grid-template-columns:1fr}}.dshmkt-market-module_appearance{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;margin-top:14px;padding:13px 15px}.dshmkt-market-module_appearanceTitle{color:var(--dsw-alias-label-primary);align-items:baseline;gap:8px;margin:0;font-size:13px;font-weight:500;display:flex}.dshmkt-market-module_appearanceCount{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:12px;font-weight:400}.dshmkt-market-module_cubes{flex-wrap:wrap;gap:8px;margin-top:10px;display:flex}.dshmkt-market-module_cubes::-webkit-scrollbar{width:8px}.dshmkt-market-module_cubes::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);background-clip:content-box;border:2px solid #0000;border-radius:999px}.dshmkt-market-module_cubes::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);background-clip:content-box}.dshmkt-market-module_cube{appearance:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;border-radius:9px;padding:6px 14px;font-size:13px}.dshmkt-market-module_cube:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}.dshmkt-market-module_cube[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}.dshmkt-market-module_cube:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.dshmkt-market-module_appearanceHint{color:var(--dsw-alias-label-caption);margin:9px 0 0;font-size:12px}.dshmkt-market-module_installedList{flex-direction:column;gap:10px;display:flex}.dshmkt-market-module_installedRow{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);border-radius:10px;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 14px;display:flex}.dshmkt-market-module_installedIcon{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);object-fit:cover;border-radius:8px;flex:none;width:72px;height:45px}.dshmkt-market-module_iconMissing{object-fit:none;color:#0000}.dshmkt-market-module_installedMain{flex:260px;min-width:0}.dshmkt-market-module_installedName{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;margin:0;font-size:14px;font-weight:600;overflow:hidden}.dshmkt-market-module_installedMeta{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:6px;margin:2px 0 0;font-size:12px;display:flex}.dshmkt-market-module_activeMark{color:var(--dsw-alias-state-success-primary)}.dshmkt-market-module_installedActions{flex:none;align-items:center;gap:8px;display:flex}.dshmkt-market-module_installedActions .dshmkt-market-module_primary,.dshmkt-market-module_installedActions .dshmkt-market-module_ghost{min-width:0;padding:5px 14px}";
const tagId = "dsh-skin-market/market.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-skin-market";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var market_module_css_default = {
	"activeMark": "dshmkt-market-module_activeMark",
	"appearance": "dshmkt-market-module_appearance",
	"appearanceCount": "dshmkt-market-module_appearanceCount",
	"appearanceHint": "dshmkt-market-module_appearanceHint",
	"appearanceTitle": "dshmkt-market-module_appearanceTitle",
	"card": "dshmkt-market-module_card",
	"count": "dshmkt-market-module_count",
	"cube": "dshmkt-market-module_cube",
	"cubes": "dshmkt-market-module_cubes",
	"desc": "dshmkt-market-module_desc",
	"diagKey": "dshmkt-market-module_diagKey",
	"diagRow": "dshmkt-market-module_diagRow",
	"diagValue": "dshmkt-market-module_diagValue",
	"done": "dshmkt-market-module_done",
	"empty": "dshmkt-market-module_empty",
	"emptyHint": "dshmkt-market-module_emptyHint",
	"error": "dshmkt-market-module_error",
	"errorActions": "dshmkt-market-module_errorActions",
	"errorTitle": "dshmkt-market-module_errorTitle",
	"foot": "dshmkt-market-module_foot",
	"ghost": "dshmkt-market-module_ghost",
	"head": "dshmkt-market-module_head",
	"hint": "dshmkt-market-module_hint",
	"hits": "dshmkt-market-module_hits",
	"icon": "dshmkt-market-module_icon",
	"iconMissing": "dshmkt-market-module_iconMissing",
	"installedActions": "dshmkt-market-module_installedActions",
	"installedIcon": "dshmkt-market-module_installedIcon",
	"installedList": "dshmkt-market-module_installedList",
	"installedMain": "dshmkt-market-module_installedMain",
	"installedMeta": "dshmkt-market-module_installedMeta",
	"installedName": "dshmkt-market-module_installedName",
	"installedRow": "dshmkt-market-module_installedRow",
	"kind": "dshmkt-market-module_kind",
	"list": "dshmkt-market-module_list",
	"log": "dshmkt-market-module_log",
	"meta": "dshmkt-market-module_meta",
	"name": "dshmkt-market-module_name",
	"primary": "dshmkt-market-module_primary",
	"root": "dshmkt-market-module_root",
	"search": "dshmkt-market-module_search",
	"sort": "dshmkt-market-module_sort",
	"sortbar": "dshmkt-market-module_sortbar",
	"spacer": "dshmkt-market-module_spacer",
	"stale": "dshmkt-market-module_stale",
	"star": "dshmkt-market-module_star",
	"statusError": "dshmkt-market-module_statusError",
	"statusOk": "dshmkt-market-module_statusOk",
	"statusWarn": "dshmkt-market-module_statusWarn",
	"subtitle": "dshmkt-market-module_subtitle",
	"tab": "dshmkt-market-module_tab",
	"tabs": "dshmkt-market-module_tabs",
	"tag": "dshmkt-market-module_tag",
	"title": "dshmkt-market-module_title",
	"variant": "dshmkt-market-module_variant",
	"version": "dshmkt-market-module_version"
};

//#endregion
//#region src/client/SkinCard.tsx
/**
* Key for card state. The install spec, not the package name: the real name is known only
* after installing (`github:LaplaceYoung/dsh-qq2006` installs as
* `@dsh-external/dsh-qq2006`), and a guessed name neither matches the installed list nor
* works for uninstalling.
*/
function cardKeyOf(entry) {
	return entry.installSpec ?? entry.skinId;
}
/**
* Source badge: where this skin installs from.
*
* On the card rather than only in a tooltip, because a git source and a published artefact
* differ by an order of magnitude in waiting time (cloning a skin repo with embedded assets
* takes minutes; fetching a tarball takes seconds). Users deserve to know how long they will
* wait, and whether consent will be demanded, before they click.
*/
function sourceBadge(entry, t) {
	if (entry.installKind === void 0) return false;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: `${market_module_css_default.tag} ${market_module_css_default.kind}`,
		title: t(`kind.${entry.installKind}.hint`),
		children: t(`kind.${entry.installKind}`)
	});
}
/**
* "Copy install command": the fallback when an automatic install fails.
*
* The command differs by source (a short package name, a github: spec, or a long Release asset
* URL), and the last is too long to retype. So this button is not a nicety — for tarball-sourced
* skins, copying is very nearly the only way to install manually.
*/
function CopyCommandButton({ entry, t }) {
	const [copied, setCopied] = (0, react.useState)(false);
	const command = entry.installCommand;
	if (command === void 0) return false;
	const fallback = () => {
		window.prompt(t("card.copyFallback"), command);
	};
	const copy = () => {
		const clipboard = navigator.clipboard;
		if (clipboard === void 0) return fallback();
		clipboard.writeText(command).then(() => {
			setCopied(true);
			setTimeout(() => {
				setCopied(false);
			}, 2e3);
		}).catch(fallback);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: market_module_css_default.ghost,
		type: "button",
		onClick: copy,
		title: command,
		children: t(copied ? "card.copied" : "card.copyCommand")
	});
}
/** Primary button: one button carries install → installing → refresh to apply / installed → uninstall. */
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
	const hint = entry.installKind === void 0 ? void 0 : t(`kind.${entry.installKind}.hint`);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: market_module_css_default.primary,
		type: "button",
		onClick: () => {
			onInstall(entry);
		},
		...hint !== void 0 ? { title: hint } : {},
		children: t("card.install")
	});
}
/**
* Render one card.
* @param props - Entry, state and callbacks.
* @returns The card element.
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
					sourceBadge(entry, t),
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
						children: [
							state.code === "BUILD_SCRIPT_BLOCKED" && entry.installKind === "github" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: market_module_css_default.primary,
								type: "button",
								onClick: () => {
									onAllowBuilds(entry);
								},
								children: t("card.retryAllow")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CopyCommandButton, {
								entry,
								t
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: market_module_css_default.ghost,
								type: "button",
								onClick: () => {
									onDismiss(entry);
								},
								children: t("card.dismiss")
							})
						]
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
/** Built-ins have localised names; a skin's theme is shown under its own id. */
const BUILTIN_LABEL = {
	system: "appearance.system",
	light: "appearance.light",
	dark: "appearance.dark"
};
/** Translations for built-ins; skin themes display their id verbatim. */
function labelOf(id, t) {
	const key = BUILTIN_LABEL[id];
	return key === void 0 ? id : t(key);
}
/**
* The appearance picker — the step that actually makes an installed skin take effect.
*
* dsh's own appearance row renders only the three built-ins, so once a skin registers with the
* theme service no UI can select it. This lists every theme in the registry.
* @param props - Options, copy and callbacks.
* @returns The section element.
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
* Skins installed on this machine.
* @param props - List, state and callbacks.
* @returns The panel element.
*/
function InstalledPanel({ items, states, t, onUninstall, activeThemeId, onEnable, failure }) {
	if (items.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: market_module_css_default.empty,
		children: [t("installed.empty"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: market_module_css_default.emptyHint,
			children: t("installed.emptyHint")
		})]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: market_module_css_default.installedList,
		children: [
			failure !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: market_module_css_default.empty,
				children: [t("installed.enableFailed"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: market_module_css_default.emptyHint,
					children: failure
				})]
			}),
			items.map((item) => {
				const state = states.get(item.packageName) ?? { kind: "idle" };
				const busy = state.kind === "working";
				const active = item.themeId !== void 0 && item.themeId === activeThemeId;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
					className: market_module_css_default.installedRow,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: market_module_css_default.installedIcon,
							src: `/skin-market/api/icon?package=${encodeURIComponent(item.packageName)}`,
							alt: "",
							loading: "lazy",
							onError: (event) => {
								event.currentTarget.classList.add(market_module_css_default.iconMissing ?? "");
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: market_module_css_default.installedMain,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: market_module_css_default.installedName,
								title: item.spec !== void 0 ? `${item.packageName}\n${item.spec}` : item.packageName,
								children: item.packageName
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: market_module_css_default.installedMeta,
								children: [
									item.version !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", item.version] }),
									item.themeId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.themeId })] }),
									active && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: market_module_css_default.activeMark,
										children: t("installed.active")
									})] }),
									item.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("installed.disabled") })] })
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: market_module_css_default.installedActions,
							children: state.kind === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: `${market_module_css_default.primary} ${market_module_css_default.done}`,
								type: "button",
								onClick: () => {
									window.location.reload();
								},
								children: t("card.reload")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [item.themeId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: active ? market_module_css_default.ghost : market_module_css_default.primary,
								type: "button",
								disabled: busy,
								onClick: () => {
									onEnable(active ? "system" : item.themeId);
								},
								children: t(active ? "installed.disable" : "installed.enable")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: market_module_css_default.ghost,
								type: "button",
								disabled: busy,
								onClick: () => {
									onUninstall(item.packageName);
								},
								children: t(busy ? "card.uninstalling" : "card.uninstall")
							})] })
						}),
						busy && state.log.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
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
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: market_module_css_default.emptyHint,
				children: t("installed.local")
			})
		]
	});
}
const STATUS_CLASS = {
	ok: market_module_css_default.statusOk,
	warn: market_module_css_default.statusWarn,
	error: market_module_css_default.statusError
};
/**
* Environment self-check: pnpm, profile, registry connectivity, and the last install output.
* @param props - Data and the refresh callback.
* @returns The panel element.
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
						children: row.status === "ok" ? "ok" : row.status === "warn" ? "check" : "error"
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
/** Search debounce: hitting the server on every keystroke saturates upstream and makes the list jitter. */
const SEARCH_DEBOUNCE_MS = 350;
/** The values are defined by the registry, not named by us: popular / latest / name. */
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
* The market page.
* @param props - The injected domain surface.
* @returns The page element.
*/
function SkinMarketSection({ api, t, version, appearance }) {
	const [tab, setTab] = (0, react.useState)("discover");
	const [term, setTerm] = (0, react.useState)("");
	const [query, setQuery] = (0, react.useState)("");
	const [sort, setSort] = (0, react.useState)("popular");
	const [page, setPage] = (0, react.useState)(void 0);
	const [failure, setFailure] = (0, react.useState)(void 0);
	/** Why the last Enable click did not switch the skin; cleared on the next attempt. */
	const [enableFailure, setEnableFailure] = (0, react.useState)(void 0);
	const [loading, setLoading] = (0, react.useState)(true);
	const [installed, setInstalled] = (0, react.useState)([]);
	const [diagnostics, setDiagnostics] = (0, react.useState)(void 0);
	const [states, setStates] = (0, react.useState)(/* @__PURE__ */ new Map());
	const [themes, setThemes] = (0, react.useState)(() => appearance?.options() ?? []);
	const builtinThemes = themes.filter((option) => option.builtin);
	/** The currently active theme id, used by the installed list to mark which skin is enabled. */
	const activeThemeId = themes.find((option) => option.active && !option.builtin)?.id;
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
	/** Run one install or uninstall, reducing progress events into that card's state. */
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
			tab === "installed" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [appearance !== void 0 && builtinThemes.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AppearancePicker, {
				options: builtinThemes,
				t,
				onSelect: appearance.select
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InstalledPanel, {
				items: installed,
				states,
				t,
				onUninstall: onUninstallName,
				...activeThemeId !== void 0 ? { activeThemeId } : {},
				...enableFailure !== void 0 ? { failure: enableFailure } : {},
				onEnable: (id) => {
					setEnableFailure(void 0);
					try {
						appearance?.select(id);
					} catch (error) {
						setEnableFailure(error instanceof Error ? error.message : String(error));
					}
				}
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
/** Copy for the `settings.skinMarket` namespace. Chinese is the source of truth for the key set; English mirrors the same keys. */
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
	"card.copyCommand": "复制安装命令",
	"card.copied": "已复制",
	"card.copyFallback": "按 Ctrl/⌘+C 复制这条命令",
	"kind.npm": "npm",
	"kind.npm.hint": "从 npm 安装预构建的包，通常几秒完成，不需要在你的机器上执行构建脚本",
	"kind.tarball": "预构建包",
	"kind.tarball.hint": "下载作者发布的打包产物，通常几秒完成，不需要在你的机器上执行构建脚本",
	"kind.github": "源码构建",
	"kind.github.hint": "要克隆整个仓库并在你的机器上构建，可能需要几分钟；部分皮肤还会请求授权执行构建脚本",
	"empty.none": "集市里还没有皮肤",
	"empty.noneHint": "皮肤会在作者提交并通过审核后出现在这里",
	"empty.search": "没有匹配「{term}」的皮肤",
	"empty.searchHint": "换个词试试，或清空搜索看全部",
	"state.loading": "正在拉取目录…",
	"state.failed": "目录拉取失败",
	"state.retry": "重试",
	"appearance.title": "外观",
	"appearance.hint": "这里只切 dsh 自带的三种；装上的皮肤在「已安装」里点启用",
	"appearance.system": "跟随系统",
	"appearance.light": "浅色",
	"appearance.dark": "深色",
	"installed.empty": "还没装过皮肤",
	"installed.emptyHint": "去「发现」里挑一个",
	"installed.disabled": "已停用",
	"installed.enable": "启用",
	"installed.disable": "停用",
	"installed.active": "生效中",
	"installed.local": "读的是本机 profile，断网也能管",
	"installed.enableFailed": "这套皮肤没能切换",
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
	"card.copyCommand": "Copy install command",
	"card.copied": "Copied",
	"card.copyFallback": "Press Ctrl/⌘+C to copy this command",
	"kind.npm": "npm",
	"kind.npm.hint": "Installs a prebuilt package from npm — usually seconds, and nothing is built on your machine",
	"kind.tarball": "Prebuilt",
	"kind.tarball.hint": "Downloads the author's published bundle — usually seconds, and nothing is built on your machine",
	"kind.github": "From source",
	"kind.github.hint": "Clones the whole repository and builds it on your machine — can take minutes, and some skins will ask permission to run build scripts",
	"empty.none": "No skins in the market yet",
	"empty.noneHint": "Skins appear here once authors submit them and they pass review",
	"empty.search": "Nothing matches “{term}”",
	"empty.searchHint": "Try another word, or clear the search to see everything",
	"state.loading": "Loading catalog…",
	"state.failed": "Could not load the catalog",
	"state.retry": "Retry",
	"appearance.title": "Appearance",
	"appearance.hint": "These are the three built-in modes; installed skins are enabled from the Installed tab",
	"appearance.system": "System",
	"appearance.light": "Light",
	"appearance.dark": "Dark",
	"installed.empty": "No skins installed yet",
	"installed.emptyHint": "Pick one from Discover",
	"installed.disabled": "Disabled",
	"installed.enable": "Enable",
	"installed.disable": "Disable",
	"installed.active": "Active",
	"installed.local": "Read from your local profile — works offline",
	"installed.enableFailed": "That skin did not switch on",
	"diag.refresh": "Re-check",
	"diag.log": "Last install output",
	"diag.loading": "Checking…"
};

//#endregion
//#region src/client/index.ts
/** The locale namespace this plugin owns. */
const NS = "settings.skinMarket";
/** Plugin version, shown in the page header. Bump it together with package.json. */
const VERSION = "0.1.0";
/** Browser-side services required. */
const inject = ["slots", "locale"];
/**
* Mount the market page.
* @param ctx - Browser plugin context.
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "skin-market: dictionaries");
	const t = ctx.locale.bind(NS);
	const api = createApi();
	/**
	* The theme service, filled once ui-theme is ready.
	*
	* 🔴 **Not `ctx.get('theme')` at apply time.** ui-theme ships with the web bundle but this plugin does not
	* declare it in `inject`, so at apply time the service may not be ready — and `get` then hands back a handle
	* that reads fine yet drives nothing: `getTheme()` returns the built-ins, so the appearance row renders and the
	* enable buttons appear, while `setTheme` throws `theme "…" is not registered` because every skin registered on
	* the live instance. Measured on dsh 0.1.2-alpha.2: clicking Enable did nothing at all, and switching to the
	* built-in `dark` through this same handle failed too — which is what proved the handle, not the skins, was the
	* broken part.
	*
	* `ctx.inject` keeps ui-theme optional (a bundle without it simply never runs this callback, and the market
	* still browses and installs) while guaranteeing the instance is the ready, current one.
	*/
	let theme;
	ctx.inject(["theme"], (ready) => {
		theme = ready.get("theme");
		if (theme === void 0) return;
		const runtime = theme;
		ctx.effect(() => restoreSaved(ctx, runtime), "skin-market: restore selected skin");
	});
	const appearance = {
		options: () => theme === void 0 ? [] : optionsOf(theme.getTheme()),
		subscribe: (listener) => ctx.on("theme/change", listener),
		select: (id) => {
			if (theme === void 0) throw new Error("theme service is not available in this bundle");
			selectTheme(theme, id);
		}
	};
	const injected = () => ({
		api,
		t,
		version: VERSION,
		appearance
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