//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel          = syscall.NewLazyDLL("kernel32.dll")
	user32          = syscall.NewLazyDLL("user32.dll")
	advapi          = syscall.NewLazyDLL("advapi32.dll")
	queryImage      = kernel.NewProc("QueryFullProcessImageNameW")
	replaceFile     = kernel.NewProc("ReplaceFileW")
	createMutex     = kernel.NewProc("CreateMutexW")
	createDirectory = kernel.NewProc("CreateDirectoryW")
	convertSDDL     = advapi.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	localFree       = kernel.NewProc("LocalFree")
	messageBox      = user32.NewProc("MessageBoxW")
)

func wide(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

type instance struct {
	handle  syscall.Handle
	path    string
	created uint64
}

func openInstance(pid uint32, terminate bool) (*instance, error) {
	access := uint32(0x1000 | 0x100000) // query limited information, synchronize
	if terminate {
		access |= 1
	}
	h, err := syscall.OpenProcess(access, false, pid)
	if err != nil {
		return nil, err
	}
	var created, exited, kernelTime, userTime syscall.Filetime
	if err = syscall.GetProcessTimes(h, &created, &exited, &kernelTime, &userTime); err != nil {
		syscall.CloseHandle(h)
		return nil, err
	}
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	ok, _, err := queryImage.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		syscall.CloseHandle(h)
		return nil, err
	}
	return &instance{h, syscall.UTF16ToString(buf[:size]), uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)}, nil
}

func (p *instance) alive() bool {
	status, err := syscall.WaitForSingleObject(p.handle, 0)
	return err == nil && status == 258
}
func (p *instance) close() { syscall.CloseHandle(p.handle) }
func (p *instance) same(other *instance) bool {
	return p.created == other.created && strings.EqualFold(p.path, other.path) && p.alive()
}

func plainPath(path string) error {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		attributes, err := syscall.GetFileAttributes(wide(p))
		if err != nil || attributes&0x400 != 0 {
			return errors.New("linked path")
		}
		if filepath.Dir(p) == p {
			return nil
		}
	}
}

func dialog(text string, confirm bool) bool {
	flags := uintptr(0x40) // informational, OK
	if confirm {
		flags = 0x03 | 0x30 | 0x200
	} // Yes/No/Cancel, default Cancel
	result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(wide(text))), uintptr(unsafe.Pointer(wide("汽水音乐 · 小图标样式增强"))), flags)
	return result == 6
}

func run(pid uint32, ack func(string) error) error {
	parent, err := openInstance(pid, false)
	if err != nil {
		return err
	}
	defer parent.close()
	if !strings.EqualFold(filepath.Base(parent.path), "MyGo Music.exe") || plainPath(parent.path) != nil {
		return errors.New("parent")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	m, err := loadManifest(root)
	if err != nil {
		return err
	}
	hash, err := hashFile(parent.path)
	if err != nil {
		return err
	}
	key := sha256.Sum256([]byte(strings.ToLower(parent.path)))
	handle, _, last := createMutex.Call(0, 0, uintptr(unsafe.Pointer(wide("Local\\MyGoQishuiLayout-"+hex.EncodeToString(key[:12])))))
	if handle == 0 {
		return errors.New("mutex")
	}
	defer syscall.CloseHandle(syscall.Handle(handle))
	if last == syscall.ERROR_ALREADY_EXISTS {
		return ack("busy")
	}
	var decision atomic.Int32
	go func() {
		deadline := time.NewTimer(5 * time.Minute)
		defer deadline.Stop()
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-deadline.C:
				if decision.CompareAndSwap(0, 2) {
					os.Exit(0)
				}
				return
			case <-tick.C:
				if decision.Load() != 0 {
					return
				}
				if !parent.alive() && decision.CompareAndSwap(0, 2) {
					os.Exit(0)
				}
			}
		}
	}()
	if err := ack("ready"); err != nil {
		return err
	}
	if hash == m.PayloadHash || hash == pilotHash {
		dialog("当前 MyGo 已支持小图标听歌模式，无需重复安装。\n\n以后可直接更新汽水插件。MyGo 官方更新可能覆盖这项增强。", false)
		return nil
	}
	if hash != stockHash {
		dialog("当前 MyGo 程序不属于已验证的 0.1.22 构建，暂不能安装此增强。\n\n没有修改程序或账号数据。", false)
		return nil
	}
	if !dialog("将为 MyGo Music 0.1.22 安装小图标听歌模式。\n\n安装会备份当前程序和已保存的数据，关闭并重启 MyGo，只更新主程序文件。\n请先保存正在修改的设置并暂停播放。\n\n是否安装并重启？", true) {
		return nil
	}
	if !decision.CompareAndSwap(0, 1) {
		return nil
	}
	result := install(pid, parent, root, m)
	time.AfterFunc(2*time.Minute, func() { os.Exit(0) })
	if result.OK {
		dialog("安装完成，MyGo 已从原路径重启。\n账号与插件数据已保留，原程序已备份。", false)
	} else {
		text := "安装未完成（" + result.Stage + "），请检查后重试。"
		if result.RolledBack {
			text += "\n已恢复并重启原程序。"
		}
		if result.Backup != "" {
			text += "\n备份位置：" + filepath.Dir(result.Backup)
		}
		dialog(text, false)
	}
	return nil
}

