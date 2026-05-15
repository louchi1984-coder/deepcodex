import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const asarPath = process.argv[2];
const exePath = process.argv[3] || "";

if (!asarPath) {
  console.error("Usage: node brand-patched-asar.mjs <app.asar> [Codex.exe]");
  process.exit(2);
}

function walkToEntry(header, rel) {
  const parts = rel.split("/");
  let node = header;
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) throw new Error(`Missing ASAR entry: ${rel}`);
  }
  return node;
}

function* walkFiles(node, prefix = "") {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      yield* walkFiles(child, rel);
    } else {
      yield [rel, child];
    }
  }
}

function readFileFromAsar(fd, entry, dataOffset) {
  const size = Number(entry.size || 0);
  const offset = dataOffset + Number(entry.offset || 0);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, offset);
  return { buf, offset };
}

function replacePadded(text, search, replacement) {
  const index = text.indexOf(search);
  if (index < 0) throw new Error(`Pattern not found: ${search.slice(0, 80)}`);
  if (replacement.length > search.length) {
    throw new Error(`Replacement longer than search: ${replacement.length} > ${search.length}`);
  }
  return text.slice(0, index) + replacement + " ".repeat(search.length - replacement.length) + text.slice(index + search.length);
}

function replaceBetweenPadded(text, start, end, replacement) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) throw new Error(`Start pattern not found: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`End pattern not found: ${end}`);
  const searchLength = endIndex - startIndex;
  if (replacement.length > searchLength) {
    throw new Error(`Replacement longer than range: ${replacement.length} > ${searchLength}`);
  }
  return text.slice(0, startIndex) + replacement + " ".repeat(searchLength - replacement.length) + text.slice(endIndex);
}

function patchPackageJson(text) {
  if (text.includes('"productName": "DeepCodex"') || text.includes('"productName":"DeepCodex"')) return text;
  let next = text.replace('"productName": "Codex"', '"productName": "DeepCodex"');
  if (next === text) throw new Error("package.json productName pattern not found");
  let extra = next.length - text.length;
  if (extra > 0) {
    next = next.replace(/: /g, (match) => {
      if (extra <= 0) return match;
      extra -= 1;
      return ":";
    });
  }
  if (next.length > text.length) {
    throw new Error(`package.json grew too large: ${next.length} > ${text.length}`);
  }
  return next + " ".repeat(text.length - next.length);
}

function patchBootstrapAppUserModelId(text) {
  const search = "process.platform===`win32`&&n.app.setAppUserModelId(t.b(x))";
  const replacement = "n.app.setAppUserModelId(`DeepCodex`)";
  if (!text.includes(search) && text.includes(replacement)) return text;
  return replacePadded(text, search, replacement);
}

function patchMainSession(text) {
  if (text.includes("var Kv=`DeepCodex`;function qv(e){return null}function Jv(e){return Kv}")) return text;
  const search = "var Kv=`Codex`;function qv(e){switch(e){case xm.Dev:return`Dev`;case xm.Agent:return`Agent`;case xm.Nightly:return`Nightly`;case xm.Owl:return`Owl`;case xm.InternalAlpha:return`Alpha`;case xm.PublicBeta:return`Beta`;case xm.Prod:return null}}function Jv(e){let t=qv(e);return t==null?Kv:`${Kv} (${t})`}";
  const replacement = "var Kv=`DeepCodex`;function qv(e){return null}function Jv(e){return Kv}";
  return replacePadded(text, search, replacement);
}

function patchWindowsCloseBehavior(text) {
  const search = "if(process.platform===`win32`&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),j.hide();return}";
  const replacement = "if(process.platform===`win32`&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){n.app.quit();return}";
  if (!text.includes(search) && text.includes(replacement)) return text;
  return replacePadded(text, search, replacement);
}

function patchLocaleInfo(text) {
  const search = "\"locale-info\":async()=>({ideLocale:n.app.getLocale(),systemLocale:n.app.getSystemLocale()})";
  const replacement = "\"locale-info\":async()=>({ideLocale:`zh-CN`,systemLocale:`zh-CN`})";
  if (!text.includes(search) && text.includes(replacement)) return text;
  return replacePadded(text, search, replacement);
}

function patchConfigWriteHandler(text) {
  const replacement = "\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)}),\"write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/value/write\",e),\"batch-write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/batchWrite\",e),\"set-configuration\":async({key:t,value:n})=>(this.globalState.set(t,n),t===e.Or.APPEARANCE_THEME&&VT(n),(t===e.Or.APPEARANCE_THEME||t===e.Or.APPEARANCE_LIGHT_CHROME_THEME||t===e.Or.APPEARANCE_DARK_CHROME_THEME)&&this.windowManager.refreshWindowBackdropForHost(this.hostConfig.id),{success:!0}),\"apply-patch\":async n=>{let r=n.hostConfig,i=this.getAppServerClientForHostIdOrThrow(r.id);return t.zt(n,this.gitManager,i,re(t.Hr(r)))},\"mcp-codex-config\":async({cwd:e})=>({config:await this.buildMcpCodexConfig(e)}),\"worktree-shell-environment-config\":async({cwd:n,hostId:r})=>{let i=this.getRequestAppServerClient(r),a=i.hostConfig;return{shellEnvironment:await t.Lt(e.zt(a)?n:this.mapAgentPathToLocalPath(n,a)??n,i)}},\"ide-context\":async({workspaceRoot:e,origin:t})=>{let n=this.getIpcClientForOrigin(t),r=await n.sendRequest(\"ide-context\",{workspaceRoot:e});return{ideContext:r.result.ideContext}},";
  if (text.includes("\"batch-write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/batchWrite\",e)")) return text;
  const currentSearch = "\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)}),\"write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/value/write\",e),\"set-configuration\":async({key:t,value:n})=>(this.globalState.set(t,n),t===e.Or.APPEARANCE_THEME&&VT(n),(t===e.Or.APPEARANCE_THEME||t===e.Or.APPEARANCE_LIGHT_CHROME_THEME||t===e.Or.APPEARANCE_DARK_CHROME_THEME)&&this.windowManager.refreshWindowBackdropForHost(this.hostConfig.id),{success:!0}),\"apply-patch\":async n=>{let r=n.hostConfig,i=this.getAppServerClientForHostIdOrThrow(r.id);return t.zt(n,this.gitManager,i,re(t.Hr(r)))},\"mcp-codex-config\":async({cwd:e})=>({config:await this.buildMcpCodexConfig(e)}),\"worktree-shell-environment-config\":async({cwd:n,hostId:r})=>{let i=this.getRequestAppServerClient(r),a=i.hostConfig;return{shellEnvironment:await t.Lt(e.zt(a)?n:this.mapAgentPathToLocalPath(n,a)??n,i)}},\"ide-context\":async({workspaceRoot:e,origin:t})=>{if(!e)throw Error(\"workspaceRoot required\");if(!this.isMultiClientTransport())throw Error(\"IPC\");let n=this.getIpcClientForOrigin(t);if(!n)throw Error(\"Missing IPC client\");let r=await n.sendRequest(\"ide-context\",{workspaceRoot:e});if(r.resultType===\"error\")throw Error(r.error);return{ideContext:r.result.ideContext}},";
  if (text.includes(currentSearch)) return replacePadded(text, currentSearch, replacement);
  const search = "\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)}),\"set-configuration\":async({key:t,value:n})=>(this.globalState.set(t,n),t===e.Or.APPEARANCE_THEME&&VT(n),(t===e.Or.APPEARANCE_THEME||t===e.Or.APPEARANCE_LIGHT_CHROME_THEME||t===e.Or.APPEARANCE_DARK_CHROME_THEME)&&this.windowManager.refreshWindowBackdropForHost(this.hostConfig.id),{success:!0}),\"apply-patch\":async({origin:e,...n})=>{let r=n.hostConfig,i=this.getAppServerClientForHostIdOrThrow(r.id);return t.zt(n,this.gitManager,i,re(t.Hr(r)))},\"mcp-codex-config\":async({cwd:e})=>({config:await this.buildMcpCodexConfig(e)}),\"worktree-shell-environment-config\":async({cwd:n,hostId:r})=>{let i=this.getRequestAppServerClient(r),a=i.hostConfig;return{shellEnvironment:await t.Lt(e.zt(a)?n:this.mapAgentPathToLocalPath(n,a)??n,i)}},\"ide-context\":async({workspaceRoot:e,origin:t})=>{if(!e)throw Error(`workspaceRoot is required`);if(!this.isMultiClientTransport())throw Error(`IPC is disabled when connected to a non-stdio app server transport`);let n=this.getIpcClientForOrigin(t);if(!n)throw Error(`Missing IPC client for window`);let r=await n.sendRequest(`ide-context`,{workspaceRoot:e});if(r.resultType===`error`)throw Error(`Failed to get ide context: ${r.error}`);return{ideContext:r.result.ideContext}},";
  return replacePadded(text, search, replacement);
}

function patchDefaultLocale(text) {
  if (text.includes("var t=`zh-CN`,n=Object.assign")) return text;
  return replacePadded(text, "var t=`en-US`,n=Object.assign", "var t=`zh-CN`,n=Object.assign");
}

function patchEnableI18n(text) {
  if (!text.includes("()=>n?.get(`enable_i18n`,!1)")) return text;
  return replacePadded(text, "()=>n?.get(`enable_i18n`,!1)", "()=>true");
}

function patchI18nLoadingGate(text) {
  const search = "(0,$.jsx)(Eo,{locale:f,defaultLocale:Aj,messages:r&&m?.locale===f?m.messages:void 0,onError:()=>{},children:r&&d&&!m?null:e})                        ";
  const replacement = "(0,$.jsx)(Eo,{locale:f,defaultLocale:Aj,messages:(0,Q.useMemo)(()=>{if(r)return m?.locale===f?m.messages:void 0},[r,m,f]),onError:()=>{},children:e})";
  if (text.includes(search)) return replacePadded(text, search, replacement);
  return text;
}

function patchAuthRequirement(text) {
  let next = text;
  if (next.includes("function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}")) {
    next = replacePadded(
      next,
      "function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}",
      "function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!1,email:null,planAtLogin:null}}",
    );
  }
  if (next.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!0)")) {
    next = replacePadded(
      next,
      "requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!0)",
      "requiresAuth:!1",
    );
  }
  if (next.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!1)")) {
    next = replacePadded(
      next,
      "requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!1)",
      "requiresAuth:!1",
    );
  }
  return next;
}

function patchOnboardingGate(text) {
  if (text.includes("v=()=>{},y=[h,_]")) return text;
  return replaceBetweenPadded(
    text,
    "v=()=>{if(!_)return;let e=_===`app`||_===`welcome`&&!h?`app`:`onboarding`;G.dispatchMessage(",
    ",e[0]=h",
    "v=()=>{},y=[h,_]",
  );
}

function patchAppRouteGate(text) {
  return text;
}

function patchAppearanceSettings(text) {
  const replacement = "function ee(){let e=(0,B.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,V.jsx)(P,{title:(0,V.jsx)(A,{slug:`appearance`}),children:(0,V.jsx)(R,{})}),e[0]=t):t=e[0],t}";
  if (text.includes(replacement)) return text;
  return replaceBetweenPadded(text, "function ee(){", "export{ee as AppearanceSettings}", replacement);
}

function patchGeneralAppearanceSettings(text) {
  const replacement = "function qn(){return(0,$.jsx)(Y,{children:(0,$.jsx)(Y.Content,{children:(0,$.jsxs)(mt,{children:[(0,$.jsx)(pr,{}),(0,$.jsx)(`div`,{className:`flex flex-col gap-2 p-1`,children:(0,$.jsx)(nn,{})}),(0,$.jsx)(mr,{})]})})})}";
  if (text.includes(replacement)) return text;
  return replaceBetweenPadded(text, "function qn(){", "function Jn(){", replacement);
}

function findBootstrapAppUserModelIdPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("setAppUserModelId(t.b(x))") ||
        text.includes("setAppUserModelId(`DeepCodex`)")) {
      return [rel, patchBootstrapAppUserModelId];
    }
  }
  throw new Error("Could not find Windows AppUserModelID bootstrap code");
}

function findMainSessionPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("var Kv=`Codex`;function qv(") || text.includes("var Kv=`DeepCodex`;function qv(")) {
      return [rel, patchMainSession];
    }
  }
  throw new Error("Could not find Codex session title bundle under .vite/build/*.js");
}

function findWindowsClosePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("canHideLastLocalWindowToTray?.()")) {
      return [rel, patchWindowsCloseBehavior];
    }
  }
  throw new Error("Could not find Windows close-to-tray behavior under .vite/build/*.js");
}

function findLocaleInfoPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("\"locale-info\":async()=>({ideLocale:n.app.getLocale(),systemLocale:n.app.getSystemLocale()})") ||
        text.includes("\"locale-info\":async()=>({ideLocale:`zh-CN`,systemLocale:`zh-CN`})")) {
      return [rel, patchLocaleInfo];
    }
  }
  throw new Error("Could not find locale-info under .vite/build/*.js");
}

function findConfigWriteHandlerPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if ((text.includes("\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)})") &&
         text.includes("\"set-configuration\":async({key:t,value:n})")) ||
        text.includes("\"write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).writeConfigValue(e)")) {
      return [rel, patchConfigWriteHandler];
    }
  }
  throw new Error("Could not find Electron config write handler table");
}

function findDefaultLocalePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("var t=`en-US`,n=Object.assign") || text.includes("var t=`zh-CN`,n=Object.assign")) {
      return [rel, patchDefaultLocale];
    }
  }
  throw new Error("Could not find webview default locale resolver");
}

function findEnableI18nPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("()=>n?.get(`enable_i18n`,!1)") || /=>true\s*,\[n\]\)/.test(text)) {
      return [rel, patchEnableI18n];
    }
  }
  throw new Error("Could not find webview i18n feature gate");
}

function findI18nLoadingGatePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("children:r&&d&&!m?null:e")) {
      return [rel, patchI18nLoadingGate];
    }
  }
  return ["package.json", (text) => text];
}

function findAuthRequirementPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}") ||
        text.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!0)")) {
      return [rel, patchAuthRequirement];
    }
    if (text.includes("function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!1,email:null,planAtLogin:null}}") &&
        text.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!1)")) {
      return [rel, (text) => text];
    }
  }
  throw new Error("Could not find webview auth requirement hook");
}

function findOnboardingGatePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if ((text.includes("function sE({auth:e,workspaceRootsData:t,workspaceRootsIsLoading:n,forcedOverride:r,postLoginWelcomePending:i,projectlessOnboardingCompleted:a,pathname:o})") &&
         (text.includes("return i&&s===0&&(o===iE||o===aE||o===oE)?`welcome`:s===0?`workspace`:`app`") ||
          text.includes("if(r)return r;if(n)return null;return`app`") ||
          text.includes("if(r)return r;return`app`") ||
          text.includes("{return`app`}"))) ||
        text.includes("function sE({auth:e,forcedOverride:t}){return e.isLoading?null:!e.authMethod&&e.requiresAuth?`login`:e.authMethod?`app`:t??`app`}") ||
        text.includes("function sE({auth:e}){return e.isLoading?null:!e.authMethod&&e.requiresAuth?`login`:`app`}")) {
      return [rel, patchOnboardingGate];
    }
  }
  throw new Error("Could not find webview onboarding gate");
}

function findAppRouteGatePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if ((text.includes("function XS(){") || text.includes("function XS(){return(0,$.jsx)(qS,{})}")) &&
        text.includes("function ZS(")) {
      return [rel, patchAppRouteGate];
    }
    if (text.includes("function dE(){") &&
        text.includes("function fE(e){") &&
        (text.includes("electron-set-window-mode") ||
         text.includes("function dE(){return(0,$.jsx)(Wr,{})}") ||
         text.includes("function dE(){let e=Zr().pathname,t=e===cE||e===lE||e===uE;"))) {
      return [rel, patchAppRouteGate];
    }
  }
  throw new Error("Could not find webview app route gate");
}

function findAppearanceSettingsPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/appearance-settings-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("children:[(0,V.jsx)(R,{}),(0,V.jsx)(Q,{})]") ||
        text.includes("children:[(0,V.jsx)(R,{})]") ||
        text.includes("export{ee as AppearanceSettings}")) {
      return [rel, patchAppearanceSettings];
    }
  }
  throw new Error("Could not find webview appearance settings bundle");
}

function findGeneralAppearanceSettingsPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/general-settings-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("function qn(){") && text.includes("function Jn(){")) {
      return [rel, patchGeneralAppearanceSettings];
    }
  }
  throw new Error("Could not find general appearance settings bundle");
}


const fd = fs.openSync(asarPath, "r+");
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerStringSize = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerStringSize);
fs.readSync(fd, headerBuf, 0, headerStringSize, 16);
const oldHeaderHash = crypto.createHash("sha256").update(headerBuf).digest("hex");
const header = JSON.parse(headerBuf.toString("utf8"));
const dataOffset = 18 + headerStringSize;

const patches = [
  ["package.json", patchPackageJson],
  findBootstrapAppUserModelIdPatch(fd, header, dataOffset),
  findMainSessionPatch(fd, header, dataOffset),
  findWindowsClosePatch(fd, header, dataOffset),
  findLocaleInfoPatch(fd, header, dataOffset),
  findConfigWriteHandlerPatch(fd, header, dataOffset),
  findDefaultLocalePatch(fd, header, dataOffset),
  findEnableI18nPatch(fd, header, dataOffset),
  findI18nLoadingGatePatch(fd, header, dataOffset),
  findAuthRequirementPatch(fd, header, dataOffset),
  findOnboardingGatePatch(fd, header, dataOffset),
  findAppRouteGatePatch(fd, header, dataOffset),
  findAppearanceSettingsPatch(fd, header, dataOffset),
  findGeneralAppearanceSettingsPatch(fd, header, dataOffset),
];

const written = [];
for (const [rel, patch] of patches) {
  const entry = walkToEntry(header, rel);
  const { buf, offset } = readFileFromAsar(fd, entry, dataOffset);
  const before = buf.toString("utf8");
  const after = patch(before);
  const afterBuf = Buffer.from(after, "utf8");
  if (afterBuf.length !== buf.length) {
    throw new Error(`${rel} size changed: ${afterBuf.length} !== ${buf.length}`);
  }
  fs.writeSync(fd, afterBuf, 0, afterBuf.length, offset);
  const hash = crypto.createHash("sha256").update(afterBuf).digest("hex");
  if (entry.integrity) {
    entry.integrity.hash = hash;
    entry.integrity.blocks = [hash];
  }
  written.push({ rel, size: afterBuf.length });
}

let nextHeaderText = JSON.stringify(header);
if (Buffer.byteLength(nextHeaderText, "utf8") > headerStringSize) {
  throw new Error(`ASAR header grew too large: ${Buffer.byteLength(nextHeaderText, "utf8")} > ${headerStringSize}`);
}
nextHeaderText += " ".repeat(headerStringSize - Buffer.byteLength(nextHeaderText, "utf8"));
const nextHeaderBuf = Buffer.from(nextHeaderText, "utf8");
fs.writeSync(fd, nextHeaderBuf, 0, nextHeaderBuf.length, 16);
fs.closeSync(fd);

const newHeaderHash = crypto.createHash("sha256").update(nextHeaderBuf).digest("hex");
let exePatched = false;
if (exePath && fs.existsSync(exePath) && oldHeaderHash !== newHeaderHash) {
  const exe = fs.readFileSync(exePath);
  const oldHashBuf = Buffer.from(oldHeaderHash, "ascii");
  const newHashBuf = Buffer.from(newHeaderHash, "ascii");
  const at = exe.indexOf(oldHashBuf);
  if (at >= 0) {
    newHashBuf.copy(exe, at);
    fs.writeFileSync(exePath, exe);
    exePatched = true;
  }
}

if (oldHeaderHash !== newHeaderHash && exePath && fs.existsSync(exePath) && !exePatched) {
  throw new Error(`ASAR header hash changed, but the old hash was not found in ${exePath}`);
}

console.log(JSON.stringify({ asarPath, written, oldHeaderHash, newHeaderHash, exePatched }, null, 2));
