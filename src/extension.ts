'use strict';
import * as vscode from 'vscode';
import { AutoJsDebugServer, Device } from './autojs-debug';
import { ProjectTemplate, Project } from './project';
import { McpBridge, DEFAULT_MCP_PORT } from './mcp';
import { ClipSyncManager } from './clipboard-sync/clip-sync';

import * as fs from 'fs'
import * as path from "path";

let server = new AutoJsDebugServer(9317);
/** activate 自动拉起服务期间为 true：此时端口冲突只做状态栏轻提示，避免每开一个窗口弹一次红框 */
let silentPortErrors = false;
let recentDevice = null;
server
  .on('connect', () => {
    let servers = server.getIPs().join(":" + server.getPort() + " or ") + ":" + server.getPort();
    let showQrcode = "Show QR code"
    vscode.window.showInformationMessage(`Autox.js-VSCodeExt-Ai \r\n server running on ${servers}`, showQrcode).then((result) => {
      if (result === showQrcode) {
        vscode.commands.executeCommand("autoxAi.showQrCode")
      }
    });
  })
  .on('connected', () => {
    vscode.window.showInformationMessage('Autox.js Server already running');
  })
  .on('disconnect', () => {
    vscode.window.showInformationMessage('Autox.js Server stopped');
  })
  // 端口被占用等监听失败：以前只 console.error，界面上还显示"已启动"。现在明确告知 + 给出解法。
  .on('listen_error', (info: { port: number; code: string; message: string }) => {
    const hint = info.code === 'EADDRINUSE'
      ? `端口 ${info.port} 已被占用（很可能另一个同类插件——原版 Auto.js-Autox.js-VSCodeExt——正在运行）。\n` +
        `两个插件同一时刻只能有一个接管手机；如需并存，请把本插件改到别的端口：设置 autoxAi.serverPort。`
      : `监听 ${info.port} 失败：${info.message || info.code}`;
    // 启动阶段（activate 自动拉起）失败只做轻提示：否则两个插件都装着时，每开一个窗口就弹一次红框
    if (silentPortErrors) {
      console.warn('Autox.js：' + hint);
      vscode.window.setStatusBarMessage(
        `$(warning) Autox.js：端口 ${info.port} 被占用，未自动启动（改 autoxAi.serverPort 可避开）`,
        15000
      );
      return;
    }
    vscode.window.showErrorMessage('Autox.js：' + hint);
  })
  .on('adb:tracking_start', () => {
    vscode.window.showInformationMessage(`ADB: Tracking start`);
  })
  .on('adb:tracking_started', () => {
    vscode.window.showInformationMessage(`ADB: Tracking already running`);
  })
  .on('adb:tracking_stop', () => {
    vscode.window.showInformationMessage(`ADB: Tracking stop`);
  })
  .on('adb:tracking_error', () => {
    vscode.window.showInformationMessage(`ADB: Tracking error`);
  })
  .on('new_device', (device: Device) => {
    let messageShown = false;
    let showMessage = () => {
      if (messageShown)
        return;
      vscode.window.showInformationMessage('New device attached: ' + device);
      messageShown = true;
    };
    setTimeout(showMessage, 1000);
    device.on('data:device_name', showMessage);
    // device.send("hello","打开连接");
  })
  .on('cmd', (cmd: String, url: String) => {
    switch (cmd) {
      case "save":
        extension.saveProject(url);
        break;
      case "rerun":
        extension.stopAll();
        setTimeout(function () {
          extension.run(url);
        }, 1000);
        break;
      default:
        break;
    }
  })





class Extension {
  private documentViewPanel: any = undefined;
  private qrCodeViewPanel: any = undefined;
  private documentCache: Map<string, string> = new Map<string, string>();
  private mcpBridge: McpBridge | undefined = undefined;

  // ---------------------------------------------------------------------------
  // 剪贴板同步
  // ---------------------------------------------------------------------------
  clipSyncToggle() {
    if (!clipSync) { return; }
    clipSync.toggle();
  }

  clipSyncInstallSender() {
    if (!clipSync) { return; }
    // 安装要等手机端回执，结果由 installSender 内部提示
    clipSync.installSender().catch((e: any) => {
      vscode.window.showErrorMessage('安装失败：' + (e && e.message ? e.message : e));
    });
  }

  clipSyncStatus() {
    if (!clipSync) { return; }
    clipSync.showStatus();
  }

  showServerAddress() {
    // 服务没真正监听时不要显示"running on ..."：端口被别的插件占用时，这种假地址最误导人
    if (!server.isHttpServerStarted) {
      vscode.window.showWarningMessage(
        `Autox.js 服务未在监听（端口 ${server.getPort()}）。\n` +
        `可能被另一个同类插件占用，可在设置 autoxAi.serverPort 换端口后重新启动服务。`
      );
      return;
    }
    let servers = server.getIPs().join(":" + server.getPort() + " or ") + ":" + server.getPort();
    vscode.window.showInformationMessage(`Autox.js-VSCodeExt-Ai \r\n server running on ${servers}`)
  }

