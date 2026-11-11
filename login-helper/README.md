# 汽水插件原生登录组件

自 0.6.1 起，将扫码和官方验证窗口随插件分发。原版 MyGo Music v0.1.22 仅通过已有 `host.spawn` 私有标准输入/输出调用本组件，不需要播放器登录补丁，也不启动独立 Chrome／Edge。Windows 使用 WebView2 Runtime，Mac 使用系统 WebKit。

## 构建与打包

需要 Go 1.27.3、Node.js 24+。在仓库根目录运行：

```sh
node scripts/build-login-helper.mjs
node scripts/build-style-player.mjs <未修改的-MyGo-v0.1.22-源码目录>
go -C login-helper run ./cmd/package -root .. -native ../dist/login-helper -out ../dist
```

产物为 `dist/plugin-windows-amd64.zip`、`dist/plugin-darwin-arm64.zip` 和 `SHA256SUMS`。打包器校验二进制架构、拒绝 QA 构建，并写入 Unix executable bit。Mac 上构建时会给辅助程序做本机临时签名；未做 Apple 公证。源码安装需将对应构建产物复制到 `qishui-account/native/qishui-login[.exe]`。发布 ZIP 已完成此步骤。

`state.go` 改编自 MyGo Music v0.1.22 及本项目的登录补丁，按 GNU AGPL v3 分发；框架与其他依赖许可随插件位于 `native-licenses/`。没有分发官方汽水原生 SDK。

## 边界与生命周期

0.6.2 在 Windows 不再把 API 根目录的 404 响应作为宿主页。Windows 不发起初始远端导航，直接用 `Page.LoadHTML(bootstrapHTML, origin + "/")` 加载本地 HTML；WebView2 通过精确文档响应提供 HTTP 200 并保留 API 来源。真实 SDK 和接口仍走 HTTPS，原有加载失败处理不变；Mac 保留已验证的 WebKit 导航方式。

官方现代二次验证组件依赖宿主提供 React / ReactDOM。0.6.3 随包内置固定版本 18.3.1 production UMD，并在加载官方组件前设置 `ucSecondVerifyReact` / `ucSecondVerifyReactDom`，保留组件需要的 `render` 和 `unmountComponentAtNode`；不增加 React CDN 请求。文件、原始 MIT 许可与校验值位于 `qishui-account/vendor/react-18.3.1/`。

页面使用临时会话且没有受信任的 Go 服务桥。宿主只读取有界状态，并在每次 Eval 内检查来源。二维码由组件编码，验证弹窗保持同一会话；最终 Cookie 只通过私有管道交给插件，再向固定汽水 API 校验身份，成功才保存会话。

页面可写的错误文本不会进入诊断，只返回固定错误码与文案。stdin 关闭和独立时限均能结束组件；父插件还提供有界进程终止。原版单次登录总时限为 5 分钟，设备准备和窗口共享此预算，不依赖延长宿主时限。

## 验证

插件回归为仓库根目录 `npm test`。`qa.go` 仅在 `-tags loginqa` 时编译，模拟验证回调属于测试控制，生产包拒绝包含这些控制的二进制。

复现原版入口验证：检出未改动的 `egoist/mygo-music` v0.1.22，将 `verification/stock-player-main.go.txt` 复制到其 `cmd/stockqa/main.go`，构建 `go build -o /private/tmp/mygo-stock-login-qa ./cmd/stockqa`。在本目录构建 `CGO_ENABLED=0 go build -tags loginqa -o <plugin>/native/qishui-login .`，使用隔离副本而非已安装插件。

向验证程序设置 `MYGO_QA_PLUGIN_DIR`、`MYGO_QA_STORAGE`（只读取现有匿名设备记录）、`MYGO_NATIVE_QA_MODE`、`MYGO_NATIVE_QA_RESULT`、`MYGO_NATIVE_QA_SCREENSHOT` 和 `MYGO_STOCK_QA_RESULT`。`mfa-success` / `mfa-cancel` 使用真实随包 React 渲染、点击与卸载受控验证组件，检查依赖在官方脚本入口前可用；该受控组件不替代真实账号的官方验证。模式为 `mfa-success`、`mfa-cancel`、`qr-origin`、`qr-token`、`unsafe-error`、`bootstrap`、`navigation-failure`。`bootstrap` 断言本地宿主页标记与页面 URL/来源一致；`navigation-failure` 在真实取码后导航到不存在的域名，必须返回 `load`。验证会创建临时插件数据，检查旧会话保留与原账号文件不变，不扫描或确认真实账号；截图会先隐藏二维码。

