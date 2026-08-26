import { n as __toDynamicImportESM, r as __toESM, t as require_dist } from "./dist-B0mZ4EzR.js";
import { createRequire } from "node:module";
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

//#region src/spec.ts
/**
* tarball 允许的下载主机。
*
* 集市目录是外部数据，一条被改写的记录可以把任意 URL 送到本机的 `pnpm add` 面前，
* 而 tarball 里的 `postinstall` 是在用户机器上、agent 沙箱之外执行的。目录白名单
* （`Catalog.allows`）挡的是「没收录的包」，挡不住「收录了但地址被换掉」，所以下载
* 主机在这里再收一道。
*
* 名单本身是保守的：GitHub Release / codeload 与 npm registry 覆盖了正常发布路径，
* 自建域名要进来就得改代码，这正是想要的摩擦。
*/
const TARBALL_HOSTS = [
	"github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"registry.npmjs.org"
];
/**
* harness 自己的 scope。
*
* 目录里出现这种 spec 只可能是元数据填错（线上就有一条把 packageName 填成
* `@deepseek-ai/dsh-client-ui-conversation` 的，多半是想表达「我覆盖了这个包」），
* 照着装会把宿主自己的包塞进 profile —— 宁可标成「不可装」，
* 也不能让一条脏数据动用户的环境。
*/
const RESERVED_SCOPE = "@deepseek-ai/";
/**
* harness 自己的无 scope 包名。
*
* 这里必须精确匹配而不是前缀匹配：`dsh-base` 用 startsWith 判会连
* `dsh-based-theme` 这种正常皮肤一起误杀。
*/
const RESERVED_NAMES = ["dsh-base"];
/**
* 这个包名是 harness 自己的东西吗。
*
* 🔴 判定必须落在**推导出来的包名**上，不能对整条 spec 做前缀匹配 ——
* `github:deepseek-ai/dsh-base` 剥掉协议前缀之后是 `deepseek-ai/dsh-base`，
* 不以任何保留名开头，于是整条溜过去。
*
* @param name - 包名或路径段。
* @returns 命中保留名则 true。
*/
function isReservedName(name$1) {
	return name$1.startsWith(RESERVED_SCOPE) || RESERVED_NAMES.includes(name$1);
}
/** tarball 的合法扩展名。别的后缀 pnpm 也不会当 tarball 处理。 */
const TARBALL_SUFFIXES = [".tgz", ".tar.gz"];
/** npm 包名（可带 scope），不含版本部分。 */
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
/**
* `github:owner/repo` 后面还允许跟什么。
*
* 只认 `#ref`（分支 / tag / commit）。**不认路径**：monorepo 合并之后
* `repoUrl` 会长成 `github.com/org/skins/tree/main/packages/niulai`，而 pnpm
* 没有「从 git 仓库的子目录安装」这回事 —— 放它过去的结果是把整个 monorepo
* 当一个包装进 profile，然后在挂载那步以 NOT_A_BUNDLE 回滚。
* 与其让用户等完一次 clone 再看见失败，不如在这里就判定为不可装。
*/
const GITHUB_TARGET = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/;
/** 去掉 npm spec 尾部的版本部分，留下包名。 */
function npmNameOf(spec) {
	const at = spec.indexOf("@", 1);
	const name$1 = at < 0 ? spec : spec.slice(0, at);
	return NPM_NAME.test(name$1) ? name$1 : void 0;
}
/** 这个 URL 指向一个 tarball 吗。 */
function isTarballUrl(url) {
	const path = url.pathname.toLowerCase();
	return TARBALL_SUFFIXES.some((suffix) => path.endsWith(suffix));
}
/**
* 把一条 spec 归类，顺带把不该装的挡在外面。
*
* 认不出、或者认出来但不安全（http 明文、主机不在白名单、指向 monorepo 子目录、
* 是 harness 自己的包），一律返回 undefined —— 调用方据此把条目标成「不可装」，
* 这比装到一半失败要诚实得多。
*
* @param spec - 集市给的安装 spec。
* @returns 分类结果；判定为不可装时 undefined。
*/
function classifySpec(spec) {
	if (spec === void 0) return void 0;
	const trimmed = spec.trim();
	if (trimmed === "") return void 0;
	if (trimmed.startsWith("github:")) return githubInfo(trimmed, trimmed.slice(7));
	if (/^(?:git\+)?https?:\/\//.test(trimmed)) {
		let url;
		try {
			url = new URL(trimmed.replace(/^git\+/, ""));
		} catch {
			return;
		}
		if (url.protocol !== "https:") return void 0;
		if (isTarballUrl(url)) {
			if (!TARBALL_HOSTS.includes(url.hostname)) return void 0;
			if (url.pathname.split("/").some(isReservedName)) return void 0;
			return {
				spec: trimmed,
				kind: "tarball",
				buildsFromSource: false
			};
		}
		if (url.hostname !== "github.com") return void 0;
		return githubInfo(trimmed, `${url.pathname.replace(/^\//, "")}${url.hash}`);
	}
	const name$1 = npmNameOf(trimmed);
	if (name$1 === void 0 || isReservedName(name$1)) return void 0;
	return {
		spec: trimmed,
		kind: "npm",
		bareName: name$1,
		buildsFromSource: false
	};
}
/**
* 校验 `owner/repo[#ref]` 部分并组装 github 分类。
* @param spec - 原样回传给 pnpm 的 spec。
* @param target - 去掉协议前缀之后的 `owner/repo[#ref]`。
* @returns 分类结果；带子路径等不可装形态时 undefined。
*/
function githubInfo(spec, target) {
	const match = GITHUB_TARGET.exec(target);
	if (match === null) return void 0;
	const repo = match[2];
	if (repo === void 0 || isReservedName(repo)) return void 0;
	return {
		spec,
		kind: "github",
		bareName: repo,
		buildsFromSource: true
	};
}
/**
* 用户想手动装时该敲的那条命令。
*
* `-w` 不能省：profile 目录自带 `pnpm-workspace.yaml`，pnpm 因此认定它是 workspace 根
* 并以 ERR_PNPM_ADDING_TO_ROOT 拒绝安装。
*
* @param spec - 安装 spec。
* @param profile - profile 名，默认 web。
* @returns 完整命令。
*/
function installCommandFor(spec, profile = "web") {
	return `dsh plugin --profile ${profile} add -w ${spec}`;
}

