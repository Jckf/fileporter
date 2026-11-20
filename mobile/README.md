# fileporter for Android and iOS

The apps are the website (`../web`, built by `cmd/build`) bundled in a
[Capacitor](https://capacitorjs.com/) shell. The page detects the app
(`web/platform.js`) and uses native plugins where the web view falls
short:

- **Saving** a received file: `plugins/save-file`, the system's "Save
  as" dialog (Android) or export dialog (iOS). The page sends the file
  over the native bridge in chunks (`web/savefile.js`).
- **Sharing** the link: `@capacitor/share`.
- **Keeping the screen on** during a transfer: `@capacitor-community/keep-awake`.
- **Opening fileporter links** in the app: `@capacitor/app` plus App
  Links / Universal Links (below).

The app loads its bundled copy from `https://fileporter.app/` (Android)
or `capacitor://localhost` (iOS); share links always point at the
public site.

## Building (Android)

Everything runs in Docker (`docker/android.Dockerfile`: Go, Node, JDK
21, Android SDK 36). `run` runs a command in the container as you, with
caches in `~/.cache/fileporter-mobile`:

    mobile/run mobile/build android      # debug APK: android/app/build/outputs/apk/debug/
    mobile/run mobile/build sync         # site → www/ → native projects only
    mobile/run mobile/build assets       # regenerate icons and launch screens from assets/*.svg

Testing on a headless emulator (needs `/dev/kvm`):

    FP_IMAGE=emulator mobile/run mobile/smoke [link]   # screenshot + log in smoke-out/
    cd test && node android.test.js                    # full transfer and save, see the file

## Building (iOS)

Needs macOS with Xcode 26. After `mobile/build sync` (in Docker or with
Go and Node installed locally), open `ios/App/App.xcodeproj`, choose
your team under Signing & Capabilities, and run. Not built or tested
in CI; `plugins/save-file/ios` has only been checked by reading.

## Links that open the app

`android/app/src/main/AndroidManifest.xml` (App Links, `autoVerify`) and
`ios/App/App/App.entitlements` (`applinks:fileporter.app`) claim
`https://fileporter.app/`. Each OS checks the claim against a file on
the site, served from `web/.well-known/` (cmd/build publishes it at the
root). Both need values that exist only once the apps are signed for
release:

`web/.well-known/assetlinks.json`, with the SHA-256 fingerprint of the
release signing certificate (Play Console → App integrity, when Play
signs the app):

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "app.fileporter",
    "sha256_cert_fingerprints": ["AB:CD:…"]
  }
}]
```

`web/.well-known/apple-app-site-association` (no extension), with the
Apple Developer Team ID:

```json
{
  "applinks": {
    "details": [{ "appIDs": ["TEAMID.app.fileporter"], "components": [{ "/": "/" }] }]
  }
}
```

Until then, links open in the browser, and the emulator tests open the
app on a link directly (`am start -a VIEW … app.fileporter`).

## Licenses

`licenses.mjs` appends the native parts (Capacitor and its plugins,
AndroidX, Cordova) to the bundled `THIRD_PARTY_LICENSES.txt`; it runs
as part of `mobile/build sync`.
