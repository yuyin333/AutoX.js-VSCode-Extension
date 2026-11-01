'use strict';

/**
 * 剪贴板同步的“伪协议”。
 *
 * 手机端到 PC 端**没有自定义消息通道**：DevPlugin 只支持 hello/ping/log 三种上行；
 * 但 `console.log` 会被全量转发到 PC（GlobalConsole -> BinderConsoleListener -> DevPlugin.log）。
 * 因此上行只能靠日志行 + 前缀约定，与 MCP 的 `AUTOMCP::` 是同一套思路。
 *
 * 下行则是 PC 直接 `run` 一段短脚本，脚本里调用 `setClip()`。
 */

/** 上行日志前缀 */
export const CLIP_PREFIX = 'AUTOCLIP1::';

/**
 * 下发到手机脚本目录的文件名（用户手动触发用）。
 * 用 ASCII 名：中文文件名在 `/sdcard` 上曾出现「文件被创建但内容 0 字节」的情况，
 * 换 ASCII 可排除这一类路径/编码隐患；脚本内部的提示文案仍是中文，用户无感。
 */
export const SENDER_SCRIPT_NAME = 'autoclip_send.js';

/** 下行脚本在手机端缓存目录下的文件名（固定名，避免每次下发都堆文件） */
export const APPLY_SCRIPT_NAME = 'autoclip_dl.js';

/** 下行脚本的 viewId；与「发送剪贴板」「安装」脚本的 id 必须不同，否则 stop 会串台 */
export const APPLY_SCRIPT_ID = 'autoclip_dl';

/** 安装脚本的 viewId / 文件名（三个脚本三套命名，互不覆盖） */
export const INSTALL_SCRIPT_ID = 'autoclip_install';
export const INSTALL_SCRIPT_NAME = 'autoclip_install.js';

/** 手机端默认脚本目录；用户改过 AutoX 的脚本目录时用 clipSync.phoneScriptDir 覆盖 */
export const DEFAULT_PHONE_SCRIPT_DIR = '/sdcard/脚本';

/** 32 位乘法：不依赖 Math.imul，也避免 h * 16777619 超过 2^53 丢精度 */
function mul32(a: number, b: number): number {
  const hi = (a >>> 16) & 0xffff;
  const lo = a & 0xffff;
  return ((((hi * b) % 65536) * 65536) + lo * b) >>> 0;
}