type receipt struct {
	OK                 bool   `json:"ok"`
	Stage              string `json:"stage"`
	Target             string `json:"targetExe"`
	Hash               string `json:"installedSha256,omitempty"`
	Backup             string `json:"backupExe,omitempty"`
	PID                int    `json:"newProcessId,omitempty"`
	DataPreserved      bool   `json:"existingFilesUnchangedBeforeRestart"`
	RolledBack         bool   `json:"rolledBack"`
	FileRestored       bool   `json:"originalFileRestored"`
	TerminationPending bool   `json:"terminationPending"`
}

func privateDirectory(path string) error {
	current, err := user.Current()
	if err != nil {
		return err
	}
	var descriptor uintptr
	ok, _, err := convertSDDL.Call(uintptr(unsafe.Pointer(wide("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;"+current.Uid+")"))), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return err
	}
	defer localFree.Call(descriptor)
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	ok, _, err = createDirectory.Call(uintptr(unsafe.Pointer(wide(path))), uintptr(unsafe.Pointer(&attributes)))
	if ok == 0 {
		return err
	}
	return nil
}

func copyFile(source, dest string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func snapshotFiles(dataRoot, target string) (map[string]string, error) {
	files := make(map[string]string)
	for _, dir := range []string{dataRoot, filepath.Join(dataRoot, "plugin-data", "qishui-account")} {
		entries, err := os.ReadDir(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
				path := filepath.Join(dir, entry.Name())
				hash, err := hashFile(path)
				if err != nil {
					return nil, err
				}
				files[path] = hash
			}
		}
	}
	entries, err := os.ReadDir(filepath.Dir(target))
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		path := filepath.Join(filepath.Dir(target), entry.Name())
		if !entry.IsDir() && !strings.EqualFold(path, target) {
			hash, err := hashFile(path)
			if err != nil {
				return nil, err
			}
			files[path] = hash
		}
	}
	return files, nil
}

func unchanged(files map[string]string) bool {
	for path, expected := range files {
		actual, err := hashFile(path)
		if err != nil || actual != expected {
			return false
		}
	}
	return true
}
func replace(target, source, backup string) error {
	var saved uintptr
	if backup != "" {
		saved = uintptr(unsafe.Pointer(wide(backup)))
	}
	ok, _, err := replaceFile.Call(uintptr(unsafe.Pointer(wide(target))), uintptr(unsafe.Pointer(wide(source))), saved, 0, 0, 0)
	if ok == 0 {
		return err
	}
	return nil
}

