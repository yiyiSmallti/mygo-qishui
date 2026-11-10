package main

import (
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"
)

// Exercise real native UI elements and keyboard actions before any installer I/O.
func TestEnhancementManagerUI(t *testing.T) {
	for _, dark := range []bool{false, true} {
		for _, state := range []string{"available", "installed", "unsupported", "working", "failed"} {
			v := &enhancementView{state: state, message: "原程序已恢复并重启。", diagnostics: "MyGo 0.1.22\nSHA256: public-build-fingerprint"}
			view := ui.NewTester(v.content, 560, 510)
			view.SetDark(dark)
			view.Frame()
			if state == "installed" || state == "available" || state == "working" {
				for _, label := range []string{"听歌模式", "插件设置入口", "任务栏播放条"} {
					if _, ok := view.Find(label); !ok {
						t.Fatalf("%s missing in %s", label, state)
					}
				}
			}
			if state != "available" {
				if _, ok := view.Find("安装并重启 MyGo"); ok {
					t.Fatalf("install offered in %s", state)
				}
			}
			if dir := os.Getenv("ENHANCEMENT_UI_EVIDENCE"); dir != "" {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				f, err := os.Create(filepath.Join(dir, fmt.Sprintf("manager-%s-dark-%v.png", state, dark)))
				if err != nil {
					t.Fatal(err)
				}
				err = png.Encode(f, view.Image())
				f.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	installed, closed := 0, 0
	v := &enhancementView{state: "available", onInstall: func() { installed++ }, onClose: func() { closed++ }}
	view := ui.NewTester(v.content, 560, 510)
	view.Frame()
	view.Key(0, ui.KeyEnter)
	view.Frame()
	if installed != 0 {
		t.Fatal("Enter installed without explicit confirmation")
	}
	view.Key(0, ui.KeyEscape)
	view.Frame()
	if installed != 0 || closed != 1 {
		t.Fatal("Escape did not cancel")
	}
	if err := view.Click("安装并重启 MyGo"); err != nil {
		t.Fatal(err)
	}
	if installed != 1 {
		t.Fatal("explicit install was not invoked")
	}
	v.state = "working"
	view.Frame()
	view.Key(0, ui.KeyEscape)
	view.Frame()
	if closed != 1 {
		t.Fatal("Escape closed an in-flight transaction")
	}
	if dir := os.Getenv("ENHANCEMENT_UI_EVIDENCE"); dir != "" {
		b, _ := json.Marshal(map[string]any{"ok": true, "lightAndDark": true, "defaultInstall": false, "escapeCancels": true, "explicitInstall": true, "workingEscapeBlocked": true})
		if err := os.WriteFile(filepath.Join(dir, "manager-ui-result.json"), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
