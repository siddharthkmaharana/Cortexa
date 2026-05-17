# resources/icons/

App icons for all platforms. Electron Forge reads these during `npm run make`.

## Required files

| File | Size | Platform | Notes |
|---|---|---|---|
| `icon.png` | 1024×1024 px | macOS, Linux | Source for all other sizes |
| `icon.icns` | multi-size | macOS | Contains 16–1024 px variants |
| `icon.ico` | multi-size | Windows | Contains 16–256 px variants |

## Generating from a PNG source

Place a 1024×1024 `icon.png` in this directory then run:

```bash
# macOS — using iconutil (built in)
mkdir icon.iconset
for size in 16 32 64 128 256 512; do
  sips -z $size $size icon.png --out icon.iconset/icon_${size}x${size}.png
  sips -z $((size*2)) $((size*2)) icon.png --out icon.iconset/icon_${size}x${size}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

# Windows .ico — using ImageMagick
magick icon.png -resize 256x256 -define icon:auto-resize="256,128,96,64,48,32,16" icon.ico

# Or use an online converter: https://convertio.co/png-ico/
```

## Design notes

CORTEXA uses a dark aesthetic — the icon should work on both light and dark macOS dock/taskbar backgrounds. Recommended: a teal (`#3ecfb2`) symbol on a near-black (`#080a0f`) rounded-rectangle background.