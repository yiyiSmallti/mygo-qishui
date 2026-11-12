// Plugin-owned installer. Opening it never authorizes changing the player.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const previousOfficialHash = "9e49bc806c3cff513c628fe40e94285c5388634e44bb333a4c21dc0dff555482"
const officialHash = "9c27f0e54214de217624099a18945d07718e90fa48a3396e9c47505a8db67eb1"
const previousVerifiedHash = "60208d6d3e647e8f8e8c1e1157657402032e9ce09553e0319a0a40823809284a"
const previousLayoutHash = "39f1383d6858cfaeeb305b722ed8529d364463495468b9c87d7cf209aef6ce28"
const previousSettingsHash = "6c916f49427988b5e5c368081f358c1914ea59692a588ea9bea5738c5a973096"

func supportedHash(hash string) bool {
	return hash == officialHash || hash == previousOfficialHash || hash == previousVerifiedHash || hash == previousLayoutHash || hash == previousSettingsHash
}

type manifest struct {
	Schema      int      `json:"schema"`
	BaseVersion string   `json:"baseVersion"`
	PayloadHash string   `json:"payloadSha256"`
	SourceHash  string   `json:"sourceSha256"`
	Components  []string `json:"components"`
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func loadManifest(root string) (manifest, error) {
	var m manifest
	b, err := os.ReadFile(filepath.Join(root, "layout-manifest.json"))
	if err != nil || len(b) > 8192 {
		return m, errors.New("payload")
	}
	if json.Unmarshal(b, &m) != nil || m.Schema != 2 || m.BaseVersion != "0.1.24" {
		return m, errors.New("payload")
	}
	expected := []string{"listening-layout", "settings-entry", "taskbar-player"}
	if len(m.Components) != len(expected) {
		return m, errors.New("payload")
	}
	for i, name := range expected {
		if m.Components[i] != name {
			return m, errors.New("payload")
		}
	}
	for _, item := range []struct{ name, hash string }{{"layout-player.exe", m.PayloadHash}, {"layout-corresponding-source.zip", m.SourceHash}} {
		if len(item.hash) != 64 || strings.Trim(item.hash, "0123456789abcdef") != "" {
			return m, errors.New("payload")
		}
		actual, err := hashFile(filepath.Join(root, item.name))
		if err != nil || actual != item.hash {
			return m, errors.New("payload")
		}
	}
	return m, nil
}

func main() {
	flags := flag.NewFlagSet("style-installer", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	parent := flags.Uint("parent", 0, "")
	if flags.Parse(os.Args[1:]) != nil || *parent == 0 || *parent > 0xffffffff {
		return
	}
	ack := func(code string) error {
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": code == "ready" || code == "busy", "code": code}); err != nil {
			return err
		}
		if code != "ready" {
			return nil
		}
		// The launcher must release ownership before any user can confirm.
		released := make(chan bool, 1)
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			scanner.Buffer(make([]byte, 128), 1024)
			released <- scanner.Scan() && scanner.Text() == "continue"
		}()
		select {
		case ok := <-released:
			if !ok {
				return errors.New("launcher")
			}
		case <-time.After(14 * time.Second):
			return errors.New("launcher")
		}
		os.Stdin.Close()
		os.Stdout.Close()
		return nil
	}

	if err := run(uint32(*parent), ack); err != nil {
		_ = ack("setup")
	}
}
