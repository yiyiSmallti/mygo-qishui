package main

import "github.com/egoist/mygo/ui"

// All state is owned by the UI thread. Installation is a separate transaction;
// this view only offers explicit user actions and displays their actual result.
type enhancementView struct {
	state, message, diagnostics, backup string
	upgrade, details, copied            bool
	onInstall, onClose, onBackup        func()
	onCopy                              func() bool
}

var enhancementIcons = []*ui.SVG{
	enhancementIcon(`<path d="M9 18V5l12-2v13"/><path d="M9 8l12-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="18" cy="16" rx="3" ry="2"/>`),
	enhancementIcon(`<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M12 8h6M12 12h6M12 16h4"/>`),
	enhancementIcon(`<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 15h20M6 18h3M12 18h6"/>`),
}

func enhancementIcon(paths string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">` + paths + `</svg>`))
}

func (v *enhancementView) close() {
	if v.state != "working" && v.onClose != nil {
		v.onClose()
	}
}

func (v *enhancementView) content(c *ui.Context) {
	theme := *c.Theme()
	theme.Accent = ui.Oklch(0.6, 0.21, 24)
	theme.Success = ui.Hex("#15803d")
	background, surface := ui.Hex("#ffffff"), ui.Hex("#f4f4f6")
	text, muted := ui.Hex("#1d1d1f"), ui.RGBA(60, 60, 67, 0.62)
	if theme.Dark {
		background, surface = ui.Hex("#141416"), ui.Hex("#1c1c1f")
		text, muted = ui.Hex("#f5f5f7"), ui.RGBA(235, 235, 245, 0.56)
		theme.Accent = ui.Oklch(0.66, 0.2, 22)
		theme.Success = ui.Hex("#22c55e")
	}
	theme.AccentText = ui.Hex("#ffffff")
	theme.AccentHover = theme.Accent.MixOklab(ui.Hex("#000000"), 0.1)
	theme.AccentPressed = theme.Accent.MixOklab(ui.Hex("#000000"), 0.2)
	c.SetTheme(&theme)
	c.OnShortcut(0, ui.KeyEscape, v.close)
	title, description := "安装界面增强", "将安装以下组件并重启 MyGo。请先保存设置并暂停播放，原程序和已保存的数据会备份。"
	if v.upgrade {
		title = "更新界面增强"
	}
	switch v.state {
	case "installed":
		title, description = "增强组件已就绪", "当前 MyGo 已包含本插件附带的全部增强。"
	case "unsupported":
		title, description = "当前 MyGo 暂不支持", "仅支持已核验的 Windows x64 MyGo 0.1.22 / 0.1.24 构建。未修改程序或账号数据。"
	case "working":
		title, description = "正在安装增强", "正在备份、更新并重启 MyGo。完成前请保持此窗口打开。"
	case "failed":
		title, description = "安装未完成", v.message
	}
	ui.Column(c).Fill().Background(background).Children(func() {
		ui.Row(c).Height(38).PaddingX(20).AlignItems(ui.Center).DragWindow().Children(func() {
			ui.Text(c, "汽水音乐").FontSize(12).FontWeight(500).TextColor(muted)
		})
		ui.Scroll(c.Key("body")).Grow(1).Padding(10, 24, 20, 24).Children(func() {
			ui.Column(c).Gap(10).Children(func() {
				ui.Text(c, title).FontSize(21).FontWeight(600).TextColor(text)
				ui.Text(c, description).FontSize(13).TextColor(muted).LineHeight(1.5)
			})
			if v.state == "available" || v.state == "installed" || v.state == "working" {
				ui.Column(c).Margin(22, 0, 0, 0).Padding(4, 14).Radius(12).Background(surface).Children(func() {
					labels := []string{"听歌模式", "插件设置入口", "任务栏播放条"}
					descriptions := []string{"小图标横卡与探索封面", "从汽水插件管理页打开增强助手", "任务栏歌词、播放控制与左右停靠"}
					for i, label := range labels {
						ui.Row(c.Key(label)).MinHeight(65).Gap(12).AlignItems(ui.Center).Children(func() {
							ui.Icon(c, enhancementIcons[i]).Size(23, 23).TextColor(text)
							ui.Column(c).Grow(1).Shrink(1).MinWidth(0).Gap(4).Children(func() {
								ui.Text(c, label).FontSize(13.5).FontWeight(500).TextColor(text)
								ui.Text(c, descriptions[i]).FontSize(11.5).TextColor(muted).LineHeight(1.35)
							})
							if v.state == "installed" {
								ui.Text(c, "已安装").FontSize(11.5).TextColor(theme.Success).Shrink(0)
							}
						})
					}
				})
			}
			if v.state == "installed" {
				ui.Text(c, "任务栏播放条可在 MyGo 设置中开启或关闭。官方更新可能覆盖增强，届时请重新检查。").Margin(16, 0, 0, 0).FontSize(11.5).TextColor(muted).LineHeight(1.45)
			}
			if v.state == "unsupported" || v.state == "failed" {
				if ui.Button(c.Key("details"), "诊断信息").Margin(18, 0, 0, 0).Clicked() {
					v.details = !v.details
				}
				if v.details {
					ui.Text(c, v.diagnostics).Margin(10, 0, 0, 0).FontSize(11.5).TextColor(muted).LineHeight(1.45).Selectable()
					if ui.Button(c.Key("copy"), "复制诊断信息").Margin(10, 0, 0, 0).Clicked() && v.onCopy != nil {
						v.copied = v.onCopy()
					}
					if v.copied {
						ui.Text(c, "已复制").FontSize(11.5).TextColor(muted)
					}
				}
				if v.backup != "" && v.onBackup != nil {
					if ui.Button(c.Key("backup"), "打开备份文件夹").Margin(12, 0, 0, 0).Clicked() {
						v.onBackup()
					}
				}
			}
		})
		ui.Row(c).Padding(16, 24).Gap(10).AlignItems(ui.Center).Background(surface).Children(func() {
			ui.Text(c, "账号与插件数据保留").FontSize(11.5).TextColor(muted).Grow(1).Shrink(1).MinWidth(0)
			if v.state == "available" {
				if ui.Button(c.Key("cancel"), "取消").Clicked() {
					v.close()
				}
				label := "安装并重启 MyGo"
				if v.upgrade {
					label = "更新并重启 MyGo"
				}
				if ui.PrimaryButton(c.Key("install"), label).Clicked() && v.onInstall != nil {
					v.onInstall()
				}
			} else if v.state == "working" {
				ui.Button(c.Key("working"), "正在安装…").Disabled(true)
			} else {
				label := "关闭"
				if v.state == "installed" {
					label = "完成"
				}
				if ui.PrimaryButton(c.Key("done"), label).Clicked() {
					v.close()
				}
			}
		})
	})
}
