// Prepares small transparent mode glyphs without the host's JPEG thumbnail path.
// Inputs are public design assets only; no account data is included.
package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// The host asks for 96 pixels and converts oversized artwork to JPEG. Keep
// the packaged glyph at this size so that the transparent PNG is decoded as-is.
const modeIconSize = 96

var sceneIconName = regexp.MustCompile(`^scene-[1-9][0-9]*\.webp$`)

func main() {
	if len(os.Args) != 3 {
		panic("usage: build-mode-icons INPUT_DIR OUTPUT_DIR")
	}
	input, output := os.Args[1], os.Args[2]
	must(os.MkdirAll(output, 0755))
	files, err := os.ReadDir(input)
	must(err)
	count := 0
	for _, file := range files {
		if file.IsDir() || !sceneIconName.MatchString(file.Name()) {
			continue
		}
		f, err := os.Open(filepath.Join(input, file.Name()))
		must(err)
		src, _, err := image.Decode(f)
		f.Close()
		must(err)
		bounds := src.Bounds()
		long := max(bounds.Dx(), bounds.Dy())
		if long < 1 {
			panic("invalid icon bounds: " + file.Name())
		}
		w, h := max(1, bounds.Dx()*modeIconSize/long), max(1, bounds.Dy()*modeIconSize/long)
		small := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(small, small.Bounds(), src, bounds, draw.Src, nil)
		name := strings.TrimSuffix(file.Name(), filepath.Ext(file.Name())) + ".png"
		out, err := os.Create(filepath.Join(output, name))
		must(err)
		err = png.Encode(out, small)
		closeErr := out.Close()
		must(err)
		must(closeErr)
		count++
	}
	if count == 0 {
		panic("no scene WebP icons found")
	}
	fmt.Printf("Built %d transparent mode icons (at most %dx%d)\n", count, modeIconSize, modeIconSize)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
