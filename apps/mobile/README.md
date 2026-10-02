# CarouselBot mobile

Expo SDK 57 / React Native 0.86 / Expo Router, matching IQMog's Expo generation.
Native screens and touch controls surround the existing CarouselBot canvas
renderer in a local, offline WebView. The app never embeds the hosted website.

```sh
npm install
cp apps/mobile/.env.example apps/mobile/.env
npm run mobile:start
```

Use an Expo development build, not Expo Go, for Clerk's native AuthView and
RevenueCat. From `apps/mobile`, run `npx expo run:ios` or
`npx eas-cli build --profile development --platform android`.
Without account configuration, **Try the editor** provides a functional local
demo. Agent calls, cloud projects and purchases require real service settings.

## Accounts and billing

Use the **same Clerk instance** as the selected backend. Clerk's native AuthView
provides email verification codes and enabled Google/Apple connections. Its
tokens stay in Expo SecureStore. Native session tokens require the signed
`aud` claim `carouselbot-mobile`, configured in Clerk's session customization;
the Worker must set `CLERK_MOBILE_AUDIENCE` to the same value. Web requests retain
their existing authorized-origin checks. This is a normal Clerk session token,
including `sid`; do not substitute a JWT template that omits the session ID.

RevenueCat uses that exact Clerk user ID as its App User ID. App Store/Play
purchases, restoration and the hosted paywall use the native SDK. The backend
subscriber API and authenticated webhook grant access and the existing shared
credit allowance. A client purchase result alone never grants credits. A Polar
subscriber can use the app without buying again, and an app subscriber can use
the web agent. Management opens the original store or Polar billing portal.

The hosted paywall is configured in RevenueCat, outside this repository. No
production product, price, offering or published paywall is silently substituted
when configuration is missing. See [launch setup](../../docs/MOBILE_APP.md).

## Editor

- Central live slide with drag, resize, rotate and pinch zoom; double-tap text
  to edit. The bottom prompt follows the keyboard, dismisses on send and displays
  one progress row with Stop. Jobs continue on Cloudflare while the app sleeps.
- Text, boxes, outlines, alignment, colors, sizes, fonts and imported fonts;
  images, videos, cropping, positioning, layer ordering, duplication and deletion.
- Slide creation, duplication, ordering, deletion, project names and folders.
- Serialized autosave with server revision checks, account-scoped recovery
  drafts, conflict recovery as a copy, manual undo/redo and durable agent Undo.
- Full-resolution PNG export to native sharing or Photos; sequential whole
  carousel export. Video frame editing and the existing MP4 renderer are included.
  Device video codec/audio compatibility still needs physical-device validation.
- Secure cloud media hydrates only the active slide; thumbnails and the private
  media cache are bounded, and temporary export files are removed after sharing.

## Builds and tests

The EAS project is [@alexgusevski/carouselbot](https://expo.dev/accounts/alexgusevski/projects/carouselbot),
ID `7b7652ae-4c24-47fd-9cb9-6f1dac8c243c`. Both bundle/package IDs are
`com.beundra.carouselbot`. Neither IQMog's app identifiers nor billing catalog
are reused. EAS profiles cover development, simulator, internal APK and store
production builds. Generated native projects are ignored; EAS prebuilds them.
The post-install hook bundles the local slide runtime before Metro builds.
Production builds require explicit backend, live Clerk and public RevenueCat
keys, preventing accidental publication of the demo or development accounts.

```sh
npm run mobile:stage
npm run mobile:typecheck
npm run test:mobile
npm run export --workspace @carouselbot/mobile
npm run test:mobile:browser
npm run test:product
```

The mobile browser check owns a separate disposable Chrome profile and loopback
server and closes both in `finally`. It verifies gestures, inspector editing,
undo/redo, bottom composer placement and full-resolution PNG dimensions. Native
auth, store purchase/restore and photo/video exports require device checks.
