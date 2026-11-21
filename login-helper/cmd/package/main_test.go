package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMacManifestOmitsWindowsEnhancements(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "qishui-account", "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err := json.Unmarshal(source, &want); err != nil {
		t.Fatal(err)
	}
	for key, page := range map[string]string{
		"navigation":      "appearance",
		"settingsActions": "appearance/open/settings",
	} {
		entries := want[key].([]any)
		kept := make([]any, 0, len(entries))
		for _, entry := range entries {
			if entry.(map[string]any)["page"] != page {
				kept = append(kept, entry)
			}
		}
		if len(kept) != len(entries)-1 {
			t.Fatalf("source manifest %s must contain the Windows page %q once", key, page)
		}
		want[key] = kept
	}

	data, err := macPluginManifest(bytes.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Mac manifest should differ only by the Windows enhancement actions: %s", data)
	}
}
