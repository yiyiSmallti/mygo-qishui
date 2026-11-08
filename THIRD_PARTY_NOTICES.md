# 第三方来源与许可

本仓库没有为所有文件统一赋予新的开源许可证。以下来源说明不能替代原权利人的许可；现有第三方声明予以保留。

## MyGo Music

`patches/mygo-0.1.21-taskbar-player.patch` 与 `patches/mygo-0.1.22-taskbar-player.patch` 分别基于 [egoist/mygo-music v0.1.21](https://github.com/egoist/mygo-music/tree/v0.1.21) 和 [v0.1.22](https://github.com/egoist/mygo-music/tree/v0.1.22)。上游采用 GNU Affero General Public License v3，许可证原文见 [patches/LICENSE-MyGo](patches/LICENSE-MyGo)。补丁中的上游代码及相应修改遵循该许可。应用补丁时应保留上游的版权和许可文件。

## 汽水客户端相关代码与图标

- `qishui-account/browser-info.js` 的文件头记录其改编自汽水音乐 3.7.0 安装资源中的 `@byted/uc-browser-sdk` 和 `@byted/account-request`。
- `qishui-account/assets/stations/` 和 `qishui-account/assets/mode-icons/` 中的场景、熟悉及新鲜模式图标衍生自汽水界面素材，具体说明见各目录的 README。个性推荐与通用场景的音频图形由代码绘制。
- 登录、设备注册和播放逻辑参考客户端公开安装资源及插件 README 列出的协议研究。

上述第三方素材的权利属于各自权利人；本仓库不声称获得其官方授权，也不将这些素材重新许可为项目原创内容。未随仓库分发官方原生 SDK、完整客户端、FFmpeg 或音频文件。运行时依赖本机自行安装的组件。
