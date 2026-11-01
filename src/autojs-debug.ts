import { EventEmitter } from 'events';
import * as ws from 'websocket';
import * as http from 'http';
import * as querystring from 'querystring';
import * as url from 'url';
import * as fs from 'fs'
import { Project, ProjectObserser } from './project';
import * as vscode from "vscode";
import Adb, { DeviceClient, Forward } from '@devicefarmer/adbkit';
import Tracker from '@devicefarmer/adbkit/dist/src/adb/tracker';
import ADBDevice from '@devicefarmer/adbkit/dist/src/Device';
import internal from "stream";
import buffer from "buffer";
import { _context } from "./extension";
const DEBUG = false;

function logDebug(message?: any, ...optionalParams: any[]) {
  if (DEBUG) {
    console.log.apply(console, arguments);
  }
}


const HANDSHAKE_TIMEOUT = 10 * 1000;

/**
 * 把下行报文压成一行摘要，避免把脚本正文（可能是整段剪贴板内容）打进日志。
 * 只在 AUTOX_DEBUG_SEND=1 时使用。
 */
function safeSummary(data: any): string {
  try {
    const clone: any = {};
    Object.keys(data || {}).forEach(k => {
      const v = data[k];
      if (typeof v === 'string' && v.length > 60) {
        clone[k] = v.substring(0, 60) + `...<${v.length} chars>`;
      } else {
        clone[k] = v;
      }
    });
    return 'send -> ' + JSON.stringify(clone);
  } catch (e) {
    return 'send -> <unserializable>';
  }
}

export class Device extends EventEmitter {
  public name: string;
  public type: string;
  public id: string;
  private connection: ws.connection;
  public attached: boolean = false;
  public projectObserser: ProjectObserser;

  constructor(connection: ws.connection, type: string, id: string) {
    super();
    this.type = type
    this.id = id
    this.connection = connection;
    this.read(this.connection);
    this.on('data:hello', data => {
      logDebug("on client hello: ", data);
      this.attached = true;
      this.name = data['device_name'];
      let message_id = `${Date.now()}_${Math.random()}`;
      // 关键兼容性修复：手机端 DevPlugin.serveHello 用【本端回复】的 versionCode
      // (即 HelloResponse.version 去掉点后的数字，缺省 -1) 决定期望的 ok 字符串：
      //   versionCode < 11090  → 期望 "连接成功"
      //   versionCode >= 11090 → 期望 "ok"
      // 原逻辑按手机 appVersionCode>=629 回 "ok"，但本机 AutoX 7.2.3(code 723) 会因此握手失败断连。
      // 统一带低版本(7.2.3→723<11090)并回 "连接成功"，可引导所有手机都期望 "连接成功"，握手必成功，
      // 同时兼容旧版无条件期望 "连接成功" 的手机。
      let returnData = JSON.stringify({ message_id, data: "连接成功", version: "7.2.3", debug: DEBUG, type: 'hello' })
      logDebug("return data: ", returnData)
      this.connection.sendUTF(returnData);
      this.emit("attach", this);
    });
    this.on('data:ping', data => {
      logDebug("on client ping: ", data);
      let message_id = `${Date.now()}_${Math.random()}`;
      var returnData = JSON.stringify({ type: 'pong', data: data })
      logDebug("pong: ", returnData)
      this.connection.sendUTF(returnData);
    })
    setTimeout(() => {
      if (!this.attached) {
        console.log("handshake timeout");
        this.connection.close();
        this.connection = null;
      }
    }, HANDSHAKE_TIMEOUT);
  }

  close() {
    let message_id = `${Date.now()}_${Math.random()}`;
    let closeMessage = JSON.stringify({ message_id, data: "close", debug: false, type: 'close' })
    this.connection.sendUTF(closeMessage);
    this.connection.close();
    this.connection = null;
  }

  send(type: string, data: any): void {
    // 防御：设备刚断开时 connection 已是 null，直接 sendUTF 会抛
    // "Cannot read property 'sendUTF' of null" 并打断调用方（如广播下发）。
    if (!this.connection) {
      console.warn(`[device ${this.id}] 连接已断开，丢弃 ${type} 报文`);
      return;
    }
    let message_id = `${Date.now()}_${Math.random()}`;
    // 隐私：data 里可能带整段脚本正文（剪贴板同步会把内容塞进 script），
    // 默认不打印全文，只给长度；需要排查时设 AUTOX_DEBUG_SEND=1。
    if (process.env.AUTOX_DEBUG_SEND) {
      console.log(safeSummary(data));
    }
    this.connection.sendUTF(JSON.stringify({
      type: type,
      message_id,
      data: data
    }));
  }

