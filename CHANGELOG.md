# Change Log

All notable changes to the "autox-js-vsce-ai" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 来源与许可

本插件是 **Auto.js / Autox.js 生态**开源项目的**衍生作品**，上游代码的版权归各自原作者所有，
本项目沿用 **GPL-2.0**（见扩展包内的 LICENSE.md），只做增量与维护，不主张上游代码的版权。

## 版本号说明

上游原版是 `1.x`（写作本文时最新为 v1.110.0）。本分支在 1.109.0 基础上
加入了上游没有的 **内置 MCP Server** 与 `get_layout` v2 等改动，属于功能级分叉，
因此自 1.109.1 之后改为 **2.x** 重新编号，与上游版本线区分开，避免版本号撞车造成误判。

### 2.2.3 — MCP 本地服务加准入校验（不需要账号体系）

**修的是真漏洞**：MCP 服务只监听 `127.0.0.1:18789`，但浏览器里任意网页都可以
`fetch('http://127.0.0.1:18789/mcp', {mode:'no-cors', headers:{'Content-Type':'text/plain'}})`
—— 用 `text/plain` 绕开预检，服务端照单全收 JSON，于是网页可以调 `device_run_code`
在用户手机上执行任意 JS。原来的 `Access-Control-Allow-Origin: *` 还让网页能读到响应。

- 新增 `McpBridge.guard()`，在**路由之前**统一拦截：
  1. **Host 必须是回环地址**（`127.0.0.1` / `localhost` / `[::1]`）→ 挡 DNS rebinding；
  2. **带 `Origin` 头的一律 403** → 本地 MCP 客户端（CLI / 桌面 AI）不会发 Origin，发的一定是浏览器；
  3. 可选 **token**：`autoxAi.mcpToken` 非空时要求 `Authorization: Bearer <t>` 或 `?token=<t>`，定长比较防时序侧信道。
- 去掉 `/sse` 响应里的 `Access-Control-Allow-Origin: *`。
- **默认无需任何配置**：`mcpToken` 留空即可，现有 `mcp.json` 的 `{"url":"http://127.0.0.1:18789/mcp"}` 照旧可用。

实测（离线 harness 起真实 HTTP 服务）：普通请求 200；带 Origin 403；伪造 Host 403；
`/health` 同样受控；SSE 不再回 ACAO；配 token 后无凭据 401、错 token 401、正确 Bearer 200。

### 2.2.2 — 去除个人标识与仓库链接

按维护者要求收敛可检索信息，**保留衍生关系与 GPL-2.0 声明**：

- `package.json`
  - `author` 不再署个人名（改为项目维护者标识）
  - 移除 `repository` / `homepage` / `bugs`（不再内置源码仓库地址）
  - `publisher` 改为独立中性标识，扩展 id 随之变化
- `README.md` / 本文件
  - 删除「来源与致敬」表格（个人姓名 + 仓库链接），改为一段不带人名的「来源与许可」说明
  - 移除文中出现的人名与本项目仓库链接

### 2.2.1 — 端口文案纠错 + 二维码给出可复制地址

2.2.0 里写的"手机端固定连 9317"不准确，会让人误以为换端口必须改手机 APK。核对 AutoX 源码后确认：

- 手机端全仓 `9317` 只有一处常量（`DevPlugin.kt:57 SERVER_PORT`），作用是①ADB 模式下自己监听的端口、
  ②**当地址里没写端口时才补上**；扫码路径（`DrawerPage.kt:656-671`）只校验 scheme，拿到什么地址就连什么地址。
- 因此：**改 `autoxAi.serverPort` 后，扫码可以直接连，不需要改 APK**；手动输入必须写 `IP:端口`；
  **ADB/USB 模式与本设置无关**（手机监听 9317 + `adb forward`，两端都写死）。

改动：
- `package.json` / `README.md` / 本文件：把"手机端固定连 9317"改成上述准确表述
- 二维码面板下方新增一行可复制的 `ws://<ip>:<port>`，并提示"手动输入请连同端口一起填"
  （改端口后摄像头扫码不一定方便，手输又最容易漏端口）

### 2.2.0 — 身份独立，可与原版共存

**破坏性变更**：扩展 id 从原版 id 改为本插件**独立 id**。
装 2.2.0 **不会覆盖**原版，而是并存；旧版需要手动卸载或禁用，否则两者会抢 9317。

- 扩展身份
  - `name` → `autox-js-vsce-ai`，`publisher` → 本插件独立标识
  - `displayName` → **`Autox.js-VSCodeExt-Ai`**，`author` → 项目维护者（不署个人名）
  - 补 `license`(GPL-2.0) / `keywords`
