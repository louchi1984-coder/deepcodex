import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EMPTY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6w7YwAAAABJRU5ErkJggg==";

function codexHomes() {
    const homes = [];
    const shared = process.env.DEEPCODEX_SHARED_CODEX_HOME || process.env.GLOBAL_CODEX_HOME || path.join(os.homedir(), ".codex");
    const current = process.env.CODEX_HOME || process.env.CODEX_HOME_DIR || "";
    for (const home of [shared, current]) {
        if (home && !homes.includes(home)) homes.push(home);
    }
    return homes;
}

function safeReadJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function listJsonFiles(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => path.join(dir, name))
            .sort();
    } catch {
        return [];
    }
}

function readConnectorDirectory() {
    for (const home of codexHomes()) {
        const dir = path.join(home, "cache", "codex_app_directory");
        for (const file of listJsonFiles(dir)) {
            const data = safeReadJson(file);
            if (Array.isArray(data?.connectors)) {
                return {
                    schema_version: data.schema_version || 1,
                    connectors: data.connectors.map(normalizeConnector),
                };
            }
        }
    }
    return { schema_version: 1, connectors: [] };
}

function readAppTools() {
    const tools = [];
    const seen = new Set();
    for (const home of codexHomes()) {
        const dir = path.join(home, "cache", "codex_apps_tools");
        for (const file of listJsonFiles(dir)) {
            const data = safeReadJson(file);
            if (!Array.isArray(data?.tools)) continue;
            for (const tool of data.tools) {
                const key = `${tool.server_name || ""}\u0000${tool.tool_namespace || ""}\u0000${tool.tool_name || ""}\u0000${tool.connector_id || ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                tools.push(tool);
            }
        }
    }
    return { schema_version: 2, tools };
}

function normalizeConnector(connector) {
    const normalized = {
        ...connector,
        id: connector?.id || connector?.connector_id || "",
        name: connector?.name || connector?.displayName || connector?.id || "App",
        description: connector?.description || "",
        logoUrl: connector?.logoUrl ?? null,
        logoUrlDark: connector?.logoUrlDark ?? null,
        distributionChannel: connector?.distributionChannel || "LOCAL_CACHE",
        appMetadata: connector?.appMetadata || {},
        labels: connector?.labels || {},
        installUrl: connector?.installUrl ?? null,
        isAccessible: connector?.isAccessible === true,
        isEnabled: connector?.isEnabled !== false,
        pluginDisplayNames: Array.isArray(connector?.pluginDisplayNames) ? connector.pluginDisplayNames : [],
    };
    if (!Array.isArray(normalized.supported_auth)) {
        normalized.supported_auth = [{ type: "UNSUPPORTED" }];
    }
    if (!normalized.link_params_schema) normalized.link_params_schema = { type: "object", properties: {} };
    return normalized;
}

function findConnector(connectorId) {
    const directory = readConnectorDirectory();
    return directory.connectors.find((connector) => connector.id === connectorId) || null;
}

function readPluginRegistrations() {
    const plugins = [];
    const seen = new Set();
    for (const home of codexHomes()) {
        collectPluginDirs(path.join(home, ".tmp", "plugins", "plugins"), "local", plugins, seen);
        collectPluginCache(path.join(home, "plugins", "cache"), plugins, seen);
    }
    plugins.sort((a, b) => a.plugin.id.localeCompare(b.plugin.id));
    return plugins;
}

function collectPluginCache(cacheRoot, plugins, seen) {
    let marketplaces = [];
    try {
        marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return;
    }
    for (const marketplace of marketplaces) {
        const marketplaceRoot = path.join(cacheRoot, marketplace);
        let pluginNames = [];
        try {
            pluginNames = fs.readdirSync(marketplaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
            continue;
        }
        for (const pluginName of pluginNames) {
            const pluginRoot = path.join(marketplaceRoot, pluginName);
            let versions = [];
            try {
                versions = fs.readdirSync(pluginRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
            } catch {
                continue;
            }
            const versionDir = versions.length ? path.join(pluginRoot, versions[versions.length - 1]) : pluginRoot;
            collectPluginDir(versionDir, marketplace, plugins, seen);
        }
    }
}

function collectPluginDirs(root, marketplaceName, plugins, seen) {
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return;
    }
    for (const name of entries) collectPluginDir(path.join(root, name), marketplaceName, plugins, seen);
}

function collectPluginDir(pluginDir, marketplaceName, plugins, seen) {
    const metadata = safeReadJson(path.join(pluginDir, ".codex-plugin", "plugin.json"));
    if (!metadata?.name) return;
    const key = `${metadata.name}@${marketplaceName}`;
    if (seen.has(key)) return;
    seen.add(key);
    plugins.push({
        marketplaceName,
        summary: metadata,
        plugin: {
            id: metadata.name,
            installed: true,
            enabled: true,
            name: metadata.name,
            version: metadata.version || "",
            description: metadata.description || "",
            interface: metadata.interface || {},
            authPolicy: "NONE",
            apps: pluginApps(pluginDir),
        },
    });
}

function pluginApps(pluginDir) {
    const appData = safeReadJson(path.join(pluginDir, ".app.json"));
    if (!appData?.apps || typeof appData.apps !== "object") return [];
    return Object.entries(appData.apps).flatMap(([name, app]) => {
        if (!app || typeof app !== "object" || !app.id) return [];
        return [{ ...normalizeConnector({ ...app, id: app.id, name }), name }];
    });
}

function pluginsPayload() {
    const plugins = readPluginRegistrations();
    return {
        featuredPluginIds: [],
        marketplaceLoadErrors: [],
        marketplaces: [],
        plugins,
        items: plugins,
        data: plugins,
        installed: plugins.filter((plugin) => plugin.plugin.installed),
    };
}

function connectorDirectoryPayload() {
    const directory = readConnectorDirectory();
    return {
        ...directory,
        items: directory.connectors,
        data: directory.connectors,
    };
}

function whamAppsPayload() {
    const directory = readConnectorDirectory();
    const tools = readAppTools();
    return {
        apps: directory.connectors,
        connectors: directory.connectors,
        tools: tools.tools,
    };
}

function connectorIdFromPath(pathname, suffix = "") {
    const match = pathname.match(/^\/backend-api\/aip\/connectors\/([^/]+)(?:\/.*)?$/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    if (suffix && !pathname.endsWith(suffix)) return null;
    return id;
}

function connectorDetailPayload(connectorId) {
    return findConnector(connectorId) || normalizeConnector({ id: connectorId, name: connectorId, isAccessible: false, isEnabled: false });
}

function connectorLogoPayload() {
    return { contentType: "image/png", base64: EMPTY_PNG_BASE64 };
}

function localBackendApiResponse(method, pathname) {
    if (method === "POST" && pathname === "/backend-api/codex/analytics-events/events") {
        return { ok: true };
    }
    if (method === "POST" && pathname === "/backend-api/wham/apps") {
        return whamAppsPayload();
    }
    if (method === "GET" && (pathname === "/backend-api/plugins/featured" || pathname === "/backend-api/plugins/list")) {
        return pluginsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/ps/plugins/installed") {
        return pluginsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/connectors/directory/list") {
        return connectorDirectoryPayload();
    }
    if (method === "GET" && pathname === "/backend-api/aip/connectors") {
        return connectorDirectoryPayload();
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+\/logo$/)) {
        return connectorLogoPayload();
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+\/link$/)) {
        return { link: null };
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+\/tos$/)) {
        return { blurbs: [], personalization_toggles: [] };
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+$/)) {
        return connectorDetailPayload(connectorIdFromPath(pathname));
    }
    if (method === "POST" && pathname === "/backend-api/aip/connectors/links/noauth") {
        return { ok: true, link: null };
    }
    if (method === "POST" && pathname === "/backend-api/aip/connectors/links/oauth") {
        return { redirect_url: null };
    }
    return null;
}

export {
    connectorDirectoryPayload,
    localBackendApiResponse,
    pluginsPayload,
    readAppTools,
    readConnectorDirectory,
    readPluginRegistrations,
};