  sendBytes(bytes: Buffer): void {
    this.connection.sendBytes(bytes);
  }

  sendBytesCommand(command: string, md5: string, data: object = {}): void {
    data = Object(data);
    data['command'] = command;
    let message_id = `${Date.now()}_${Math.random()}`;
    this.connection.sendUTF(JSON.stringify({
      type: 'bytes_command',
      message_id,
      md5: md5,
      data: data
    }));
  }

  sendCommand(command: string, data: object): void {
    data = Object(data);
    data['command'] = command;
    this.send('command', data);
  }

  public toString = (): string => {
    if (!this.name) {
      return `Device (${this.type}: ${this.id})`;
    }
    return `Device ${this.name}(${this.type}: ${this.id})`;
  }

  private read(connection: ws.connection) {
    connection.on('message', message => {
      logDebug("message: ", message);
      if (message.type == 'utf8') {
        try {
          let json = JSON.parse(message.utf8Data);
          logDebug("json: ", json);
          this.emit('message', json);
          this.emit('data:' + json['type'], json['data']);
        } catch (e) {
          console.error(e);
        }
      }
    });
    connection.on('close', (reasonCode, description) => {
      console.log(`close: device = ${this}, reason = ${reasonCode}, desc = ${description}`);
      this.connection = null;
      this.emit('disconnect');
    });
  }

}

export class AutoJsDebugServer extends EventEmitter {
  public isHttpServerStarted = false
  private httpServer: http.Server;
  public adbClient = Adb.createClient()
  private tracker: Tracker
  private port: number;
  public devices: Array<Device> = [];
  public project: Project = null;
  private logChannels: Map<string, vscode.OutputChannel>;
  private fileFilter = (relativePath: string, absPath: string, stats: fs.Stats) => {
    if (!this.project) {
      return true;
    }
    return this.project.fileFilter(relativePath, absPath, stats);
  };