- 命令
  - 命令 id 前缀 `extension.*` → **`autoxAi.*`**（26 条），与原版不再同名，
    避免两台扩展同时激活时 `registerCommand` 重复注册报错导致半激活
  - 命令分类 `Auto.js autoxjs` → **`Autox.js`**
  - 补上遗漏的 `onCommand:autoxAi.rerun`
  - 新 id 对照：`autoxAi.run` / `autoxAi.stop` / `autoxAi.stopAll` / `autoxAi.rerun` /
    `autoxAi.save` / `autoxAi.startServer` / `autoxAi.startAllServer` / `autoxAi.showQrCode` /
    `autoxAi.manuallyConnectADB` / `autoxAi.openDocument` / `autoxAi.startMcpServer` /
    `autoxAi.clipSyncToggle` …（其余同理：原 `extension.X` → `autoxAi.X`）
- 端口与共存
  - 新增 `autoxAi.serverPort`（默认 9317）、`autoxAi.mcpPort`（默认 18789）
  - `EADDRINUSE` 不再静默：弹窗明确说明"端口被占用"，`showServerAddress` 在未监听时不再显示假地址
  - MCP 启动提示改为**监听成功后**才弹（原来是"先弹成功再 listen"）
- 文档
  - README 增加「来源与许可」，说明本插件是 Auto.js / Autox.js 生态的衍生作品并遵循 GPL-2.0
  - 删掉"不能与 0.3.8 同时启用"的旧结论，改为"可共存，但手机同一时刻只连一个电脑端"
  - 输出通道名加 `Autox.js ` 前缀，避免与原版同名通道混淆

### 2.1.1
修复「安装手机端『发送剪贴板』脚本」装出 **0 字节空文件**、却提示"已保存"的问题。

- **根因**：安装走的是 `save` 命令 → 手机端 `DevPluginResponseHandler.saveScript()`，
  该函数 `PFiles.write()` 的返回值被丢弃、随后无条件 `toast("保存成功")`，而 `save` 协议本身
  **没有回执**；PC 侧 `installSender()` 也是发完就弹"已保存"。于是写失败被两端同时掩盖，
  真机上留下一个 0 字节的 `剪贴板发送.js`（属主是 AutoX、mtime 正是点安装的时刻）。
- **改法**：安装不再用 `save`，改为 `run` 一段安装脚本，由手机端 JS 用 `files.write()`
  写入、`files.read()` **回读比对**，再以 `AUTOCLIP1::{"k":"install","ok":…,"n":…,"path":…,"m":…}`
  把结果打回 PC。扩展**等回执**（8 秒超时）才算成功，失败时弹窗显示手机端原文错误。
  真机实测：`ok:true, n:342`，文件 508 字节；写入非法路径时回报
  `ok:false, m:"JavaException: … open failed: ENOTDIR"`。
- **文件名改 ASCII**：`剪贴板发送.js` → **`autoclip_send.js`**（脚本内提示文案仍是中文）。
  旧的 0 字节中文文件可手动删除，不影响使用。
- **新增配置** `clipSync.phoneScriptDir`（默认 `/sdcard/脚本`），AutoX 脚本目录改过时可覆盖。
- 新增三个互不冲突的脚本 id/文件名：`autoclip_dl`（下行）、`autoclip_send`（发送）、
  `autoclip_install`（安装），避免 `stop` 串台与同名覆盖。

### 2.1.0
- 新增**剪贴板同步**（默认关闭）：
  - **PC → 手机**：自动。轮询本机剪贴板，变化即 `run` 一段短脚本调用 `setClip()`，实测约 0.4s 生效
  - **手机 → PC**：手动。安装 `剪贴板发送.js` 后，在手机上点运行即回传（借 `console.log` 前缀 `AUTOCLIP1::`
    走 DevPlugin 日志通道）
  - 状态栏 `$(clippy) 剪贴板 ↑↓`、输出通道「剪贴板同步」、3 个命令与 `clipSync.*` 配置项
  - 防回环：内容指纹幂等 + 回声窗口 + “刚由手机写入”抑制窗口；空内容**永不**改写对端（不误清剪贴板）
  - 下行节流（默认 400ms）+ 只发最后一次；超长（>32KB）跳过不截断
- **为什么手机→PC 必须手动**（实测结论）：Android 10+ 后台读剪贴板被系统拒绝，
  `appops set <pkg> READ_CLIPBOARD allow` 在 Android 14 上**解不开**
  （实测：前台 `n=28` 读到内容，后台 `n=0` 空串；把 op 设成 `ignore` 前台也读不到，证明 op 生效但不够）。
  故改为“用户在手机上点一下”的用户态方案，不依赖任何权限绕过。
