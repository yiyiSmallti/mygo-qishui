# MyGo Music v0.1.21 补丁

`mygo-0.1.21-taskbar-player.patch` 包含 Windows 任务栏播放条及听歌页面布局改动，共涉及 30 个文件，配套插件 0.5.0。补丁对应上游标签 **v0.1.21**，不适用于任意版本。

## 可见变化

- 任务栏常驻透明播放条（默认左侧），包括封面、当前歌词、上一首、播放／暂停、下一首和喜欢；点击歌曲信息可打开主窗口。
- 根据任务栏可用空间缩小或隐藏，跟随 Windows 任务栏深浅色；关闭系统阴影、外框与圆角。
- 歌词放大到 15 DIP，有真实逐字时间时渐进扫亮，长句跟随当前唱词；没有逐字时间则按行显示。暂停和跳转直接跟随播放器时间。
- 拖动封面或歌词区域停靠左侧或右侧并保存；右侧窄档保留歌词与必要播控，极窄空间仅保留封面和必要按钮。右上角小关闭按钮隐藏播放条但不停止音乐。
- 设置中可关闭播放条。播放队列、托盘菜单、媒体键与主窗口共用播放器。
- `Section.layout: "compact"` 将听歌模式显示为小横卡；无封面的链接显示为操作行。
- `Link.reload: true` 使主动刷新重新请求页面，普通导航保留页面缓存。
- `Section.layout: "mode-buttons"` 显示常用模式横卡，`mode-covers` 显示宽幅探索封面卡；`Station.iconUrl` 提供随主题着色的小图标，同时保留 `imageUrl` 的旧布局兼容性。

## 应用及构建

在本仓库目录运行，需 Git、Go 1.27.3，以及 Node.js 22.6 以上或 Bun：

```powershell
git clone --branch v0.1.21 --depth 1 https://github.com/egoist/mygo-music.git .verification/mygo-music
git -C .verification/mygo-music apply --check ../../patches/mygo-0.1.21-taskbar-player.patch
git -C .verification/mygo-music apply ../../patches/mygo-0.1.21-taskbar-player.patch
Set-Location .verification/mygo-music
go test ./internal/...
go test ./internal/app -run '^TestTaskbar' -count=5
go tool mygo build -platform windows/amd64 -skip-installer -o build-taskbar
```

依赖版本以补丁后的 `go.mod` 为准。构建后，先从托盘正常退出 MyGo，备份原程序，再使用构建输出替换程序；不要覆盖账号数据目录。

这不是 MyGo 官方发行版。自动更新仍然保留，官方更新可能覆盖补丁，届时需重新移植。

上游项目：[egoist/mygo-music](https://github.com/egoist/mygo-music/tree/v0.1.21)。上游 AGPL v3 原文见 [LICENSE-MyGo](LICENSE-MyGo)。