  constructor(port: number) {
    super();
    this.logChannels = new Map<string, vscode.OutputChannel>();
    this.port = port;
    this.httpServer = http.createServer((request, response) => {
      console.log(new Date() + ' Received request for ' + request.url);
      var urlObj = url.parse(request.url);
      var query = urlObj.query;
      var queryObj = querystring.parse(query);
      if (urlObj.pathname == "/exec") {
        response.writeHead(200);
        response.end("this commond is:" + queryObj.cmd + "-->" + queryObj.path);
        this.emit('cmd', queryObj.cmd, queryObj.path);
        console.log(queryObj.cmd, queryObj.path);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    // 监听错误只挂一次：以前写在 listen() 里，反复 start/stop 会不断累积监听器。
    // EADDRINUSE 会单独 emit 'listen_error'，让扩展能明确告诉用户"端口被占用"，
    // 而不是像改版前那样只 console.error、界面上还显示"已启动"。
    this.httpServer.on('error', (e: any) => {
      this.isHttpServerStarted = false;
      const code = e && e.code ? String(e.code) : '';
      console.error('server error: ', e);
      this.emit('listen_error', {
        port: this.port,
        code: code,
        message: e && e.message ? String(e.message) : String(e)
      });
    });
    let wsServer = new ws.server({ httpServer: this.httpServer, keepalive: true, keepaliveInterval: 10000 });
    wsServer.on('request', request => {
      let connection = request.accept();
      if (!connection) {
        return;
      }
      this.newDevice(connection, "tcp", connection.socket.remoteAddress + ":" + connection.socket.remotePort)
    })
  }

  getDeviceById(id: string): Device {
    return this.devices.find((value) => {
      return value.id == id
    })
  }

  private newDevice(connection: ws.connection, type: string, id: string) {
    let device = new Device(connection, type, id);
    logDebug(connection.state, "--->status")
    device
      .on("attach", (device) => {
        this.attachDevice(device);
        this.emit('new_device', device);
        let logChannel = this.newLogChannel(device);
        logChannel.appendLine(`Device connected: ${device}`);
      })
  }

  async adbShell(device: DeviceClient, command: string): Promise<string> {
    let duplex: internal.Duplex = await device.shell(command)
    // @ts-ignore
    let brandBuf: buffer.Buffer = await Adb.util.readAll(duplex)
    return brandBuf.toString()
  }

  private connectAutoxjsByADB(port: Number, deviceId: string) {
    let autoJsDebugServer = this
    let url = `ws://localhost:${port}/`

    var client = new ws.client();

    client.on('connectFailed', function (error) {
      let err = 'Connect Error: ' + error.toString()
      console.log(err);
      vscode.window.showInformationMessage(err)
    });

    client.on('connect', function (connection) {
      console.log("connected to " + url)
      autoJsDebugServer.newDevice(connection, "adb", deviceId)
    });
    client.connect(url);
  }

  listen(): void {
    if (this.isHttpServerStarted) {
      this.emit("connected");
      return
    }
    this.httpServer.listen(this.port, '0.0.0.0', () => {
      this.isHttpServerStarted = true
      const address: any = this.httpServer.address();
      var localAddress = this.getIPAddress();
      console.log(`server listening on ${localAddress}:${address.port} / ${address.address}:${address.port}`);
      this.emit("connect");
    });
  }


  async listADBDevices(): Promise<ADBDevice[]> {
    return this.adbClient.listDevices();
  }

  async trackADBDevices() {
    let thisServer = this
    let devices = await thisServer.adbClient.listDevices()
    for (let device0 of devices) {
      // 防御：listDevices 会返回 unauthorized/offline 设备，对其 forward 会抛
      // FailError（Failure: ''）并中断整个 trackADBDevices，导致 MCP 服务起不来。
      // 逐设备隔离，失败仅跳过该设备。
      try {
        await thisServer.connectDevice(device0.id)
      } catch (e: any) {
        console.error(`skip device ${device0.id}: ${e && e.message ? e.message : e}`)
      }
    }
    if (this.tracker) {
      this.emit("adb:tracking_started");
      return
    }
    try {
      let tracker = await thisServer.adbClient.trackDevices()
      thisServer.tracker = tracker
      tracker.on('add', async function (device0) {
        console.log("adb device " + device0.id + " added")
        const device = thisServer.adbClient.getDevice(device0.id)
        await device.waitForDevice()
        await thisServer.connectDevice(device0.id, device)
      })
      tracker.on('remove', function (device) {
        console.log("adb device " + device.id + " removed")
        let wsDevice = thisServer.getDeviceById(device.id)
        if (wsDevice) {
          wsDevice.close()
        }

      })
      tracker.on('end', function () {
        thisServer.tracker = undefined
        console.log('ADB Tracking stopped')
        thisServer.emit("adb:tracking_stop")
      })
    } catch (err) {
      this.tracker = undefined
      thisServer.emit("adb:tracking_error")
      console.error('ADB error: ', err.stack)
    }

    this.emit("adb:tracking_start");
  }

  async connectDevice(id: string, device: DeviceClient = undefined) {
    if (!device) device = this.adbClient.getDevice(id)
    let wsDevice = this.getDeviceById(id)
    if (wsDevice && wsDevice.attached) return
    let forwards: Forward[] = []
    try {
      forwards = await this.listForwards(device, id)
      if (forwards.length == 0) {
        let forwarded = await device.forward(`tcp:0`, `tcp:9317`)
        if (forwarded) {
          forwards = await this.listForwards(device, id)
        }
      }
    } catch (e: any) {
      // 设备不可用（unauthorized/offline）时 forward 失败：跳过，不抛出。
      console.error(`forward failed for ${id}: ${e && e.message ? e.message : e}`)
      return
    }
    if (forwards.length > 0) {
      let forward = forwards[0]
      console.log(`forward ${id}: local -> ${forward.local}, remote -> ${forward.remote}`)
      let port = Number(forward.local.replace("tcp:", ""))
      this.connectAutoxjsByADB(port, id)
    }
  }

  private async listForwards(device: DeviceClient, id: string): Promise<Forward[]> {
    let forwards: Forward[] = await device.listForwards()
    return forwards.filter((forward) => {
      return forward.serial == id && forward.remote == "tcp:9317"
    })
  }

  stopTrackADBDevices() {
    if (this.tracker) {
      this.tracker.end()
      this.tracker = undefined
    }
  }

  send(type: string, data: any): void {
    this.devices.forEach(device => {
      device.send(type, data);
    });
  }

  sendBytes(data: Buffer): void {
    this.devices.forEach(device => {
      device.sendBytes(data);
    });
  }

  sendBytesCommand(command: string, md5: string, data: object = {}): void {
    this.devices.forEach(device => {
      device.sendBytesCommand(command, md5, data);
    });
  }

  sendProjectCommand(folder: string, command: string) {
    let startTime = new Date().getTime();
    this.devices.forEach(device => {
      if (device.projectObserser == null || device.projectObserser.folder != folder) {
        device.projectObserser = new ProjectObserser(folder, this.fileFilter);
      }
      device.projectObserser.diff()
        .then(result => {
          device.sendBytes(result.buffer);
          device.sendBytesCommand(command, result.md5, {
            'id': folder,
            'name': folder
          });
          this.getLogChannel(device).appendLine(`发送项目耗时: ${(new Date().getTime() - startTime) / 1000} 秒`);
        });
    });
  }

  sendCommand(command: string, data: object = {}): void {
    this.devices.forEach(device => {
      device.sendCommand(command, data);
    });
  }

  disconnect(): void {
    this.httpServer.close();
    this.isHttpServerStarted = false
    this.emit("disconnect");
    this.logChannels.forEach(channel => {
      channel.dispose();
    });
    this.logChannels.clear();
    this.devices.forEach((device) => {
      device.close()
    })
  }

  /** 获取本地IP */
  getIPAddress(): string {
    var interfaces = require('os').networkInterfaces();
    for (var devName in interfaces) {
      var iface = interfaces[devName];
      for (var i = 0; i < iface.length; i++) {
        var alias = iface[i];
        console.log("---", alias)
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
          return alias.address;
        }
      }
    }
  }
  /** 获取本地IP */
  getIPs(): string[] {
    var ips = [];
    var interfaces = require('os').networkInterfaces();
    for (var devName in interfaces) {
      var iface = interfaces[devName];
      for (var i = 0; i < iface.length; i++) {
        var alias = iface[i];
        console.log("---", alias)
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
          ips.push(alias.address);
        }
      }
    }
    return ips;
  }

  /** 获取服务运行端口 */
  getPort(): number {
    return this.port;
  }

  /** 设置监听端口；服务已启动时忽略（改端口需要先停服务）。 */
  setPort(port: number): boolean {
    if (!port || port < 1 || port > 65535) {
      return false;
    }
    if (this.isHttpServerStarted) {
      console.warn(`[Autox.js] 服务已在监听 ${this.port}，忽略端口修改为 ${port}；请先停止服务。`);
      return false;
    }
    this.port = port;
    return true;
  }

  private attachDevice(device: Device): void {
    this.devices.push(device);
    device.on('data:log', data => {
      const line = data['log'];
      // 剪贴板同步的载荷里是明文内容，别原样打进扩展宿主日志（输出通道仍保留，用户自己看）
      if (typeof line === 'string' && line.indexOf('AUTOCLIP1::') < 0) {
        console.log(line);
      }
      this.getLogChannel(device).appendLine(line);
      this.emit('log', line);
    });
    device.on('disconnect', this.detachDevice.bind(this, device));
  }

  private detachDevice(device: Device): void {
    const idx = this.devices.indexOf(device);
    if (idx >= 0) { this.devices.splice(idx, 1); }
    console.log("detachDevice: " + device);
    vscode.window.showInformationMessage(`Device disconnected: ${device}`)
    // 防御：trackADBDevices 直连路径可能未创建日志通道，getLogChannel 会返回 undefined，
    // 直接 .dispose() 会抛 "Cannot read properties of undefined (reading 'dispose')"。
    var logChannel = this.getLogChannel(device)
    if (logChannel) { logChannel.dispose(); }
    this.logChannels.delete(device.toString())
  }

  /** 创建设备日志打印通道 */
  /** 输出通道名（带扩展名前缀：同时装了原版插件时，两个同名设备通道没法区分） */
  private logChannelKey(device: Device): string {
    return 'Autox.js ' + device.toString();
  }

  private newLogChannel(device: Device): vscode.OutputChannel {
    let channelName = this.logChannelKey(device);
    // let logChannel = this.logChannels.get(channelName);
    // if (!logChannel) {
    let logChannel = vscode.window.createOutputChannel(channelName);
    this.logChannels.set(channelName, logChannel);
    // }
    logChannel.show(true);
    // console.log("创建日志通道" + channelName)
    return logChannel;
  }

  /** 获取设备日志打印通道 */
  private getLogChannel(device: Device): vscode.OutputChannel {
    let channelName = this.logChannelKey(device);
    // console.log("获取日志通道：" + channelName);
    return this.logChannels.get(channelName);
  }

}
