# MyGo Music 播放器补丁

补丁包含 Windows 任务栏播放条及听歌页面布局。必须选择与上游标签一致的文件，不适用于任意版本：

| 上游版本 | 补丁文件 |
| --- | --- |
| **v0.1.22（当前适配）** | `mygo-0.1.22-taskbar-player.patch` |
| v0.1.21 | `mygo-0.1.21-taskbar-player.patch` |

0.6.1 的登录组件随插件分发，原版播放器即可使用。下列补丁仅提供任务栏与页面样式扩展。

## 插件内的小图标安装助手

0.6.4 的 Windows 插件包已自带样式组件。普通使用者从插件侧栏「界面增强」打开原生助手即可，无需自行应用源码补丁或运行脚本。助手只支持已验证的 v0.1.22 构建，并在确认后备份、更新单个 EXE 和重启；账号与插件数据保留。已增强的程序不会重复安装，未知构建不会被降级或覆盖。

`mygo-0.1.22-layout-only.patch` 是此组件的五文件源码补丁，仅包含 compact、mode-buttons、mode-covers 和刷新操作布局，不包含下述 Windows 任务栏、登录或歌词改动。构建方式为 `node scripts/build-style-player.mjs /path/to/unmodified-mygo-v0.1.22`，生成的程序和对应源码由插件打包器收录。

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
Set-Location .verification/mygo-music
go test ./internal/...
go test ./internal/app -run '^TestTaskbar' -count=5
go tool mygo build -platform windows/amd64 -skip-installer -o build-embedded
```

依赖版本以补丁后的 `go.mod` 为准。构建后，先从托盘正常退出 MyGo，备份原程序，再使用构建输出替换程序；不要覆盖账号数据目录。

Mac arm64 可用 `go tool mygo build -platform darwin/arm64 -sign - -skip-dmg -skip-notarize -skip-installer -o build-embedded` 构建本机签名版。Windows 输出需保留 EXE 同目录资源；Mac 需保留完整 `.app`。

这不是 MyGo 官方发行版。自动更新仍然保留，官方更新可能覆盖补丁，届时需重新移植。

上游项目：[egoist/mygo-music](https://github.com/egoist/mygo-music/tree/v0.1.22)。上游 AGPL v3 原文见 [LICENSE-MyGo](LICENSE-MyGo)。