/** FNV-1a 32 位 */
function fnv1a32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = mul32(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 内容指纹：两个不同种子的 32 位哈希拼成 16 位十六进制。
 * 只用于“内容有没有变”和“回声识别”，不做安全用途。
 */
export function hashOf(text: string): string {
  const a = fnv1a32(text, 2166136261);
  const b = fnv1a32(text, 0x9e3779b9);
  return ('00000000' + a.toString(16)).slice(-8) + ('00000000' + b.toString(16)).slice(-8);
}

export interface ClipUp {
  /** scan（手机手动发送）/ applied（下行已应用）/ install（安装结果）/ error / event */
  k?: string;
  /** 字符数 */
  n?: number;
  /** 文本内容 */
  txt?: string;
  /** 错误信息 */
  m?: string;
  /** install 专用：回读校验是否通过 */
  ok?: boolean;
  /** install 专用：实际落盘路径 */
  path?: string;
}

/**
 * 从一行设备日志里解析伪协议消息。
 * 用 indexOf 而不是 startsWith：GlobalConsole 会给每行加 `HH:mm:ss.SSS/D: ` 前缀。
 */
export function parseClipLine(line: any): ClipUp | null {
  if (typeof line !== 'string') {
    return null;
  }
  const idx = line.indexOf(CLIP_PREFIX);
  if (idx < 0) {
    return null;
  }
  try {
    const obj = JSON.parse(line.substring(idx + CLIP_PREFIX.length));
    return obj && typeof obj === 'object' ? obj as ClipUp : null;
  } catch (e) {
    return null;
  }
}

/**
 * 生成合法的 JS 字符串字面量。
 * JSON.stringify 会保留 U+2028/U+2029，部分老引擎把它们当换行，必须转义。
 */
export function jsStringLiteral(text: string): string {
  return JSON.stringify(text)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 下行脚本：把 PC 剪贴板写进手机剪贴板（只用 Rhino 可用的 API） */
export function buildApplyScript(text: string): string {
  return [
    '// [autoclip] 由 VS Code 自动生成，请勿手改',
    'var __t = ' + jsStringLiteral(text) + ';',
    'try {',
    '  setClip(__t);',
    '  console.log("' + CLIP_PREFIX + '" + JSON.stringify({ k: "applied", n: __t.length }));',
    '} catch (e) {',
    '  console.log("' + CLIP_PREFIX + '" + JSON.stringify({ k: "error", m: String(e) }));',
    '}'
  ].join('\n');
}

/**
 * 手机端「发送剪贴板」脚本：用户自己点运行。
 *
 * 为什么必须手动：Android 10+ 拒绝后台读剪贴板，`appops READ_CLIPBOARD allow`
 * 在本机实测也解不开（实测前台 n:28 / 后台 n:0）。只有 AutoX 在前台（有焦点）时才能读。
 */
export function buildSenderScript(): string {
  return [
    '// [autoclip] 发送剪贴板 —— 在 AutoX 里点「运行」即可把手机剪贴板发到电脑',
    '// 说明：必须是 AutoX 处于前台时才读得到（系统限制，见插件文档）',
    'var __t = "";',
    'try { __t = getClip(); } catch (e) {}',
    'console.log("' + CLIP_PREFIX + '" + JSON.stringify({ k: "scan", n: __t.length, txt: __t }));',
    'if (__t.length === 0) {',
    '  toast("剪贴板为空，或系统拒绝了读取（请确认 AutoX 在前台）");',
    '} else {',
    '  toast("已发送 " + __t.length + " 字符到电脑");',
    '}'
  ].join('\n');
}

/**
 * 安装脚本：把「发送剪贴板」脚本写进手机脚本目录，并**回读校验**。
 *
 * 为什么不用 `save` 命令：
 * 手机端 `DevPluginResponseHandler.saveScript()` 里 `PFiles.write()` 的返回值被丢弃，
 * 紧接着无条件 `toast("保存成功")`，且 `save` 协议本身没有回执 ——
 * 写失败时两端都报成功（真机上出现过「文件被创建、内容 0 字节」）。
 * 改成让手机执行这段 JS：写入、回读、比对、把结果打回 PC，失败能说出原因。
 *
 * 只用 Rhino 可用的 API（`files.*`），不走 Node 引擎（该 APK 未打包 Javet，`.mjs` 会崩）。
 */
export function buildInstallScript(dir: string, name: string, body: string): string {
  return [
    '// [autoclip] 安装「发送剪贴板」脚本（由 VS Code 生成，请勿手改）',
    'var __dir = ' + jsStringLiteral(dir) + ';',
    'var __name = ' + jsStringLiteral(name) + ';',
    'var __body = ' + jsStringLiteral(body) + ';',
    'var __p = __dir + "/" + __name;',
    'var __r = { k: "install", ok: false, n: 0, path: __p, m: "" };',
    'try {',
    '  files.ensureDir(__dir + "/");',
    '  files.write(__p, __body);',
    '  var __back = files.read(__p);',
    '  __r.n = __back.length;',
    '  __r.ok = (__back === __body);',
    '  if (!__r.ok) {',
    '    __r.m = "回读不一致：应写 " + __body.length + " 字符，实际读回 " + __back.length + " 字符";',
    '  }',
    '} catch (e) {',
    '  __r.m = String(e);',
    '}',
    'console.log("' + CLIP_PREFIX + '" + JSON.stringify(__r));'
  ].join('\n');
}
