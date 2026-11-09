# 汽水插件原生登录组件

自 0.6.1 起，将扫码和官方验证窗口随插件分发。原版 MyGo Music v0.1.22 仅通过已有 `host.spawn` 私有标准输入/输出调用本组件，不需要播放器登录补丁，也不启动独立 Chrome／Edge。Windows 使用 WebView2 Runtime，Mac 使用系统 WebKit。

## 构建与打包

需要 Go 1.27.3、Node.js 24+。在仓库根目录运行：

```sh
node scripts/build-login-helper.mjs
go -C login-helper run ./cmd/package -root .. -native ../dist/login-helper -out ../dist
```

产物为 `dist/plugin-windows-amd64.zip`、`dist/plugin-darwin-arm64.zip` 和 `SHA256SUMS`。打包器校验二进制架构、拒绝 QA 构建，并写入 Unix executable bit。Mac 上构建时会给辅助程序做本机临时签名；未做 Apple 公证。源码安装需将对应构建产物复制到 `qishui-account/native/qishui-login[.exe]`。发布 ZIP 已完成此步骤。

`state.go` 改编自 MyGo Music v0.1.22 及本项目的登录补丁，按 GNU AGPL v3 分发；框架与其他依赖许可随插件位于 `native-licenses/`。没有分发官方汽水原生 SDK。

## 边界与生命周期

0.6.2 在 Windows 不再把 API 根目录的 404 响应作为宿主页。Windows 不发起初始远端导航，直接用 `Page.LoadHTML(bootstrapHTML, origin + "/")` 加载本地 HTML；WebView2 通过精确文档响应提供 HTTP 200 并保留 API 来源。真实 SDK 和接口仍走 HTTPS，原有加载失败处理不变；Mac 保留已验证的 WebKit 导航方式。

页面使用临时会话且没有受信任的 Go 服务桥。宿主只读取有界状态，并在每次 Eval 内检查来源。二维码由组件编码，验证弹窗保持同一会话；最终 Cookie 只通过私有管道交给插件，再向固定汽水 API 校验身份，成功才保存会话。

页面可写的错误文本不会进入诊断，只返回固定错误码与文案。stdin 关闭和独立时限均能结束组件；父插件还提供有界进程终止。原版单次登录总时限为 5 分钟，设备准备和窗口共享此预算，不依赖延长宿主时限。

## 验证

插件回归为仓库根目录 `npm test`。`qa.go` 仅在 `-tags loginqa` 时编译，模拟验证回调属于测试控制，生产包拒绝包含这些控制的二进制。

复现原版入口验证：检出未改动的 `egoist/mygo-music` v0.1.22，将 `verification/stock-player-main.go.txt` 复制到其 `cmd/stockqa/main.go`，构建 `go build -o /private/tmp/mygo-stock-login-qa ./cmd/stockqa`。在本目录构建 `CGO_ENABLED=0 go build -tags loginqa -o <plugin>/native/qishui-login .`，使用隔离副本而非已安装插件。

向验证程序设置 `MYGO_QA_PLUGIN_DIR`、`MYGO_QA_STORAGE`（只读取现有匿名设备记录）、`MYGO_NATIVE_QA_MODE`、`MYGO_NATIVE_QA_RESULT`、`MYGO_NATIVE_QA_SCREENSHOT` 和 `MYGO_STOCK_QA_RESULT`。模式为 `mfa-success`、`mfa-cancel`、`qr-origin`、`qr-token`、`unsafe-error`、`bootstrap`、`navigation-failure`。`bootstrap` 断言本地宿主页标记与页面 URL/来源一致；`navigation-failure` 在真实取码后导航到不存在的域名，必须返回 `load`。验证会创建临时插件数据，检查旧会话保留与原账号文件不变，不扫描或确认真实账号；截图会先隐藏二维码。

Mac 已通过上述原版入口取码和窗口验证，Windows 本轮只完成交叉编译，真实账号确认及平台二次验证仍需在目标电脑完成。
