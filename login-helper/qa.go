//go:build loginqa

package main

import (
	"encoding/json"
	"github.com/egoist/mygo"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

func init() {
	mode := os.Getenv("MYGO_NATIVE_QA_MODE")
	var mu sync.Mutex
	flags := map[string]any{"mode": mode, "realNativeWebView": true, "realAccountLogin": false}
	save := func(key string, value any) { mu.Lock(); flags[key] = value; mu.Unlock() }
	beforePage = func(script string) string {
		modeJSON, _ := json.Marshal(mode)
		observe := `(()=>{const mode=MODE;const original=window.fetch;let firstPoll=true,token,trace,portrait;window.__qaMfa={rendered:false,callback:false,resend:false,sameToken:false,sameTrace:false};
const append=Node.prototype.appendChild;Node.prototype.appendChild=function(node){if(node.tagName==='SCRIPT'&&node.src.startsWith('https://auth.zijieapi.com/qa-embedded-verification.js')){const React=window.ucSecondVerifyReact,ReactDOM=window.ucSecondVerifyReactDom;
window.__qaMfa.reactReady=React?.version==='18.3.1'&&ReactDOM?.version?.startsWith('18.3.1')&&typeof ReactDOM.render==='function'&&typeof ReactDOM.unmountComponentAtNode==='function';
if(window.__qaMfa.reactReady){window.ucWebSecondVerify=options=>{const root=document.createElement('div');document.body.appendChild(root);function Verification(){const [label]=React.useState('Embedded verification QA (not a real account check)');return React.createElement('button',{id:'qa-verify-button',onClick:()=>{window.__qaMfa.callback=true;window.__qaMfa.unmounted=ReactDOM.unmountComponentAtNode(root);root.remove();options.verifyFinishCallback({status:mode!=='mfa-cancel'})}},label)}ReactDOM.render(React.createElement(Verification),root);window.__qaMfa.rendered=!!document.querySelector('#qa-verify-button')}};queueMicrotask(()=>node.onload?.());return node}return append.call(this,node)};
window.fetch=async function(...args){const u=new URL(args[0],location.origin);const r=await original.apply(this,args);if(u.origin!=='https://api.qishui.com')return r;
if(u.pathname==='/passport/web/get_qrcode/'&&['qr-origin','qr-token'].includes(mode)){const x=await r.clone().json();if(x.data){const q=new URL(x.data.qrcode_index_url);if(mode==='qr-origin')q.hostname='example.invalid';else q.searchParams.set('token','qa-mismatched-token');x.data.qrcode_index_url=q.href}return new Response(JSON.stringify(x),{status:200,headers:{'Content-Type':'application/json'}})}
if(u.pathname==='/passport/web/check_qrconnect/'&&mode.startsWith('mfa-')){const h=new Headers(args[1]?.headers);const t=new URLSearchParams(args[1]?.body).get('token');if(firstPoll){firstPoll=false;token=t;trace=h.get('x-tt-passport-trace-id');portrait=h.get('x-tt-passport-verify-portrait');return new Response(JSON.stringify({message:'error',data:{error_code:2046,url:'https://auth.zijieapi.com/qa-embedded-verification.js'}}),{status:200,headers:{'Content-Type':'application/json'}})}if(u.searchParams.get('isResend')==='true'){Object.assign(window.__qaMfa,{resend:true,sameToken:t===token,sameTrace:h.get('x-tt-passport-trace-id')===trace&&h.get('x-tt-passport-verify-portrait')===portrait})}}
return r}})();`
		return strings.Replace(observe, "MODE", string(modeJSON), 1) + script
	}
	observePage = func(win *mygo.Window) {
		for deadline := time.Now().Add(50 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
			if strings.HasPrefix(mode, "mfa-") {
				win.Page().Eval("document.querySelector('#qa-verify-button')?.click()")
			}
			raw, err := win.Page().Eval("JSON.stringify(window.__mygoLoginState||null)")
			if err != nil {
				continue
			}
			text, ok := raw.(string)
			if !ok {
				continue
			}
			var state signInPageState
			if json.Unmarshal([]byte(text), &state) != nil {
				continue
			}
			if strings.HasPrefix(mode, "mfa-") && state.Status == "error" {
				value, _ := win.Page().Eval("JSON.stringify(window.__qaMfa)")
				var mfa map[string]bool
				encoded, _ := value.(string)
				json.Unmarshal([]byte(encoded), &mfa)
				save("mfa", mfa)
				return
			}
			if mode == "mfa-cancel" {
				continue
			}
			if state.QR == "" {
				continue
			}
			address, err := url.Parse(state.QR)
			if err != nil || address.Host != "bff-pc.qishui.com" || address.Query().Get("computer_name") == "" {
				continue
			}
			visible, _ := win.Page().Eval("Boolean(document.querySelector('#login-qr')?.complete&&document.querySelector('#login-qr')?.naturalWidth>0&&document.querySelector('#login-qr')?.src.startsWith('data:image/png;base64,'))")
			if visible != true {
				continue
			}
			if mode == "mfa-success" {
				value, _ := win.Page().Eval("JSON.stringify(window.__qaMfa)")
				encoded, _ := value.(string)
				var mfa map[string]bool
				json.Unmarshal([]byte(encoded), &mfa)
				if !mfa["reactReady"] || !mfa["rendered"] || !mfa["unmounted"] || !mfa["resend"] || !mfa["sameToken"] || !mfa["sameTrace"] || !mfa["callback"] {
					continue
				}
				save("mfa", mfa)
			}
			sameOrigin, _ := win.Page().Eval("location.origin==='https://api.qishui.com'&&location.href==='https://api.qishui.com/'")
			marker, _ := win.Page().Eval("document.querySelector('meta[name=mygo-qishui-bootstrap]')?.content==='1'")
			save("hostDocumentSameOrigin", sameOrigin == true)
			save("localBootstrap", marker == true)
			save("bootstrapMatchesPlatform", sameOrigin == true && (runtime.GOOS != "windows" || marker == true))
			save("realAnonymousQR", true)
			save("deviceNamePresent", true)
			save("qrImageRenderedByHelper", true)
			if mode == "navigation-failure" {
				win.Page().LoadURL("https://example.invalid/")
				return
			}
			if mode == "unsafe-error" {
				win.Page().Eval("window.__mygoLoginState={status:'error',code:'private-ticket-123',message:'https://example.invalid/?token=qa-private-token'}")
				return
			}
			blocked, err := win.Page().Eval("window.mygo.call('QA.NoService').then(()=>false,e=>String(e.message||e).includes('untrusted'))")
			save("remoteGoBridgeBlocked", err == nil && blocked == true)
			win.Page().Eval("window.open('https://auth.zijieapi.com/','qa-verification')")
			popup := false
			for until := time.Now().Add(3 * time.Second); time.Now().Before(until); time.Sleep(50 * time.Millisecond) {
				for _, child := range mygo.Windows() {
					if child.Parent() == win {
						popup = true
						child.Close()
					}
				}
				if popup {
					break
				}
			}
			save("verificationPopupEmbedded", popup)
			win.Page().Eval("document.querySelector('#qr-section').hidden=true;document.querySelector('#login-status').textContent='Plugin native window verified (QR hidden).'")
			if png, err := win.CapturePage(); err == nil {
				os.WriteFile(os.Getenv("MYGO_NATIVE_QA_SCREENSHOT"), png, 0600)
			}
			win.Close()
			return
		}
		save("observationTimedOut", true)
		win.Close()
	}
	afterOutcome = func(err error) {
		mu.Lock()
		defer mu.Unlock()
		expected := "closed"
		if mode == "qr-origin" || mode == "qr-token" {
			expected = "qr"
		}
		if mode == "mfa-cancel" {
			expected = "cancelled"
		}
		if mode == "unsafe-error" {
			expected = "page"
		}
		if mode == "navigation-failure" {
			expected = "load"
		}
		e, known := err.(*signInError)
		ok := known && e.Code == expected
		if mode == "" || mode == "mfa-success" || mode == "bootstrap" {
			ok = ok && flags["qrImageRenderedByHelper"] == true && flags["remoteGoBridgeBlocked"] == true && flags["verificationPopupEmbedded"] == true && flags["bootstrapMatchesPlatform"] == true
		}
		if mode == "unsafe-error" {
			ok = ok && !strings.Contains(e.Message, "qa-private-token") && !strings.Contains(e.Message, "https://")
		}
		flags["ok"] = ok
		if known {
			flags["outcomeCode"] = e.Code
		}
		if !ok && err != nil {
			flags["error"] = err.Error()
		}
		data, _ := json.MarshalIndent(flags, "", "  ")
		os.WriteFile(os.Getenv("MYGO_NATIVE_QA_RESULT"), append(data, '\n'), 0600)
	}
}
