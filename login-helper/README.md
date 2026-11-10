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

Mac 已通过上述原版入口取码和窗口验证，Windows 本轮只完成交叉编译，真实账号确认及平台二次验证仍需在目标电脑完成。

## 随插件安装的样式增强（0.6.5）

Windows ZIP 包含 `native/style-installer.exe`、`native/layout-player.exe`、校验清单和完整对应源码。后者在 v0.1.22 上增加布局及插件设置页动作支持，不包含任务栏、登录或歌词改动。原版主程序没有插件安装钩子，因此插件提供明确的「界面增强」入口；首次安装仍需要用户确认关闭并重启主程序，不能仅靠图片或 CSS 改变原生布局。

Node 启动器绑定其真实 MyGo 父进程，使用私有管道完成双向交接后退出；独立原生助手不会被插件退出连带终止。助手以持有的进程 handle、创建时间、路径和已知 SHA-256 绑定目标，默认取消。已安装、取消及未知程序分支不创建备份或写 AppData；确认后才在用户私有目录备份数据与原程序，验证同目录文件未变，只原子替换 EXE。重启失败会恢复原文件，并独立检查原程序是否恢复运行；不请求管理员权限，不创建计划任务或自启动项，不依赖 PowerShell。

构建样式组件使用 `scripts/build-style-player.mjs`；打包器的 `-style` 指定组件目录。Mac ZIP 不带 Windows 二进制或源码包。官方主程序更新可能覆盖增强，届时需要重新检查兼容版本。

0.6.5 补入经官方发布包校验的 Windows x64 原版哈希。原有两个已验证构建继续支持；旧布局版需要确认升级才能获得设置页按钮。安装与失败回退均使用本次启动时核对的实际原程序哈希，不再假定所有原程序等于早期试验构建。

设置页入口复现：将 `verification/settings-entry.go.txt` 复制到已应用本项目布局补丁的 MyGo v0.1.22 源码 `internal/app/qishui_settings_e2e_test.go`。在 Mac 上设置 `STYLE_PLUGIN_TEST_DIR` 为本项目 `qishui-account` 的绝对路径，并设置 `STYLE_ENTRY_EVIDENCE` 为独立证据目录，运行 `go test -tags styleqa ./internal/app -run TestQishuiSettingsActualPluginEntry -count=1`。该检查通过真实插件驱动设置页的无账号、非当前音源、重复点击与停用隐藏场景，并生成 PNG 和 JSON 工件；它使用 Mac 的不支持平台分支，不代替 Windows 安装与回退实测。