- 安全/隐私加固：
  - `Device.send()` 不再无脑 `console.log(data)`（会把整段剪贴板明文写进扩展日志），改为
    `AUTOX_DEBUG_SEND=1` 时才打印摘要（长字符串只留 60 字符）
  - `Device.send()` 增加连接判空（设备刚断开时广播会抛 `sendUTF of null`）
  - 设备日志里含 `AUTOCLIP1::` 的行不再打进扩展宿主 console（输出通道仍保留）
  - `mcp.ts` 的 `device_run_code` 收集日志时过滤 `AUTOCLIP1::`，避免污染脚本返回值
- 版本号 2.0.0 → **2.1.0**

### 2.0.0
- 版本线正式从 1.x 迁移到 2.x（上一次打包为 1.109.1，内容与此版本一致）
- 内置 **MCP Server**（默认 `127.0.0.1:18789`，命令：`启动/停止 AutoX MCP 服务`），
  让 AI/客户端可直接驱动手机，共 7 个工具：
  - `device_list` / `device_connect` / `device_stop`：设备发现、连接、停脚本
  - `device_screenshot`：设备截图
  - `device_get_layout`：获取界面布局树
  - `device_run_code`：在设备上执行 AutoX 代码（支持 `timeoutMs`，上限 120s，超时与正常结束分别上报）
  - `device_tap`：点击目标节点（重取布局 + 指纹校验，`node.click()` → 祖先 `click()` → 坐标点击 三级回退）
- `get_layout` v2 重写：
  - 以 `isVisibleToUser()` 为主判据（比 bounds 更准，可识别被软键盘遮挡的节点），只返回当前屏幕可见节点
  - 坐标改为**可见交集矩形**中心（`clamp` 到安全区），修掉退化 bounds 点到状态栏的问题
  - 恢复输出「有文案但不可点击」的节点（可作坐标锚点），不再被过滤规则误删
  - 新增 `ref`（`hash.ord`）稳定定位、`dropped` 分桶（notVisible / occluded / belowFold 等，互斥）、
    `scrollables` 列表；`mode` 支持 `actionable` / `tree` / `verbose`
- 修复手机端 Hello 握手兼容问题：按本端回复的 `versionCode` 决定期望字符串，
  解决 AutoX 7.x（versionCode 723）因握手不匹配导致断连

### 1.109.0
- 添加心跳检测（需要Autox.js 6.2.9 版本以上才会启用）
- 设备断开连接后关闭日志通道

### 1.108.0

优化以下特性：

