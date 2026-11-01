# Autox.js-VSCodeExt-Ai

> Auto.js / Autox.js 的 VS Code 开发插件（AI 增强分支）。

## 来源与许可

本插件是 **Auto.js / Autox.js 生态**开源项目的**衍生作品**：上游代码的版权归各自原作者所有，
本项目沿用 **GPL-2.0**（见扩展包内的 LICENSE.md），只做增量与维护，不主张上游代码的版权，
也不对上游项目的适用性与合规性作任何担保。

## 插件背景

本插件由 **Auto.js-Autox.js-VSCodeExt**（Auto.js / Autox.js 生态中的开源 VS Code 端插件）
二次开发而来，其上游为 **Auto.js-VSCodeExt-Fixed 0.3.8** 与 **Auto.js** 生态。
上游的主要能力是：右键【文件夹】保存项目到设备、右键【js文件】运行、编辑器右上角一键运行、
结合 webpack 编译打包一气呵成。本分支在此基础上增加了 AI 相关能力（详见 `更改日志`）。

**关于与其它同类插件共存：**

自 2.2.0 起本插件使用**独立的扩展 id** 与**独立的命令前缀**（`autoxAi.*`），
因此可以和原版 `Auto.js-Autox.js-VSCodeExt` **同时安装、同时启用**，
不会互相覆盖，也不会因命令重名而半激活。

但**手机同一时刻只能连一个电脑端**：手机端只有一个调试连接，谁先占住 9317 就是谁在接管。
端口被占用时本插件会**明确弹窗提示**（旧版本是静默失败），需要并存时把本插件改到别的端口即可：

```jsonc
// settings.json
{ "autoxAi.serverPort": 9318, "autoxAi.mcpPort": 18790 }
```

**改端口不需要修改手机端 APK**：

- **扫码连接**（推荐）：二维码内容就是 `ws://<ip>:<端口>`，手机扫到后原样使用 —— 实测手机端只在
  "地址里没写端口"时才补 9317，端口随二维码走。
- **手动输入 IP**：必须连端口一起填，写 `192.168.1.5:9318`；只写 `192.168.1.5` 会被补成 `:9317` 而连不上。
- **ADB / USB 模式与本项无关**：那条链路是手机自己监听 9317、PC 用 `adb forward` 连过去，跟本插件监听哪个端口是两回事。

## 安装

本分支不发布到 Marketplace，用 vsix 本地安装：

```bash
code --install-extension autox-js-vsce-ai-2.2.2.vsix
```

桌面编辑器 Visual Studio Code 的插件。可以让 Visual Studio Code 支持
Autox.js 开发。

## Features

* 在VS Code的开发者工具实时显示Auto.js的日志与输出
* 在VS Code命令中增加Run, Stop, Rerun, Stop all等选项。可以在手机与电脑连接后把vscode编辑器中的脚本推送到AutoJs中执行，或者停止AutoJs中运行的脚本。
* 在Autox.js扫码连接电脑
* 通过数据线(ADB)连接电脑
* **内置 MCP Server**（`127.0.0.1:18789`）：AI 客户端可直接读取无障碍树、点击控件、下发并运行代码
* **剪贴板同步**（默认关闭）：PC 复制的内容自动写入手机，手机内容可一键回传
* **端口可配置**：`autoxAi.serverPort` / `autoxAi.mcpPort`，与其它同类插件并存时不再静默冲突

## Usage

### Step 1
按 `Ctrl+Shift+P` 或点击"查看"->"命令面板"可调出命令面板，输入 `Autox.js` 可以看到几个命令（命令面板里显示为 `Autox.js: 开启服务并监听ADB设备(Start all server)`），按回车键执行该命令。

