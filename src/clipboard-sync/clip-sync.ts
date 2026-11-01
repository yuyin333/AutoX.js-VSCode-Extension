'use strict';

import * as vscode from 'vscode';
import { AutoJsDebugServer } from '../autojs-debug';
import {
  APPLY_SCRIPT_ID,
  APPLY_SCRIPT_NAME,
  ClipUp,
  DEFAULT_PHONE_SCRIPT_DIR,
  INSTALL_SCRIPT_ID,
  INSTALL_SCRIPT_NAME,
  SENDER_SCRIPT_NAME,
  buildApplyScript,
  buildInstallScript,
  buildSenderScript,
  hashOf,
  parseClipLine
} from './protocol';

type Direction = 'both' | 'pc2phone' | 'phone2pc';

interface ClipSyncConfig {
  enabled: boolean;
  direction: Direction;
  pollIntervalMs: number;
  unfocusedPollMs: number;
  maxTextLength: number;
  minDownlinkIntervalMs: number;
  logContent: boolean;
  skipPatterns: string[];
  /** 手机端 AutoX 的脚本目录，安装「发送剪贴板」脚本时落在这里 */
  phoneScriptDir: string;
}

/** 手机端刚写进 PC 剪贴板的内容指纹；这段时间内 PC 侧轮询看到它要跳过，否则会立刻回传形成回环 */
const SUPPRESS_TTL = 15000;
/** 刚下发过的内容指纹；用户紧接着点“发送”时用它识别回声 */
const ECHO_TTL = 30000;

/**
 * 剪贴板同步。
 *
 * 通道事实（均经真机验证，见 docs）：
 * - 下行：`run` 一段短脚本 → `setClip()`，后台可写，约 0.4s 完成；
 * - 上行：只走 `console.log` 前缀，且**必须 AutoX 在前台**（Android 10+ 后台读被拒）。
 */
