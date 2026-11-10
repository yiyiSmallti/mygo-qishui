# 第三方来源与许可

本仓库没有为所有文件统一赋予新的开源许可证。以下来源说明不能替代原权利人的许可；现有第三方声明予以保留。

## MyGo Music

`patches/mygo-0.1.21-taskbar-player.patch` 与 `patches/mygo-0.1.22-taskbar-player.patch` 分别基于 [egoist/mygo-music v0.1.21](https://github.com/egoist/mygo-music/tree/v0.1.21) 和 [v0.1.22](https://github.com/egoist/mygo-music/tree/v0.1.22)。`login-helper/` 的窗口与会话代码也改编自该版本的登录实现及本项目补丁，遵循同一 AGPL v3，完整源码随发布包提供。0.6.1 不再需要修改播放器的登录接口。上游采用 GNU Affero General Public License v3，许可证原文见 [patches/LICENSE-MyGo](patches/LICENSE-MyGo)。补丁中的上游代码及相应修改遵循该许可。应用补丁时应保留上游的版权和许可文件。

## 汽水客户端相关代码与图标

- `qishui-account/browser-info.js` 的文件头记录其改编自汽水音乐 3.7.0 安装资源中的 `@byted/uc-browser-sdk` 和 `@byted/account-request`。
- `qishui-account/assets/stations/` 和 `qishui-account/assets/mode-icons/` 中的场景、熟悉及新鲜模式图标衍生自汽水界面素材，具体说明见各目录的 README。个性推荐与通用场景的音频图形由代码绘制。
- 登录、设备注册和播放逻辑参考客户端公开安装资源及插件 README 列出的协议研究。

上述第三方素材的权利属于各自权利人；本仓库不声称获得其官方授权，也不将这些素材重新许可为项目原创内容。未随仓库分发官方原生 SDK、完整客户端、FFmpeg 或音频文件。运行时依赖本机自行安装的组件。

## 登录组件依赖

登录组件使用 MyGo 框架（MIT）、purego（Apache-2.0）、rsc.io/qr 及 Go x/net、x/text（BSD）。许可原文随插件存放在 `native-licenses/`，不包含汽水官方原生 SDK。

## React / ReactDOM

`qishui-account/vendor/react-18.3.1/` 包含官方 npm `react@18.3.1` 和 `react-dom@18.3.1` 的未修改 production UMD 文件，以满足官方二次验证组件的外部依赖及 legacy DOM API。两者采用 MIT 许可，原文、来源和文件 SHA-256 均保留在该目录中。