  showQrCode() {
    let ips = server.getIPs()
    if (ips.length == 1) {
      this.showQrcodeWebview(ips[0])
    } else {
      vscode.window.showQuickPick(ips)
        .then(ip => {
          this.showQrcodeWebview(ip)
        });
    }

  }

  private showQrcodeWebview(ip: string) {
    let url = `ws://${ip}:${server.getPort()}`
    if (!this.qrCodeViewPanel) {
      this.qrCodeViewPanel = vscode.window.createWebviewPanel(
        'Qr code',
        "Qr code",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
        }
      );
      this.qrCodeViewPanel.onDidDispose(() => {
        this.qrCodeViewPanel = undefined;
      },
        undefined,
        _context.subscriptions
      );
    }
    this.qrCodeViewPanel.webview.html = Extension.getQrCodeHtml(url)
  }

  private static getQrCodeHtml(text: string): string {
    const icon = Extension.getVscodeResourceUrl("logo.png")
    const qrcodejs = Extension.getVscodeResourceUrl("assets/qrcode.js")
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QR CODE</title>
</head>
<body>
    <div id="qrcode"></div>
    <div style="margin-top:12px;font-family:Consolas,Menlo,monospace;font-size:14px;user-select:all">${text}</div>
    <div style="margin-top:4px;font-size:12px;opacity:.7">扫码连接；手动输入请连同端口一起填</div>
    <script src="${qrcodejs}"></script>
    <script type="text/javascript">
        new QRCode(document.getElementById("qrcode"), {
            width: 200,
            height: 200,
            curtainWidth: 220,
            curtainHeight: 220,
            qrcodeOffsetX: 10,
            qrcodeOffsetY: 10,
            curtainBgColor: "white",
            text: "${text}",
            iconSrc: "${icon}",
            iconRadius: 10
        }
        )
    </script>
</body>
</html>`
  }

  private static getVscodeResourceUrl(relativePath: string): string {
    return vscode.Uri.file(
      path.join(_context.extensionPath, relativePath)
    ).with({ scheme: 'vscode-resource' }).toString();
  }

  openDocument() {
    if (this.documentViewPanel) {
      this.documentViewPanel.reveal((vscode.ViewColumn as any).Beside);
    } else {
      // 1.创建并显示Webview
      this.documentViewPanel = (vscode.window as any).createWebviewPanel(
        // 该webview的标识，任意字符串
        'Autox.js Document',
        // webview面板的标题，会展示给用户
        'Autox.js开发文档',
        // webview面板所在的分栏
        (vscode.ViewColumn as any).Beside,
        // 其它webview选项
        {
          // Enable scripts in the webview
          enableScripts: true,
          retainContextWhenHidden: true, // webview被隐藏时保持状态，避免被重置
        }
      );
      // Handle messages from the webview
      this.documentViewPanel.webview.onDidReceiveMessage(message => {
        // console.log('插件收到的消息：' + message.href);
        let href = message.href.substring(message.href.indexOf("\/electron-browser\/") + 18);
        // console.log("得到uri：" + href)
        this.loadDocument(href)
      }, undefined, _context.subscriptions);
      this.documentViewPanel.onDidDispose(() => {
        this.documentViewPanel = undefined;
      },
        undefined,
        _context.subscriptions
      );
    }
    try {
      // 默认加载首页
      this.loadDocument("http://doc.autoxjs.com/#/");
    } catch (e) {
      console.trace(e)
    }
  }

  private loadDocument(url) {
    try {
      let cache = this.documentCache.get(url);
      if (!cache) {
        cache = `<!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" name="viewport">
                    <meta content="portrait" name="x5-orientation">
                    <meta content="true" name="x5-fullscreen">
                    <meta content="portrait" name="screen-orientation">
                    <meta content="yes" name="full-screen">
                    <meta content="webkit" name="renderer">
                    <meta content="IE=Edge" http-equiv="X-UA-Compatible">
                    <title>微信读书</title>
                    <style>
                    html,body,iframe{
                        width:100%;
                        height:100%;
                        border:0;
                        overflow: hidden;
                    }
                    </style>
                </head>
                <body>
                    <iframe src="`+ url + `"/>
                </body>
                </html>`;
        this.documentCache.set(url, cache);
      }
      this.documentViewPanel.webview.html = cache;
    } catch (e) {
      console.trace(e);
    }
  }

  startServer() {
    server.listen();
  }

  stopServer() {
    server.disconnect();
  }

  /** 启动 AutoX MCP 桥（HTTP/SSE，127.0.0.1:18789/sse），复用 server 单例暴露工具给 AI 主机（方案 §14.7）。
   *  同时拉起调试服务并自动跟踪/连接 ADB 设备：adb 模式下手机是 WS 服务端，扩展必须主动 connectDevice
   *  才能把设备附加到 server.devices，否则 getDeviceById 永远拿不到设备、MCP 工具全部“无设备”（方案 §16 真机验证结论）。*/
  startMcpServer() {
    if (this.mcpBridge) {
      vscode.window.showInformationMessage('Autox.js MCP server already running');
      return;
    }
    const port = Extension.readPort('mcpPort', DEFAULT_MCP_PORT);
    if (!server.isHttpServerStarted) {
      server.listen();
    }
    server.trackADBDevices();
    const bridge = new McpBridge(server, port);
    // 可选令牌：留空则只做 Host/Origin 校验（默认，客户端无需任何配置）
    bridge.setToken(vscode.workspace.getConfiguration('autoxAi').get<string>('mcpToken', ''));
    this.mcpBridge = bridge;
    // 等 listen 真正出结果再提示（以前是"先弹成功、再异步 listen"，端口被占时提示与事实相反）
    bridge.start((ok: boolean, realPort: number, code?: string) => {
      if (ok) {
        vscode.window.showInformationMessage(`Autox.js MCP server started at http://127.0.0.1:${realPort}/sse (device auto-connecting)`);
        return;
      }
      this.mcpBridge = undefined;
      const hint = code === 'EADDRINUSE'
        ? `端口 ${realPort} 已被占用（可能另一个同类插件在用）。可在设置 autoxAi.mcpPort 换端口后重试。`
        : `启动失败（${code || 'unknown'}）`;
      vscode.window.showErrorMessage('Autox.js MCP：' + hint);
    });
  }

  /** 停止 Autox.js MCP 桥 */
  stopMcpServer() {
    if (this.mcpBridge) {
      this.mcpBridge.stop();
      this.mcpBridge = undefined;
      vscode.window.showInformationMessage('Autox.js MCP server stopped');
    }
  }

  /** 读取端口配置并做范围校验（非法值回落到默认） */
  static readPort(key: 'serverPort' | 'mcpPort', def: number): number {
    const v = vscode.workspace.getConfiguration('autoxAi').get<number>(key, def);
    const n = typeof v === 'number' ? Math.floor(v) : def;
    return (n >= 1024 && n <= 65535) ? n : def;
  }

  startTrackADBDevices() {
    server.trackADBDevices()
  }

  stopTrackADBDevices() {
    server.stopTrackADBDevices()
  }

  startAllServer() {
    server.listen()
    server.trackADBDevices()
  }

  stopAllServer() {
    server.disconnect()
    server.stopTrackADBDevices()
  }

  async manuallyConnectADB() {
    let devices = await server.listADBDevices()
    let names = await Promise.all(devices.map(async (device) => {
      let adbDevice = server.adbClient.getDevice(device.id)
      let brand = await server.adbShell(adbDevice, "getprop ro.product.brand")
      let model = await server.adbShell(adbDevice, "getprop ro.product.model")
      return `${brand} ${model}: ${device.id}`
    }));
    vscode.window.showQuickPick(names)
      .then(name => {
        let device = devices[names.indexOf(name)]
        server.connectDevice(device.id)
      });
  }

  manuallyDisconnect() {
    let devices = server.devices
    let names = devices.map((device) => { return device.name + ": " + device.id })
    vscode.window.showQuickPick(names)
      .then(name => {
        let device = devices[names.indexOf(name)]
        server.getDeviceById(device.id).close()
      });
  }

  run(url?) {
    this.runOrRerun('run', url);
  }

  stop() {
    server.sendCommand('stop', {
      'id': vscode.window.activeTextEditor.document.fileName,
    });

  }

  stopAll() {
    server.sendCommand('stopAll');

  }
  rerun(url?) {
    this.runOrRerun('rerun', url);

  }
  runOrRerun(cmd, url?) {
    console.log("url-->", url);
    let text = "";
    let filename = null;
    if (url != null) {
      let uri = vscode.Uri.parse(url);
      filename = uri.fsPath;
      console.log("fileName-->", filename);
      try {
        text = fs.readFileSync(filename, 'utf8');
      } catch (error) {
        console.error(error);
      }
    } else {
      let editor = vscode.window.activeTextEditor;
      console.log("dfn", editor.document.fileName);
      filename = editor.document.fileName;
      text = editor.document.getText();
    }
    server.sendCommand(cmd, {
      'id': filename,
      'name': filename,
      'script': text
    });
  }

  runOnDevice() {
    this.selectDevice(device => this.runOn(device));
  }
  selectDevice(callback) {
    let devices: Array<Device> = server.devices;
    if (recentDevice) {
      let i = devices.indexOf(recentDevice);
      if (i > 0) {
        devices = devices.slice(0);
        devices[i] = devices[0];
        devices[0] = recentDevice;
      }
    }
    let names = devices.map(device => device.toString());
    vscode.window.showQuickPick(names)
      .then(select => {
        let device = devices[names.indexOf(select)];
        recentDevice = device;
        callback(device);
      });
  }
  runOn(target: AutoJsDebugServer | Device) {
    let editor = vscode.window.activeTextEditor;
    target.sendCommand('run', {
      'id': editor.document.fileName,
      'name': editor.document.fileName,
      'script': editor.document.getText()
    })

  }

  save(url?) {
    this.saveTo(server, url);
  }
  saveToDevice() {
    this.selectDevice(device => this.saveTo(device));
  }

  saveTo(target: AutoJsDebugServer | Device, url?) {

    let text = "";
    let filename: string;
    if (null != url) {
      let uri = vscode.Uri.parse(url);
      filename = uri.fsPath;
      console.log("fileName-->", filename);
      try {
        text = fs.readFileSync(filename, 'utf8');
      } catch (error) {
        console.error(error);
      }
    } else {
      let editor = vscode.window.activeTextEditor;
      filename = editor.document.fileName;
      text = editor.document.getText();
    }
    console.log("url-->", filename);
    try {
      target.sendCommand('save', {
        'id': filename,
        'name': filename,
        'script': text
      })
    } catch (error) {
      console.error(error);
    }


  }

  newProject() {
    vscode.window.showOpenDialog({
      'canSelectFiles': false,
      'canSelectFolders': true,
      'openLabel': '新建到这里'
    }).then(uris => {
      if (!uris || uris.length == 0) {
        return;
      }
      return new ProjectTemplate(uris[0])
        .build();
    }).then(uri => {
      vscode.commands.executeCommand("vscode.openFolder", uri);
    });
  }
  runProject() {
    this.sendProjectCommand("run_project");
  }
  sendProjectCommand(command: string, url?) {
    console.log("url-->", url);
    let folder = null;
    if (url == null) {
      let folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length == 0) {
        vscode.window.showInformationMessage("请打开一个项目的文件夹");
        return null;
      }
      folder = folders[0].uri;
    } else {
      folder = vscode.Uri.parse(url);
    }
    console.log("folder-->", folder);
    if (!server.project || server.project.folder != folder) {
      server.project && server.project.dispose();
      server.project = new Project(folder);
    }
    if (!server.project || server.project.folder != folder) {
      server.project && server.project.dispose();
      server.project = new Project(folder);
    }
    server.sendProjectCommand(folder.fsPath, command);
  }
  saveProject(url?) {
    this.sendProjectCommand("save_project", url);
  }
}