export class ClipSyncManager implements vscode.Disposable {
  private statusItem: vscode.StatusBarItem;
  private output: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];

  private enabled = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private pendingText: string | null = null;
  private pendingTimer: NodeJS.Timeout | undefined;

  private lastPcHash = '';
  private suppressHash = '';
  private suppressAt = 0;

  private lastDownHash = '';
  private lastDownAt = 0;
  private lastDownlinkAt = 0;

  private appliedCount = 0;
  private scanCount = 0;
  private lastEvent = '空闲';
  private lastDeviceCount = 0;
  private warnedTooBig = false;

  /** 安装回执的一次性等待者（事件驱动，不轮询） */
  private installWaiter: { settle: (m: ClipUp | null) => void; timer: NodeJS.Timeout } | undefined = undefined;

  constructor(private server: AutoJsDebugServer) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'autoxAi.clipSyncStatus';
    this.output = vscode.window.createOutputChannel('Autox.js 剪贴板同步');
    this.statusItem.show();

    // 上行：所有设备日志都会汇总成 server 的 'log' 事件（autojs-debug.ts attachDevice）
    // 注：EventEmitter.on 返回自身而非 Disposable，不能塞进 disposables
    this.server.on('log', (line: string) => this.onDeviceLog(line));
    this.server.on('new_device', () => this.render());
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('clipSync')) {
        this.applyConfig();
      }
    }));
    this.disposables.push(vscode.window.onDidChangeWindowState(() => {
      // 焦点变化后立刻按新节奏重排一次，不等当前定时器自然到期
      if (this.enabled) {
        this.unschedule();
        this.schedule(10);
      }
    }));
    this.disposables.push(this.statusItem);
    this.disposables.push(this.output);

    // 注意：这里不能直接把 enabled 置成配置值 —— 否则 start() 里 applyConfig 会认为
    // “本来就是开的”，跳过首次调度，轮询永远起不来。
    this.render();
  }

  private config(): ClipSyncConfig {
    const c = vscode.workspace.getConfiguration('clipSync');
    return {
      enabled: c.get('enabled', false),
      direction: c.get<Direction>('direction', 'both'),
      pollIntervalMs: Math.max(100, c.get('pollIntervalMs', 300)),
      unfocusedPollMs: Math.max(300, c.get('unfocusedPollMs', 2000)),
      maxTextLength: Math.max(1024, c.get('maxTextLength', 32768)),
      minDownlinkIntervalMs: Math.max(0, c.get('minDownlinkIntervalMs', 400)),
      logContent: c.get('logContent', false),
      skipPatterns: c.get<string[]>('skipPatterns', ['-----BEGIN [A-Z ]*PRIVATE KEY-----']),
      phoneScriptDir: (c.get<string>('phoneScriptDir', DEFAULT_PHONE_SCRIPT_DIR) || DEFAULT_PHONE_SCRIPT_DIR).replace(/\/+$/, '')
    };
  }

  /** 启用时启动；配置变化时重排 */
  start(): void {
    this.applyConfig();
  }

  private applyConfig(): void {
    const cfg = this.config();
    const wasEnabled = this.enabled;
    this.enabled = cfg.enabled;
    if (this.enabled) {
      if (!wasEnabled) {
        this.lastPcHash = '';
        this.unschedule();
        this.schedule(10);
        this.info('已启用（' + cfg.direction + '，轮询 ' + cfg.pollIntervalMs + 'ms / 失焦 ' + cfg.unfocusedPollMs + 'ms）');
      }
    } else {
      this.unschedule();
      if (wasEnabled) {
        this.info('已停用');
      }
    }
    this.render();
  }

  async toggle(): Promise<void> {
    const next = !this.enabled;
    await vscode.workspace.getConfiguration('clipSync').update('enabled', next, vscode.ConfigurationTarget.Global);
    this.applyConfig();
    if (next) {
      vscode.window.showInformationMessage('剪贴板同步已开启：PC 复制的内容会自动写入手机剪贴板。');
    }
  }

  /**
   * 把「发送剪贴板」脚本写到手机脚本目录（一次性安装）。
   *
   * 不用 `save` 命令：手机端 `saveScript()` 丢弃 `PFiles.write` 的返回值、无条件 toast 成功，
   * 且 `save` 没有回执 —— 真机上出现过「文件被创建但内容 0 字节，两端都报成功」。
   * 改为 `run` 一段安装脚本：手机自己写盘 + 回读比对 + 把结果打回 PC，失败能说出原因。
   */
  async installSender(): Promise<void> {
    if (this.server.devices.length === 0) {
      vscode.window.showWarningMessage('没有已连接的设备：请先在 AutoX 里开启「连接电脑」，或连接 ADB。');
      return;
    }
    const cfg = this.config();
    const body = buildSenderScript();
    const target = cfg.phoneScriptDir + '/' + SENDER_SCRIPT_NAME;
    this.info(`开始安装：${target}（正文 ${body.length} 字符）`);

    const pending = this.waitInstall(8000);
    try {
      this.server.sendCommand('run', {
        id: INSTALL_SCRIPT_ID,
        name: INSTALL_SCRIPT_NAME,
        script: buildInstallScript(cfg.phoneScriptDir, SENDER_SCRIPT_NAME, body)
      });
    } catch (e: any) {
      this.settleInstall(null);
      vscode.window.showErrorMessage('下发失败：' + (e && e.message ? e.message : e));
      return;
    }

    const res = await pending;
    if (!res) {
      this.lastEvent = '安装无回执（超时）';
      this.info(this.lastEvent);
      this.render();
      vscode.window.showErrorMessage(
        `安装没有收到手机端回执（8 秒超时）。请确认 AutoX 仍连着电脑；` +
        `若手机脚本目录不是 ${cfg.phoneScriptDir}，请改设置 clipSync.phoneScriptDir 后重试。`
      );
      return;
    }

    if (res.ok) {
      this.lastEvent = `已安装 ${SENDER_SCRIPT_NAME}（${res.n || 0} 字符）`;
      this.info(this.lastEvent + ' -> ' + (res.path || target));
      this.render();
      vscode.window.showInformationMessage(
        `已安装「${SENDER_SCRIPT_NAME}」：${res.n || 0} 字符，已回读校验（${res.path || target}）。` +
        '在 AutoX 里打开它点运行，即可把手机剪贴板发送到电脑。',
        '知道了'
      );
      return;
    }

    const why = res.m || '手机端未说明原因';
    this.lastEvent = '安装失败：' + why;
    this.info(this.lastEvent + '（目标 ' + (res.path || target) + '）');
    this.render();
    vscode.window.showErrorMessage(
      `安装失败（手机端回报）：${why}\n目标路径：${res.path || target}\n` +
      `若是目录不对，改设置 clipSync.phoneScriptDir；若是写入被拒，检查 AutoX 的存储权限。`
    );
  }

  /** 展示状态面板 */
  showStatus(): void {
    const cfg = this.config();
    const lines = [
      '启用：' + (this.enabled ? '是' : '否'),
      '方向：' + cfg.direction,
      '已连接设备：' + this.server.devices.length,
      'PC->手机 下发：' + this.appliedCount + ' 次',
      '手机->PC 接收：' + this.scanCount + ' 次',
      '最近事件：' + this.lastEvent,
      '',
      '说明：手机到电脑需要你在手机上运行「' + SENDER_SCRIPT_NAME + '」（Android 10+ 不允许后台读剪贴板）。',
      '还没安装该脚本？执行命令：Autox.js: 安装手机端「发送剪贴板」脚本。'
    ];
    this.output.appendLine('--- ' + new Date().toLocaleString() + ' ---');
    lines.forEach(l => this.output.appendLine(l));
    this.output.show(true);
  }

  // -------------------------------------------------------------------------
  // 安装回执
  // -------------------------------------------------------------------------
  /** 等手机端 install 回执；超时 resolve(null)。事件驱动，不做轮询等待。 */
  private waitInstall(timeoutMs: number): Promise<ClipUp | null> {
    this.settleInstall(null);
    return new Promise<ClipUp | null>(resolve => {
      const timer = setTimeout(() => {
        // 只清掉自己（期间可能已被新一次安装顶替）
        if (this.installWaiter && this.installWaiter.timer === timer) {
          this.installWaiter = undefined;
        }
        resolve(null);
      }, timeoutMs);
      this.installWaiter = { settle: resolve, timer: timer };
    });
  }

  /** 结算等待者；没有等待者时是空操作 */
  private settleInstall(msg: ClipUp | null): void {
    const waiter = this.installWaiter;
    if (!waiter) {
      return;
    }
    this.installWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.settle(msg);
  }

  // -------------------------------------------------------------------------
  // PC 侧轮询
  // -------------------------------------------------------------------------
  private schedule(ms: number): void {
    this.pollTimer = setTimeout(() => { this.tick(); }, ms);
  }

  private unschedule(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled) {
      this.pollTimer = undefined;
      return;
    }
    const cfg = this.config();
    const focused = vscode.window.state.focused;
    try {
      if (this.server.devices.length === 0) {
        // 没设备就不必碰剪贴板，降频等待，设备一来立刻恢复
        this.render();
        this.schedule(1000);
        return;
      }
      let text = '';
      try {
        text = await vscode.env.clipboard.readText();
      } catch (e) {
        text = '';
      }
      const h = hashOf(text);
      if (h !== this.lastPcHash) {
        this.lastPcHash = h;
        const suppressed = this.suppressHash === h && (Date.now() - this.suppressAt) < SUPPRESS_TTL;
        if (!suppressed) {
          this.onPcChanged(text, h);
        } else if (this.lastEvent !== '已跳过刚由手机写入的内容') {
          this.lastEvent = '已跳过刚由手机写入的内容';
          this.render();
        }
      }
    } finally {
      this.schedule(focused ? cfg.pollIntervalMs : cfg.unfocusedPollMs);
    }
  }

  private onPcChanged(text: string, h: string): void {
    const cfg = this.config();
    if (!this.enabled || cfg.direction === 'phone2pc') {
      return;
    }
    if (!text) {
      // 空值一律视为“没有信号”，不主动把手机剪贴板清空
      return;
    }
    if (text.length > cfg.maxTextLength) {
      if (!this.warnedTooBig) {
        this.warnedTooBig = true;
        this.info(`内容 ${text.length} 字符，超过上限 ${cfg.maxTextLength}，已跳过（不截断，避免发出半截内容）`);
        vscode.window.showWarningMessage(`剪贴板内容过长（${text.length} > ${cfg.maxTextLength}），本次未同步。`);
      }
      return;
    }
    this.warnedTooBig = false;
    if (this.matchesSkip(text, cfg.skipPatterns)) {
      this.info('内容命中 skipPatterns，已跳过');
      return;
    }
    // 回声：就是刚下发的那份内容
    if (h === this.lastDownHash && (Date.now() - this.lastDownAt) < ECHO_TTL) {
      return;
    }
    this.queueDownlink(text);
  }

  private matchesSkip(text: string, patterns: string[]): boolean {
    for (const p of patterns || []) {
      if (!p) { continue; }
      try {
        if (new RegExp(p).test(text)) { return true; }
      } catch (e) { /* 用户写了非法正则，忽略该条 */ }
    }
    return false;
  }

  /**
   * 下行节流：内容变化可能很密（拖选/连续复制），只发最后一次，
   * 且两次下发至少间隔 minDownlinkIntervalMs —— 每次下发都会在手机上起一个脚本任务。
   */
  private queueDownlink(text: string): void {
    const cfg = this.config();
    this.pendingText = text;
    if (this.pendingTimer) {
      return;
    }
    const wait = Math.max(0, cfg.minDownlinkIntervalMs - (Date.now() - this.lastDownlinkAt));
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      const t = this.pendingText;
      this.pendingText = null;
      if (t === null) { return; }
      this.sendDownlink(t);
    }, wait);
  }

  private sendDownlink(text: string): void {
    const cfg = this.config();
    // 排队期间可能被关掉/设备掉线，落地前再确认一次
    if (!this.enabled || this.server.devices.length === 0) {
      return;
    }
    if (text.length > cfg.maxTextLength) {
      return;
    }
    const h = hashOf(text);
    this.lastDownHash = h;
    this.lastDownAt = Date.now();
    this.lastDownlinkAt = Date.now();
    try {
      this.server.sendCommand('run', {
        id: APPLY_SCRIPT_ID,
        name: APPLY_SCRIPT_NAME,
        script: buildApplyScript(text)
      });
      this.appliedCount++;
      this.lastEvent = 'PC->手机 ' + text.length + ' 字符';
      if (cfg.logContent) {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] 下发 ${text.length} 字符 h=${h} 内容=${JSON.stringify(text)}`);
      } else {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] 下发 ${text.length} 字符 h=${h}`);
      }
    } catch (e: any) {
      this.lastEvent = '下发失败：' + (e && e.message ? e.message : e);
      this.info(this.lastEvent);
    }
    this.render();
  }

  // -------------------------------------------------------------------------
  // 手机 -> PC
  // -------------------------------------------------------------------------
  private onDeviceLog(line: string): void {
    if (this.enabled && this.lastDeviceCount !== this.server.devices.length) {
      this.lastDeviceCount = this.server.devices.length;
      this.render();
    }
    const msg = parseClipLine(line);
    if (!msg) {
      return;
    }
    if (msg.k === 'scan') {
      this.onPhoneScan(typeof msg.txt === 'string' ? msg.txt : '');
      return;
    }
    if (msg.k === 'install') {
      this.settleInstall(msg);
      return;
    }
    if (msg.k === 'applied') {
      this.lastEvent = '手机已应用 ' + (msg.n || 0) + ' 字符';
      this.render();
      return;
    }
    if (msg.k === 'error') {
      this.lastEvent = '手机端报错：' + (msg.m || '');
      this.info(this.lastEvent);
      this.render();
    }
  }

  private onPhoneScan(text: string): void {
    const cfg = this.config();
    if (!this.enabled || cfg.direction === 'pc2phone') {
      return;
    }
    if (text.length === 0) {
      // 硬规则：空内容永不写入 PC 剪贴板（区分不了“真空”和“被拒”，一律不动）
      this.lastEvent = '手机剪贴板为空或被拒，未改动 PC 剪贴板';
      this.render();
      return;
    }
    if (text.length > cfg.maxTextLength) {
      this.lastEvent = `手机内容过长（${text.length}），已忽略`;
      this.render();
      return;
    }
    const h = hashOf(text);
    if (h === this.lastDownHash && (Date.now() - this.lastDownAt) < ECHO_TTL) {
      this.lastEvent = '手机发回的就是刚下发的同一份内容，已忽略';
      this.render();
      return;
    }
    if (h === this.lastPcHash) {
      this.lastEvent = '两端内容一致，无需写入';
      this.render();
      return;
    }
    this.suppressHash = h;
    this.suppressAt = Date.now();
    this.lastPcHash = h;
    vscode.env.clipboard.writeText(text).then(() => {
      this.scanCount++;
      this.lastEvent = '手机->PC ' + text.length + ' 字符';
      if (cfg.logContent) {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] 接收 ${text.length} 字符 h=${h} 内容=${JSON.stringify(text)}`);
      } else {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] 接收 ${text.length} 字符 h=${h}`);
      }
      this.render();
    }, (e: any) => {
      this.lastEvent = '写 PC 剪贴板失败：' + (e && e.message ? e.message : e);
      this.info(this.lastEvent);
      this.render();
    });
  }

  // -------------------------------------------------------------------------
  private info(text: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${text}`);
  }

  private render(): void {
    const dir = this.config().direction;
    const arrow = dir === 'pc2phone' ? '↓' : (dir === 'phone2pc' ? '↑' : '↕');
    if (!this.enabled) {
      this.statusItem.text = '$(clippy) 剪贴板：关';
      this.statusItem.tooltip = '剪贴板同步已关闭，点击查看状态';
      return;
    }
    const n = this.server.devices.length;
    this.statusItem.text = '$(clippy) 剪贴板 ' + arrow + (n > 0 ? '' : ' 待设备');
    this.statusItem.tooltip = [
      '剪贴板同步已开启',
      '方向：' + dir,
      '设备：' + n + ' 台',
      'PC->手机 ' + this.appliedCount + ' 次 / 手机->PC ' + this.scanCount + ' 次',
      '最近：' + this.lastEvent,
      '点击查看详情'
    ].join('\n');
  }

  dispose(): void {
    this.unschedule();
    this.settleInstall(null);
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.disposables.forEach(d => { try { d.dispose(); } catch (e) { } });
    this.disposables = [];
  }
}
