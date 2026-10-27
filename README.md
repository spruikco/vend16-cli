# vend16

Put a buy button in your app. We get the rest sorted.

`vend16` adds verified in-app purchases to an iOS or Android app in one command. It works out what kind of app you have, signs you in to [Vend16](https://vend16.com), finds or creates your app there, puts your public key where your app expects it, installs the store client, and lists what is left to click in App Store Connect and Play Console.

```bash
npx github:spruikco/vend16-cli init
```

(Once it is on npm this becomes `npx vend16 init`.)

Works with Capacitor 8, React Native, Expo, Flutter, and native Swift and Kotlin apps. Needs Node 20 or later.

## What `init` does

1. **Finds your app.** Reads `capacitor.config`, `package.json`, `app.json`, `pubspec.yaml`, your `.xcodeproj` and `app/build.gradle` for the iOS bundle ID and Android application ID.
2. **Signs you in.** Shows a short code and opens https://vend16.com/activate. You approve it in the browser; no passwords in the terminal. No account yet? You can make one on that page. Free covers your first 100 live purchases.
3. **Finds or creates your Vend16 app** with the same bundle ID and package name.
4. **Adds the public key** (`pk_...`, safe to ship in the app) in the usual place:

   | App | Where | Read it with |
   | --- | --- | --- |
   | Capacitor + Vite | `.env`, `VITE_VEND16_PUBLIC_KEY` | `import.meta.env.VITE_VEND16_PUBLIC_KEY` |
   | Capacitor + Next.js | `.env`, `NEXT_PUBLIC_VEND16_PUBLIC_KEY` | `process.env.NEXT_PUBLIC_VEND16_PUBLIC_KEY` |
   | Capacitor, other | `src/vend16.config.js` | `import { VEND16_PUBLIC_KEY } from './vend16.config.js'` |
   | Expo | `app.json`, `expo.extra.vend16PublicKey` | `Constants.expoConfig.extra.vend16PublicKey` |
   | React Native | `vend16.config.js` | `import { VEND16_PUBLIC_KEY } from './vend16.config.js'` |
   | Flutter | `lib/vend16_config.dart` | `vend16PublicKey` |
   | Native Android | `res/values/vend16.xml` | `getString(R.string.vend16_public_key)` |
   | Native iOS | `Info.plist`, `Vend16PublicKey` | `Bundle.main.object(forInfoDictionaryKey: "Vend16PublicKey")` |

5. **Secret key, only if you have a server.** Give it your server's env file and it writes `VEND16_SECRET_KEY` there. It refuses a file git tracks or does not ignore, and it never prints the key.
6. **Installs the store client.** Capacitor: `github:spruikco/capacitor-iap` and `npx cap sync`. React Native and Expo: `react-native-iap`. Flutter: `in_app_purchase` and `http`. Native: StoreKit 2 is built in; Android gets a one-line Gradle note.
7. **Prints your setup checklist**: products, the App Store notifications URL, the Google Play service account and notifications, each ticked off once Vend16 sees it working.

Then wire purchases into your code with the guide for your stack (`init` prints the link), or let your coding agent do it.

## Commands

| Command | What it does |
| --- | --- |
| `vend16 init` | Everything above |
| `vend16 login` / `vend16 logout` | Sign in through the browser, or forget this computer |
| `vend16 status` | Who you are, this app, and its setup checklist |
| `vend16 keys` | This app's public key. `--server-env FILE --yes` makes a new secret key and writes it to FILE |
| `vend16 doctor` | Checks the key, the client, the native wiring, that no secret key is in git, and the store setup |

## For coding agents

Every command runs without questions and returns one JSON object:

```bash
npx github:spruikco/vend16-cli init --yes --json
```

- `--yes` takes the safe default for every question: create the app if there is none, install the client, and skip the secret key unless `--server-env` is given.
- `--json` prints one JSON object on stdout. Progress, and the sign-in code the person has to approve, go to stderr: show the stderr text to the person.
- `--app app_...` picks the Vend16 app when more than one matches (exit 4 lists the candidates).
- `--skip-install` leaves package installs to you; the JSON's `manual` list says what to run.
- `VEND16_TOKEN=at_...` uses an agent token instead of the browser sign-in.

Exit codes: `0` done, `1` error or problems found, `2` bad usage, `3` not signed in, `4` no app found or no matching Vend16 app, `5` Vend16 could not be reached.

The JSON from `init` has `app`, `public_key.read_with` (how the code should read the key), `install`, `setup` (the checklist), `manual` (what still needs a person) and `next` (the wiring guide for this stack). See [AGENTS.md](AGENTS.md).

## Privacy

The sign-in token is stored in your user config folder (`%APPDATA%\vend16` on Windows, `~/.config/vend16` elsewhere), readable only by you. `vend16 logout` deletes it. The CLI sends nothing but the requests listed in `src/api.js`.

## Help

Docs: https://vend16.com/docs. Email: hello@spruik.co. MIT licensed.
