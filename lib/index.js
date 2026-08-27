import { n as __toDynamicImportESM, r as __toESM, t as require_dist } from "./dist-B0mZ4EzR.js";
import { createRequire } from "node:module";
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

//#region src/spec.ts
/**
* Hosts a tarball may be downloaded from.
*
* The registry catalog is external data, and one rewritten record could hand an arbitrary
* URL to the local `pnpm add`, while a tarball's `postinstall` runs on the user's machine
* outside the agent sandbox. The catalog allowlist (`Catalog.allows`) blocks packages that
* are not listed; it cannot block a listed package whose URL was swapped. Hence a second
* gate on the download host.
*
* The list is deliberately conservative: GitHub Releases / codeload and the npm registry
* cover every normal publishing route, and adding a custom domain requires a code change —
* exactly the friction we want.
*/
const TARBALL_HOSTS = [
	"github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"registry.npmjs.org"
];
/**
* The harness's own scope.
*
* A spec like this in the catalog can only be bad metadata (production has one entry whose
* packageName is `@deepseek-ai/dsh-client-ui-conversation`, probably meaning "I override
* this package"), and installing it would push a host package into the profile. Better to
* mark it uninstallable than let one dirty record touch a user's environment.
*/
const RESERVED_SCOPE = "@deepseek-ai/";
/**
* The harness's own unscoped package names.
*
* These must match exactly, not by prefix: testing `dsh-base` with startsWith would also
* kill a perfectly normal skin named `dsh-based-theme`.
*/
const RESERVED_NAMES = ["dsh-base"];
/**
* Is this package name one of the harness's own?
*
* 🔴 The test must run on the **derived package name**, never as a prefix match on the whole
* spec — `github:deepseek-ai/dsh-base` becomes `deepseek-ai/dsh-base` once the protocol is
* stripped, starts with no reserved name, and would slip straight through.
*
* @param name - A package name or path segment.
* @returns True when it hits a reserved name.
*/
function isReservedName(name$1) {
	return name$1.startsWith(RESERVED_SCOPE) || RESERVED_NAMES.includes(name$1);
}
/** Valid tarball extensions. pnpm would not treat any other suffix as a tarball either. */
const TARBALL_SUFFIXES = [".tgz", ".tar.gz"];
/** An npm package name, optionally scoped, without the version part. */
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
/**
* What may follow `github:owner/repo`.
*
* Only `#ref` (branch / tag / commit). **No paths**: after the monorepo merge a `repoUrl`
* grows into `github.com/org/skins/tree/main/packages/niulai`, and pnpm has no notion of
* installing from a subdirectory of a git repo — letting it through installs the whole
* monorepo as one package into the profile, then rolls back at the mount step with
* NOT_A_BUNDLE. Better to call it uninstallable here than after a full clone.
*/
const GITHUB_TARGET = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/;
/** Strip the trailing version from an npm spec, leaving the package name. */
function npmNameOf(spec) {
	const at = spec.indexOf("@", 1);
	const name$1 = at < 0 ? spec : spec.slice(0, at);
	return NPM_NAME.test(name$1) ? name$1 : void 0;
}
/** Does this URL point at a tarball? */
function isTarballUrl(url) {
	const path = url.pathname.toLowerCase();
	return TARBALL_SUFFIXES.some((suffix) => path.endsWith(suffix));
}
/**
* Classify a spec, and block what should not be installed along the way.
*
* Unrecognised, or recognised but unsafe (plaintext http, a host outside the allowlist, a
* monorepo subdirectory, a harness package) all return undefined — the caller marks the
* entry uninstallable, which is far more honest than failing halfway through.
*
* @param spec - The install spec from the registry.
* @returns The classification, or undefined when judged uninstallable.
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
* Validate the `owner/repo[#ref]` part and build the github classification.
* @param spec - The spec passed back to pnpm verbatim.
* @param target - The `owner/repo[#ref]` left after stripping the protocol.
* @returns The classification, or undefined for uninstallable shapes such as a subpath.
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
* The command a user types to install manually.
*
* `-w` is not optional: the profile directory ships a `pnpm-workspace.yaml`, so pnpm reads
* it as a workspace root and refuses with ERR_PNPM_ADDING_TO_ROOT.
*
* @param spec - The install spec.
* @param profile - Profile name, defaulting to web.
* @returns The full command.
*/
function installCommandFor(spec, profile = "web") {
	return `dsh plugin --profile ${profile} add -w ${spec}`;
}

