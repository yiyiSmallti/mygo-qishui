// Independent plugin-owned native login window. Assisted-by: Cindy (https://cindy.app)
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

const origin = "https://api.qishui.com"

// The API root returns HTTP 404. WebView2 treats that navigation as failed,
// so serve a local document at the same origin instead of requesting it.
const bootstrapHTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"mygo-qishui-bootstrap\" content=\"1\"></head><body></body></html>"

type device struct {
	Schema                  int
	Aid                     int
	Did, Iid, ClientVersion string
}
type startRequest struct {
	Type                  string
	Device                device
	ComputerName, OsLabel string
	TimeoutMs             int
}
type signInOptions struct {
	CookiesOf, ScriptOrigin, PreloadScript string
	Until, UntilAny                        []string
}
type signInError struct{ Code, Message string }

func (e *signInError) Error() string     { return e.Message }
func problem(code, message string) error { return &signInError{code, message} }

// Production has no QA controls; tagged verification builds install these hooks.
var beforePage func(string) string
var observePage func(*mygo.Window)
var afterOutcome func(error)

func main() {
	log.SetOutput(os.Stderr)
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 4096), 262144)
	initial := make(chan []byte, 1)
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		if input.Scan() {
			initial <- append([]byte(nil), input.Bytes()...)
		}
		for input.Scan() {
		}
	}()
	var req startRequest
	select {
	case raw := <-initial:
		if json.Unmarshal(raw, &req) != nil {
			emitError(problem("setup", "登录组件收到无效请求，请重新安装插件。"))
			return
		}
	case <-closed:
		return
	case <-time.After(30 * time.Second):
		return
	}
	id := regexp.MustCompile("^[1-9][0-9]{8,24}$")
	if req.Type != "start" || req.Device.Schema != 1 || req.Device.Aid != 386088 || !id.MatchString(req.Device.Did) || !id.MatchString(req.Device.Iid) || req.Device.ClientVersion == "" || len(req.Device.ClientVersion) > 32 || req.ComputerName == "" || len([]rune(req.ComputerName)) > 255 || strings.ContainsAny(req.ComputerName, "\r\n\x00") || (req.OsLabel != "Windows" && req.OsLabel != "Mac") {
		emitError(problem("setup", "登录设备信息不完整，请重新登录。"))
		return
	}
	if req.TimeoutMs < 1000 || req.TimeoutMs > 240000 {
		req.TimeoutMs = 240000
	}
	script, err := scripts(req)
	if err != nil {
		emitError(err)
		return
	}
	if beforePage != nil {
		script = beforePage(script)
	}
	mygo.App.SetName("MyGo 汽水登录")
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.WhenReady(func() {
		go func() {
			type outcome struct {
				cookie string
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				cookie, err := login(script, time.Duration(req.TimeoutMs)*time.Millisecond, closed)
				done <- outcome{cookie, err}
			}()
			deadline := time.NewTimer(time.Duration(req.TimeoutMs)*time.Millisecond + time.Second)
			defer deadline.Stop()
			var result outcome
			// Independent of page evaluation and native Cookie callbacks.
			select {
			case result = <-done:
			case <-closed:
				result.err = problem("closed", "登录已取消，请重新登录。")
			case <-deadline.C:
				result.err = problem("timeout", "本次登录已超时，请重新登录。")
			}
			if afterOutcome != nil {
				afterOutcome(result.err)
			}
			if result.err != nil {
				emitError(result.err)
			} else {
				emit(map[string]any{"type": "complete", "cookie": result.cookie})
			}
			for _, window := range mygo.Windows() {
				window.Close()
			}
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		emitError(problem("setup", "无法启动汽水登录窗口，请检查系统网页组件。"))
	}
}

// stdout is exclusively the parent's private JSON-lines channel.
func emit(value any) { json.NewEncoder(os.Stdout).Encode(value) }
func emitError(err error) {
	if e, ok := err.(*signInError); ok {
		emit(map[string]any{"type": "error", "code": e.Code, "message": e.Message})
		return
	}
	emit(map[string]any{"type": "error", "code": "page", "message": "登录组件未能完成，请重新登录。"})
}

func scripts(req startRequest) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", problem("setup", "无法读取登录组件，请重新安装对应平台插件。")
	}
	// Binaries live at <plugin>/native/qishui-login[.exe]. Resolve fixed scripts
	// through OpenRoot so a symlink cannot make them escape the plugin package.
	root, err := os.OpenRoot(filepath.Dir(filepath.Dir(executable)))
	if err != nil {
		return "", problem("setup", "无法读取登录组件，请重新安装对应平台插件。")
	}
	defer root.Close()
	data, _ := json.Marshal(map[string]any{"device": map[string]any{"schema": req.Device.Schema, "aid": req.Device.Aid, "did": req.Device.Did, "iid": req.Device.Iid, "clientVersion": req.Device.ClientVersion}, "computerName": req.ComputerName, "osLabel": req.OsLabel})
	var result strings.Builder
	result.WriteString("if(location.origin==='" + origin + "'){window.__mygoSignInData=" + string(data) + ";\n")
	for _, name := range []string{"browser-info.js", "browser-verification.js", "embedded-login.js"} {
		f, e := root.Open(name)
		if e != nil {
			return "", problem("setup", "插件缺少登录脚本，请重新安装对应平台插件。")
		}
		b, e := io.ReadAll(io.LimitReader(f, 524289))
		f.Close()
		if e != nil || len(b)+result.Len() > 524288 {
			return "", problem("setup", "登录脚本无效，请重新安装插件。")
		}
		result.Write(b)
		result.WriteString("\n;\n")
	}
	result.WriteString("\n}")
	return result.String(), nil
}

