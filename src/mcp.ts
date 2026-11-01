'use strict';
/**
 * AutoX MCP Bridge —— 把官方 AutoX VS Code 扩展的 `server` 单例暴露为 MCP 工具。
 *
 * 设计约束（见方案文档 §14.7）：
 *  1. 传输不能用 stdio（VS Code 占用扩展 stdio）→ 此处独立起 HTTP/SSE 服务（默认 127.0.0.1:18789/sse）。
 *  2. 必须定向设备：用 server.getDeviceById(id).sendCommand(...) 而非 server.sendCommand（广播）。
 *  3. 结果按请求 id 关联：下发脚本里 console.log("AUTOMCP::<reqId>::" + JSON)，在 device 的 data:log 事件中过滤解析。
 *  4. 单引擎串行锁：同一设备一次只跑一个脚本，避免与官方"运行"按钮互相撞车。
 *
 * 本文件不依赖 @modelcontextprotocol/sdk，直接用 Node http 实现 MCP(Streamable/SSE) 的最小可用子集，
 * 以规避额外依赖与类型摩擦，编译环境与扩展现有工具链（commonjs/es6/@types/node16）完全兼容。
 */

import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AutoJsDebugServer, Device } from './autojs-debug';

/** MCP 默认端口；实际端口来自配置 autoxAi.mcpPort（同时装多个同类插件时可改） */
export const DEFAULT_MCP_PORT = 18789;
/**
 * 允许的 Host：只认回环地址。
 * DNS rebinding 攻击时浏览器把 attacker.com 解析到 127.0.0.1，但 Host 头仍是 attacker.com，
 * 这一条就能把它挡在门外。
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const MCP_PREFIX = 'AUTOMCP::';
const RUN_TIMEOUT = 30000; // 方案 §14.3：默认 30s 超时
const SCREEN_DIR = '/sdcard/Download/mcp/imgs'; // 方案 §3.6 / §11-B

/**
 * 危险调用黑名单（方案 §6.1 运行时安全）。
 *
 * 【2026-09-28 修正，两轮】
 * 原实现是 `['sms','telephony','call(','deletefile','remove(']` 对小写后的**整段代码**
 * 做 `indexOf` —— 朴素子串匹配，会把无害标识符当成危险调用：真机探针里的变量名
 * `mismSamples` 小写后是 `mi`+`sms`+`amples`，**误命中 `sms`**，脚本被拦下要求
 * confirmToken（多烧一轮，且模型会以为代码有问题）。同类误伤：`smsList`、`recall(`。
 *
 * 第一轮改成纯 `\b` 词边界后**引入漏报**（更危险的方向）：`telephonyManager`、
 * `smsManager`、`SmsManager` 这些真实 API 名因为后面紧跟字母而没有词边界，全都漏掉。
 *
 * 第二轮（当前）：**先把标识符按驼峰拆开，再做词边界匹配**。
 *   `smsManager`       → `sms Manager`     → 命中 ✅
 *   `SmsManager`       → `Sms Manager`     → 命中 ✅
 *   `SMSManager`       → `SMS Manager`     → 命中 ✅
 *   `telephonyManager` → `telephony Manager` → 命中 ✅
 *   `mismSamples`      → `mism Samples`    → 不命中 ✅（拆开的词是 mism / Samples）
 *   `recall(`          → 原样              → 不命中 ✅
 *   `removeAll(`       → `remove All(`     → 不命中 ✅（无害）
 *   `callback(`        → 原样              → 不命中 ✅
 * 这样"误报"和"漏报"两个方向同时收敛。
 * 注意：正则**不带 g 标志** —— 带 g 的 RegExp.test 会保留 lastIndex，
 * 导致同一实例重复调用时交替返回 true/false（经典陷阱）。
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bsms\b/i,
  /\btelephony\b/i,
  /\bcall\s*\(/i,
  /\bdelete\s*file\b/i,
  /\bremove\s*\(/i
];

/** 把 camelCase / PascalCase / 连续大写缩写拆成用空格分隔的词，便于词边界匹配 */
function splitIdentifiers(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase  → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');  // SMSManager → SMS Manager
}

function needsConfirm(code: string): boolean {
  const normalized = splitIdentifiers(code);
  return FORBIDDEN_PATTERNS.some(re => re.test(normalized));
}