export let _context: vscode.ExtensionContext;
let extension = new Extension();
/** 剪贴板同步（activate 时创建；构造函数要碰 vscode.window，不能在模块级 new） */
let clipSync: ClipSyncManager | undefined = undefined;
const commands = ['startAllServer', 'stopAllServer', 'startServer', 'stopServer', 'startTrackADBDevices',
  'stopTrackADBDevices', 'manuallyConnectADB', 'manuallyDisconnect', 'showServerAddress', 'showQrCode', 'openDocument', 'run', 'runOnDevice',
  'stop', 'stopAll', 'rerun', 'save', 'saveToDevice', 'newProject', 'runProject', 'saveProject',
  'startMcpServer', 'stopMcpServer',
  'clipSyncToggle', 'clipSyncInstallSender', 'clipSyncStatus'];

export function activate(context: vscode.ExtensionContext) {
  console.log('Autox.js-VSCodeExt-Ai is now active.');
  // 端口必须在任何 listen() 之前设置（activate 里随后就会自动拉起服务）
  const configuredPort = Extension.readPort('serverPort', 9317);
  if (configuredPort !== server.getPort()) {
    server.setPort(configuredPort);
  }
  commands.forEach((command) => {
    let action: Function = extension[command];
    context.subscriptions.push(vscode.commands.registerCommand('autoxAi.' + command, action.bind(extension)));
    _context = context;
    // @ts-ignore
    console.log(context.extension.packageJSON.version)
  })
  // 自动拉起 MCP 桥，让 AI 主机随时可连（方案 §15.3）
  // 这期间的端口冲突只走状态栏提示（listen 是异步的，5 秒窗口足够覆盖）
  silentPortErrors = true;
  extension.startMcpServer();
  setTimeout(() => { silentPortErrors = false; }, 5000);

  // 剪贴板同步：默认关闭，只挂状态栏与日志监听，不读剪贴板
  clipSync = new ClipSyncManager(server);
  context.subscriptions.push(clipSync);
  clipSync.start();
}

export function deactivate() {
  extension.stopMcpServer();
  server.stopTrackADBDevices();
  server.disconnect();
}