func login(script string, timeout time.Duration, cancelled <-chan struct{}) (string, error) {
	var available bool
	mygo.RunOnMain(func() { available = mygo.WebViewAvailable() })
	if !available {
		return "", problem("setup", "系统无法显示登录窗口。Windows 请安装 WebView2 Runtime 后重试。")
	}
	session := mygo.NewEphemeralSession()
	initialURL := origin + "/"
	if runtime.GOOS == "windows" {
		initialURL = ""
	}
	win := mygo.NewWindow(mygo.WindowOptions{Title: "登录汽水音乐", URL: initialURL, Width: 480, Height: 680, MinWidth: 360, MinHeight: 480, Page: mygo.PageOptions{Session: session, PreloadScript: script, Untrusted: true}})
	if runtime.GOOS == "windows" {
		// Stock host.spawn supplies STARTF_USESHOWWINDOW/SW_HIDE. Windows
		// consumes that state on the first ShowWindow call; the next call
		// explicitly displays the plugin login window.
		win.Show()
		win.Show()
	}
	defer embeddedSignInPopups(win, session)()
	defer win.Close()
	closed := make(chan struct{})
	win.OnClosed(func() { close(closed) })
	failed := make(chan struct{}, 1)
	win.Page().OnDidFailLoad(func(_ *mygo.LoadError) {
		select {
		case failed <- struct{}{}:
		default:
		}
	})
	if runtime.GOOS == "windows" {
		win.Page().LoadHTML(bootstrapHTML, origin+"/")
	}
	if observePage != nil {
		go observePage(win)
	}
	options := signInOptions{CookiesOf: origin + "/", ScriptOrigin: origin, UntilAny: []string{"sessionid", "sessionid_ss"}}
	lastQR, applied := "", false
	tick := time.NewTicker(400 * time.Millisecond)
	defer tick.Stop()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case <-cancelled:
			return "", problem("closed", "登录已取消，请重新登录。")
		case <-closed:
			return "", problem("closed", "登录窗口已关闭，登录尚未完成。")
		case <-failed:
			return "", problem("load", "登录页面未能加载，请检查网络后重试。")
		case <-deadline.C:
			return "", problem("timeout", "本次登录已超时，请重新登录。")
		case <-tick.C:
			if err := scriptedSignInState(win, options, session, &lastQR, &applied); err != nil {
				return "", err
			}
			cookies, err := session.Cookies.List(mygo.CookieFilter{URL: origin + "/"})
			if err != nil {
				continue
			}
			if header, ok := signInCookies(cookies, nil, options.UntilAny); ok {
				if len(header) > 65536 {
					return "", problem("page", "登录凭据无效，请重新登录。")
				}
				return header, nil
			}
		}
	}
}

func cookieHeader(cookies []mygo.Cookie, until []string) (string, bool) {
	have := map[string]bool{}
	values := []string{}
	for _, c := range cookies {
		if c.Value != "" && signInCookieName.MatchString(c.Name) && !strings.ContainsAny(c.Value, ";\r\n\x00") {
			have[c.Name] = true
			values = append(values, c.Name+"="+c.Value)
		}
	}
	for _, name := range until {
		if !have[name] {
			return "", false
		}
	}
	return strings.Join(values, "; "), true
}

func T(text string) string {
	translations := map[string]string{
		"The sign-in page returned invalid data":        "登录页面返回的数据无效。",
		"Signing in failed. Try again.":                 "登录未能完成，请重试。",
		"The sign-in page returned an invalid QR code":  "登录页面返回的二维码无效。",
		"The sign-in QR code could not be generated":    "无法生成登录二维码。",
		"The sign-in page returned invalid credentials": "登录页面返回的凭据无效。",
		"The sign-in session could not be saved":        "无法保存本次登录会话。",
		"Sign-in verification":                          "汽水音乐安全验证",
	}
	if value, ok := translations[text]; ok {
		return value
	}
	return fmt.Sprint(text)
}