//#endregion
//#region src/catalog.ts
/**
* Registry URL. **The `/dsh-skin` context path is mandatory** — without it CloudFront falls
* the request back to the SPA and returns 200 with index.html instead of 404, which is deeply
* misleading to debug.
*/
const DEFAULT_CATALOG_ORIGIN = "https://dsh.a2hmarket.ai/dsh-skin";
/** Catalog TTL. The skin catalog changes slowly; ten minutes is plenty and keeps paging off upstream. */
const CACHE_TTL_MS = 600 * 1e3;
/** Upstream timeout. Better to fall back to cache quickly than leave the settings page spinning. */
const UPSTREAM_TIMEOUT_MS = 8e3;
/**
* Popularity-report timeout, half the catalog's: it is optional telemetry, and there is no
* reason to wait longer for a response we can do without.
*/
const REPORT_TIMEOUT_MS = 4e3;
/** Maximum entries per page. More from upstream is truncated, so we never render a thousand cards at once. */
const MAX_PAGE_SIZE = 60;
const str = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
/**
* Derive `github:owner/repo` from a repository URL, as the install spec when there is no npm name.
*
* 🔴 <b>Only URLs pointing exactly at a repository root count.</b> A path segment after
* owner/repo means this repoUrl points somewhere inside the repository — and once a monorepo
* gathers many skins, `github.com/org/skins/tree/main/packages/niulai` is the norm.
*
* pnpm has no notion of installing from a subdirectory of a git repo, so a forced
* `github:org/skins` installs the entire monorepo as one package, makes the user wait through
* a clone, and then rolls back at mount with NOT_A_BUNDLE. Such entries should be marked
* uninstallable from the start, so the author supplies a real installSpec (an npm name or a
* Release tarball).
*
* @param repoUrl - The repository URL registered with the registry.
* @returns The install spec, or undefined when the URL is not a repository root.
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
/** Normalise a date to YYYY-MM-DD; whatever format upstream sends must not break a card. */
function dateOf(value) {
	const raw = str(value);
	if (raw === void 0) return void 0;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : parsed.toISOString().slice(0, 10);
}
/** Upstream cover: prefer an explicit iconUrl, otherwise take the cover from media. */
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
* Author name. The registry currently sends `authorNickname`; the other two shapes (string /
* object) leave room for a future API consolidation, and all three are accepted.
*/
function authorOf(row) {
	const nickname = str(row.authorNickname);
	if (nickname !== void 0) return { name: nickname };
	const raw = row.author;
	if (typeof raw === "object" && raw !== null) {
		const entry = raw;
		return {
			name: str(entry.name) ?? "anonymous",
			...str(entry.homepage) !== void 0 ? { url: str(entry.homepage) } : {}
		};
	}
	return { name: str(raw) ?? str(row.authorName) ?? "anonymous" };
}
/** Tags: the registry sends an array, while an earlier field was a comma-separated string. Both are accepted. */
function tagsOf(row) {
	if (Array.isArray(row.tags)) return row.tags.map(str).filter((tag) => tag !== void 0);
	return (str(row.tags) ?? "").split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
}
/**
* Extract the spec from the full install command the registry provides.
*
* It looks like `dsh plugin --profile web add -w github:owner/repo`. Scan backwards for the
* first word that is not a flag — the spec is always last, and `add` may be followed first by
* `-w` (a required flag: the profile directory ships a pnpm-workspace.yaml, and without it
* pnpm refuses).
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
* One upstream row → one catalog entry.
* Every missing field has a fallback; one incomplete record must never take down a whole page.
* @param raw - One item from the upstream items array.
* @returns The normalised entry, or undefined when even the id is missing (that row is dropped).
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
/** Catalog service: one instance per dsh process. */
var Catalog = class {
	origin;
	cache = /* @__PURE__ */ new Map();
	snapshot;
	/**
	* @param origin - The registry root URL, including the context path.
	*/
	constructor(origin = DEFAULT_CATALOG_ORIGIN) {
		this.origin = origin.replace(/\/+$/, "");
	}
	/**
	* Fetch one catalog page. When upstream is unavailable it falls back to the cache, then the
	* bundled snapshot, and states the source in the result — so the user knows the data is old
	* rather than being shown a pretence of being online.
	* @param query - Search term, sort and pagination.
	* @returns One catalog page. Never throws.
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
				staleReason: `registry unreachable (${reason}); showing the local cache`
			};
			return this.fromSnapshot(query, page, size, reason);
		}
	}
	/**
	* The catalog entry matching this install spec.
	*
	* This is both the pre-install allowlist check (no arbitrary package names) and a way to hand
	* back the entry itself — its skinId reports popularity after installing, so the client never
	* has to send an id it could fabricate.
	*
	* @param spec - The install spec to validate.
	* @returns The matching entry, or undefined when it is not in the catalog.
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
	/** Is this install spec in the catalog — the pre-install allowlist check that blocks arbitrary package names. */
	async allows(spec) {
		return await this.findBySpec(spec) !== void 0;
	}
	/**
	* Report one popularity hit to the registry after a successful install.
	*
	* 🔴 <b>Never affects the install result.</b> A dead registry, a timeout or a business error
	* are all swallowed. The user's skin is already installed, and turning success into failure
	* over a telemetry ping has it backwards — callers should not await this either.
	*
	* @param skinId - The registry entry id.
	* @returns Whether it was actually recorded, for tests and diagnostics.
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
		if (!contentType.includes("json")) throw new Error(`upstream returned ${contentType || "an unknown type"} instead of JSON — check whether the /dsh-skin prefix is missing from the URL`);
		const envelope = await response.json();
		if (envelope.code !== void 0 && envelope.code !== "OK") throw new Error(`registry returned ${envelope.code}: ${envelope.message ?? "no reason given"}`);
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
	/** Bundled snapshot: the last resort when the registry has never been reachable. */
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
			staleReason: `registry unreachable (${reason}); showing the snapshot bundled with the plugin`
		};
	}
};