- [wilinz](https://github.com/wilinz)  增加手动连接ADB命令和手动关闭连接命令

- [wilinz](https://github.com/wilinz) 修复&优化


### 1.107.0

优化以下特性：

-  [wilinz](https://github.com/wilinz)  修改连接不上的bug


### 1.105.0

优化以下特性：

-  修改名字，修改描述

### 1.104.0

优化以下特性：

-  [wilinz](https://github.com/wilinz) 修复一些bug
- 增加license


### 1.103.0

优化以下特性：

-  [wilinz](https://github.com/wilinz) 增加adb方式进行连接、二维码等
- 修改一些语法错误问题
- 不能自动运行的bug


### 1.102.0

优化以下特性：

-  内部测试，修正一些依赖版本，调整代码


### 1.101.0

优化以下特性：

- 服务器多 ip 无法显示所有 ip 问题
- 命令行分组提示 区分 autojs

### 1.100.0

优化以下特性：

- 修复创建新项目时候，非空文件夹中 main.js 和 project.json 被覆盖的问题

### 1.99.0

优化以下特性：

- 修复 1.98 版本中，文件名丢失的 bug

### 1.98.0

优化以下特性：

- 自动补全功能

### 1.97.3

优化以下特性：

- 修复 bug 保存文件名后缀为 js 的问题

### 1.97.2

优化以下特性：

- vscode 中使用统一文档

### 0.3.14

优化以下特性：

- 兼容应用商店版
- 修复 UI 闪退问题

### 0.3.13

优化以下特性：

- 兼容 webpack 5
- 功能冲突问题

### 0.3.12

优化以下特性：

- 增加功能（watch 模式）下 rerun 为先发 stop，再发 run 命令的模式，来修复 rerun 造成 app 闪退问题

### 0.3.11

优化以下特性：

- 增加功能（watch 模式）：根据项目配置，脚本保存后，自动重新运行脚本或保存项目到设备,
- 完全实现工程化，编译、混淆、打包、热更，项目自动保存到手机、运行脚本。
- js 文件 右键， 保存脚本 (此处并非保存到项目下,而是在通用目录中)
- 请结合 webpack-autojs cli 自动化工具，开发一行代码，不用按 f5，来回叨叨了 https://github.com/kkevsekk1/webpack-autojs

### 0.3.10

优化以下特性：

- 文件夹,右键菜单中添加‘保存项目到设备’； 结合 webpack 编译，混淆打包，保存到手机一气呵成
- js 文件 右键--运行脚本，js 文件中，右上角 点击运行脚本
- 结合 webpack， https://github.com/kkevsekk1/webpack-autojs 项目，可以做到高度工程化。
- 下一个版本将增加功能（watch 模式）：脚本保存后自动完成，热更新编译、混淆、打包、自动到手机、运行脚本。

### 0.3.8

优化以下特性：

- 开发文档： 修复 HTTP 文档打不开

### 0.3.7

优化以下特性：

- 开启服务(Start Server): 支持显示本地 IP，免去手动查询当前 vscode 运行机器所属 IP
- 开发文档: 优化重复点击”索引“菜单无跳转效果问题
  PS: 由于官方文档在小屏幕下没有显示比较有效的导航引导，建议配合一下快捷键使用，提高跳转效率
  - `Ctrl + Home`(到页面顶部)
  - `Ctrl + End`(到页面底部)
  - `PageUp`(上一页)
  - `PageDown`(下一页)

### 0.3.6

优化以下特性：

- 开发文档：支持快捷键`F4`开启显示

### 0.3.5

优化以下特性：

- 优化开发文档非第一次显示速度

### 0.3.4

优化以下特性：

- 修复离线开发文档显示问题
- 减少无相关的日志输出

### 0.3.3

增加以下特性：

- 增加离线开发文档

### 0.3.2

优化以下特性：

- 增加插件自身图标

### 0.3.1

优化以下特性：

- 手机打印日志输出，支持自动滚动，展示最新日志输出信息
- 重启 VsCode 插件服务后，手机打印日志通道不重复创建

### 0.3.0

优化以下特性：

- Run Project（运行项目）：优化项目配置 project.json 中 ignore 选项处理，提高 VsCode 到手机的项目传输速度
- Save Project（保存项目）：优化项目配置 project.json 中 ignore 选项处理，提高 VsCode 到手机的项目传输速度
- 支持手机打印输出到 VsCode 的输出通道面板上，无需在开发人员工具的控制台查看。每一个设备对应一个 VsCode 输出通道面板

<!-- | 功能 | 快捷键 | 说明 |
| ---- | ---- | ---- |
| 打开文档(Open Document) | `F4` | 打开Auto.js离线开发文档 |
| 开启服务(Start Server) |  | 启动插件服务。之后在确保手机和电脑在同一区域网的情况下，在Auto.js的侧拉菜单中使用连接电脑功能连接 |
| 停止服务(Stop Server) |  | 停止插件服务 |
| 运行脚本(Run) | `F5` | 运行当前编辑器的脚本。如果有多个设备连接，则在所有设备运行 |
| 重新运行(Rerun) | `Ctrl+Shift+F5`<br/>`Cmd+Shift+F5` | 停止当前文件对应的脚本并重新运行。如果有多个设备连接，则在所有设备重新运行 |
| 停止当前脚本(Stop) | `Shift+F5` | 停止当前文件对应的脚本。如果有多个设备连接，则在所有设备停止 |
| 停止所有脚本(Stop All) |  | 停止所有正在运行的脚本。如果有多个设备连接，则在所有设备运行所有脚本 |
| 保存到所有设备(Save) | `Ctrl+Shift+S`<br/>`Cmd+Shift+S` | 保存当前文件到手机的脚本默认目录（文件名会加上前缀remote)。如果有多个设备连接，则在所有设备保存 |
| 在指定设备运行脚本(Run On Device) | `Ctrl+F5`<br/>`Cmd+F5` | 弹出设备菜单并在指定设备运行脚本 |
| 保存到指定设备(Save On Device) |  | 弹出设备菜单并在指定设备保存脚本 |
| 新建项目(New Project) |  | 选择一个空文件夹（或者在文件管理器中新建一个空文件夹），将会自动创建一个项目 |
| 运行项目(Run Project) |  | 运行一个项目，需要Auto.js 4.0.4Alpha5以上支持 |
| 保存项目到设备(Save Project) |  | 保存一个项目，需要Auto.js 4.0.4Alpha5以上支持 | -->
