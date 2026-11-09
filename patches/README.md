# MyGo Music 播放器补丁

补丁包含 Windows 任务栏播放条、听歌页面布局，以及 0.6.0 插件需要的 MyGo 内嵌登录能力。必须选择与上游标签一致的文件，不适用于任意版本：

| 上游版本 | 补丁文件 |
| --- | --- |
| **v0.1.22（当前适配）** | 先 `mygo-0.1.22-taskbar-player.patch`，再 `mygo-0.1.22-embedded-signin.patch` |
| v0.1.21 | `mygo-0.1.21-taskbar-player.patch` |

## 内嵌登录

新增 `host.features.scriptedWebSignIn`、受限本地脚本注入、`untilAny` Cookie 条件和可辨别的关窗／超时结果。脚本必须位于插件目录、对应声明的 HTTPS 来源；远程页面没有 Go 服务权限。二维码由宿主编码，验证弹窗共用临时会话并保留在 MyGo 内。0.6.0 插件必须配套此补丁；旧播放器会收到明确提示。

Mac 原生取码、二维码显示、验证回调接续与取消、窗口关闭、会话保留及错误二维码拒绝已验证；Windows 目前仅交叉编译通过，真实账号验证仍需人工完成。

## 可见变化

- 任务栏常驻透明播放条（默认左侧），包括封面、当前歌词、上一首、播放／暂停、下一首和喜欢；点击歌曲信息可打开主窗口。
- 根据任务栏可用空间缩小或隐藏，跟随 Windows 任务栏深浅色；关闭系统阴影、外框与圆角。
- 歌词放大到 15 DIP，有真实逐字时间时渐进扫亮，长句跟随当前唱词；没有逐字时间则按行显示。暂停和跳转直接跟随播放器时间。
- 按住封面或歌词区域可直接用鼠标拖动，播放条水平跟随，松手后吸附至左侧或右侧空闲位置并保存；右侧窄档保留歌词与必要播控，极窄空间仅保留封面和必要按钮。鼠标进入整个播放条即显示右上角小关闭按钮，移出后隐藏；键盘聚焦时也显示，点击隐藏播放条但不停止音乐。
- 拖动时用淡色圆角吸附框标出目标空闲位置，边框大小对应最终停靠尺寸；切换左右时更新，松手或按 Esc 后隐藏。预览框不抢焦点、不拦截鼠标，也不占用任务栏空间探测结果。
- 设置中可关闭播放条。播放队列、托盘菜单、媒体键与主窗口共用播放器。
- `Section.layout: "compact"` 将听歌模式显示为小横卡；无封面的链接显示为操作行。
- `Link.reload: true` 使主动刷新重新请求页面，普通导航保留页面缓存。
- `Section.layout: "mode-buttons"` 显示常用模式横卡，`mode-covers` 显示宽幅探索封面卡；`Station.iconUrl` 提供随主题着色的小图标，同时保留 `imageUrl` 的旧布局兼容性。

## 应用及构建

在本仓库目录运行，需 Git、Go 1.27.3，以及 Node.js 22.6 以上或 Bun：

```powershell
git clone --branch v0.1.22 --depth 1 https://github.com/egoist/mygo-music.git .verification/mygo-music
git -C .verification/mygo-music apply --check ../../patches/mygo-0.1.22-taskbar-player.patch
git -C .verification/mygo-music apply ../../patches/mygo-0.1.22-taskbar-player.patch
git -C .verification/mygo-music apply --check ../../patches/mygo-0.1.22-embedded-signin.patch
git -C .verification/mygo-music apply ../../patches/mygo-0.1.22-embedded-signin.patch
Set-Location .verification/mygo-music
go test ./internal/...
go test ./internal/app -run '^TestTaskbar' -count=5
go tool mygo build -platform windows/amd64 -skip-installer -o build-embedded
```

依赖版本以补丁后的 `go.mod` 为准。构建后，先从托盘正常退出 MyGo，备份原程序，再使用构建输出替换程序；不要覆盖账号数据目录。

Mac arm64 可用 `go tool mygo build -platform darwin/arm64 -sign - -skip-dmg -skip-notarize -skip-installer -o build-embedded` 构建本机签名版。Windows 输出需保留 EXE 同目录资源；Mac 需保留完整 `.app`。

这不是 MyGo 官方发行版。自动更新仍然保留，官方更新可能覆盖补丁，届时需重新移植。

上游项目：[egoist/mygo-music](https://github.com/egoist/mygo-music/tree/v0.1.22)。上游 AGPL v3 原文见 [LICENSE-MyGo](LICENSE-MyGo)。