function genReqId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * 把任意字符串安全地嵌进**生成的脚本源码**里的双引号字符串字面量。
 *
 * 【必须做】生成的脚本是通过 TS 模板字符串拼出来的，若直接插入用户传入的
 * scope / text，里面的 `"` 或 `\` 会破坏脚本语法（甚至注入代码）。
 * 顺序不能反：先转义反斜杠，再转义引号。
 */
function jsStr(s: any): string {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ');
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
}

/**
 * 单次脚本下发的结局。
 *
 * 【为什么需要】原 runScript 无论「脚本正常跑完」还是「卡死超时」都 resolve 同一个
 * `string[]`，形状完全相同 —— 调用方（模型）拿到一堆 log 字符串后**无法判断**这次到底是
 * 成功、脚本抛错、还是压根没跑完，只能靠肉眼猜，于是开始瞎改代码。
 * 现在把三者分开表达。
 */
interface ScriptRun {
  /** ok=脚本跑完（异常由 AUTOMCP_ERR 行另行表达）；timeout=超时未收到结束标记 */
  status: 'ok' | 'timeout';
  /** captureAll=true 时是所有 log 行；false 时是剥掉 AUTOMCP::<reqId>:: 前缀后的载荷 */
  logs: string[];
  /** 仅 status==='timeout' 时给出 */
  timeoutMs?: number;
}

export class McpBridge {
  private server: AutoJsDebugServer;
  private port: number;
  private httpServer?: http.Server;
  private running = false;
  /** sessionId -> SSE 响应对象（legacy SSE transport） */
  private sessions = new Map<string, http.ServerResponse>();
  /** 每台设备的串行锁链（约束 4） */
  private locks = new Map<string, Promise<any>>();

  /**
   * 可选的访问令牌（来自 `autoxAi.mcpToken`）。留空=不启用 token，
   * 但仍会做 Host/Origin 校验（见 guard）。
   */
  private token = '';

  constructor(server: AutoJsDebugServer, port: number = DEFAULT_MCP_PORT) {
    this.server = server;
    this.port = port;
  }

  /** 设置访问令牌；空字符串表示不启用 */
  setToken(token: string): void {
    this.token = (token || '').trim();
  }

  /**
   * 本地服务的准入校验（**不需要账号体系**）。
   *
   * 为什么必须做：
   *   服务只监听 127.0.0.1，但浏览器里任意网页都能 `fetch('http://127.0.0.1:18789/mcp',
   *   {mode:'no-cors', headers:{'Content-Type':'text/plain'}})` —— 用 text/plain 绕开预检，
   *   我们的 JSON.parse 照单全收，于是网页可以调用 `device_run_code` 在用户手机上执行任意 JS。
   *
   * 三道闸：
   *   1) Host 必须是回环地址 —— 挡住 DNS rebinding（攻击者域名解析到 127.0.0.1 时 Host 是他自己的域名）；
   *   2) 带 Origin 头的一律拒绝 —— 本地 MCP 客户端（CLI/桌面 AI）不会发 Origin，发的一定是浏览器；
   *   3) 配了 token 时校验 Bearer / ?token= —— 可选，用于共享机器或想再上一层保险的场景。
   */
  private guard(req: http.IncomingMessage, res: http.ServerResponse, parsed: url.UrlWithParsedQuery): boolean {
    const host = String(req.headers.host || '');
    const origin = req.headers.origin;

    const deny = (code: number, message: string, extraHeaders?: http.OutgoingHttpHeaders): boolean => {
      console.warn(`[Autox.js-Ai-MCP] 拒绝请求：${message} (host=${host || '-'}, origin=${origin || '-'})`);
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
      res.end(JSON.stringify({ error: message }));
      return false;
    };

    if (!LOOPBACK_HOST.test(host)) {
      return deny(403, 'forbidden: host must be loopback');
    }
    if (origin) {
      return deny(403, 'forbidden: browser origin not allowed');
    }
    if (this.token) {
      const auth = String(req.headers.authorization || '');
      const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      const q = parsed.query && parsed.query.token ? String(parsed.query.token) : '';
      const okBearer = bearer !== '' && McpBridge.safeEqual(bearer, this.token);
      const okQuery = q !== '' && McpBridge.safeEqual(q, this.token);
      if (!okBearer && !okQuery) {
        return deny(401, 'unauthorized: missing or invalid token', { 'WWW-Authenticate': 'Bearer' });
      }
    }
    return true;
  }

  /** 定长比较，避免时序侧信道 */
  private static safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) {
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  }

  /**
   * 启动 MCP 监听。
   * 回调里给出**真实结果**：以前是"先弹成功提示、再异步 listen"，端口被占时提示与事实相反。
   * 返回 false 表示已在运行（无需重复启动）。
   */
  start(onResult?: (ok: boolean, port: number, code?: string) => void): boolean {
    if (this.running) {
      if (onResult) { onResult(true, this.port, 'ALREADY_RUNNING'); }
      return false;
    }
    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));
    this.httpServer.on('error', (e: any) => {
      this.running = false;
      const code = e && e.code ? String(e.code) : '';
      console.error('[Autox.js-Ai-MCP] http server error:', e && e.message);
      if (onResult) { onResult(false, this.port, code); }
    });
    this.httpServer.listen(this.port, '127.0.0.1', () => {
      this.running = true;
      const addr: any = this.httpServer.address();
      const realPort = addr && addr.port ? addr.port : this.port;
      this.port = realPort;
      console.log(`[Autox.js-Ai-MCP] listening on http://127.0.0.1:${realPort}/sse`);
      if (onResult) { onResult(true, realPort); }
    });
    return true;
  }

  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = undefined;
    }
    this.sessions.forEach(s => {
      try { s.end(); } catch (e) { /* ignore */ }
    });
    this.sessions.clear();
    this.running = false;
    console.log('[Autox.js-Ai-MCP] stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // HTTP 路由
  // ---------------------------------------------------------------------------
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = url.parse(req.url || '', true);
    // 准入校验必须在路由之前：任何端点（含 /health）都不给浏览器开
    if (!this.guard(req, res, parsed)) {
      return;
    }
    const pathname = parsed.pathname || '';
    if (pathname.endsWith('/sse') && req.method === 'GET') {
      this.handleSse(req, res);
    } else if (pathname.endsWith('/messages') && req.method === 'POST') {
      this.handleMessages(req, res, parsed.query.sessionId as string);
    } else if (pathname.endsWith('/mcp') && req.method === 'POST') {
      this.handleMcpDirect(req, res);
    } else if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, devices: this.server.devices.length }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  /** streamable-http 直连端点：POST /mcp 直接返回 JSON-RPC 结果（兼容 Claude Code / Cursor 等现代客户端） */
  private handleMcpDirect(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end();
        return;
      }
      let sid = req.headers['mcp-session-id'] as string;
      if (!sid) {
        sid = genReqId() + genReqId();
        res.setHeader('Mcp-Session-Id', sid);
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        res.end();
        this.dispatch(msg, sid).catch(err => console.error('[Autox.js-Ai-MCP] dispatch error:', err));
        return;
      }
      this.dispatch(msg, sid)
        .then(d => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.rpcResponse(msg.id, d)));
        })
        .catch(err => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32000, message: String((err && err.message) || err) }
          }));
        });
    });
  }

  /** legacy SSE transport：GET /sse 建立流，并告知客户端后续 POST 的 endpoint */
  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = genReqId() + genReqId();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
      // 不再发 Access-Control-Allow-Origin：本地 MCP 客户端不是浏览器，不需要 CORS；
      // 发出去等于允许任意网页读取响应。
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    this.sessions.set(sessionId, res);
    // 心跳，保持连接
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(hb);
      this.sessions.delete(sessionId);
    });
  }

  /** 客户端把 JSON-RPC 请求 POST 到 /messages?sessionId=... */
  private handleMessages(req: http.IncomingMessage, res: http.ServerResponse, sessionId?: string): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end();
        return;
      }
      // 通知（无 id）-> 202，无需回包
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        res.end();
        this.dispatch(msg, sessionId).catch(err => console.error('[Autox.js-Ai-MCP] dispatch error:', err));
        return;
      }
      // 请求 -> 处理完后经 SSE 流回结果
      res.writeHead(202);
      res.end();
      this.dispatch(msg, sessionId)
        .then(d => this.sendSse(sessionId, this.rpcResponse(msg.id, d)))
        .catch(err => this.sendSse(sessionId, {
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: String((err && err.message) || err) }
        }));
    });
  }

  private sendSse(sessionId: string | undefined, payload: any): void {
    if (!sessionId) {
      return;
    }
    const res = this.sessions.get(sessionId);
    if (!res) {
      return;
    }
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC 分发
  // ---------------------------------------------------------------------------
  private async dispatch(msg: any, sessionId?: string): Promise<{ ok: boolean; payload: any }> {
    const method: string = msg.method;
    const params: any = msg.params || {};
    switch (method) {
      case 'initialize':
        return {
          ok: true,
          payload: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'autox-mcp', version: '0.1.0' }
          }
        };
      case 'ping':
        return { ok: true, payload: {} };
      case 'tools/list':
        return { ok: true, payload: { tools: this.toolsList() } };
      case 'tools/call':
        return { ok: true, payload: await this.toolsCall(params.name, params.arguments || {}) };
      case 'resources/list':
      case 'prompts/list':
        return { ok: true, payload: { resources: [], prompts: [] } };
      default:
        return { ok: false, payload: { code: -32601, message: 'Method not found: ' + method } };
    }
  }

  /** 把 dispatch 结果包成标准 JSON-RPC 2.0 响应（成功->result，失败->error） */
  private rpcResponse(msgId: any, d: { ok: boolean; payload: any }): any {
    if (d.ok) {
      return { jsonrpc: '2.0', id: msgId, result: d.payload };
    }
    return { jsonrpc: '2.0', id: msgId, error: d.payload };
  }

  private toolsList(): ToolDef[] {
    return [
      {
        name: 'device_list',
        description: '列出当前已连接（完成 hello 握手）的设备。返回 id/name/type/attached。',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'device_connect',
        description: '建立/刷新设备连接。mode=adb 时若给出 serial 则连该设备，否则开启 ADB 设备跟踪（连接所有已授权 ADB 设备）；mode=lan 时提示在手机端扫码/输地址连入 PC。',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['adb', 'lan'], description: '连接模式，默认 adb' },
            serial: { type: 'string', description: 'adb 模式下的设备序列号（可选）' },
            ip: { type: 'string', description: 'lan 模式下的 PC 地址（可选，通常由手机端填写）' }
          }
        }
      },
      {
        name: 'device_run_code',
        description: [
          '在目标设备上运行一段 AutoX(Rhino) 代码，返回 {status, logs, error?}。',
          '',
          'status 有三种，含义严格区分（不要只看 logs）：',
          "  · 'ok'      脚本正常跑完（logs 为全部 console 输出）",
          "  · 'error'   脚本抛异常，error 字段是异常信息，logs 是异常前的输出",
          "  · 'timeout' 超时未结束（默认 30000ms，可用 timeoutMs 覆盖）——通常是长 sleep / 死循环 / 阻塞调用",
          "status 不是 'ok' 时，**不要原样重发同一段代码**，先读 error 与 logs 定位问题。",
          '',
          '运行时安全：代码命中危险调用（sms / telephony / call( / deleteFile / remove(）',
          '且未带 confirmToken 时，返回 status=needs_confirmation 与一次性 confirmToken，',
          '再次调用时带上该 token 才会真正下发。',
          '匹配规则是"先按驼峰拆词、再按词边界匹配"，所以 smsManager / SmsManager 会被拦，',
          '而 mismSamples / recall( / removeAll( 这类无害标识符不会误伤。',
          '',
          '【常见任务怎么写】',
          '  · 点击坐标： click(cx, cy)   ← 坐标优先取 device_get_layout 返回的 cx/cy（已修正过）',
          '  · 输入文本： 先点中控件，再 setText("...")；或用 node.setText()',
          '  · 滑动：     swipe(x1, y1, x2, y2, 300)',
          '  · 启动应用： app.launchApp("QQ音乐") 或 app.launchPackage("com.tencent.qqmusic")',
          '',
          '【避坑】',
          '  · 不要用 currentPackage() 判断前台应用 —— 软键盘弹出时它返回输入法包名（实测 Gboard）。',
          '    用 auto.root.packageName()。',
          '  · UiObject.text() 是快照；setText() 之后必须重新 findOne() 才能读到新值。',
          '  · 不要写"搜索+点击+验证"一条龙长脚本 —— 一次只做一个动作，做完用 device_get_layout 验证。',
          '  · 单次下发有超时上限，长等待请拆成多次调用。'
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '要执行的 AutoX（Rhino）代码' },
            deviceId: { type: 'string', description: '目标设备 id（可选，缺省取唯一已连设备）' },
            confirmToken: { type: 'string', description: '二次确认凭证（危险代码需要）' },
            timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000，范围 [1000, 120000]（可选）' }
          },
          required: ['code']
        }
      },
      {
        name: 'device_get_layout',
        description: [
          '获取当前界面**可见且可识别**的控件**扁平列表**（不是控件树）。',
          '',
          '【保留规则】可见 && (有 text/desc || 可点 || 可滚 || 可编辑 || 可长按)。',
          '  注意：资源 id **不作为保留依据**（只是输出字段）—— 实测把 id 算进来会让返回量从 187',
          '  涨到 331，多出的全是看不懂也点不动的装饰容器。确实需要时用 mode="verbose"。',
          '',
          '【返回结构】',
          '  nodes[]     扁平数组。每项：',
          '                ref   稳定指纹 "<hash>.<序号>"，可直接传给 device_tap',
          '                cls   短类名（TextView / RelativeLayout ...）',
          '                text / desc   已剥掉 <em> 等 HTML 标签的文案',
          '                id    资源 id（如 com.tencent.qqmusic:id/song_name）',
          '                b     [left, top, right, bottom] 绝对坐标',
          '                cx,cy **可直接点击**的坐标（已按"可见交集矩形"取中心并 clamp 到屏幕内 8px 安全区）',
          '                clk/sc/lclk/ed  可点 / 可滚 / 可长按 / 可编辑',
          '                opaque  true 表示这是"无可读文案的可点空壳"，靠 pt（最近带文案祖先）判断它是什么',
          '                d     层级深度；textRaw/descRaw 仅在原文含标签时出现',
          '  dropped     被剔除节点的统计：total / notVisible / occluded / horizontalOffscreen / belowFold /',
          '              belowFoldReachable / degenerate / noSignal / idOnly / scopeFiltered',
          '  scrollables[] 本页可滚动容器 [{ref,b,dir}]，dir 为 "v"/"h"',
          '  truncated   true 表示节点数超过 maxNodes（默认 300）被截断',
          '',
          '【已被剔除，不要再去找】不可见节点（屏幕外 / 被软键盘遮挡 / 尺寸退化）、',
          '纯布局容器（noSignal），以及"只有资源 id、无文案也不可交互"的装饰节点（idOnly）。',
          '它们点不到或毫无线索，只会把定位带偏。',
          '',
          '【目标不在 nodes 里时怎么办】不要反复改选择器！按顺序尝试：',
          '  1) 看 scrollables[]，用 device_run_code 做 swipe 滚动后重新 get_layout（dropped.belowFoldReachable>0 说明下面还有内容）',
          '  2) 调大 maxNodes（默认 300，可能 truncated=true）',
          '  3) 传 scope（对 text/desc 做子串过滤，缩小范围）',
          '  4) idOnly>0 且你确实要按 id 找节点 → mode="verbose"',
          '  5) 确实需要"无文案又不可交互"的空白区域按坐标操作 → mode="tree" 拿全量树',
          '',
          '【避坑】',
          '  · text/desc 已剥掉 <em> 标签 —— 按肉眼看到的文案匹配，不要带标签。',
          '  · 有文案但 clk=false 的节点（如歌名 TextView）是正常的：它是坐标锚点，',
          '    点击请用它的可点祖先，或直接把 cx/cy 交给 click()。',
          '  · 不要用 currentPackage() 判断前台应用（键盘弹出返回输入法包名）。',
          '',
          '【推荐节奏】一次只做一个动作：get_layout → 选 ref → device_tap → 再 get_layout 验证。',
          '宁可多 dump 几次，也不要写"盲改选择器"的猜测式代码。'
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: { type: 'string', description: '目标设备 id（可选）' },
            scope: { type: 'string', description: '可选：对 text/desc 做子串过滤（在可见性筛选之后执行）' },
            maxNodes: { type: 'number', description: '返回节点数上限，默认 300，范围 [1, 2000]（可选）' },
            mode: {
              type: 'string',
              enum: ['actionable', 'verbose', 'tree'],
              description: 'actionable（默认）= 只回可见可识别节点的扁平列表；'
                + 'verbose = 额外保留"只有资源 id"的装饰节点（量大，约 +40%）；'
                + 'tree = 逃生舱，回全量控件树（体积最大，仅用于按坐标操作空白区域）'
            },
            timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000（可选）' }
          }
        }
      },
      {
        name: 'device_tap',
        description: [
          '点击控件。优先用 device_get_layout 返回的 ref；也可用 text / desc 精确匹配。',
          '',
          '内部会在**同一次下发里**重新 dump 界面、按指纹校验、再点击，因此不会有"坐标漂移"问题。',
          '点击目标按顺序尝试：目标节点 click() → 最近的可点祖先 click() → 手势 click(x,y) → Tap(x,y)。',
          '（"最近可点祖先"是必要的：歌名 TextView 本身不可点，可点的是它所在的行容器。）',
          '',
          '返回：{status:"ok", via, ref, cls, text, desc, b, cx, cy}',
          '  · status="not_found" → ref 已失效（页面变了/节点没了）→ 重新 device_get_layout',
          '  · status="ambiguous" → 有多个节点指纹相同（如多行同名按钮）→ 用 candidates 里的 ref 重新指定',
          '  · status="failed"    → 四种点击方式都失败',
          '',
          '建议用 ref 而不是 text/desc：多行列表里同名文案会有多个匹配，ref 能唯一定位。'
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'device_get_layout 返回的 ref，形如 "1a2b3c.0"（首选）' },
            text: { type: 'string', description: '按文案精确匹配（可选，ref 缺省时使用）' },
            desc: { type: 'string', description: '按内容描述精确匹配（可选，ref 缺省时使用）' },
            deviceId: { type: 'string', description: '目标设备 id（可选）' },
            timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000（可选）' }
          }
        }
      },
      {
        name: 'device_screenshot',
        description: '在设备截图并取回本地路径（adb 模式）。截图落盘 /sdcard/Download/mcp/imgs/ 后自动 adb pull 到本机临时目录，返回本地路径。',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: { type: 'string', description: '目标设备 id（可选）' },
            path: { type: 'string', description: '覆盖设备端默认截图目录（可选）' }
          }
        }
      },
      {
        name: 'device_stop',
        description: '停止目标设备（或所有设备）上正在运行的脚本（command:stopAll）。',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: { type: 'string', description: '目标设备 id（可选，缺省向所有设备广播 stopAll）' }
          }
        }
      }
    ];
  }

  // ---------------------------------------------------------------------------
  // 工具实现
  // ---------------------------------------------------------------------------
  private async toolsCall(name: string, args: any): Promise<any> {
    try {
      switch (name) {
        case 'device_list':
          return this.ok(this.listDevices());
        case 'device_connect':
          return this.ok(await this.connect(args));
        case 'device_run_code':
          return await this.runCode(args);
        case 'device_get_layout':
          return this.ok(await this.getLayout(args));
        case 'device_tap':
          return await this.tap(args);
        case 'device_screenshot':
          return this.ok(await this.screenshot(args));
        case 'device_stop':
          return this.ok(this.stopDevice(args));
        default:
          return this.fail('Unknown tool: ' + name);
      }
    } catch (e: any) {
      return this.fail(String(e && e.message ? e.message : e));
    }
  }

  private ok(data: any): any {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  private fail(message: string): any {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  private listDevices(): any[] {
    return this.server.devices.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      attached: d.attached
    }));
  }

  private pickDevice(deviceId?: string): Device {
    if (deviceId) {
      const d = this.server.getDeviceById(deviceId);
      if (!d) {
        throw new Error('device not found: ' + deviceId);
      }
      return d;
    }
    if (this.server.devices.length === 1) {
      return this.server.devices[0];
    }
    if (this.server.devices.length === 0) {
      throw new Error('no device connected, call device_connect first');
    }
    throw new Error('multiple devices, please specify deviceId');
  }

  private async connect(args: any): Promise<any> {
    const mode = (args.mode || 'adb') as string;
    if (mode === 'adb') {
      if (args.serial) {
        await this.server.connectDevice(args.serial);
      } else {
        await this.server.trackADBDevices();
      }
    } else {
      // lan 模式：PC 端 server 已在 9317 监听，等待手机端扫码/输地址连入；此处仅提示
      if (!this.server.isHttpServerStarted) {
        this.server.listen();
      }
    }
    // 等待握手完成
    await this.delay(1500);
    return { connected: this.listDevices(), mode };
  }

  private async runCode(args: any): Promise<any> {
    const code: string = args.code;
    if (!code || typeof code !== 'string') {
      return this.fail('code is required');
    }
    // 运行时安全（§6.1）：危险代码需确认
    if (needsConfirm(code) && !args.confirmToken) {
      const token = genReqId();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'needs_confirmation',
            confirmToken: token,
            reason: 'code matches forbidden token, require explicit confirmToken to execute on device'
          })
        }],
        isError: true
      };
    }
    const device = this.pickDevice(args.deviceId);
    const reqId = genReqId();
    const timeout = this.normalizeTimeout(args.timeoutMs);
    const script = this.wrapScript(code, reqId, true);
    const run = await this.withLock(device.id, () =>
      this.runScript(device, script, reqId, true, timeout));
    return this.scriptResult(run, device.id, timeout);
  }

  /**
   * 把一次脚本执行的结局转成结构化工具结果。
   * 三种 status 分别对应：ok / error（脚本抛异常）/ timeout（未收到结束标记）。
   * status!=='ok' 时置 isError，让客户端显式暴露失败，而不是把失败埋在 logs 里。
   */
  private scriptResult(run: ScriptRun, deviceId?: string, timeoutMs?: number): any {
    if (run.status === 'timeout') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'timeout',
            device: deviceId,
            timeoutMs: timeoutMs || RUN_TIMEOUT,
            error: `script did not emit the end marker within ${timeoutMs || RUN_TIMEOUT}ms`,
            hint: '常见原因：脚本里有长 sleep / 死循环 / 阻塞调用（如 images.requestScreenCapture 等用户授权）。'
              + '不要直接重发同一段代码，先看下面的部分日志定位卡在哪一行。',
            logs: run.logs
          }, null, 2)
        }],
        isError: true
      };
    }
    const errLine = run.logs.find(l => l.indexOf('AUTOMCP_ERR:') >= 0);
    if (errLine) {
      const idx = errLine.indexOf('AUTOMCP_ERR:');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            device: deviceId,
            error: errLine.substring(idx + 'AUTOMCP_ERR:'.length),
            logs: run.logs
          }, null, 2)
        }],
        isError: true
      };
    }
    return this.ok({ status: 'ok', device: deviceId, logs: run.logs });
  }

  /** timeoutMs 归一化：缺省 30s，夹在 [1s, 120s]（防负数/NaN/离谱值） */
  private normalizeTimeout(v: any): number {
    const n = Number(v);
    if (!n || !isFinite(n) || n <= 0) {
      return RUN_TIMEOUT;
    }
    return Math.max(1000, Math.min(120000, Math.floor(n)));
  }

  /** maxNodes 归一化：缺省 300，夹在 [1, 2000] */
  private normalizeMaxNodes(v: any): number {
    const n = Number(v);
    if (!n || !isFinite(n) || n <= 0) {
      return 300;
    }
    return Math.max(1, Math.min(2000, Math.floor(n)));
  }

  /**
   * 取当前界面的**可见可识别控件扁平列表**。
   *
   * 【2026-09-28 重写】落地 v2 方案：把"控件树"换成"可见节点的扁平列表"。
   * 依据（真机实测，QQ音乐搜索结果页 729 节点）：
   *   - 不可见 356（水平离屏 243 / 退化 bounds 51 / 垂直离屏 49 / 被软键盘遮挡 13）
   *   - 可见但无文案且不可交互 ~199（纯布局容器，模型看不见任何线索）
   *   → 真正有用的只有 ~120 个"有文案"节点 + 43 个可点空壳 + 滚动容器。
   * 这些不可见节点是**静默失败**的主要来源：按几何中心算出的坐标会落到屏幕外，
   * 点击毫无反应，模型误判成"选择器写错了"，然后开始瞎改。
   */
  private async getLayout(args: any): Promise<any> {
    const device = this.pickDevice(args.deviceId);
    const reqId = genReqId();
    const scope: string = typeof args.scope === 'string' ? args.scope : '';
    const maxNodes = this.normalizeMaxNodes(args.maxNodes);
    const timeout = this.normalizeTimeout(args.timeoutMs);
    const mode: string = args.mode === 'tree' ? 'tree' : (args.mode === 'verbose' ? 'verbose' : 'actionable');
    const script = this.buildLayoutScript(reqId, scope, maxNodes, mode);
    const run = await this.withLock(device.id, () =>
      this.runScript(device, script, reqId, false, timeout));
    if (run.status === 'timeout') {
      return this.fail(`device layout timeout after ${timeout}ms（无障碍服务未响应，或页面正在渲染/动画中）`);
    }
    // 取最后一个 AUTOMCP 载荷（布局 JSON）
    let tree: any = null;
    let error: string | undefined;
    for (const line of run.logs) {
      try {
        const obj = JSON.parse(line);
        if (obj && (obj.error || obj.status === 'error')) {
          error = obj.error || obj.message || 'unknown layout error';
        } else {
          tree = obj;
        }
      } catch (e) {
        /* ignore non-json */
      }
    }
    if (error) {
      return this.fail('device layout error: ' + error);
    }
    if (!tree) {
      return this.fail('device layout: empty result (未收到 AUTOMCP 载荷，见日志)');
    }
    return { device: device.id, tree };
  }

  /**
   * 按 ref（get_layout 返回的稳定指纹）或 text/desc 点击控件。
   *
   * 【为什么需要】get_layout 与真正的点击是两次独立的下发，中间界面可能已经变化；
   * 而且跨屏边界节点的坐标按几何中心算是错的。这里把「重新 dump → 指纹校验 → 点击」
   * 压进**同一个脚本**里执行，从根上消除坐标漂移。
   */
  private async tap(args: any): Promise<any> {
    const ref: string = typeof args.ref === 'string' ? args.ref.trim() : '';
    const text: string = typeof args.text === 'string' ? args.text : '';
    const desc: string = typeof args.desc === 'string' ? args.desc : '';
    if (!ref && !text && !desc) {
      return this.fail('ref is required (or provide text / desc as fallback selector)');
    }
    const device = this.pickDevice(args.deviceId);
    const reqId = genReqId();
    const timeout = this.normalizeTimeout(args.timeoutMs);
    const script = this.buildTapScript(reqId, ref, text, desc);
    const run = await this.withLock(device.id, () =>
      this.runScript(device, script, reqId, false, timeout));
    if (run.status === 'timeout') {
      return this.fail(`device tap timeout after ${timeout}ms`);
    }
    let res: any = null;
    for (const line of run.logs) {
      try {
        const obj = JSON.parse(line);
        if (obj) { res = obj; }
      } catch (e) { /* ignore */ }
    }
    if (!res) {
      return this.fail('device tap: empty result (未收到 AUTOMCP 载荷)');
    }
    if (res.status === 'error') {
      return this.fail('device tap error: ' + (res.message || res.error || 'unknown'));
    }
    if (res.status !== 'ok') {
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: true };
    }
    return this.ok(res);
  }

  private async screenshot(args: any): Promise<any> {
    const device = this.pickDevice(args.deviceId);
    const dir: string = args.path || SCREEN_DIR;
    const reqId = genReqId();
    const script = this.buildScreenshotScript(reqId, dir);
    const logs = await this.withLock(device.id, () =>
      this.runScript(device, script, reqId, false));
    let remotePath: string | undefined;
    let error: string | undefined;
    for (const line of logs) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.error) {
          error = obj.error;
        } else if (obj && obj.path) {
          remotePath = obj.path;
        }
      } catch (e) { /* ignore */ }
    }
    if (error) {
      return this.fail('device screenshot error: ' + error);
    }
    if (!remotePath) {
      return this.fail('screenshot failed: no path returned');
    }
    // 仅 adb 模式可直接 pull；lan 模式返回设备端路径并提示
    const localDir = path.join(require('os').tmpdir(), 'autox-mcp', 'imgs');
    fs.mkdirSync(localDir, { recursive: true });
    const localPath = path.join(localDir, path.basename(remotePath));
    try {
      await this.pullFile(device, remotePath, localPath);
      return { remotePath, localPath, note: 'adb pull done' };
    } catch (e: any) {
      return {
        remotePath,
        localPath: undefined,
        note: 'adb pull failed (non-adb device?): ' + String(e && e.message ? e.message : e)
      };
    }
  }

  private stopDevice(args: any): any {
    if (args.deviceId) {
      this.server.getDeviceById(args.deviceId).sendCommand('stopAll', {});
    } else {
      this.server.sendCommand('stopAll');
    }
    return { stopped: true };
  }

  // ---------------------------------------------------------------------------
  // 脚本模板（Rhino 同步引擎，对应方案 §8.4 v1）
  // ---------------------------------------------------------------------------
  /** 包裹任意用户代码，追加 AUTOMCP 终止符，确保 runScript 能判定结束（captureAll 模式） */
  private wrapScript(code: string, reqId: string, captureAll: boolean): string {
    const endMarker = `console.log("${MCP_PREFIX}${reqId}::__END__");`;
    if (captureAll) {
      // 吞掉用户代码异常，仍输出终止符
      return `(function(){\n try{\n${code}\n }catch(e){ console.log("AUTOMCP_ERR:"+(e&&e.message||e)); }\n ${endMarker}\n})();`;
    }
    return code + '\n' + endMarker;
  }

  /**
   * v2 布局脚本：把界面归一化成**可见可识别节点的扁平列表**。
   *
   * 规则（真机实测校准，详见 AutoX-MCP-getLayout-新方案-v2.md §四）：
   *   · W/H 每次重读 device.width/height（旋转后必须重读，不能缓存）
   *   · 可见 = node.isVisibleToUser()（主判据）；该 API 抛错时才退回 bounds 求交
   *   · 保留 = 可见 && (text || desc || id || clickable || scrollable || editable || longClickable)
   *   · 坐标 = **可见交集矩形的中心**，再 clamp 到 [8, W-8]/[8, H-8]
   *            （不是几何中心！`b=[0,-100,1080,100]` 的几何中心 y=0 会点到状态栏）
   *   · 清洗 = text/desc 剥掉 <em> 等 HTML 标签，原值另存 textRaw/descRaw
   *   · 不去重（多行同文案按钮是合法重复，去重会误杀）
   *   · ref = "<hash(cls|text|desc)>.<同指纹序号>" —— 与 scope 无关，可跨调用复用
   *   · 垂直离屏节点不返回，但计进 dropped.belowFold / belowFoldReachable 与 scrollables[]，
   *     否则模型会丧失"该滚动一下"的判断力，转而去瞎改选择器。
   *
   * mode='tree' 是逃生舱：返回全量控件树（旧行为），用于确实需要"无文案又不可交互"的
   * 空白区域按坐标操作时。
   *
   * ⚠️ 本方法的产物是**要下发给设备的 JS 源码**，所以在 TS 模板字符串里：
   *    每一个反斜杠都必须写成 `\\` —— 否则 `\s` 会被模板字符串吞成 `s`，正则静默失效。
   *    不要在这个模板里写 `\b`（会变成退格符）。
   */
  private buildLayoutScript(reqId: string, scope: string, maxNodes: number, mode: string): string {
    const safeScope = jsStr(scope);
    const safeMode = (mode === 'tree' || mode === 'verbose') ? mode : 'actionable';
    // 【AutoX v6 API】auto() 是 void 函数（仅 ensureServiceEnabled），返回 undefined；
    // 根节点是【属性 getter】auto.root（= accessibilityBridge.getRootInCurrentWindow()）。
    // 故必须用 auto.root，绝不能用 auto().root()（会抛 "Cannot call method root of undefined"）。
    const body = `
(function(){
  var REQ = "${reqId}";
  var SCOPE = "${safeScope}";
  var MODE = "${safeMode}";
  var MAX = ${maxNodes};
  var SAFE = 8;
  var W = 1080, H = 1920;
  try { W = device.width || W; H = device.height || H; } catch(e){}

  function R(b){ try { return {l:b.left, t:b.top, r:b.right, b:b.bottom}; } catch(e){ return null; } }
  function clean(s){
    try {
      var t = String(s==null?"":s).replace(/<[^>]*>/g, " ");
      t = t.replace(/\\s+/g, " ");
      return t.replace(/^ /, "").replace(/ $/, "");
    } catch(e){ return String(s==null?"":s); }
  }
  function h32(s){ var h=5381,i=0; for(;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))|0; } return (h>>>0).toString(36); }
  function clamp(v,lo,hi){ return v<lo?lo:(v>hi?hi:v); }
  function shortCls(c){ var s=String(c||""); var i=s.lastIndexOf("."); return i>=0?s.substring(i+1):s; }

  try {
    auto();
    var root = auto.root;
    if(!root){ throw new Error("auto.root is null (无障碍服务未连接?)"); }

    if(MODE === "tree"){
      // 逃生舱：全量树（不做可见性过滤，仅标注 vt=false）
      function buildTree(node, depth){
        if(!node || depth > 80) return null;
        var o = {};
        try { o.cls = shortCls(node.className()||""); } catch(e){}
        try { var t=node.text()||""; if(t){ o.text = clean(t); } } catch(e){}
        try { var d=node.desc()||""; if(d){ o.desc = clean(d); } } catch(e){}
        try { var i2=node.id()||""; if(i2){ o.id = i2; } } catch(e){}
        try { var bb=R(node.bounds()); if(bb){ o.b=[bb.l,bb.t,bb.r,bb.b]; } } catch(e){}
        try { if(node.clickable()){ o.clk=true; } } catch(e){}
        try { if(node.scrollable()){ o.sc=true; } } catch(e){}
        try { if(node.isVisibleToUser()===false){ o.vt=false; } } catch(e){}
        var ch=[]; var n=0;
        try { n = node.childCount(); } catch(e){ n=0; }
        for(var i=0;i<n;i++){
          var c=null; try { c=node.child(i); } catch(e){ c=null; }
          if(c){ var t2=buildTree(c, depth+1); if(t2){ ch.push(t2); } }
        }
        if(ch.length){ o.children = ch; }
        return o;
      }
      console.log("${MCP_PREFIX}"+REQ+"::"+JSON.stringify({ ok:true, mode:"tree", screen:{w:W,h:H}, tree: buildTree(root,0) }));
      console.log("${MCP_PREFIX}"+REQ+"::__END__");
      return;
    }

    var nodes=[], scroll=[], hashCount={};
    var kept=0, total=0, overLimit=0;
    // 【实测校准】id 只作为输出字段，**不**作为保留依据。
    // 真机在 QQ音乐搜索结果页实测：把 id 算进 keep 会让返回节点从 187 涨到 331，
    // 多出的 144 个（43.5%）全是"只有资源 id、无文案也不可交互"的装饰容器
    // （FrameLayout/ImageView/RelativeLayout，形如 com.tencent.qqmusic:id/j61），
    // 模型既看不懂也点不动，只是把 payload 从 26KB 撑到 46KB —— 纯上下文噪声。
    // 需要它们时用 mode="verbose"。
    var IDKEEP = (MODE === "verbose");
    var drop={ occluded:0, horizontalOffscreen:0, belowFold:0, belowFoldReachable:0, degenerate:0, noSignal:0, idOnly:0, scopeFiltered:0 };

    function visit(node, depth, inScroll, pt){
      if(!node || depth > 80) return;
      var cls="", text="", desc="", id="", b=null;
      var clk=false, sc=false, lclk=false, ed=false, vis=null;
      try { cls = node.className()||""; } catch(e){}
      try { text = node.text()||""; } catch(e){}
      try { desc = node.desc()||""; } catch(e){}
      try { id = node.id()||""; } catch(e){}
      var tRaw = String(text), dRaw = String(desc);
      text = clean(text); desc = clean(desc);
      try { b = R(node.bounds()); } catch(e){ b = null; }
      try { clk = !!node.clickable(); } catch(e){}
      try { sc = !!node.scrollable(); } catch(e){}
      try { lclk = !!node.longClickable(); } catch(e){}
      ed = /EditText/i.test(cls);
      if(!ed){ try { ed = !!node.editable(); } catch(e){} }
      try { vis = node.isVisibleToUser(); } catch(e){ vis = null; }

      total++;
      var sw = b ? (b.r-b.l) : 0;
      var sh = b ? (b.b-b.t) : 0;
      var curScroll = inScroll || sc;

      if(!b || sw<=0 || sh<=0){
        drop.degenerate++;
      } else if(b.r <= 0 || b.l >= W){
        drop.horizontalOffscreen++;
      } else if(b.b <= 0 || b.t >= H){
        drop.belowFold++;
        if(curScroll){ drop.belowFoldReachable++; }
      } else if(vis === false){
        drop.occluded++;
      } else {
        var keep = !!(text || desc || clk || sc || ed || lclk);
        if(!keep && id){
          if(IDKEEP){ keep = true; } else { drop.idOnly++; }
        }
        if(!keep){
          if(!id){ drop.noSignal++; }
        } else {
          kept++;
          var h = h32(cls + "|" + text + "|" + desc);
          var ord = hashCount[h] || 0;
          hashCount[h] = ord + 1;
          var myRef = h + "." + ord;
          var scopeOk = !SCOPE || text.indexOf(SCOPE) >= 0 || desc.indexOf(SCOPE) >= 0;
          // scrollables 描述的是**页面**的滚动能力，不是当前返回子集的能力。
          // 所以即使该节点被 scope 滤掉 / 被 maxNodes 截断，也要记下来 ——
          // 否则模型用 scope 缩小范围后就看不到"这页能滚"了，会误以为内容只有这些。
          // （ref 是自洽指纹，可以不在 nodes 里。）
          if(sc){
            var dir = /ViewPager|HorizontalScrollView/i.test(cls) ? "h" : (sw > sh ? "h" : "v");
            scroll.push({ ref: myRef, b: [b.l, b.t, b.r, b.b], dir: dir });
          }
          if(!scopeOk){
            drop.scopeFiltered++;
          } else if(nodes.length >= MAX){
            overLimit++;
          } else {
            var o = {
              ref: myRef,
              cls: shortCls(cls),
              b: [b.l, b.t, b.r, b.b],
              cx: clamp((Math.max(b.l,0) + Math.min(b.r,W)) / 2, SAFE, W-SAFE),
              cy: clamp((Math.max(b.t,0) + Math.min(b.b,H)) / 2, SAFE, H-SAFE),
              d: depth
            };
            if(text){ o.text = text; }
            if(desc){ o.desc = desc; }
            if(id){ o.id = id; }
            if(text !== tRaw){ o.textRaw = tRaw; }
            if(desc !== dRaw){ o.descRaw = dRaw; }
            if(clk){ o.clk = true; }
            if(sc){ o.sc = true; }
            if(lclk){ o.lclk = true; }
            if(ed){ o.ed = true; }
            if(!text && !desc){
              if(pt){ o.pt = pt; }
              if(clk || lclk){ o.opaque = true; }
            }
            nodes.push(o);
          }
        }
      }

      var nextPt = text || desc || pt || "";
      var n = 0;
      try { n = node.childCount(); } catch(e){ n = 0; }
      for(var i=0;i<n;i++){
        var c = null; try { c = node.child(i); } catch(e){ c = null; }
        if(c){ visit(c, depth+1, curScroll, nextPt); }
      }
    }

    visit(root, 0, false, "");

    var notVisible = drop.occluded + drop.horizontalOffscreen + drop.belowFold + drop.degenerate;
    console.log("${MCP_PREFIX}"+REQ+"::"+JSON.stringify({
      ok: true,
      mode: "actionable",
      screen: { w: W, h: H },
      total: total,
      kept: kept,
      returned: nodes.length,
      truncated: overLimit > 0,
      dropped: {
        total: total - kept,
        notVisible: notVisible,
        occluded: drop.occluded,
        horizontalOffscreen: drop.horizontalOffscreen,
        belowFold: drop.belowFold,
        belowFoldReachable: drop.belowFoldReachable,
        degenerate: drop.degenerate,
        noSignal: drop.noSignal,
        idOnly: drop.idOnly,
        scopeFiltered: drop.scopeFiltered,
        overLimit: overLimit
      },
      scrollables: scroll,
      nodes: nodes
    }));
  } catch(e) {
    console.log("${MCP_PREFIX}"+REQ+"::"+JSON.stringify({ ok:false, status:"error", error: String(e && e.message || e) }));
  }
  console.log("${MCP_PREFIX}"+REQ+"::__END__");
})();
`;
    return body;
  }

  /**
   * 点击脚本：**在同一次下发内**完成「重新 dump → 指纹校验 → 点击」。
   *
   * 这样做的原因：get_layout 与点击是两次独立下发，中间界面可能已变；若沿用旧坐标
   * 会点空且**静默失败**（跟离屏点击是同一类问题）。把三步压进一个脚本后，位置永远
   * 取自点击前一刻的真实布局。
   *
   * 点击优先级：目标节点 click() → 最近的可点祖先 click() → 手势 click(x,y) → Tap(x,y)。
   * 「最近可点祖先」是必需的：歌名 TextView 本身 clk=false，可点的是它所在的行容器。
   *
   * 判定的可见性/keep 逻辑必须与 buildLayoutScript **逐字一致**，否则 ord 序号会错位，
   * ref 就指不到同一个节点。
   */
  private buildTapScript(reqId: string, ref: string, text: string, desc: string): string {
    const safeRef = jsStr(ref);
    const safeText = jsStr(text);
    const safeDesc = jsStr(desc);
    const body = `
(function(){
  var REQ = "${reqId}";
  var REF = "${safeRef}";
  var TSEL = "${safeText}";
  var DSEL = "${safeDesc}";
  var W = 1080, H = 1920;
  try { W = device.width || W; H = device.height || H; } catch(e){}
  function emit(o){ console.log("${MCP_PREFIX}"+REQ+"::"+JSON.stringify(o)); }
  function clean(s){
    try {
      var t = String(s==null?"":s).replace(/<[^>]*>/g, " ");
      t = t.replace(/\\s+/g, " ");
      return t.replace(/^ /, "").replace(/ $/, "");
    } catch(e){ return String(s==null?"":s); }
  }
  function h32(s){ var h=5381,i=0; for(;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))|0; } return (h>>>0).toString(36); }
  function shortCls(c){ var s=String(c||""); var i=s.lastIndexOf("."); return i>=0?s.substring(i+1):s; }
  function R(b){ try { return {l:b.left, t:b.top, r:b.right, b:b.bottom}; } catch(e){ return null; } }
  function clamp(v,lo,hi){ return v<lo?lo:(v>hi?hi:v); }

  var targetHash = "", targetOrd = -1;
  if(REF){
    var dot = REF.lastIndexOf(".");
    if(dot > 0){
      targetHash = REF.substring(0, dot);
      var ordStr = REF.substring(dot+1);
      if(ordStr !== "" && !isNaN(Number(ordStr))){ targetOrd = parseInt(ordStr, 10); }
    } else {
      targetHash = REF;
    }
    if(!targetHash){
      emit({ status:"error", message:"bad ref format: " + REF });
      console.log("${MCP_PREFIX}"+REQ+"::__END__");
      return;
    }
  }

  var hashCount = {};
  var byRef = [], bySel = [];

  function visit(node, depth, inScroll){
    if(!node || depth > 80) return;
    var cls="", text="", desc="", id="", b=null;
    var clk=false, sc=false, lclk=false, ed=false, vis=null;
    try { cls = node.className()||""; } catch(e){}
    try { text = node.text()||""; } catch(e){}
    try { desc = node.desc()||""; } catch(e){}
    try { id = node.id()||""; } catch(e){}
    text = clean(text); desc = clean(desc);
    try { b = R(node.bounds()); } catch(e){ b = null; }
    try { clk = !!node.clickable(); } catch(e){}
    try { sc = !!node.scrollable(); } catch(e){}
    try { lclk = !!node.longClickable(); } catch(e){}
    ed = /EditText/i.test(cls);
    if(!ed){ try { ed = !!node.editable(); } catch(e){} }
    try { vis = node.isVisibleToUser(); } catch(e){ vis = null; }

    var sw = b ? (b.r-b.l) : 0;
    var sh = b ? (b.b-b.t) : 0;
    var visible = !!b && sw>0 && sh>0 && !(b.r<=0 || b.l>=W || b.b<=0 || b.t>=H) && vis !== false;

    if(visible){
      var keep = !!(text || desc || id || clk || sc || ed || lclk);
      if(keep){
        var h = h32(cls + "|" + text + "|" + desc);
        var ord = hashCount[h] || 0;
        hashCount[h] = ord + 1;
        if(targetHash && h === targetHash && (targetOrd < 0 || ord === targetOrd)){
          byRef.push({ node:node, ref:h+"."+ord, cls:cls, text:text, desc:desc, b:b });
        }
        if((TSEL && text === TSEL) || (DSEL && desc === DSEL)){
          bySel.push({ node:node, ref:h+"."+ord, cls:cls, text:text, desc:desc, b:b });
        }
      }
    }

    var n = 0;
    try { n = node.childCount(); } catch(e){ n = 0; }
    for(var i=0;i<n;i++){
      var c = null; try { c = node.child(i); } catch(e){ c = null; }
      if(c){ visit(c, depth+1, inScroll || sc); }
    }
  }

  try {
    auto();
    var root = auto.root;
    if(!root){ throw new Error("auto.root is null (无障碍服务未连接?)"); }
    visit(root, 0, false);

    var cand = byRef.length ? byRef : bySel;
    if(!cand.length){
      emit({
        status: "not_found",
        message: REF ? ("ref 已失效：" + REF + "（该节点已不存在或页面已变化）")
                     : "未找到文案/描述与给定值精确相等的可见节点",
        hint: "请重新调用 device_get_layout 取新的 ref。页面滚动/跳转后旧 ref 会失效。"
      });
    } else if(cand.length > 1){
      var list = [];
      for(var j=0; j<cand.length && j<10; j++){
        var c1 = cand[j];
        list.push({ ref:c1.ref, cls:shortCls(c1.cls), text:c1.text, desc:c1.desc, b:[c1.b.l,c1.b.t,c1.b.r,c1.b.b] });
      }
      emit({
        status: "ambiguous",
        count: cand.length,
        candidates: list,
        hint: "有多个节点指纹相同，请用 device_tap{ref:\\"...\\"} 指定其中一个。"
      });
    } else {
      var hit = cand[0];
      var cx = clamp((Math.max(hit.b.l,0) + Math.min(hit.b.r,W)) / 2, 8, W-8);
      var cy = clamp((Math.max(hit.b.t,0) + Math.min(hit.b.b,H)) / 2, 8, H-8);

      var clickTarget = null;
      var el = hit.node, guard = 0;
      while(el && guard++ < 20){
        var okc = false;
        try { okc = !!el.clickable(); } catch(e){ okc = false; }
        if(okc){ clickTarget = el; break; }
        try { el = el.parent(); } catch(e){ el = null; }
      }

      var done = false, via = "";
      if(clickTarget){
        try { if(clickTarget.click()){ done = true; via = "node.click()"; } } catch(e){ done = false; }
      }
      if(!done){
        try { click(cx, cy); done = true; via = "gesture click(x,y)"; } catch(e){ done = false; }
      }
      if(!done){
        try { Tap(cx, cy); done = true; via = "root Tap(x,y)"; } catch(e){ done = false; }
      }

      var res = {
        status: done ? "ok" : "failed",
        via: via,
        ref: hit.ref,
        cls: shortCls(hit.cls),
        text: hit.text,
        desc: hit.desc,
        b: [hit.b.l, hit.b.t, hit.b.r, hit.b.b],
        cx: cx,
        cy: cy
      };
      // 若命中的节点本身不可点（如歌名 TextView），真正被点的是它的祖先容器。
      // 明确报出来，避免"我点了歌名结果点在整行上"这种隐性偏差。
      if(clickTarget){
        var tcls = "";
        try { tcls = clickTarget.className() || ""; } catch(e){}
        if(tcls !== hit.cls){
          res.targetCls = shortCls(tcls);
          try {
            var tb = R(clickTarget.bounds());
            if(tb){ res.targetB = [tb.l, tb.t, tb.r, tb.b]; }
          } catch(e){}
          res.note = "目标节点本身不可点，已上溯到最近的可点祖先";
        }
      }
      if(!done){ res.error = "所有点击方式均失败（node.click / click(x,y) / Tap(x,y)）"; }
      emit(res);
    }
  } catch(e) {
    emit({ status:"error", message: String(e && e.message || e) });
  }
  console.log("${MCP_PREFIX}"+REQ+"::__END__");
})();
`;
    return body;
  }

  private buildScreenshotScript(reqId: string, dir: string): string {
    const safeDir = dir.replace(/"/g, '\\"');
    // 截屏需 MediaProjection（截屏/录屏）权限；不存在时 images.captureScreen 抛
    // "No screen capture permission"。此处先尝试直接截图，失败再 images.requestScreenCapture()
    // 触发系统授权弹窗（Android 14 起 MediaProjection 需每次会话用户确认）。
    // 注意：requestScreenCapture() 为阻塞调用（runBlocking），会等待用户在设备上点"允许"。
    return `
(function(){
  var REQ = "${reqId}";
  function emit(o){ console.log("${MCP_PREFIX}"+REQ+"::"+JSON.stringify(o)); }
  try {
    var dir = "${safeDir}";
    importClass(java.io.File);
    var f = new File(dir); f.mkdirs();
    var p = dir + "/shot_" + (new Date().getTime()) + ".png";
    try {
      images.captureScreen(p);
    } catch (e0) {
      var msg = String(e0 && e0.message || e0);
      if (msg.indexOf("permission") >= 0 || msg.indexOf("SecurityException") >= 0) {
        var ok = images.requestScreenCapture();
        if (!ok) { throw new Error("screen capture permission denied by user"); }
        images.captureScreen(p);
      } else {
        throw e0;
      }
    }
    var file = new File(p);
    if (!file.exists()) { throw new Error("capture reported success but file missing: " + p); }
    emit({path: p, size: file.length()});
  } catch(e){
    emit({error: String(e && e.message || e)});
  }
  console.log("${MCP_PREFIX}"+REQ+"::__END__");
})();
`;
  }

  // ---------------------------------------------------------------------------
  // 执行与关联
  // ---------------------------------------------------------------------------
  /** 串行锁：同一设备一次只跑一个脚本（约束 4） */
  private withLock(deviceId: string, fn: () => Promise<any>): Promise<any> {
    const key = deviceId || 'global';
    const prev = this.locks.get(key) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /**
   * 下发脚本到设备并收集结果。
   * - captureAll=false：只收集带 AUTOMCP::<reqId>:: 前缀的行（布局/截图结构化结果）。
   * - captureAll=true：收集所有 log 行（device_run_code 的任意输出）。
   * 以 AUTOMCP::<reqId>::__END__ 或超时为结束信号。
   *
   * 【2026-09-28】返回值由 `string[]` 改为 {@link ScriptRun} —— 超时与正常结束
   * 分别表达，调用方不再需要靠"有没有 __END__"去猜。
   */
  private runScript(device: Device, script: string, reqId: string, captureAll: boolean, timeout: number = RUN_TIMEOUT): Promise<ScriptRun> {
    const prefix = MCP_PREFIX + reqId + '::';
    return new Promise<ScriptRun>((resolve) => {
      const collected: string[] = [];
      let done = false;
      let timedOut = false;
      const finish = () => {
        if (done) { return; }
        done = true;
        clearTimeout(timer);
        device.removeListener('data:log', handler);
        resolve(timedOut ? { status: 'timeout', logs: collected, timeoutMs: timeout } : { status: 'ok', logs: collected });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        finish();
      }, timeout);

      const handler = (data: any) => {
        const text = data && data.log;
        if (typeof text !== 'string') {
          return;
        }
        if (captureAll) {
          // 剪贴板同步的桥接日志会混进来（它借 console.log 当上行通道），
          // 不是本次脚本的输出，必须滤掉，否则 device_run_code 的返回会被污染。
          if (text.indexOf('AUTOCLIP1::') >= 0) {
            return;
          }
          collected.push(text);
          if (text.indexOf(prefix + '__END__') >= 0) {
            finish();
          }
          return;
        }
        const idx = text.indexOf(prefix);
        if (idx >= 0) {
          const payload = text.substring(idx + prefix.length);
          if (payload === '__END__') {
            finish();
          } else {
            collected.push(payload);
          }
        }
      };

      device.on('data:log', handler);
      // 下发前先 stopAll，清掉可能残留的脚本（方案 §14.3：单连接串行）
      try { device.sendCommand('stopAll', {}); } catch (e) { /* ignore */ }
      // 【关键】name 必须带 .js 扩展名。设备端 DevPluginResponseHandler.runScript 用
      // name 拼出文件名（remote-<name>）后交给 EngineController.runScript，后者按
      // file.extension 选择脚本源/引擎：带 .js → JavaScriptSource(ENGINE)，其 console
      // 会转发到 globalConsole（→ DevPlugin 回传）；无扩展名 → ScriptFile.toSource()
      // 解析为非 JS 源，脚本仍会执行（有 Start operation/Finished running 生命周期日志），
      // 但其 console.log 不会转发到 globalConsole，导致宿主收不到任何脚本输出。
      // 真机二分实测：name='b1.js' → 脚本日志回传 ✅；name='b2' → 仅引擎日志 ❌。
      device.sendCommand('run', { id: 'automcp_' + reqId, name: 'automcp_' + reqId + '.js', script });
    });
  }

  private async pullFile(device: Device, remotePath: string, localPath: string): Promise<void> {
    const adbDevice = this.server.adbClient.getDevice(device.id);
    const transfer = await adbDevice.pull(remotePath);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(localPath);
      transfer.on('end', () => { ws.end(); resolve(); });
      transfer.on('error', (e: any) => { ws.end(); reject(e); });
      transfer.pipe(ws);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
