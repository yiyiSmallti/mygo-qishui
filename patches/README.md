# MyGo Music v0.1.21 补丁

`mygo-0.1.21-taskbar-player.patch` 包含 Windows 任务栏播放条及推荐页布局改动，共涉及 24 个文件。补丁对应上游标签 **v0.1.21**，不适用于任意版本。

## 可见变化

- 任务栏左侧常驻透明播放条，包括封面、当前歌词、上一首、播放／暂停、下一首和喜欢；点击歌曲信息可打开主窗口。
- 根据任务栏可用空间缩小或隐藏，跟随 Windows 任务栏深浅色；关闭系统阴影、外框与圆角。
- 设置中可关闭播放条。播放队列、托盘菜单、媒体键与主窗口共用播放器。
- `Section.layout: "compact"` 将听歌模式显示为小横卡；无封面的链接显示为操作行。
- `Link.reload: true` 使主动刷新重新请求页面，普通导航保留页面缓存。

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