//#endregion
//#region src/catalog.ts
/**
* 集市地址。**必须带 `/dsh-skin` 这个 context-path** —— 少了它 CloudFront 会把
* 请求回落到 SPA，返回 200 + index.html 而不是 404，排查时极具迷惑性。
*/
const DEFAULT_CATALOG_ORIGIN = "https://dsh.a2hmarket.ai/dsh-skin";
/** 目录缓存有效期。皮肤目录变化很慢，10 分钟足够，也让翻页不打上游。 */
const CACHE_TTL_MS = 600 * 1e3;
/** 上游超时。宁可快速回落到缓存，也不要让设置页转圈。 */
const UPSTREAM_TIMEOUT_MS = 8e3;
/**
* 热度回报超时。比目录短一半：它是可有可无的埋点，
* 拿不到响应就算了，没有任何理由为它多等。
*/
const REPORT_TIMEOUT_MS = 4e3;
/** 一页最多几条。上游给更多也截断，避免一次渲染上千张卡片。 */
const MAX_PAGE_SIZE = 60;
const str = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
/**
* 从仓库地址推 `github:owner/repo`，作为没有 npm 包名时的安装 spec。
*
* 🔴 <b>只认恰好指向仓库根的地址</b>。owner/repo 之后还有路径段，说明这条 repoUrl
* 指的是仓库里的某个位置 —— monorepo 把多个皮肤收进一个仓之后，
* `github.com/org/skins/tree/main/packages/niulai` 正是常态。
*
* 而 pnpm 没有「从 git 仓库的子目录安装」这回事：硬推出来的 `github:org/skins`
* 会把整个 monorepo 当一个包装进 profile，用户等完一次 clone，再在挂载那步
* 以 NOT_A_BUNDLE 回滚。这种条目应当从一开始就标成「不可装」，
* 让作者去补一个真正的 installSpec（npm 包名或 Release tarball）。
*
* @param repoUrl - 集市登记的仓库地址。
* @returns 安装 spec；不是仓库根地址时 undefined。
*/
function githubSpecOf(repoUrl) {
	if (repoUrl === void 0) return void 0;
	let url;
	try {
		url = new URL(repoUrl);
	} catch {
		return;
	}
	if (url.hostname !== "github.com") return void 0;
	const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
	if (segments.length !== 2) return void 0;
	const owner = segments[0];
	const repo = segments[1]?.replace(/\.git$/, "");
	if (owner === void 0 || owner === "" || repo === void 0 || repo === "") return void 0;
	return `github:${owner}/${repo}`;
}
/** 日期归一到 YYYY-MM-DD；上游给什么格式都不让它把卡片弄崩。 */
function dateOf(value) {
	const raw = str(value);
	if (raw === void 0) return void 0;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : parsed.toISOString().slice(0, 10);
}
/** 上游封面：优先显式 iconUrl，退而求其次取 media 里的封面。 */
function iconOf(row) {
	const direct = str(row.iconUrl) ?? str(row.coverUrl);
	if (direct !== void 0) return direct;
	const media = Array.isArray(row.media) ? row.media : [];
	for (const item of media) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item;
		if (str(entry.kind)?.toUpperCase() === "COVER") return str(entry.url);
	}
}
/**
* 作者名。集市当前给的是 `authorNickname`，另外两种形状（字符串 / 对象）
* 是为将来接口收敛留的余地，都吃下来。
*/
function authorOf(row) {
	const nickname = str(row.authorNickname);
	if (nickname !== void 0) return { name: nickname };
	const raw = row.author;
	if (typeof raw === "object" && raw !== null) {
		const entry = raw;
		return {
			name: str(entry.name) ?? "匿名",
			...str(entry.homepage) !== void 0 ? { url: str(entry.homepage) } : {}
		};
	}
	return { name: str(raw) ?? str(row.authorName) ?? "匿名" };
}
/** 标签：集市给的是数组，早期字段是逗号分隔的字符串，两种都认。 */
function tagsOf(row) {
	if (Array.isArray(row.tags)) return row.tags.map(str).filter((tag) => tag !== void 0);
	return (str(row.tags) ?? "").split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
}
/**
* 从集市给的整条安装命令里取出 spec。
*
* 形如 `dsh plugin --profile web add -w github:owner/repo`。从末尾往回找第一个
* 不是 flag 的词 —— spec 总在命令最后，而 `add` 后面可能先跟着 `-w`（那个 flag
* 是必需的：profile 目录自带 pnpm-workspace.yaml，不加会被 pnpm 拒绝）。
*/
function specFromCommand(command) {
	if (command === void 0) return void 0;
	const words = command.trim().split(/\s+/);
	const at = words.lastIndexOf("add");
	if (at < 0) return void 0;
	for (let index = words.length - 1; index > at; index -= 1) {
		const word = words[index];
		if (word === void 0 || word.startsWith("-")) continue;
		return word.startsWith("<") ? void 0 : word;
	}
}
/**
* 上游一行 → 目录条目。
* 缺字段一律兜底，绝不因为某条数据不全就让整页拉不出来。
* @param raw - 上游 items 里的一项。
* @returns 归一化条目；连 id 都没有时返回 undefined（这条丢弃）。
*/
function normalizeEntry(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const row = raw;
	const skinId = str(row.skinId) ?? str(row.id);
	const slug = str(row.slug) ?? str(row.packageName) ?? skinId;
	if (skinId === void 0 || slug === void 0) return void 0;
	const author = authorOf(row);
	const repoUrl = str(row.repoUrl);
	const resolved = classifySpec(str(row.installSpec) ?? specFromCommand(str(row.installCommand)) ?? str(row.packageName) ?? githubSpecOf(repoUrl));
	const variant = str(row.variant);
	const icon = iconOf(row);
	const category = str(row.category) ?? tagsOf(row)[0];
	const releasedAt = dateOf(row.releasedAt ?? row.updatedAt);
	return {
		skinId,
		slug,
		...variant !== void 0 ? { variant } : {},
		name: str(row.name) ?? slug,
		...str(row.tagline) !== void 0 ? { tagline: str(row.tagline) } : {},
		author: author.name,
		...author.url !== void 0 ? { authorUrl: author.url } : {},
		...icon !== void 0 ? { iconUrl: icon } : {},
		...category !== void 0 ? { category } : {},
		starCount: num(row.starCount ?? row.stars),
		...releasedAt !== void 0 ? { releasedAt } : {},
		...repoUrl !== void 0 ? { repoUrl } : {},
		...resolved !== void 0 ? {
			installSpec: resolved.spec,
			installKind: resolved.kind,
			installCommand: installCommandFor(resolved.spec)
		} : {},
		installCount: num(row.installCount)
	};
}
/** 目录服务：一个 dsh 进程一个实例。 */
var Catalog = class {
	origin;
	cache = /* @__PURE__ */ new Map();
	snapshot;
	/**
	* @param origin - 集市根地址，需含 context-path。
	*/
	constructor(origin = DEFAULT_CATALOG_ORIGIN) {
		this.origin = origin.replace(/\/+$/, "");
	}
	/**
	* 取一页目录。上游不可用时依次回落到缓存、随包快照，并在结果里说明来源 ——
	* 让用户知道看到的是旧数据，而不是假装在线。
	* @param query - 搜索词、排序、分页。
	* @returns 一页目录，永不抛错。
	*/
	async page(query) {
		const size = Math.min(Math.max(query.size ?? 24, 1), MAX_PAGE_SIZE);
		const page = Math.max(query.page ?? 1, 1);
		const key = JSON.stringify([
			query.q ?? "",
			query.sort ?? "",
			query.tag ?? "",
			page,
			size
		]);
		const cached = this.cache.get(key);
		if (cached !== void 0 && Date.now() - cached.at < CACHE_TTL_MS) return cached.page;
		try {
			const live = await this.fetchPage({
				...query,
				page,
				size
			});
			this.cache.set(key, {
				at: Date.now(),
				page: live
			});
			return live;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (cached !== void 0) return {
				...cached.page,
				source: "cache",
				staleReason: `集市连不上（${reason}），显示的是本地缓存`
			};
			return this.fromSnapshot(query, page, size, reason);
		}
	}
	/**
	* 目录里这个安装 spec 对应的条目。
	*
	* 既是安装前的白名单校验（不放行任意包名），也顺手把条目本身交出来 ——
	* 装完要用它的 skinId 回报热度，这样就不必让客户端多传一个可以随便捏造的 id。
	*
	* @param spec - 待校验的安装 spec。
	* @returns 命中的条目；目录里没有时 undefined。
	*/
	async findBySpec(spec) {
		let scanned = 0;
		for (let page = 1; page <= 10; page += 1) {
			const result = await this.page({
				page,
				size: MAX_PAGE_SIZE
			});
			for (const item of result.items) if (item.installSpec === spec) return item;
			scanned += result.items.length;
			if (result.items.length === 0 || scanned >= result.total) break;
		}
	}
	/** 目录里有没有这个安装 spec —— 安装前的白名单校验，不放行任意包名。 */
	async allows(spec) {
		return await this.findBySpec(spec) !== void 0;
	}
	/**
	* 安装成功后给集市记一次热度。
	*
	* 🔴 <b>绝不影响安装结果</b>：集市挂了、超时、返回业务错误，一律咽下去。
	* 用户的皮肤已经装好了，为一个统计埋点把成功报成失败是本末倒置 ——
	* 所以调用方也应当不 await 它。
	*
	* @param skinId - 集市条目 id。
	* @returns 是否真的记上了，供测试与诊断判断。
	*/
	async reportInstall(skinId) {
		const url = `${this.origin}/api/v1/public/skins/${encodeURIComponent(skinId)}/install-hit`;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(REPORT_TIMEOUT_MS)
			});
			if (!response.ok) return false;
			const envelope = await response.json();
			return envelope.code === void 0 || envelope.code === "OK";
		} catch {
			return false;
		}
	}
	async fetchPage(query) {
		const url = new URL(`${this.origin}/api/v1/public/skins`);
		url.searchParams.set("page", String(query.page));
		url.searchParams.set("size", String(query.size));
		if (query.q !== void 0 && query.q !== "") url.searchParams.set("keyword", query.q);
		if (query.sort !== void 0 && query.sort !== "") url.searchParams.set("sort", query.sort);
		if (query.tag !== void 0 && query.tag !== "") url.searchParams.set("tag", query.tag);
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("json")) throw new Error(`上游返回了 ${contentType || "未知类型"} 而不是 JSON，检查地址是否漏了 /dsh-skin 前缀`);
		const envelope = await response.json();
		if (envelope.code !== void 0 && envelope.code !== "OK") throw new Error(`集市返回 ${envelope.code}：${envelope.message ?? "未说明原因"}`);
		const data = envelope.data ?? {};
		const items = (data.items ?? []).map(normalizeEntry).filter((entry) => entry !== void 0);
		return {
			items,
			total: typeof data.total === "number" ? data.total : items.length,
			page: query.page,
			size: query.size,
			source: "live"
		};
	}
	/** 随包快照：集市从没连通过时的最后兜底。 */
	async fromSnapshot(query, page, size, reason) {
		if (this.snapshot === void 0) try {
			const file = fileURLToPath(new URL("../snapshot/skins.json", import.meta.url));
			this.snapshot = (JSON.parse(await readFile(file, "utf8")).items ?? []).map(normalizeEntry).filter((entry) => entry !== void 0);
		} catch {
			this.snapshot = [];
		}
		const term = (query.q ?? "").toLowerCase();
		const matched = term === "" ? this.snapshot : this.snapshot.filter((entry) => `${entry.slug} ${entry.name} ${entry.author} ${entry.tagline ?? ""}`.toLowerCase().includes(term));
		return {
			items: matched.slice((page - 1) * size, page * size),
			total: matched.length,
			page,
			size,
			source: "snapshot",
			staleReason: `集市连不上（${reason}），显示的是随插件附带的快照`
		};
	}
};

