// Archives the complete enhanced player's corresponding source with fixed modes.
package main

import (
	"archive/zip"
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
	root := flag.String("root", "", "modified MyGo source directory")
	out := flag.String("out", "", "source ZIP")
	flag.Parse()
	if err := archive(*root, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func archive(root, out string) error {
	if root == "" || out == "" {
		return fmt.Errorf("root and out are required")
	}
	for _, name := range []string{"LICENSE", "go.mod", "internal/app/ui_listening_modes.go", "internal/app/ui_settings.go", "internal/app/ui_main.go", "internal/app/taskbar_windows.go", "internal/app/taskbar_widget_view_windows.go", "internal/app/taskbar_probe_windows.go"} {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			return err
		}
	}
	file, err := os.Create(out)
	if err != nil {
		return err
	}
	defer file.Close()
	w := zip.NewWriter(file)
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" || d.Name() == "dist" || strings.HasPrefix(d.Name(), "build") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("symlinks are not allowed in source archives")
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("unexpected source file")
		}
		header := &zip.FileHeader{Name: "mygo-music/" + filepath.ToSlash(rel), Method: zip.Deflate, Modified: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)}
		header.SetMode(0644)
		entry, err := w.CreateHeader(header)
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
	})
	closeErr := w.Close()
	if err != nil {
		return err
	}
	return closeErr
}