上述原版登录组件专项检查已在 Mac 完成取码和窗口验证，Windows 在该轮仅完成交叉编译，不代表当前全部平台状态。后续 Windows 0.6.7 已收到用户实机测试暂未发现问题的反馈；0.6.8 的 Mac 免客户端准备和真实播放另有专项验证，详见 [历史记录](../docs/history.md)。这些检查不替代真实账号的人工扫码确认及官方二次验证。

## 随插件安装的增强组件（自 0.6.6 起）

Windows ZIP 包含 `native/style-installer.exe`、`native/layout-player.exe`、校验清单和完整对应源码。增强程序包含听歌模式布局、插件设置动作、侧栏兼容规则，以及原有 Windows 任务栏播放条和逐字歌词显示；不包含登录补丁。原版首次仍需确认更新主程序；新主程序有设置页按钮后，侧栏重复项隐藏。

管理窗口使用与 MyGo 相同的原生 UI 控件，不使用 MessageBox 或浏览器。它随系统深浅外观显示，明确列出组件及实际安装状态，默认回车不会安装，Esc 可在确认前取消。原生窗口在完成双向管道交接前保持隐藏，Node 启动器随后退出。确认后在后台执行原有备份和更新事务，关闭与退出事件不会中断复制或回退；即使 UI 事件循环异常退出，主协程也会等待事务结果。事务完成后有独立的退出上限，避免后台助手残留。

助手继续以进程 handle、创建时间、路径和已知 SHA256 绑定目标。取消、已安装与未知构建分支不替换播放器、不创建播放器备份，也不修改账号及插件资料；确认后才创建私有备份，验证已有数据，只原子替换 EXE。重启失败会恢复实际原程序，并独立检查是否恢复运行。不请求管理员权限，不注册服务、计划任务或自启动项。

清单 schema 2 声明 `listening-layout`、`settings-entry` 和 `taskbar-player` 三项；打包器及源码归档器均检查对应源码文件。官方 Windows x64 0.1.22 和此前已验证的构建继续支持，新增接受 0.6.5 的增强程序以便升级；未知程序仍拒绝覆盖。Mac ZIP 不带 Windows 增强二进制或源码包。

原生窗口的可重复视图检查位于 `cmd/style-installer/view_test.go`，通过 `ENHANCEMENT_UI_EVIDENCE` 指定 PNG/JSON 证据目录。侧栏兼容检查源码为 `verification/sidebar-fallback.go.txt`，分别放进原版和已应用增强补丁的 MyGo 源码 `internal/app/sidebar_fallback_e2e_test.go`，设置 `ENHANCEMENT_PLUGIN_DIR`、`ENHANCEMENT_SIDEBAR_EVIDENCE` 及 `ENHANCEMENT_EXPECT_FALLBACK=true/false`，执行 `go test -tags enhancementqa ./internal/app -run TestEnhancementSidebarCompatibility -count=1`。这些检查不代替 Windows 原生进程安装、回退、实际关闭事件或任务栏占位与拖动的实机验收。

设置页入口复现：将 `verification/settings-entry.go.txt` 复制到已应用本项目布局补丁的 MyGo v0.1.22 源码 `internal/app/qishui_settings_e2e_test.go`。在 Mac 上设置 `STYLE_PLUGIN_TEST_DIR` 为本项目 `qishui-account` 的绝对路径，并设置 `STYLE_ENTRY_EVIDENCE` 为独立证据目录，运行 `go test -tags styleqa ./internal/app -run TestQishuiSettingsActualPluginEntry -count=1`。该检查通过真实插件驱动设置页的无账号、非当前音源、重复点击与停用隐藏场景，并生成 PNG 和 JSON 工件；它使用 Mac 的不支持平台分支，不代替 Windows 安装与回退实测。