//#endregion
//#region src/profile.ts
var import_dist = /* @__PURE__ */ __toESM(require_dist(), 1);
/** 内联条目的归属标记，写在每个顶层条目的前置注释里。 */
const OWNER_TAG = "skin-market:";
/** 某个包的标记文本。 */
const tagOf = (packageName) => `${OWNER_TAG}${packageName}`;
/**
* 把 ctx.baseUrl 解成本地目录。它可能是 file:// URL，也可能已经是路径。
* @param baseUrl - 配置树锚点。
* @returns profile 目录绝对路径；解不出来时 undefined。
*/
function profileDirOf(baseUrl) {
	if (baseUrl === void 0 || baseUrl === "") return void 0;
	try {
		return baseUrl.startsWith("file:") ? fileURLToPath(baseUrl) : baseUrl;
	} catch {
		return;
	}
}
/** 目录可写吗 —— 装之前先问，别装到一半才失败。 */
async function isWritable(dir) {
	try {
		await access(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
/** 读 profile 的 patch 文件；不存在时给一份空文档。 */
async function loadPatch(profileDir) {
	const file = join(profileDir, "cordis.patch.yml");
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {
		text = "";
	}
	const doc = (0, import_dist.parseDocument)(text === "" ? "[]" : text);
	if (!(doc.contents instanceof import_dist.YAMLSeq)) throw new Error(`${file} 不是 patch 条目数组，为避免覆盖你的配置，市场不动它`);
	if (text === "") doc.contents.flow = false;
	return {
		file,
		doc
	};
}
/**
* 顶层条目上的归属标记（我们写进去的那条注释）。
* 标记后面可能跟着补充说明，所以只取第一个词。
*/
function ownerOf(item) {
	const comment = item?.commentBefore;
	if (typeof comment !== "string") return void 0;
	for (const line of comment.split("\n")) {
		const at = line.indexOf(OWNER_TAG);
		if (at < 0) continue;
		const owner = line.slice(at + 12).trim().split(/\s+/)[0];
		if (owner !== void 0 && owner !== "") return owner;
	}
}
/**
* 修正后那一行的 id：由我们命名，不沿用作者那个从没生效过的 id。
* 用完整包名保证唯一（两个 scope 下的同名包不会撞），同包多行时追加序号。
* @param packageName - 提供这行的包。
* @param ordinal - 该包第几个被修正的行，从 0 起。
* @returns 统一格式的行 id。
*/
const repairedIdOf = (packageName, ordinal) => ordinal === 0 ? `skin:${packageName}` : `skin:${packageName}#${ordinal + 1}`;
/**
* 读一个已安装包声明的 bundle patch 文件。
* @param profileDir - profile 目录。
* @param packageName - 包名（必须是真实包名，不是从 spec 猜的）。
* @param packageDir - 包的实际目录；调用方能从 pnpm 问到时一定要传。
* @returns 解析后的 patch 文档。
* @throws 包不存在、没声明 dsh.bundle、或 patch 文件读不出来。
*/
async function loadBundlePatch(profileDir, packageName, packageDir) {
	const manifestPath = packageDir !== void 0 ? join(packageDir, "package.json") : resolveManifest(profileDir, packageName);
	let raw;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch {
		throw new Error(`${packageName} 装出来的目录里没有 package.json。这个皮肤多半放在仓库的子目录里，而 pnpm 不支持从 git 仓库的子目录安装（\`#\` 后面只能跟分支或提交）。请按作者在集市页上给的说明手动安装。`);
	}
	const relative = JSON.parse(raw).dsh?.bundle?.patch;
	if (relative === void 0) throw new Error(`${packageName} 没有声明 dsh.bundle.patch —— 它是一个普通依赖，不是能挂载的皮肤组合包`);
	const doc = (0, import_dist.parseDocument)(await readFile(resolve(dirname(manifestPath), relative), "utf8"));
	if (!(doc.contents instanceof import_dist.YAMLSeq)) throw new Error(`${packageName} 的 ${relative} 不是 patch 条目数组`);
	return doc;
}
/**
* 没有 pnpm 给的路径时，退回自己找 manifest。
*
* 直接拼 `node_modules/<包名>` 并不可靠：pnpm 的 isolated 布局把实体放在
* `.pnpm/<hash>/node_modules/<包名>`，顶层只是一个符号链接，而这个链接的
* 建立时机没有保证 —— 装完立刻去读会 ENOENT。所以先走 Node 的解析算法。
* @param profileDir - profile 目录。
* @param packageName - 包名。
* @returns package.json 的路径（可能不存在，由调用方的读操作报错）。
*/
function resolveManifest(profileDir, packageName) {
	const require = createRequire(join(profileDir, "noop.js"));
	try {
		return require.resolve(`${packageName}/package.json`);
	} catch {
		return join(profileDir, "node_modules", packageName, "package.json");
	}
}
/**
* 列出市场装过的皮肤。数据来自本机 profile，不碰网络 —— 断网也能管。
* @param profileDir - profile 目录。
* @returns 已装皮肤，按包名排序。
*/
async function listInstalled(profileDir) {
	const { doc } = await loadPatch(profileDir);
	const deps = await readDependencies(profileDir);
	const seen = /* @__PURE__ */ new Map();
	for (const item of doc.contents.items) {
		const owner = ownerOf(item);
		if (owner === void 0) continue;
		const previous = seen.get(owner) ?? {
			rows: 0,
			disabled: true
		};
		const disabled = item.get?.("disabled") === true;
		seen.set(owner, {
			rows: previous.rows + 1,
			disabled: previous.disabled && disabled
		});
	}
	const out = [];
	for (const [packageName, state] of seen) out.push({
		packageName,
		rowId: tagOf(packageName),
		disabled: state.disabled,
		...deps[packageName] !== void 0 ? { spec: deps[packageName] } : {},
		...await readVersion(profileDir, packageName),
		...await readThemeId(profileDir, packageName)
	});
	return out.sort((a, b) => a.packageName.localeCompare(b.packageName));
}
/** profile package.json 的 dependencies。 */
async function readDependencies(profileDir) {
	try {
		const raw = await readFile(join(profileDir, "package.json"), "utf8");
		return JSON.parse(raw).dependencies ?? {};
	} catch {
		return {};
	}
}
/**
* 在 profile 的依赖里按安装 spec 反查包名。
*
* 用于两种「依赖已经在了」的局面：重复安装，以及卸载时 `pnpm remove` 失败留下的
* 残留（patch 行已摘、依赖还在）。pnpm 有时会把 git spec 规范化并缀上 commit，
* 所以精确比不中时再按 `#` 之前的部分比一次。
* @param profileDir - profile 目录。
* @param spec - 目录给出的安装 spec。
* @returns 匹配到的包名；没有则 undefined。
*/
async function findBySpec(profileDir, spec) {
	const deps = Object.entries(await readDependencies(profileDir));
	const exact = deps.find(([, value]) => value === spec);
	if (exact !== void 0) return exact[0];
	const bare = spec.split("#")[0];
	return deps.find(([, value]) => value.split("#")[0] === bare)?.[0];
}
/** 已装包的实际版本。读不到就不给，不猜。 */
async function readVersion(profileDir, packageName) {
	try {
		const raw = await readFile(join(profileDir, "node_modules", packageName, "package.json"), "utf8");
		const parsed = JSON.parse(raw);
		return parsed.version === void 0 ? {} : { version: parsed.version };
	} catch {
		return {};
	}
}
/**
* 解析某个已装皮肤的预览图绝对路径。
*
* 🔴 路径来自包自己的 skin.json，但<b>必须验证解析结果仍在包目录内</b> ——
* 那个字段是包作者写的，`../../..` 之类的值会让这个路由变成任意文件读取。
* 校验用 resolve 后的前缀比对，不是字符串里找 `..`（`%2e%2e` 那类编码绕得过去）。
*
* @param profileDir - profile 目录。
* @param packageName - 包名，调用方必须先确认它在已装列表里。
* @returns 预览图绝对路径；没有或越界时 undefined。
*/
async function resolveIconPath(profileDir, packageName) {
	if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(packageName)) return void 0;
	const packageDir = join(profileDir, "node_modules", packageName);
	try {
		const skin = JSON.parse(await readFile(join(packageDir, "skin.json"), "utf8"));
		const candidates = Object.values(skin.preview ?? {}).filter((v) => typeof v === "string");
		for (const relative of candidates) {
			const full = resolve(packageDir, relative);
			if (!full.startsWith(resolve(packageDir) + "/")) continue;
			try {
				await access(full, constants.R_OK);
				return full;
			} catch {}
		}
	} catch {}
}
/**
* 从包里的 skin.json 读它注册的主题 id。
*
* 皮肤的三处 id（skin.json#id、THEME_ID、patch 的 insert.id）按约定必须一致，
* 所以读 skin.json 就够。没有这个文件的包（不是按规范做的皮肤）返回空，
* 界面据此不显示启用按钮 —— 而不是猜一个 id 去 setTheme，切不过去还查不出原因。
* @param profileDir - profile 目录。
* @param packageName - 包名。
* @returns 主题 id；读不到时空对象。
*/
async function readThemeId(profileDir, packageName) {
	try {
		const raw = await readFile(join(profileDir, "node_modules", packageName, "skin.json"), "utf8");
		const parsed = JSON.parse(raw);
		return typeof parsed.id === "string" && parsed.id !== "" ? { themeId: parsed.id } : {};
	} catch {
		return {};
	}
}
/**
* 把一个已安装皮肤包声明的 patch 层内联进用户层。
*
* 逐条原样搬运，只给每条挂一个归属注释 —— 作者写的是 `insert` 还是按 id 覆盖，
* 语义都保持不变。已经搬过就不重复搬（幂等）。
* @param profileDir - profile 目录。
* @param packageName - 真实包名（从安装结果读出来的，不是猜的）。
* @param packageDir - 包的实际目录；调用方能从 pnpm 问到时一定要传。
* @returns 搬进去的条目数与其中被修正的行数；已经在了返回 rows: 0。
*/
async function applyBundlePatch(profileDir, packageName, packageDir) {
	const { file, doc } = await loadPatch(profileDir);
	const seq = doc.contents;
	if (seq.items.some((item) => ownerOf(item) === packageName)) return {
		rows: 0,
		repaired: 0
	};
	const rows = (await loadBundlePatch(profileDir, packageName, packageDir)).contents.items;
	if (rows.length === 0) throw new Error(`${packageName} 的 bundle patch 是空的，没有可挂载的插件行`);
	let repaired = 0;
	for (const row of rows) {
		const plain = JSON.parse(JSON.stringify(row));
		const fixed = repairSelfMount(plain, packageName, repaired);
		const note = fixed === plain ? "" : ` （已修正，原 id: ${String(plain.id)}）`;
		if (fixed !== plain) repaired += 1;
		const node = doc.createNode(fixed);
		node.commentBefore = ` ${tagOf(packageName)}${note}`;
		seq.add(node);
	}
	await writeFile(file, doc.toString({ lineWidth: 0 }), "utf8");
	return {
		rows: rows.length,
		repaired
	};
}
/**
* 接住一种常见的 bundle patch 笔误：把「挂载我自己」写成了「改一行」。
*
* patch 的语义是：`{insert: [...]}` 追加新行，而 `{id, ...}` 是**按 id 覆盖已有行**，
* 找不到那个 id 就只 warn 一句然后跳过（vendor/include 的 applyEntryPatches）。
* 于是 `- id: ui-skin-xxx / name: '<自己的包名>'` 这种写法在任何层里都是空操作 ——
* 包括走官方 `dsh.profile.bundles` 时，装了也静默不生效。社区里已经有皮肤这么写。
*
* 判据收得很紧，只认「它显然是想挂载自己」这一种：没有 insert、有 id、且 name
* 正是这个包自己。真正的覆盖型 patch（name 指向别的包，或压根不写 name）不受影响。
*
* 修正时顺手把行 id 换成我们统一命名的那个：作者原来的 id 从没在树里生效过，
* 也就不可能有别的行按它引用，换掉是安全的，换来的是 profile 里一眼能认出
* 哪些行是市场装的。作者写对的行则连 id 都不碰 —— 同包多行之间可能靠 id 互相引用。
* @param row - bundle patch 里的一行。
* @param packageName - 提供这行的包。
* @param ordinal - 该包此前已修正过几行。
* @returns 需要修正时返回改名并包装后的行，否则原样返回入参。
*/
function repairSelfMount(row, packageName, ordinal) {
	if (row.insert !== void 0) return row;
	if (typeof row.id !== "string" || row.name !== packageName) return row;
	return { insert: [{
		...row,
		id: repairedIdOf(packageName, ordinal)
	}] };
}
/**
* 摘掉某个包内联进来的所有条目。只认归属注释，用户自己写的行一律不碰。
* @param profileDir - profile 目录。
* @param packageName - 包名。
* @returns 是否真的删掉了。
*/
async function removeRow(profileDir, packageName) {
	const { file, doc } = await loadPatch(profileDir);
	const seq = doc.contents;
	const before = seq.items.length;
	seq.items = seq.items.filter((item) => ownerOf(item) !== packageName);
	if (seq.items.length === before) return false;
	await writeFile(file, doc.toString({ lineWidth: 0 }), "utf8");
	return true;
}

//#endregion
//#region src/installer.ts
/**
* 单次 pnpm 调用的上限。
*
* 🔴 原本是 5 分钟，实测不够：一个 68.7 MB 的皮肤仓库（作者把素材内嵌进 bundle，
* 这在皮肤里并不罕见）走代理 clone，310 秒才刚拉到一半就被杀了，已下载的 132 MB
* 全部作废，重试还得从头来。把"慢"当成"卡死"，代价比多等一会儿大得多。
*
* 20 分钟是留给最坏情况的兜底，不是期望值 —— 正常仓库几十秒就完事。真卡死了也还是
* 会结束，不会永远转圈。
*/
const PNPM_TIMEOUT_MS = 1200 * 1e3;
/**
* 心跳间隔：git clone 期间 pnpm 完全静默（进度条是 TTY 动画，append-only 下
* 那行 `Progress: resolved N` 拉完之前根本不动），界面看着就像死了。每隔这么久
* 补一行"还活着"，让人知道该等而不是该重试 —— 重复点安装会起第二个 pnpm 抢同一条
* 带宽，只会更慢，实测就撞上过。
*/
const HEARTBEAT_MS = 20 * 1e3;
/**
* profile 目录自带 `pnpm-workspace.yaml`（`packages: ['.']`，dsh 初始化时写的），
* 于是 pnpm 认为它是 workspace 根，`pnpm add` 会以 ERR_PNPM_ADDING_TO_ROOT 拒绝。
* 这里加的正是"我确实要装到根"这个声明 —— 实测不加装不上。
*/
const ROOT_FLAG = "--ignore-workspace-root-check";
/**
* 默认 reporter 在非 TTY 下几乎不输出（进度是 TTY 动画），于是 git 源那几十秒里
* 界面只有一行 DeprecationWarning，看着像卡死。append-only 会逐行打进度。
*/
const REPORTER_FLAG = "--reporter=append-only";
/**
* `pnpm add` 的参数。ROOT_FLAG 只有 add 认识 —— remove 带上它会以
* "Unknown option" 直接失败，卸载功能就废了。
*/
const ADD_FLAGS = [ROOT_FLAG, REPORTER_FLAG];
/** `pnpm remove` 的参数。 */
const REMOVE_FLAGS = [REPORTER_FLAG];
/** 诊断与错误信息里回带的最近一次输出。 */
let lastLog = "";
/** 最近一次安装/卸载的完整输出。 */
const getLastLog = () => lastLog;
/** 带错误码的失败，路由层据此决定回什么状态码和提示。 */
var InstallFailure = class extends Error {
	code;
	detail;
	constructor(code, message, detail) {
		super(message);
		this.name = "InstallFailure";
		this.code = code;
		this.detail = detail;
	}
};
/**
* 跑一条命令并把输出逐行回流。
* @param command - 可执行文件。
* @param args - 参数。
* @param cwd - 工作目录。
* @param emit - 行回调，可省略（只收集不回流）。
* @returns 退出码与完整输出。
*/
function run(command, args, cwd, emit) {
	return new Promise((resolve$1) => {
		const child = spawn(command, [...args], {
			cwd,
			env: process.env
		});
		let output = "";
		let settled = false;
		const startedAt = Date.now();
		const timer = setTimeout(() => {
			if (settled) return;
			child.kill("SIGKILL");
			output += `\n[超时] 命令超过 ${PNPM_TIMEOUT_MS / 6e4} 分钟未结束，已终止。
仓库过大或网络过慢时会走到这里；已下载的部分不会保留，重试将从头开始。`;
		}, PNPM_TIMEOUT_MS);
		let quietSince = Date.now();
		const heartbeat = setInterval(() => {
			if (settled || emit === void 0) return;
			if (Date.now() - quietSince < HEARTBEAT_MS) return;
			emit({
				type: "log",
				line: `… 仍在下载，已用时 ${Math.round((Date.now() - startedAt) / 1e3)}s（大仓库可能要几分钟，请勿重复点击）`
			});
			quietSince = Date.now();
		}, HEARTBEAT_MS);
		const consume = (chunk) => {
			const text = chunk.toString();
			output += text;
			quietSince = Date.now();
			if (emit === void 0) return;
			for (const line of text.split("\n")) {
				const trimmed = line.trimEnd();
				if (trimmed !== "") emit({
					type: "log",
					line: trimmed
				});
			}
		};
		child.stdout.on("data", consume);
		child.stderr.on("data", consume);
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(heartbeat);
			resolve$1({
				ok,
				output
			});
		};
		child.on("error", (error) => {
			output += `\n${error.message}`;
			finish(false);
		});
		child.on("close", (code) => {
			finish(code === 0);
		});
	});
}
/**
* 问 pnpm 要顶层依赖清单及其**实际路径**。
*
* 这是包名与包目录的权威来源：装完自己拼 `node_modules/<包名>` 会踩空
* （isolated 布局下顶层只是符号链接，建立时机没有保证），而 pnpm 直接告诉我们
* 实体在 `.pnpm/<hash>/node_modules/<包名>`。
* @param profileDir - profile 目录。
* @returns 包名到路径的映射；pnpm answer 不了时是空表，调用方各自兜底。
*/
async function inventory(profileDir) {
	const listed = await run("pnpm", [
		"list",
		"--json",
		"--depth=0"
	], profileDir);
	const out = /* @__PURE__ */ new Map();
	if (!listed.ok) return out;
	try {
		const roots = JSON.parse(listed.output);
		for (const root of roots) for (const [name$1, info] of Object.entries(root.dependencies ?? {})) if (typeof info.path === "string") out.set(name$1, {
			name: name$1,
			path: info.path
		});
	} catch {}
	return out;
}
/**
* pnpm 在不在，版本是多少。
* @param cwd - 工作目录。
* @returns 版本号；没装时 undefined。
*/
async function pnpmVersion(cwd) {
	const result = await run("pnpm", ["--version"], cwd);
	return result.ok ? result.output.trim().split("\n").pop() : void 0;
}
/**
* 装进来的包，它声明的入口文件真的在吗。
*
* 这是最要紧的一道闸：git 源的 TypeScript 包要靠 `prepare` 构建出 lib/，而 pnpm
* 默认拒绝执行构建脚本，于是包装上了、`lib/index.js` 却不存在。这种包一旦写进
* 配置，Loader 在下次启动时会以 ERR_MODULE_NOT_FOUND 崩掉 —— **整个 dsh 起不来**，
* 比皮肤不生效严重得多。所以挂载之前先验，缺文件就回滚。
* @param packageDir - 包的实际目录。
* @returns 缺失的入口文件列表；空数组表示可加载。
*/
async function missingEntries(packageDir) {
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	} catch {
		return ["package.json"];
	}
	const candidates = /* @__PURE__ */ new Set();
	const collect = (value) => {
		if (typeof value === "string") {
			if (value.startsWith("./")) candidates.add(value);
			return;
		}
		if (typeof value === "object" && value !== null) for (const nested of Object.values(value)) collect(nested);
	};
	if (typeof manifest.main === "string") candidates.add(manifest.main);
	collect(manifest.exports);
	const missing = [];
	for (const relative of candidates) {
		if (relative.includes("*")) continue;
		try {
			await access(join(packageDir, relative), constants.F_OK);
		} catch {
			missing.push(relative);
		}
	}
	return missing;
}
/** pnpm 因为构建脚本没授权而没跑 prepare —— git 源装完会缺构建产物，加载必挂。 */
const blockedBuild = (output) => /ignored build scripts|approve-builds|allowBuilds/i.test(output);
/**
* 装一个皮肤包。
* @param profileDir - profile 目录（= ctx.baseUrl）。
* @param spec - 安装 spec，必须已经过目录白名单校验。
* @param packageName - 期望的包名，用于写 patch 行。
* @param emit - 过程事件。
* @throws InstallFailure 任一阶段失败。
*/
async function install(profileDir, spec, emit) {
	if (!await isWritable(profileDir)) throw new InstallFailure("PROFILE_UNRESOLVED", `profile 目录不可写：${profileDir}`);
	if ((await listInstalled(profileDir)).some((row) => row.spec === spec)) throw new InstallFailure("ALREADY_INSTALLED", `${spec} 已经装过了`);
	if (await pnpmVersion(profileDir) === void 0) throw new InstallFailure("PNPM_MISSING", "pnpm 不在 PATH 上。dsh 的插件安装本身就是转发 pnpm，所以必须先装它。", "试试 corepack enable pnpm，或 npm i -g pnpm");
	const before = new Set(Object.keys(await readDependencies(profileDir)));
	emit({
		type: "step",
		step: "resolve"
	});
	emit({
		type: "log",
		line: `$ pnpm add ${spec}  (cwd: ${profileDir})`
	});
	emit({
		type: "step",
		step: "download"
	});
	const added = await run("pnpm", [
		"add",
		...ADD_FLAGS,
		spec
	], profileDir, emit);
	lastLog = added.output;
	if (!added.ok) {
		if (blockedBuild(added.output)) throw buildBlocked(spec);
		throw new InstallFailure("PNPM_FAILED", `pnpm add ${spec} 失败`, tailOf(added.output));
	}
	const packages = await inventory(profileDir);
	const after = await readDependencies(profileDir);
	const packageName = [...packages.keys()].find((name$1) => !before.has(name$1)) ?? Object.keys(after).find((name$1) => !before.has(name$1)) ?? await findBySpec(profileDir, spec);
	if (packageName === void 0) throw new InstallFailure("PNPM_FAILED", "pnpm 报告成功，但 profile 依赖里找不到这个 spec，无法确定装上的包名", tailOf(added.output));
	emit({
		type: "log",
		line: `✓ 已安装 ${packageName}`
	});
	if (blockedBuild(added.output)) {
		await run("pnpm", [
			"remove",
			...REMOVE_FLAGS,
			packageName
		], profileDir);
		throw buildBlocked(packageName);
	}
	const packageDir = packages.get(packageName)?.path;
	if (packageDir !== void 0) {
		const missing = await missingEntries(packageDir);
		if (missing.length > 0) {
			await run("pnpm", [
				"remove",
				...REMOVE_FLAGS,
				packageName
			], profileDir);
			throw new InstallFailure("BUILD_SCRIPT_BLOCKED", `${packageName} 缺少它自己声明的入口文件，装上去会让 dsh 下次启动失败，已卸回去。`, `缺：${missing.join("、")}。这类包需要在安装时构建（prepare 脚本），而 pnpm 默认不执行它。授权后可重试 —— 这等于允许该包的代码在你机器上执行，且不在 agent 沙箱内。`);
		}
	}
	emit({
		type: "step",
		step: "patch"
	});
	try {
		const applied = await applyBundlePatch(profileDir, packageName, packageDir);
		emit({
			type: "log",
			line: `✓ 已把 ${packageName} 声明的 ${applied.rows} 行 patch 内联进 profile`
		});
		if (applied.repaired > 0) emit({
			type: "log",
			line: `⚠ 其中 ${applied.repaired} 行写成了「改一个不存在的行」，已按「挂载自己」修正 —— 否则这个皮肤装了也不会生效（用官方命令装同样如此，建议向作者反馈）`
		});
	} catch (error) {
		await run("pnpm", [
			"remove",
			...REMOVE_FLAGS,
			packageName
		], profileDir);
		const reason = error instanceof Error ? error.message : String(error);
		const notABundle = reason.includes("没有 package.json") || reason.includes("没有声明 dsh.bundle");
		throw new InstallFailure(notABundle ? "NOT_A_BUNDLE" : "PATCH_WRITE_FAILED", notABundle ? `${spec} 装不了，已把下载的包卸回去。` : `${packageName} 挂载失败，已把包卸回去。`, reason);
	}
	emit({
		type: "step",
		step: "compose"
	});
	emit({
		type: "log",
		line: "✓ Loader 树将在约 1 秒内热重组（未重启进程）"
	});
	emit({
		type: "done",
		packageName,
		needsReload: true
	});
	return packageName;
}
/** 构建脚本被 pnpm 拦下的统一说法：这一条必须让用户明确点头，不能替他决定。 */
function buildBlocked(target) {
	return new InstallFailure("BUILD_SCRIPT_BLOCKED", `${target} 需要在安装时运行构建脚本，pnpm 默认拒绝了。`, "同意即表示允许该包的代码在你的机器上执行，且不在 agent 沙箱内。确认后我们会把 allowBuilds 写进 profile 的 pnpm-workspace.yaml 并重试。");
}
/**
* 卸一个皮肤包：先摘 patch 行（停止挂载），再删依赖。
* @param profileDir - profile 目录。
* @param packageName - 包名。
* @param emit - 过程事件。
* @throws InstallFailure 没装过或 pnpm 失败。
*/
async function uninstall(profileDir, packageName, emit) {
	const installed = await listInstalled(profileDir);
	const deps = await readDependencies(profileDir);
	if (!installed.some((row) => row.packageName === packageName) && deps[packageName] === void 0) throw new InstallFailure("NOT_INSTALLED", `${packageName} 既没有挂载行也不在依赖里`);
	emit({
		type: "step",
		step: "patch"
	});
	await removeRow(profileDir, packageName);
	emit({
		type: "log",
		line: "✓ 已从 cordis.patch.yml 摘除"
	});
	emit({
		type: "step",
		step: "download"
	});
	emit({
		type: "log",
		line: `$ pnpm remove ${packageName}`
	});
	const removed = await run("pnpm", [
		"remove",
		...REMOVE_FLAGS,
		packageName
	], profileDir, emit);
	lastLog = removed.output;
	if (!removed.ok) throw new InstallFailure("PNPM_FAILED", `皮肤已停用，但 pnpm remove ${packageName} 失败，依赖仍留在 profile 里。`, tailOf(removed.output));
	emit({
		type: "done",
		packageName,
		needsReload: true
	});
}
/**
* 授权某个包运行构建脚本：把 allowBuilds 写进 profile 的 pnpm-workspace.yaml。
* 只在用户显式同意后调用 —— 这等于允许该包代码在本机执行。
* @param profileDir - profile 目录。
* @param packageName - 被授权的包。
*/
async function allowBuilds(profileDir, packageName) {
	const file = join(profileDir, "pnpm-workspace.yaml");
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {
		text = "";
	}
	const { parseDocument: parseDocument$1, YAMLMap } = await import("./dist-DVKNHrvb.js").then(__toDynamicImportESM(1));
	const doc = parseDocument$1(text === "" ? "{}" : text);
	let allow = doc.get("allowBuilds");
	if (!(allow instanceof YAMLMap)) {
		allow = doc.createNode({});
		doc.set("allowBuilds", allow);
	}
	allow.set(packageName, true);
	const { writeFile: writeFile$1 } = await import("node:fs/promises");
	await writeFile$1(file, doc.toString({ lineWidth: 0 }), "utf8");
}
/** 报错时只回带尾部输出：前面几十行 pnpm 进度对定位没有帮助。 */
function tailOf(output, lines = 12) {
	return output.trimEnd().split("\n").slice(-lines).join("\n");
}