//#endregion
//#region src/profile.ts
var import_dist = /* @__PURE__ */ __toESM(require_dist(), 1);
/** Ownership marker for inlined entries, written as a leading comment on each top-level entry. */
const OWNER_TAG = "skin-market:";
/** Marker text for a given package. */
const tagOf = (packageName) => `${OWNER_TAG}${packageName}`;
/**
* Resolve ctx.baseUrl to a local directory. It may be a file:// URL or already a path.
* @param baseUrl - The config-tree anchor.
* @returns Absolute profile directory, or undefined when it cannot be resolved.
*/
function profileDirOf(baseUrl) {
	if (baseUrl === void 0 || baseUrl === "") return void 0;
	try {
		return baseUrl.startsWith("file:") ? fileURLToPath(baseUrl) : baseUrl;
	} catch {
		return;
	}
}
/** Is the directory writable? Ask before installing, not halfway through. */
async function isWritable(dir) {
	try {
		await access(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
/** Read the profile's patch file, returning an empty document when absent. */
async function loadPatch(profileDir) {
	const file = join(profileDir, "cordis.patch.yml");
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {
		text = "";
	}
	const doc = (0, import_dist.parseDocument)(text === "" ? "[]" : text);
	if (!(doc.contents instanceof import_dist.YAMLSeq)) throw new Error(`${file} is not an array of patch entries; the market leaves it alone rather than overwrite your config`);
	if (text === "") doc.contents.flow = false;
	return {
		file,
		doc
	};
}
/**
* The ownership marker on a top-level entry — the comment we wrote.
* Extra explanation may follow it, so take only the first word.
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
* The id of a repaired row: named by us, not the author's id that never took effect.
* The full package name guarantees uniqueness (same-named packages under two scopes cannot
* collide), with an ordinal appended when one package contributes several rows.
* @param packageName - The package providing this row.
* @param ordinal - Which repaired row of that package this is, from 0.
* @returns A row id in the uniform format.
*/
const repairedIdOf = (packageName, ordinal) => ordinal === 0 ? `skin:${packageName}` : `skin:${packageName}#${ordinal + 1}`;
/**
* Read the bundle patch file an installed package declares.
* @param profileDir - The profile directory.
* @param packageName - The package name (must be the real one, never guessed from the spec).
* @param packageDir - The package's actual directory; always pass it when pnpm can tell you.
* @returns The parsed patch document.
* @throws When the package is missing, declares no dsh.bundle, or the patch file is unreadable.
*/
async function loadBundlePatch(profileDir, packageName, packageDir) {
	const manifestPath = packageDir !== void 0 ? join(packageDir, "package.json") : resolveManifest(profileDir, packageName);
	let raw;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch {
		throw new Error(`${packageName} installed into a directory with no package.json. This skin most likely lives in a subdirectory of its repository, and pnpm cannot install from a subdirectory of a git repo (only a branch or commit may follow \`#\`). Please install it manually, following the author's instructions on the market page.`);
	}
	const relative = JSON.parse(raw).dsh?.bundle?.patch;
	if (relative === void 0) throw new Error(`${packageName} declares no dsh.bundle.patch — it is a plain dependency, not a mountable skin bundle`);
	const doc = (0, import_dist.parseDocument)(await readFile(resolve(dirname(manifestPath), relative), "utf8"));
	if (!(doc.contents instanceof import_dist.YAMLSeq)) throw new Error(`${relative} in ${packageName} is not an array of patch entries`);
	return doc;
}
/**
* Without a path from pnpm, fall back to finding the manifest ourselves.
*
* Joining `node_modules/<name>` is unreliable: pnpm's isolated layout keeps the real files
* in `.pnpm/<hash>/node_modules/<name>` with only a symlink at the top level, and nothing
* guarantees when that link appears — reading right after install can ENOENT. So try Node's
* resolution algorithm first.
* @param profileDir - The profile directory.
* @param packageName - The package name.
* @returns The package.json path (which may not exist; the caller's read reports that).
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
* List the skins the market installed. The data comes from the local profile and touches no
* network, so this works offline.
* @param profileDir - The profile directory.
* @returns Installed skins, sorted by package name.
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
/** The profile package.json's dependencies. */
async function readDependencies(profileDir) {
	try {
		const raw = await readFile(join(profileDir, "package.json"), "utf8");
		return JSON.parse(raw).dependencies ?? {};
	} catch {
		return {};
	}
}
/**
* Look up a package name in the profile's dependencies by install spec.
*
* For the two "the dependency is already there" cases: a repeat install, and the residue of
* a failed `pnpm remove` during uninstall (patch row gone, dependency still present). pnpm
* sometimes normalises a git spec and appends a commit, so when an exact match fails,
* compare again on the part before `#`.
* @param profileDir - The profile directory.
* @param spec - The install spec from the catalog.
* @returns The matching package name, or undefined.
*/
async function findBySpec(profileDir, spec) {
	const deps = Object.entries(await readDependencies(profileDir));
	const exact = deps.find(([, value]) => value === spec);
	if (exact !== void 0) return exact[0];
	const bare = spec.split("#")[0];
	return deps.find(([, value]) => value.split("#")[0] === bare)?.[0];
}
/** The installed package's actual version. If unreadable, omit it rather than guess. */
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
* Resolve the absolute path of an installed skin's preview image.
*
* 🔴 The path comes from the package's own skin.json, but <b>the resolved result must be
* verified to stay inside the package directory</b> — that field is written by the package
* author, and a value like `../../..` would turn this route into arbitrary file read.
* Validation compares prefixes after resolve, not by searching for `..` in the string
* (encodings such as `%2e%2e` slip past that).
*
* @param profileDir - The profile directory.
* @param packageName - The package name; the caller must first confirm it is installed.
* @returns The absolute preview path, or undefined when absent or out of bounds.
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
* Read the theme id a package registers from its skin.json.
*
* A skin's three ids (skin.json#id, THEME_ID, and the patch's insert.id) must agree by
* convention, so reading skin.json is enough. A package without that file — not a skin built
* to spec — returns nothing, and the UI simply shows no enable button, rather than guessing
* an id for setTheme that fails to switch with no diagnosable reason.
* @param profileDir - The profile directory.
* @param packageName - The package name.
* @returns The theme id, or an empty object when unreadable.
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
* Inline the patch layer an installed skin package declares into the user layer.
*
* Entries are carried over verbatim, with only an ownership comment attached — whether the
* author wrote an `insert` or an override by id, the semantics are preserved. Idempotent:
* already-carried entries are not carried again.
* @param profileDir - The profile directory.
* @param packageName - The real package name, read from the install result rather than guessed.
* @param packageDir - The package's actual directory; always pass it when pnpm can tell you.
* @returns How many entries were carried and how many of them were repaired; rows: 0 when already present.
*/
async function applyBundlePatch(profileDir, packageName, packageDir) {
	const { file, doc } = await loadPatch(profileDir);
	const seq = doc.contents;
	if (seq.items.some((item) => ownerOf(item) === packageName)) return {
		rows: 0,
		repaired: 0
	};
	const rows = (await loadBundlePatch(profileDir, packageName, packageDir)).contents.items;
	if (rows.length === 0) throw new Error(`${packageName}'s bundle patch is empty — there is no plugin row to mount`);
	let repaired = 0;
	for (const row of rows) {
		const plain = JSON.parse(JSON.stringify(row));
		const fixed = repairSelfMount(plain, packageName, repaired);
		const note = fixed === plain ? "" : ` (repaired, original id: ${String(plain.id)})`;
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
* Catch a common bundle-patch mistake: writing "mount myself" as "edit a row".
*
* The patch semantics are: `{insert: [...]}` appends new rows, while `{id, ...}` **overrides
* an existing row by id**, and a missing id only warns and skips (applyEntryPatches in
* vendor/include). So `- id: ui-skin-xxx / name: '<its own package name>'` is a no-op in any
* layer — including the official `dsh.profile.bundles` route, where it installs and silently
* does nothing. Skins in the wild are written this way.
*
* The test is deliberately narrow, matching only the obvious "it meant to mount itself" case:
* no insert, an id present, and a name that is this very package. Genuine override patches
* (name pointing at another package, or no name at all) are untouched.
*
* While repairing, the row id is also switched to our uniform naming: the author's id never
* took effect in the tree, so no other row can reference it, making the change safe — and it
* buys instant recognition of which rows the market installed. Rows the author wrote
* correctly keep even their id, since several rows of one package may reference each other by id.
* @param row - One row from the bundle patch.
* @param packageName - The package providing this row.
* @param ordinal - How many rows of that package have already been repaired.
* @returns The renamed and wrapped row when repair is needed, otherwise the input unchanged.
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
* Remove every entry a package inlined. Only ownership comments count; rows the user wrote
* are never touched.
* @param profileDir - The profile directory.
* @param packageName - The package name.
* @returns Whether anything was actually removed.
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
* Ceiling for a single pnpm invocation.
*
* 🔴 It was 5 minutes, which measurement showed is not enough: a 68.7 MB skin repository
* (the author embedded assets into the bundle, not unusual for skins) cloned through a proxy
* was killed at 310 seconds while barely half done, discarding 132 MB already downloaded and
* forcing a retry from scratch. Mistaking "slow" for "hung" costs far more than waiting.
*
* Twenty minutes is a worst-case backstop, not an expectation — a normal repository finishes
* in tens of seconds. A genuine hang still terminates rather than spinning forever.
*/
const PNPM_TIMEOUT_MS = 1200 * 1e3;
/**
* Heartbeat interval: during a git clone pnpm is completely silent (its progress bar is a TTY
* animation, and under append-only the `Progress: resolved N` line does not move until the
* clone finishes), so the UI looks dead. A line every so often says "still alive", telling
* people to wait rather than retry — a second install click starts a second pnpm competing for
* the same bandwidth, which only makes it slower. We have hit exactly that.
*/
const HEARTBEAT_MS = 20 * 1e3;
/**
* The profile directory ships a `pnpm-workspace.yaml` (`packages: ['.']`, written by dsh at
* init), so pnpm reads it as a workspace root and `pnpm add` refuses with
* ERR_PNPM_ADDING_TO_ROOT. This flag is the "yes, install into the root" declaration —
* measured: without it, nothing installs.
*/
const ROOT_FLAG = "--ignore-workspace-root-check";
/**
* The default reporter prints almost nothing outside a TTY (progress is a TTY animation), so
* during the tens of seconds a git source takes, the UI shows a single DeprecationWarning and
* looks hung. append-only prints progress line by line.
*/
const REPORTER_FLAG = "--reporter=append-only";
/**
* Arguments for `pnpm add`. Only add understands ROOT_FLAG — passing it to remove fails
* outright with "Unknown option", breaking uninstall.
*/
const ADD_FLAGS = [ROOT_FLAG, REPORTER_FLAG];
/** Arguments for `pnpm remove`. */
const REMOVE_FLAGS = [REPORTER_FLAG];
/** The most recent output, returned in diagnostics and error messages. */
let lastLog = "";
/** Full output of the most recent install or uninstall. */
const getLastLog = () => lastLog;
/** A failure carrying a code, from which the route layer decides the status and the message. */
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
* Run a command, streaming its output line by line.
* @param command - The executable.
* @param args - Arguments.
* @param cwd - Working directory.
* @param emit - Line callback; omit it to collect without streaming.
* @returns The exit code and the full output.
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
			output += `\n[timeout] the command did not finish within ${PNPM_TIMEOUT_MS / 6e4} minutes and was terminated.
A very large repository or a very slow network ends up here; what was downloaded is not kept, and a retry starts over.`;
		}, PNPM_TIMEOUT_MS);
		let quietSince = Date.now();
		const heartbeat = setInterval(() => {
			if (settled || emit === void 0) return;
			if (Date.now() - quietSince < HEARTBEAT_MS) return;
			emit({
				type: "log",
				line: `… still downloading, ${Math.round((Date.now() - startedAt) / 1e3)}s elapsed (a large repository can take minutes — please do not click again)`
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
* Ask pnpm for the top-level dependency list and their **real paths**.
*
* This is the authoritative source for package names and directories: joining
* `node_modules/<name>` after an install can miss (under the isolated layout the top level is
* only a symlink, with no guarantee of when it appears), whereas pnpm tells us directly that
* the real files are in `.pnpm/<hash>/node_modules/<name>`.
* @param profileDir - The profile directory.
* @returns A name-to-path map; empty when pnpm cannot answer, and callers fall back themselves.
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
* Is pnpm present, and at what version.
* @param cwd - Working directory.
* @returns The version, or undefined when pnpm is not installed.
*/
async function pnpmVersion(cwd) {
	const result = await run("pnpm", ["--version"], cwd);
	return result.ok ? result.output.trim().split("\n").pop() : void 0;
}
/**
* Does the installed package's declared entry file actually exist?
*
* This is the most important gate: a TypeScript package from a git source relies on `prepare`
* to produce lib/, but pnpm refuses build scripts by default, so the package installs while
* `lib/index.js` does not exist. Once such a package is written into the config, the Loader
* crashes at the next start with ERR_MODULE_NOT_FOUND — **the whole of dsh fails to boot**,
* far worse than a skin that does nothing. So verify before mounting, and roll back on a
* missing file.
* @param packageDir - The package's actual directory.
* @returns The list of missing entry files; an empty array means loadable.
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
/** pnpm skipped prepare because build scripts were not authorised — a git source then lacks build output and cannot load. */
const blockedBuild = (output) => /ignored build scripts|approve-builds|allowBuilds/i.test(output);
/**
* Install a skin package.
* @param profileDir - The profile directory (= ctx.baseUrl).
* @param spec - The install spec, already validated against the catalog allowlist.
* @param packageName - The expected package name, used to write the patch row.
* @param emit - Progress events.
* @throws InstallFailure when any stage fails.
*/
async function install(profileDir, spec, emit) {
	if (!await isWritable(profileDir)) throw new InstallFailure("PROFILE_UNRESOLVED", `profile directory is not writable: ${profileDir}`);
	if ((await listInstalled(profileDir)).some((row) => row.spec === spec)) throw new InstallFailure("ALREADY_INSTALLED", `${spec} is already installed`);
	if (await pnpmVersion(profileDir) === void 0) throw new InstallFailure("PNPM_MISSING", "pnpm is not on PATH. dsh plugin installation forwards to pnpm, so it must be installed first.", "Try corepack enable pnpm, or npm i -g pnpm");
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
		throw new InstallFailure("PNPM_FAILED", `pnpm add ${spec} failed`, tailOf(added.output));
	}
	const packages = await inventory(profileDir);
	const after = await readDependencies(profileDir);
	const packageName = [...packages.keys()].find((name$1) => !before.has(name$1)) ?? Object.keys(after).find((name$1) => !before.has(name$1)) ?? await findBySpec(profileDir, spec);
	if (packageName === void 0) throw new InstallFailure("PNPM_FAILED", "pnpm reported success, but this spec is absent from the profile dependencies, so the installed package name cannot be determined", tailOf(added.output));
	emit({
		type: "log",
		line: `✓ installed ${packageName}`
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
			throw new InstallFailure("BUILD_SCRIPT_BLOCKED", `${packageName} is missing the entry file it declares; installing it would break dsh's next start, so it has been uninstalled.`, `Missing: ${missing.join(", ")}. Packages like this build at install time (a prepare script), which pnpm does not run by default. You may authorise and retry — that permits this package's code to execute on your machine, outside the agent sandbox.`);
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
			line: `✓ inlined the ${applied.rows} patch row(s) declared by ${packageName} into the profile`
		});
		if (applied.repaired > 0) emit({
			type: "log",
			line: `⚠ ${applied.repaired} of them were written as "edit a row that does not exist" and were repaired to "mount myself" — otherwise this skin would install and do nothing (the same happens via the official command; consider telling the author)`
		});
	} catch (error) {
		await run("pnpm", [
			"remove",
			...REMOVE_FLAGS,
			packageName
		], profileDir);
		const reason = error instanceof Error ? error.message : String(error);
		const notABundle = reason.includes("no package.json") || reason.includes("declares no dsh.bundle");
		throw new InstallFailure(notABundle ? "NOT_A_BUNDLE" : "PATCH_WRITE_FAILED", notABundle ? `${spec} cannot be installed; the downloaded package has been removed.` : `${packageName} failed to mount; the package has been removed.`, reason);
	}
	emit({
		type: "step",
		step: "compose"
	});
	emit({
		type: "log",
		line: "✓ the Loader tree will recompose within about a second (no process restart)"
	});
	emit({
		type: "done",
		packageName,
		needsReload: true
	});
	return packageName;
}
/** The single wording for pnpm blocking build scripts: this needs explicit user consent and must never be decided for them. */
function buildBlocked(target) {
	return new InstallFailure("BUILD_SCRIPT_BLOCKED", `${target} needs to run build scripts at install time, which pnpm refused by default.`, "Agreeing permits this package's code to execute on your machine, outside the agent sandbox. On confirmation we write allowBuilds into the profile pnpm-workspace.yaml and retry.");
}
/**
* Uninstall a skin package: remove the patch row first (stopping the mount), then the dependency.
* @param profileDir - The profile directory.
* @param packageName - The package name.
* @param emit - Progress events.
* @throws InstallFailure when it was never installed, or pnpm fails.
*/
async function uninstall(profileDir, packageName, emit) {
	const installed = await listInstalled(profileDir);
	const deps = await readDependencies(profileDir);
	if (!installed.some((row) => row.packageName === packageName) && deps[packageName] === void 0) throw new InstallFailure("NOT_INSTALLED", `${packageName} has neither a mount row nor a dependency entry`);
	emit({
		type: "step",
		step: "patch"
	});
	await removeRow(profileDir, packageName);
	emit({
		type: "log",
		line: "✓ removed from cordis.patch.yml"
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
	if (!removed.ok) throw new InstallFailure("PNPM_FAILED", `The skin is disabled, but pnpm remove ${packageName} failed and the dependency remains in the profile.`, tailOf(removed.output));
	emit({
		type: "done",
		packageName,
		needsReload: true
	});
}
/**
* Authorise a package to run build scripts by writing allowBuilds into the profile's
* pnpm-workspace.yaml. Called only after explicit user consent — it permits that package's
* code to execute locally.
* @param profileDir - The profile directory.
* @param packageName - The package being authorised.
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
/** On error, return only the tail: the preceding dozens of pnpm progress lines do not help diagnosis. */
function tailOf(output, lines = 12) {
	return output.trimEnd().split("\n").slice(-lines).join("\n");
}

//#endregion
//#region src/index.ts
/** Plugin name (the `name` of the loader entry). */
const name = "skin-market";
/** Wait for the web server; without it this plugin is pointless. */
const inject = ["webServer"];
/** Route prefix. The client half builds its URLs from the same constant. */
const API_PREFIX = "/skin-market/api";
/**
* Report one popularity hit to the registry after a successful install.
*
* 🔴 <b>Deliberately not awaited.</b> The skin is already installed and this is pure telemetry.
* A slow or dead registry must not delay the "installed" verdict, still less turn success into
* failure.
*
* Without it, the registry's install counts would only include people who clicked "copy
* install command" on the web page, missing every one-click install from this plugin and
* skewing the ranking.
*
* @param ctx - Plugin context, used only for logging.
* @param catalog - The catalog service.
* @param skinId - The registry entry id, looked up from the spec in the catalog rather than
*   taken from client input.
*/
function reportInstalled(ctx, catalog, skinId) {
	catalog.reportInstall(skinId).then((recorded) => {
		if (!recorded) ctx.logger.debug("[skin-market] install count was not recorded (skinId=%s); the install result is unaffected", skinId);
	});
}
/** Content types for preview images. Only these are recognised; nothing is guessed. */
const IMAGE_TYPES = {
	webp: "image/webp",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	avif: "image/avif",
	gif: "image/gif",
	svg: "image/svg+xml"
};
/** JSON response. */
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
* Allow write operations only from a direct local connection.
*
* Only the socket's peer address counts, and any forwarding header is an outright refusal —
* a reverse proxy relaying an external request also looks like 127.0.0.1 on the socket, so the
* address alone would hollow out the "local installs only" guarantee.
*/
function isDirectLoopback(req) {
	if (req.headers["x-forwarded-for"] !== void 0 || req.headers["x-forwarded-host"] !== void 0) return false;
	const address = req.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** Same-origin POST: when Origin is present it must match Host, blocking other pages from commanding the local port. */
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}
/** Read a JSON request body, with a size cap. */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 64 * 1024) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Open an SSE stream and return a push function. An install can take tens of seconds, and a single response would look hung. */
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
* Shared shell for install and uninstall: authorise, read parameters, open the stream, run, and
* emit failures as events on the stream too.
* @param ctx - Plugin context, for logging.
* @param config - Plugin config.
* @param profileDir - The profile directory.
* @param action - The actual operation.
*/
function writeRoute(ctx, config, profileDir, action) {
	return async (req, res) => {
		if (req.method !== "POST") return json(res, 405, { code: "METHOD_NOT_ALLOWED" });
		if (config.allowInstall === false) return json(res, 403, {
			code: "INSTALL_DISABLED",
			message: "the market is read-only on this machine"
		});
		if (!isDirectLoopback(req) || !isSameOrigin(req)) return json(res, 403, {
			code: "NOT_LOOPBACK",
			message: "installs may only be initiated by a browser connected directly to this machine"
		});
		if (profileDir === void 0) return json(res, 500, {
			code: "PROFILE_UNRESOLVED",
			message: "cannot locate the profile directory (ctx.baseUrl is empty)"
		});
		let body;
		try {
			body = await readBody(req);
		} catch (error) {
			return json(res, 400, {
				code: "BAD_REQUEST",
				message: error instanceof Error ? error.message : "request body could not be parsed"
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
/** Diagnostics: what a user checks first when an install fails, and a screen that is easy to paste to us. */
async function diagnose(profileDir, catalog) {
	const rows = [];
	if (profileDir === void 0) rows.push({
		key: "profile directory",
		value: "unresolved (ctx.baseUrl is empty)",
		status: "error"
	});
	else {
		const writable = await isWritable(profileDir);
		rows.push({
			key: "profile directory",
			value: profileDir,
			status: writable ? "ok" : "error",
			...writable ? {} : { hint: "directory is not writable; installs will fail" }
		});
		const version = await pnpmVersion(profileDir);
		rows.push(version === void 0 ? {
			key: "pnpm",
			value: "not on PATH",
			status: "error",
			hint: "try corepack enable pnpm"
		} : {
			key: "pnpm",
			value: version,
			status: "ok"
		});
		rows.push({
			key: "installed skins",
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
		key: "registry connectivity",
		value: page.source === "live" ? `ok · ${Date.now() - started}ms · ${page.total} entries` : page.staleReason ?? "unavailable",
		status: page.source === "live" ? "ok" : "warn"
	});
	const log = getLastLog();
	return {
		rows,
		...log === "" ? {} : { lastInstallLog: log }
	};
}
/**
* Mount the market's host half.
* @param ctx - Plugin context.
* @param config - Plugin config.
*/
function apply(ctx, config = {}) {
	const catalog = new Catalog(config.catalogOrigin ?? DEFAULT_CATALOG_ORIGIN);
	const profileDir = profileDirOf(ctx.baseUrl);
	if (profileDir === void 0) ctx.logger.warn("[skin-market] ctx.baseUrl is empty, so the profile directory cannot be located and installing is unavailable");
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
				if (spec === "") throw new InstallFailure("SPEC_NOT_IN_CATALOG", "missing install spec");
				const entry = await catalog.findBySpec(spec);
				if (entry === void 0) throw new InstallFailure("SPEC_NOT_IN_CATALOG", `${spec} is not in the registry catalog; the market does not install unlisted packages`);
				await install(dir, spec, emit);
				reportInstalled(ctx, catalog, entry.skinId);
			})
		},
		{
			path: `${API_PREFIX}/uninstall`,
			handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
				const packageName = typeof body.packageName === "string" ? body.packageName : "";
				if (packageName === "") throw new InstallFailure("NOT_INSTALLED", "missing package name");
				await uninstall(dir, packageName, emit);
			})
		},
		{
			path: `${API_PREFIX}/allow-builds`,
			handler: writeRoute(ctx, config, profileDir, async (dir, body, emit) => {
				const spec = typeof body.spec === "string" ? body.spec : "";
				if (spec === "") throw new InstallFailure("SPEC_NOT_IN_CATALOG", "missing spec");
				const entry = await catalog.findBySpec(spec);
				if (entry === void 0) throw new InstallFailure("SPEC_NOT_IN_CATALOG", `${spec} is not in the registry catalog`);
				const info = classifySpec(spec);
				if (info === void 0) throw new InstallFailure("SPEC_NOT_IN_CATALOG", `${spec} is not an installable spec`);
				if (!info.buildsFromSource || info.bareName === void 0) throw new InstallFailure("BUILD_SCRIPT_BLOCKED", `${spec} installs a prebuilt artefact, so build scripts need not — and should not — be authorised.`, "A failure here most likely means the package itself is broken (missing build output, or a misconfigured files field in package.json). Authorising its scripts will not fix that; consider telling the author.");
				await allowBuilds(dir, info.bareName);
				emit({
					type: "log",
					line: `✓ authorised ${info.bareName} to run build scripts; retrying the install`
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
	ctx.logger.info("[skin-market] mounted %s/* (profile: %s)", API_PREFIX, profileDir ?? "unresolved");
}

//#endregion
export { API_PREFIX, Catalog, DEFAULT_CATALOG_ORIGIN, apply, inject, name };