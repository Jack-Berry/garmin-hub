# Garmin Hub for iPhone

The app is a SwiftUI shell around the exact dashboard served by the droplet. A
custom `hub://dashboard` scheme maps every page, asset, and API request to
`https://hub.berrydev.co.uk` with `X-Api-Key` attached. It also injects
`window.__HUB_API_KEY__` at document start so the shared web API wrapper uses
the same Keychain value.

Normal `http` and `https` links are opened outside the app. They are not sent
through the authenticated scheme and never receive the API key. Only the fixed
Garmin Hub host is proxied.

## Generate and run

Install XcodeGen, then generate the project and icon:

```sh
cd ios
swift scripts/make-app-icon.swift \
  GarminHub/Assets.xcassets/AppIcon.appiconset/AppIcon.png
xcodegen generate
open GarminHub.xcodeproj
```

Select the `GarminHub` scheme and the connected iPhone, confirm automatic
signing uses team `ZZ2RVM493V`, then press Run. On first launch, enter the
production `API_SECRET`. It is stored in the device Keychain. Pull down on the
dashboard to reload it. Settings can replace the key later.

The app checks `/api/health` before loading WebKit. A missing or wrong key and
an unreachable droplet each produce a visible retry screen.

## TestFlight

In Xcode, choose a generic iOS device destination, then use Product > Archive.
In Organizer select the archive, choose Distribute App > App Store Connect >
Upload, and follow the signing prompts. After processing in App Store Connect,
assign the build to the desired TestFlight group.