//#endregion
//#region src/index.ts
/** 插件名（loader 行的 name）。 */
const name = "skin-market";
/** 等 web 服务就绪；没有它这个插件没有意义。 */
const inject = ["webServer"];
/** 路由前缀。client 半按同一个常量拼 URL。 */
const API_PREFIX = "/skin-market/api";
/**
* 装成功后给集市记一次热度。
*
* 🔴 <b>刻意不 await</b>：皮肤此刻已经装好了，回报是纯统计。集市慢或者挂了，
* 不该让「已装好」这个结论等它，更不该因此把成功报成失败。
*
* 没有这一下的话，集市上的装机量只统计得到「在网页上点了复制安装命令」的人，
* 从本插件一键装的全都不计入，排序会失真。
*
* @param ctx - 插件上下文，只用来打日志。
* @param catalog - 目录服务。
* @param skinId - 集市条目 id，由 spec 在目录里反查得到，不取客户端传入值。
*/
function reportInstalled(ctx, catalog, skinId) {
	catalog.reportInstall(skinId).then((recorded) => {
		if (!recorded) ctx.logger.debug("[skin-market] 装机量回报没记上（skinId=%s），不影响安装结果", skinId);
	});
}
/** 预览图的 content-type。只认这几种，不猜。 */
const IMAGE_TYPES = {
	webp: "image/webp",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	avif: "image/avif",
	gif: "image/gif",
	svg: "image/svg+xml"
};
/** JSON 响应。 */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* 直连本机才放行写操作。
*
* 只认 socket 的对端地址，并且带了转发头就直接拒 —— 一个反代把外部请求转进来时
* socket 看着也是 127.0.0.1，仅凭它会把"本机才能装"这条保证架空。
*/
function isDirectLoopback(req) {
	if (req.headers["x-forwarded-for"] !== void 0 || req.headers["x-forwarded-host"] !== void 0) return false;
	const address = req.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** 同源 POST：Origin 存在时必须与 Host 一致，挡掉别的网页对本地端口发指令。 */
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}
/** 读 JSON 请求体，带体积上限。 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 64 * 1024) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** 开一条 SSE，返回推事件的函数。安装过程可能几十秒，一次性响应会让用户以为卡死。 */
function openStream(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive"
	});
	return (event) => {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	};
}
/**
* 装/卸的公共外壳：鉴权、取参、开流、跑、把失败也当成流里的一条事件发出去。
* @param ctx - 插件上下文（用于日志）。
* @param config - 插件配置。
* @param profileDir - profile 目录。
* @param action - 实际动作。
*/
function writeRoute(ctx, config, profileDir, action) {
	return async (req, res) => {
		if (req.method !== "POST") return json(res, 405, { code: "METHOD_NOT_ALLOWED" });
		if (config.allowInstall === false) return json(res, 403, {
			code: "INSTALL_DISABLED",
			message: "这台机器上的市场是只读的"
		});
		if (!isDirectLoopback(req) || !isSameOrigin(req)) return json(res, 403, {
			code: "NOT_LOOPBACK",
			message: "安装只允许本机直连的浏览器发起"
		});
		if (profileDir === void 0) return json(res, 500, {
			code: "PROFILE_UNRESOLVED",
			message: "定位不到 profile 目录（ctx.baseUrl 为空）"
		});
		let body;
		try {
			body = await readBody(req);
		} catch (error) {
			return json(res, 400, {
				code: "BAD_REQUEST",
				message: error instanceof Error ? error.message : "请求体无法解析"
			});
		}
		const emit = openStream(res);
		try {
			await action(profileDir, body, emit);
		} catch (error) {
			if (error instanceof InstallFailure) emit({
				type: "error",
				code: error.code,
				message: error.message,
				...error.detail !== void 0 ? { detail: error.detail } : {}
			});
			else {
				ctx.logger.warn(error);
				emit({
					type: "error",
					code: "PNPM_FAILED",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		} finally {
			res.end();
		}
	};
}
/** 诊断：装不上时用户第一时间能自查，也方便把这一屏贴给我们。 */
async function diagnose(profileDir, catalog) {
	const rows = [];
	if (profileDir === void 0) rows.push({
		key: "profile 目录",
		value: "未解析（ctx.baseUrl 为空）",
		status: "error"
	});
	else {
		const writable = await isWritable(profileDir);
		rows.push({
			key: "profile 目录",
			value: profileDir,
			status: writable ? "ok" : "error",
			...writable ? {} : { hint: "目录不可写，安装会失败" }
		});
		const version = await pnpmVersion(profileDir);
		rows.push(version === void 0 ? {
			key: "pnpm",
			value: "不在 PATH 上",
			status: "error",
			hint: "试试 corepack enable pnpm"
		} : {
			key: "pnpm",
			value: version,
			status: "ok"
		});
		rows.push({
			key: "已安装皮肤",
			value: String((await listInstalled(profileDir)).length),
			status: "ok"
		});
	}
	const started = Date.now();
	const page = await catalog.page({
		page: 1,
		size: 1
	});
	rows.push({
		key: "集市连通性",
		value: page.source === "live" ? `正常 · ${Date.now() - started}ms · 共 ${page.total} 条` : page.staleReason ?? "不可用",
		status: page.source === "live" ? "ok" : "warn"
	});
	const log = getLastLog();
	return {
		rows,
		...log === "" ? {} : { lastInstallLog: log }
	};
}
/**
* 挂载市场的 host 半。
* @param ctx - 插件上下文。
* @param config - 插件配置。
*/
function apply(ctx, config = {}) {
	const catalog = new Catalog(config.catalogOrigin ?? DEFAULT_CATALOG_ORIGIN);
	const profileDir = profileDirOf(ctx.baseUrl);
	if (profileDir === void 0) ctx.logger.warn("[skin-market] ctx.baseUrl 为空，定位不到 profile 目录，安装功能不可用");
	const routes = [
		{
			path: `${API_PREFIX}/catalog`,
			handler: async (req, res) => {
				const url = new URL(req.url ?? "/", "http://x");
				json(res, 200, await catalog.page({
					q: url.searchParams.get("q") ?? void 0,
					sort: url.searchParams.get("sort") ?? void 0,
					page: Number(url.searchParams.get("page") ?? "1") || 1,
					size: Number(url.searchParams.get("size") ?? "24") || 24
				}));
			}
		},
		{
			path: `${API_PREFIX}/installed`,
			handler: async (_req, res) => {
				json(res, 200, { items: profileDir === void 0 ? [] : await listInstalled(profileDir) });
			}
		},
		{
			path: `${API_PREFIX}/icon`,
			handler: async (req, res) => {
				const packageName = new URL(req.url ?? "/", "http://x").searchParams.get("package") ?? "";
				if (profileDir === void 0 || packageName === "") {
					res.writeHead(404).end();
					return;
				}
				if (!(await listInstalled(profileDir)).some((row) => row.packageName === packageName)) {
					res.writeHead(404).end();
					return;
				}
				const file = await resolveIconPath(profileDir, packageName);
				if (file === void 0) {
					res.writeHead(404).end();
					return;
				}
				try {
					const body = await readFile(file);
					const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
					res.writeHead(200, {
						"content-type": IMAGE_TYPES[ext] ?? "application/octet-stream",
						"content-length": body.byteLength,
						"cache-control": "private, max-age=300"
					});
					res.end(body);
				} catch {
					res.writeHead(404).end();
				}
			}
		},
		{
			path: `${API_PREFIX}/diagnostics`,
			handler: async (_req, res) => {
				json(res, 200, await diagnose(profileDir, catalog));
			}
		},
		{
			path: `${API_PREFIX}/install`,
			handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
				const spec = typeof body.spec === "string" ? body.spec : "";
				if (spec === "") throw new InstallFailure("SPEC_NOT_IN_CATALOG", "缺少安装 spec");
				const entry = await catalog.findBySpec(spec);
				if (entry === void 0) throw new InstallFailure("SPEC_NOT_IN_CATALOG", `${spec} 不在集市目录里，市场不代装未收录的包`);
				await install(dir, spec, emit);
				reportInstalled(ctx, catalog, entry.skinId);
			})
		},
		{
			path: `${API_PREFIX}/uninstall`,
			handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
				const packageName = typeof body.packageName === "string" ? body.packageName : "";
				if (packageName === "") throw new InstallFailure("NOT_INSTALLED", "缺少包名");
				await uninstall(dir, packageName, emit);
			})
		},
		{
			path: `${API_PREFIX}/allow-builds`,
			handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
				const spec = typeof body.spec === "string" ? body.spec : "";
				if (spec === "") throw new InstallFailure("SPEC_NOT_IN_CATALOG", "缺少 spec");
				const entry = await catalog.findBySpec(spec);
				if (entry === void 0) throw new InstallFailure("SPEC_NOT_IN_CATALOG", `${spec} 不在集市目录里`);
				const info = classifySpec(spec);
				if (info === void 0) throw new InstallFailure("SPEC_NOT_IN_CATALOG", `${spec} 不是一条可安装的 spec`);
				if (!info.buildsFromSource || info.bareName === void 0) throw new InstallFailure("BUILD_SCRIPT_BLOCKED", `${spec} 装的是预构建的发布物，不需要、也不应该授权构建脚本。`, "装不上多半是这个包自己有问题（缺构建产物，或者 package.json 的 files 配错了），授权执行它的脚本解决不了，建议向作者反馈。");
				await allowBuilds(dir, info.bareName);
				emit({
					type: "log",
					line: `✓ 已授权 ${info.bareName} 运行构建脚本，正在重试安装`
				});
				await install(dir, spec, emit);
				reportInstalled(ctx, catalog, entry.skinId);
			})
		}
	];
	for (const route of routes) ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: route.path,
		handler: route.handler
	}), `skin-market: ${route.path}`);
	ctx.logger.info("[skin-market] 已挂载 %s/*（profile: %s）", API_PREFIX, profileDir ?? "未解析");
}

//#endregion
export { API_PREFIX, Catalog, DEFAULT_CATALOG_ORIGIN, apply, inject, name };