如果你想使用数据线连接电脑，但是你调用命令后，VS Code右下角没有显示 _"ADB: Tracking started"_ ，你需要先启动或安装ADB服务，启动命令：```adb start-server```。下载页面：[ADB(中国站)](https://developer.android.google.cn/studio/releases/platform-tools) 或 [ADB(国际站)](https://developer.android.com/studio/releases/platform-tools)，然后在adb所在的目录运行```./adb start-server```。

此时VS Code会在右下角显示 _"Autox.js-VSCodeExt-Ai server running on ..."_ ，即开启服务成功。
如果弹出「端口 9317 已被占用」，说明另一个同类插件正在运行，改 `autoxAi.serverPort` 再启动即可。

### Step 2
#### 1. 无线连接：
将手机连*接到电脑启用的Wifi或者同一*局域网中。在Autox.js的侧拉菜单中启用调试服务，并输入VS Code右下角显示的IP地址，等待连接成功。你也可以点击VS Code右下角"server running on ..."通知的下方按钮 _"Show QR code"_ 或按 `Ctrl+Shift+P` 搜索执行`Show qr code`命令，然后用Autox.js扫码连接。

#### 2. 通过数据线连接(ADB)：
如要在通过 USB 连接的设备上使用 adb，您必须在设备的系统设置中启用 USB 调试（位于开发者选项下）。

在搭载 Android 4.2 及更高版本的设备上，“开发者选项”屏幕默认情况下处于隐藏状态。如需将其显示出来，请依次转到设置 > 关于手机，然后点按版本号七次。返回上一屏幕，在底部可以找到开发者选项。

在某些设备上，“开发者选项”屏幕所在的位置或名称可能有所不同。

在确保手机已经在开发者选项中打开USB调试后，在Autox.js的侧拉菜单中启用ADB调试，再使用数据线连接电脑，插件会自动识别设备。

### Step 3
之后就可以在电脑上编辑JavaScript文件并通过命令`Run`或者按键`F5`在手机上运行了。

## Commands

按 `Ctrl+Shift+P` 或点击"查看"->"命令面板"可调出命令面板，输入 `Autox.js` 可以看到几个命令
（命令分类显示为 **`Autox.js`**，命令 id 前缀是 `autoxAi.*`，与原版的 `extension.*` 不冲突）：
* 开启服务并监听ADB设备(Start all server: 相当于同时调用(Start Server)和(Start track adb devices)
* 停止服务并停止监听ADB设备(Stop all server)
* 开启服务(Start Server)： 启动插件服务。之后在确保手机和电脑在同一区域网的情况下，在Auto.js的侧拉菜单中使用连接电脑功能连接
* 停止服务(Stop Server)： 停止插件服务
* 开始监听ADB设备(Start track adb devices): 开启后会自动连接ADB设备
* 停止监听ADB设备(Stop track adb devices)
* 手动连接ADB设备(Manually connect adb device)
* 手动关闭设备连接(Manually disconnect device)
* 打开文档(Open Document)： 打开Auto.js开发文档
* 显示服务端二维码(Show qr code): 显示服务端二维码，之后可用客户端扫码连接
* 显示服务端ip地址(Show server address)
* 运行脚本(Run)： 运行当前编辑器的脚本。如果有多个设备连接，则在所有设备运行
* 重新运行(Rerun)： 停止当前文件对应的脚本并重新运行。如果有多个设备连接，则在所有设备重新运行
* 停止当前脚本(Stop)： 停止当前文件对应的脚本。如果有多个设备连接，则在所有设备停止
* 停止所有脚本(Stop All)： 停止所有正在运行的脚本。如果有多个设备连接，则在所有设备运行所有脚本
* 保存到所有设备(Save)： 保存当前文件到手机的脚本默认目录（文件名会加上前缀remote)。如果有多个设备连接，则在所有设备保存
* 在指定设备运行脚本(Run On Device)： 弹出设备菜单并在指定设备运行脚本
* 保存到指定设备(Save On Device)： 弹出设备菜单并在指定设备保存脚本
* 新建项目(New Project)： 选择一个空文件夹（或者在文件管理器中新建一个空文件夹），将会自动创建一个项目
* 运行项目(Run Project)： 运行一个项目，需要Auto.js 4.0.4Alpha5以上支持
* 保存项目到设备(Save Project)： 保存一个项目，需要Auto.js 4.0.4Alpha5以上支持

以上命令一些有对应的快捷键，参照命令后面的说明即可。


# 以下是原插件开发日志，二次开发变更日志请在`更改日志`查看
## Log


要显示来自Auto.js的日志，打开 VS Code上面菜单的"帮助"->"切换开发人员工具"->"Console"即可。

## 剪贴板同步（2.1.0 新增）

PC 与手机剪贴板双向同步，**默认关闭**。

### 用法
1. 命令面板执行 `AutoX: 剪贴板同步：开/关` 开启。
2. **PC → 手机**：在 VS Code 里复制内容，手机会自动写入剪贴板（约 0.4 秒）。
3. **手机 → PC**：先执行一次 `AutoX: 剪贴板同步：安装手机端「发送剪贴板」脚本`，
   之后在 AutoX 里打开 `autoclip_send.js` 点运行即可。

> 安装是**可校验**的：脚本由手机自己写入并回读比对，成功后提示里会带字符数；
> 失败会弹出手机端回报的真实原因（例如 `ENOTDIR`、`EACCES`），不再出现"提示已保存、文件却是 0 字节"。
> 若 AutoX 的脚本目录改过，请同步修改 `clipSync.phoneScriptDir`。

### 为什么手机→PC 要手点
Android 10 起系统禁止后台应用读剪贴板，只有**默认输入法**或**有焦点的应用**能读。
实测（Pixel 5a / Android 14）：即使 `appops set <pkg> READ_CLIPBOARD allow`，后台 `getClip()` 仍返回空串；
AutoX 在**前台**运行时才能读到。所以手机上必须有一次“把 AutoX 带到前台”的动作。

> 写入方向没有任何限制，`setClip()` 后台随时可用。

### 配置项（`clipSync.*`）
| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `direction` | `both` | `both` / `pc2phone` / `phone2pc` |
| `pollIntervalMs` | `300` | VS Code 聚焦时的轮询间隔（没有剪贴板变化事件，只能轮询） |
| `unfocusedPollMs` | `2000` | 失焦时的轮询间隔 |
| `maxTextLength` | `32768` | 超过则跳过，不截断 |
| `minDownlinkIntervalMs` | `400` | 下行节流（每次下发会在手机上起一个短脚本任务） |
| `logContent` | `false` | 是否在输出通道打印正文 |
| `skipPatterns` | 私钥块 | 命中正则的内容不同步 |
| `phoneScriptDir` | `/sdcard/脚本` | 手机端脚本目录，安装 `autoclip_send.js` 时落在这里 |

### 连接与端口（`autoxAi.*`）
| 键 | 默认 | 说明 |
|---|---|---|
| `autoxAi.serverPort` | `9317` | 手机调试服务端口，一般不用改。改后**扫码**可直接连（端口随二维码下发），**手输**需写 `IP:端口`；ADB 模式不受影响 |
| `autoxAi.mcpPort` | `18789` | 内置 MCP Server 端口（仅 127.0.0.1） |
| `autoxAi.mcpToken` | 空 | 可选的 MCP 访问令牌。留空即不启用（默认已做 Host/Origin 校验，网页无法调用）；填了之后客户端需带 `Authorization: Bearer <token>` |

### MCP 服务的访问控制

MCP 服务只监听 `127.0.0.1`，但这本身**不足以**挡住浏览器：任意网页都能向 `127.0.0.1:18789` 发
`fetch(..., {mode:'no-cors'})` 并用 `text/plain` 绕过预检，进而调用 `device_run_code`。

因此服务端在路由前统一校验（2.2.3 起）：

- **Host 必须是回环地址** —— 挡 DNS rebinding（攻击者域名解析到 127.0.0.1 时 Host 是他自己的域名）；
- **拒绝任何带 `Origin` 头的请求** —— 本地 MCP 客户端不会发 Origin，发的一定是浏览器；
- 不再返回 `Access-Control-Allow-Origin: *`；
- 需要更严时可设 `autoxAi.mcpToken`，客户端带 `Authorization: Bearer <token>` 或 `?token=<token>`。

这两条**默认开启、零配置**，现有 `{"url":"http://127.0.0.1:18789/mcp"}` 不用改。

### 隐私提示
- 剪贴板常含密码/验证码，**默认关闭**，开启前请确认场景。
- 内容经局域网 `ws://` 明文传输（与脚本下发同一条连接），不要在不可信网络中使用。
- 日志里默认只记录长度与指纹，不记录正文。

## Release Notes

### 0.0.1

首次发布。包含以下特性：
* 启动，停止服务
* 显示Auto.js的日志
* 运行，停止，重新运行脚本
* 多设备连接支持，允许在运行时选择要运行的设备

### 0.0.2
增加以下特性：
* 脚本保存到设备

### 0.2.0 
增加以下特性：
* New Project（新建项目）：选择一个空文件夹（或者在文件管理器中新建一个空文件夹），将会自动创建一个项目
* Run Project（运行项目）：运行一个项目，需要Auto.js 4.0.4Alpha5以上支持
* Save Project（保存项目）：保存一个项目，需要Auto.js 4.0.4Alpha5以上支持

-----------------------------------------------------------------------------------------------------------

### For more information

源码与许可说明见扩展包内 `LICENSE.md`。

**Enjoy!**