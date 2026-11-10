// Packages platform-specific login binaries with the plugin, preserving Unix modes.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"debug/macho"
	"debug/pe"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	root := flag.String("root", "..", "repository root")
	native := flag.String("native", "../dist/login-helper", "native build directory")
	style := flag.String("style", "../dist/style-support/windows-amd64", "Windows layout player and corresponding source")
	out := flag.String("out", "../dist", "output directory")
	flag.Parse()
	if err := run(*root, *native, *style, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(root, native, style, out string) error {
	if err := os.MkdirAll(out, 0755); err != nil {
		return err
	}
	var sums strings.Builder
	for _, platform := range []string{"windows-amd64", "darwin-arm64"} {
		name := "qishui-login"
		if platform == "windows-amd64" {
			name += ".exe"
		}
		binary := filepath.Join(native, platform, name)
		if platform == "windows-amd64" {
			p, e := pe.Open(binary)
			if e != nil {
				return fmt.Errorf("build %s first: %w", platform, e)
			}
			valid := p.Machine == pe.IMAGE_FILE_MACHINE_AMD64
			p.Close()
			if !valid {
				return fmt.Errorf("wrong Windows binary architecture")
			}
		} else {
			p, e := macho.Open(binary)
			if e != nil {
				return fmt.Errorf("build %s first: %w", platform, e)
			}
			valid := p.Cpu == macho.CpuArm64
			p.Close()
			if !valid {
				return fmt.Errorf("wrong Mac binary architecture")
			}
		}
		content, err := os.ReadFile(binary)
		if err != nil {
			return err
		}
		for _, marker := range []string{"MYGO_NATIVE_QA_MODE", "qa-embedded-verification.js", "qa-private-token"} {
			if strings.Contains(string(content), marker) {
				return fmt.Errorf("refusing QA binary in production package")
			}
		}
		var layoutManifest []byte
		if platform == "windows-amd64" {
			player := filepath.Join(style, "MyGo Music.exe")
			p, err := pe.Open(player)
			if err != nil {
				return fmt.Errorf("build the Windows layout player first: %w", err)
			}
			valid := p.Machine == pe.IMAGE_FILE_MACHINE_AMD64
			p.Close()
			if !valid {
				return fmt.Errorf("wrong layout player architecture")
			}
			bytes, err := os.ReadFile(player)
			if err != nil {
				return err
			}

			for _, blocked := range []string{"MYGO_NATIVE_QA_MODE", "MYGO_QA_PLUGIN_DIR"} {
				if strings.Contains(string(bytes), blocked) {
					return fmt.Errorf("refusing QA layout player")
				}
			}
			playerHash := sha256.Sum256(bytes)
			sourcePath := filepath.Join(style, "corresponding-source.zip")
			archive, err := zip.OpenReader(sourcePath)
			if err != nil {
				return err
			}
			present := map[string]bool{}
			for _, f := range archive.File {
				present[f.Name] = true
			}
			archive.Close()
			for _, name := range []string{"mygo-music/LICENSE", "mygo-music/internal/app/ui_listening_modes.go"} {
				if !present[name] {
					return fmt.Errorf("layout source archive lacks %s", name)
				}
			}
			source, err := os.ReadFile(sourcePath)
			if err != nil {
				return err
			}
			sourceHash := sha256.Sum256(source)
			installerPath := filepath.Join(native, platform, "style-installer.exe")
			installer, err := pe.Open(installerPath)
			if err != nil {
				return err
			}
			valid = installer.Machine == pe.IMAGE_FILE_MACHINE_AMD64
			installer.Close()
			if !valid {
				return fmt.Errorf("wrong style installer architecture")
			}
			layoutManifest, _ = json.Marshal(map[string]any{"schema": 1, "baseVersion": "0.1.22", "payloadSha256": hex.EncodeToString(playerHash[:]), "sourceSha256": hex.EncodeToString(sourceHash[:])})
		}
		archive := filepath.Join(out, "plugin-"+platform+".zip")
		file, err := os.Create(archive)
		if err != nil {
			return err
		}
		writer := zip.NewWriter(file)
		add := func(path, name string, mode fs.FileMode) error {
			header := &zip.FileHeader{Name: filepath.ToSlash(name), Method: zip.Deflate, Modified: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)}
			header.SetMode(mode)
			entry, err := writer.CreateHeader(header)
			if err != nil {
				return err
			}
			in, err := os.Open(path)
			if err != nil {
				return err
			}
			defer in.Close()
			_, err = io.Copy(entry, in)
			return err
		}
		pluginRoot := filepath.Join(root, "qishui-account")
		err = filepath.WalkDir(pluginRoot, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(pluginRoot, path)
			if err != nil {
				return err
			}
			if relative == "." {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") || relative == "native" {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type()&fs.ModeSymlink != 0 {
				return fmt.Errorf("symlinks are not allowed in plugins")
			}
			if d.IsDir() {
				return nil
			}
			if !d.Type().IsRegular() {
				return fmt.Errorf("invalid plugin file")
			}
			return add(path, relative, 0644)
		})
		if err == nil {
			err = add(binary, filepath.Join("native", name), 0755)
		}
		if err == nil && platform == "windows-amd64" {
			for _, entry := range []struct{ path, name string }{
				{filepath.Join(native, platform, "style-installer.exe"), "native/style-installer.exe"},
				{filepath.Join(style, "MyGo Music.exe"), "native/layout-player.exe"},
				{filepath.Join(style, "corresponding-source.zip"), "native/layout-corresponding-source.zip"},
			} {
				if err = add(entry.path, entry.name, 0755); err != nil {
					break
				}
			}
			if err == nil {
				var entry io.Writer
				entry, err = writer.Create("native/layout-manifest.json")
				if err == nil {
					_, err = entry.Write(layoutManifest)
				}
			}
		}
		closeErr := writer.Close()
		file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		bytes, err := os.ReadFile(archive)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(bytes)
		fmt.Fprintf(&sums, "%s  %s\n", hex.EncodeToString(digest[:]), filepath.Base(archive))
		fmt.Println(archive)
	}
	return os.WriteFile(filepath.Join(out, "SHA256SUMS"), []byte(sums.String()), 0644)
}
