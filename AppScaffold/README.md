# AppScaffold — container-app overlay

`safari-web-extension-converter` (run by `../make-xcode-project.sh`) generates a
complete Xcode project with four targets:

- **X Video Downloader** (macOS app) — the container app
- **X Video Downloader Extension** (macOS) — the Safari Web Extension
- **X Video Downloader** (iOS app) — the container app
- **X Video Downloader Extension** (iOS) — the Safari Web Extension

The generated project already builds and runs. The files in this folder are a
**branded overlay** — drop them on top of what the converter creates if you want
the container-app window to look like the extension rather than the stock
"This app contains a Safari extension" placeholder.

## What to copy where

This is a **styling-only** overlay. The converter's `Base.lproj/Main.html` and
`Resources/Script.js` are coupled to the native `ViewController`s (they toggle
`platform-mac` / `state-on` classes and call `show(...)`), so those are left
exactly as generated — only the look is overridden.

After running `../make-xcode-project.sh` (output in `../XcodeProject/`):

| This file | Replaces (in the generated project) |
| --- | --- |
| `Resources/Style.css` | `Shared (App)/Resources/Style.css` |
| `Resources/Icon.png` | `Shared (App)/Resources/Icon.png` |
| `SafariWebExtensionHandler.swift` | both `*/SafariWebExtensionHandler.swift` (optional; the generated one already works) |

`../make-xcode-project.sh` applies this overlay automatically after generating
the project. Do **not** hand-edit `project.pbxproj` and do **not** replace
`Main.html` / `Script.js` — the converter already wired the real ones into the
build against the native UI contract.

## Configuration you set in Xcode (not in files)

- **Signing & Capabilities** → select your Team on all four targets.
- **Bundle identifiers** — set once via `BUNDLE_ID=…` when running the converter
  script, or change them per-target in Xcode. Each extension's bundle id must be
  a child of its app's id (Apple requirement), e.g.
  - `com.you.xvideodownloader` (app)
  - `com.you.xvideodownloader.Extension` (extension)
- **App Sandbox** (macOS) — leave the converter's default entitlement
  (`com.apple.security.app-sandbox = YES`) and its outgoing-network client
  entitlement in place; the extension needs network access to fetch media.
- **Deployment targets** — set macOS 13+ and iOS 16+ (see ../README.md for the
  reasoning). macOS 14 / iOS 17 recommended for full `world: "MAIN"` support.
