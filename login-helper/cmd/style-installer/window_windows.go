//go:build windows

package main

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

// The hidden window is prepared before the launcher releases ownership. Once
// confirmed, closing or quitting cannot interrupt copying or recovery.
func showEnhancementManager(view *enhancementView, ack func(string) error, decision *atomic.Int32, apply func() receipt) error {
	var win *mygo.Window
	var started, loopEnded atomic.Bool
	finished := make(chan receipt, 1)
	ackFailed := make(chan error, 1)
	mygo.App.SetName("汽水音乐界面增强")
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
		if view.state == "working" {
			e.PreventDefault()
		}
	})
	mygo.App.OnWindowAllClosed(func() {
		if view.state != "working" {
			mygo.App.Quit()
		}
	})
	mygo.App.WhenReady(func() {
		win = mygo.NewWindow(mygo.WindowOptions{
			Title: "汽水音乐 · 界面增强", Hidden: true,
			Width: 560, Height: 510, MinWidth: 480, MinHeight: 470,
			TitleBarStyle: mygo.TitleBarHidden, TitleBarHeight: 38,
			DisableMinimize: true, DisableMaximize: true, AutoHideMenuBar: true,
			BackgroundColor: "light-dark(#ffffff, #141416)", Content: ui.View(view.content),
		})
		win.OnClose(func(e *mygo.CloseEvent) {
			if view.state == "working" {
				e.PreventDefault()
				return
			}
			decision.CompareAndSwap(0, 2)
		})
		view.onClose = func() {
			if view.state == "working" {
				return
			}
			decision.CompareAndSwap(0, 2)
			mygo.App.Quit()
		}
		view.onCopy = func() bool { return mygo.Clipboard.Write(transfer.TextData(view.diagnostics)) == nil }
		view.onBackup = func() {
			if view.backup != "" {
				mygo.Shell.OpenPath(view.backup)
			}
		}
		view.onInstall = func() {
			if view.state != "available" || !decision.CompareAndSwap(0, 1) {
				return
			}
			view.state = "working"
			started.Store(true)
			win.Invalidate()
			go func() {
				result := apply()
				// The event loop may fail independently. The transaction result
				// must reach main before any attempted UI update can wait on it.
				finished <- result
				// A stuck UI must not leave a detached helper running forever.
				// This bound starts only after copying and recovery have finished.
				time.AfterFunc(2*time.Minute, func() {
					mygo.App.Quit()
					time.AfterFunc(3*time.Second, func() { os.Exit(0) })
				})
				if loopEnded.Load() {
					return
				}
				win.Update(func() {
					if result.OK {
						view.state = "installed"
					} else {
						view.state = "failed"
						view.message = "在“" + result.Stage + "”阶段未能完成安装。"
						if result.RolledBack {
							view.message += "原程序已恢复并重启。"
						} else if result.FileRestored {
							view.message += "原程序文件已恢复，请从原路径重新启动。"
						}
						if result.TerminationPending {
							view.message += "MyGo 仍在退出，程序尚未替换。"
						}
						if result.Backup != "" {
							view.backup = filepath.Dir(result.Backup)
						}
						view.diagnostics += "\n失败阶段：" + result.Stage + "\n备份目录：" + view.backup
					}
				})
			}()
		}
		go func() {
			if err := ack("ready"); err != nil {
				ackFailed <- err
				mygo.App.Quit()
				return
			}
			mygo.RunOnMain(func() {
				// Consume STARTF_USESHOWWINDOW before explicitly showing the GUI.
				win.Show()
				win.Show()
				win.Focus()
			})
		}()
	})
	err := mygo.App.Run()
	loopEnded.Store(true)
	if started.Load() {
		<-finished
	}
	select {
	case failure := <-ackFailed:
		return failure
	default:
		return err
	}
}