func install(pid uint32, initial *instance, root string, m manifest) (result receipt) {
	result = receipt{Target: initial.path, Stage: "检查程序"}
	config, err := os.UserConfigDir()
	if err != nil {
		return result
	}
	dataRoot := filepath.Join(config, "MyGo Music")
	if plainPath(dataRoot) != nil {
		return result
	}
	defer func() {
		state := filepath.Join(dataRoot, "style-support")
		if os.MkdirAll(state, 0700) == nil {
			data, _ := json.MarshalIndent(result, "", "  ")
			tmp := filepath.Join(state, fmt.Sprintf("result-%d.tmp", os.Getpid()))
			if os.WriteFile(tmp, append(data, '\n'), 0600) == nil {
				os.Rename(tmp, filepath.Join(state, "last-result.json"))
			}
		}
	}()
	process, err := openInstance(pid, true)
	if err != nil {
		return result
	}
	defer process.close()
	if !initial.same(process) {
		return result
	}
	actual, err := hashFile(initial.path)
	if err != nil || actual != stockHash {
		return result
	}
	files, err := snapshotFiles(dataRoot, initial.path)
	if err != nil {
		return result
	}
	time.Sleep(2 * time.Second)
	if !unchanged(files) {
		result.Stage = "请暂停播放并保存设置"
		return result
	}
	result.Stage = "备份数据"
	backupParent := filepath.Join(dataRoot, "player-backups")
	if os.MkdirAll(backupParent, 0700) != nil {
		return result
	}
	private := filepath.Join(backupParent, "layout-"+time.Now().UTC().Format("20060102T150405.000000000Z"))
	if privateDirectory(private) != nil {
		return result
	}
	result.Backup = filepath.Join(private, "MyGo Music.exe")
	if copyFile(initial.path, result.Backup) != nil {
		return result
	}
	for path := range files {
		if rel, err := filepath.Rel(dataRoot, path); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			dest := filepath.Join(private, "data", rel)
			if os.MkdirAll(filepath.Dir(dest), 0700) != nil || copyFile(path, dest) != nil {
				return result
			}
			hash, err := hashFile(dest)
			if err != nil || hash != files[path] {
				return result
			}
		}
	}
	if hash, err := hashFile(result.Backup); err != nil || hash != stockHash {
		return result
	}
	sourceSnapshot := filepath.Join(private, "corresponding-source.zip")
	if copyFile(filepath.Join(root, "layout-corresponding-source.zip"), sourceSnapshot) != nil {
		return result
	}
	if hash, err := hashFile(sourceSnapshot); err != nil || hash != m.SourceHash {
		return result
	}
	stage := filepath.Join(filepath.Dir(initial.path), fmt.Sprintf("mygo-layout-%d.new", os.Getpid()))
	defer os.Remove(stage)
	result.Stage = "准备更新文件"
	if copyFile(filepath.Join(root, "layout-player.exe"), stage) != nil {
		return result
	}
	if hash, err := hashFile(stage); err != nil || hash != m.PayloadHash {
		return result
	}
	if !initial.same(process) || !unchanged(files) {
		return result
	}
	if hash, err := hashFile(initial.path); err != nil || hash != stockHash {
		return result
	}
	replaced := false
	terminationRequested := false
	var started *exec.Cmd
	var stopped <-chan error
	defer func() {
		if result.OK {
			return
		}
		if !replaced && process.alive() {
			if !terminationRequested {
				return
			}
			status, err := syscall.WaitForSingleObject(process.handle, 30000)
			if err != nil || status != 0 {
				result.TerminationPending = true
				result.Stage = "MyGo 仍在退出，尚未更新程序"
				return
			}
		}
		if started != nil && started.Process != nil {
			started.Process.Kill()
			if stopped != nil {
				select {
				case <-stopped:
				case <-time.After(10 * time.Second):
					return
				}
			}
		}
		if replaced {
			current, err := hashFile(initial.path)
			if err != nil || current != m.PayloadHash {
				return
			}
			rollback := filepath.Join(filepath.Dir(initial.path), fmt.Sprintf("mygo-rollback-%d.new", os.Getpid()))
			defer os.Remove(rollback)
			if copyFile(result.Backup, rollback) != nil {
				return
			}
			if replace(initial.path, rollback, "") != nil {
				return
			}
		}
		if hash, err := hashFile(initial.path); err != nil || hash != stockHash {
			return
		}
		result.FileRestored = true
		original := exec.Command(initial.path)
		original.Dir = filepath.Dir(initial.path)
		if original.Start() != nil {
			return
		}
		live, err := openInstance(uint32(original.Process.Pid), false)
		if err != nil {
			original.Process.Kill()
			original.Wait()
			return
		}
		defer live.close()
		done := make(chan error, 1)
		go func() { defer close(done); done <- original.Wait() }()
		select {
		case <-done:
			return
		case <-time.After(3 * time.Second):
		}
		if live.alive() && strings.EqualFold(live.path, initial.path) {
			result.RolledBack = true
		}
	}()
	result.Stage = "关闭 MyGo"
	if syscall.TerminateProcess(process.handle, 0) != nil {
		return result
	}
	terminationRequested = true
	if status, err := syscall.WaitForSingleObject(process.handle, 10000); err != nil || status != 0 {
		return result
	}
	result.Stage = "更新程序"
	if replace(initial.path, stage, "") != nil {
		return result
	}
	replaced = true
	if hash, err := hashFile(initial.path); err != nil || hash != m.PayloadHash || !unchanged(files) {
		return result
	}
	result.DataPreserved = true
	result.Stage = "重新启动 MyGo"
	started = exec.Command(initial.path)
	started.Dir = filepath.Dir(initial.path)
	if started.Start() != nil {
		return result
	}
	done := make(chan error, 1)
	stopped = done
	go func() { defer close(done); done <- started.Wait() }()
	child, err := openInstance(uint32(started.Process.Pid), false)
	if err != nil {
		return result
	}
	defer child.close()
	select {
	case <-done:
		return result
	case <-time.After(3 * time.Second):
	}
	if !child.alive() || !strings.EqualFold(child.path, initial.path) {
		return result
	}
	result.OK = true
	result.Stage = "完成"
	result.Hash = m.PayloadHash
	result.PID = started.Process.Pid
	return result
}
