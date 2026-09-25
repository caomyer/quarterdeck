# Releasing and updating Quarterdeck

Every change that lands on `main` is released, and a running app updates itself from that release.
This page says how, and what the captain sets up once.

## How an update travels

1. A push to `main` runs `.github/workflows/release.yml`.
   It stamps the version `0.1.<run number>`, builds the app, signs it, and publishes a GitHub Release holding the updater's archive, its signature, and `latest.json`.
2. The app reads `https://github.com/caomyer/quarterdeck/releases/latest/download/latest.json` 20 seconds after launch and every 4 hours after that (`src-tauri/src/update.rs`).
   It downloads a newer version on its own and checks its signature against the public key in `src-tauri/tauri.conf.json` before it keeps it.
   Without an update waiting, the sidebar says when it last looked, and Check now looks at once: the same check, signature and all, joined rather than repeated if one is running, and the 4-hour schedule stays as it was.
3. The sidebar says "Update ready", with what changed behind "What's new".
   Restart installs it once the first mate's current turn has ended; quitting installs it too.
   After the restart the sidebar says once what the update brought.

An update replaces the app and the engine inside it, and nothing else.
The home, its `state/`, `data/`, `config/` (crew routing included) and `.env`, and the app's own settings all live outside the app and are untouched.
On the next launch `bin/fm-home-init.sh` points the home at the new engine and the app rebinds the home's watches, as it does on every launch.
Crewmates running in tmux keep running through the restart; the relaunched first mate picks up what they reported meanwhile.

`app.yml`'s Bundle job runs the same build on every branch with a throwaway identity and key, and publishes nothing, so a change that would break a release is red before it lands.

## Why signing matters: macOS permissions

macOS remembers a permission (Screen Recording, Accessibility, Documents and so on) against the app's *designated requirement*, which `codesign -d -r- <app>` prints.
A build nobody signed has a requirement naming that one build's hash, so every new build is a stranger and every permission is asked for again.
A build signed with a certificate has a requirement naming the app's identifier and that certificate, the same for every build signed with it, so a permission granted once survives every update.
So `release.yml` never publishes a release without the certificate.

## What only the captain can do

### 1. Create the signing certificate (once, about five minutes)

Until this is done, a merge to `main` produces a failed Release job and no release, deliberately.
A release without the certificate would reset every permission macOS granted the app when it installed.

1. Open Keychain Access from Spotlight (press Command-Space and type Keychain Access), or run `open "/System/Library/CoreServices/Applications/Keychain Access.app"`.
   On macOS 26 it is no longer in the Utilities folder, and an old Dock or Launchpad alias to it opens as "damaged".
   Then choose Keychain Access > Certificate Assistant > Create a Certificate.
2. Name it `Quarterdeck Self-Signed`.
   Identity Type: Self-Signed Root.
   Certificate Type: Code Signing.
   Tick "Let me override defaults", then Continue.
3. Set Validity Period (days) to `7300`, and Continue through every later screen, keeping its defaults, until it is created in the login keychain.
   The long validity matters: a renewed certificate is a different certificate, and every permission would be asked for once more.
4. In the login keychain, open the certificate, expand Trust, and set Code Signing to Always Trust.
   macOS asks for your password.
   Without this, `codesign` refuses the certificate outright.
5. Check it: `security find-identity -v -p codesigning` lists `"Quarterdeck Self-Signed"` as a valid identity.
6. Give it to CI.
   In Keychain Access, select the certificate, choose File > Export Items, save it as `Quarterdeck.p12` and give it a strong password.
   Then run the commands below, which read the file and the password without echoing them anywhere; paste the password when the second one asks for it.

   ```sh
   base64 -i Quarterdeck.p12 | gh secret set QUARTERDECK_SIGNING_P12 --repo caomyer/quarterdeck
   gh secret set QUARTERDECK_SIGNING_P12_PASSWORD --repo caomyer/quarterdeck
   rm Quarterdeck.p12
   ```

#### Or, from the command line

The same identity, without Certificate Assistant, and without a way to skip the trust step.
Run it in an empty folder, then continue at "Give it to CI" above with the `Quarterdeck.p12` it leaves.

```sh
cat > cert.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Quarterdeck Self-Signed
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config cert.cnf -keyout key.pem -out cert.pem
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "Quarterdeck Self-Signed" -out Quarterdeck.p12
security import Quarterdeck.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain cert.pem
security find-identity -v -p codesigning
rm key.pem cert.cnf
```

- The first `openssl` line makes a code-signing certificate valid for 7300 days, and the second packs it with its key into `Quarterdeck.p12`, asking for the password to protect it.
- `security import` puts the identity in your login keychain, asking for that password again.
- `sudo security add-trusted-cert` trusts it for code signing, asking for your Mac password; it is the Always Trust step.
- The last check must list `"Quarterdeck Self-Signed"` as a valid identity.
- `/usr/bin/openssl` is macOS's own LibreSSL, named on purpose: a Homebrew OpenSSL 3 writes a `.p12` that macOS may refuse to import.

How far this is verified: making the certificate, packing the `.p12` and importing it were run on macOS 26.5.1 into a throwaway keychain, never a login keychain, which then listed the identity as not yet trusted.
The trust command and signing with the identity it trusts are the same commands `scripts/release-signing.sh` runs in CI, where a hosted Mac signed the app with them.

The certificate stays in your login keychain.
To sign a build you make yourself with the same identity, so its permissions also carry over: `APPLE_SIGNING_IDENTITY="Quarterdeck Self-Signed" pnpm tauri build`.

### 2. Back up the updater's private key (once, now)

This is the one file here that cannot be replaced.
Every installed app trusts only updates signed by it.
If it is lost, no installed app can take another update, and each has to be reinstalled by hand with a new key.

- It is at `~/.tauri/quarterdeck-updater.key` on this Mac, readable only by you.
- It is also the repository secret `TAURI_SIGNING_PRIVATE_KEY`, but GitHub never gives a secret back, so that copy is not a backup.
- Keep a copy in your password manager, as a file attachment or a secure note holding its contents.
- Never commit it, paste it into a chat, a pull request or an issue, or email it.
- Once it is in your password manager, deleting the copy on this Mac is safe.

The public half is in `src-tauri/tauri.conf.json`, and is meant to be public.

### 3. Enrol in the Apple Developer Program (later)

The self-signed certificate keeps permissions on this Mac.
A Developer ID certificate, which needs the Apple Developer Program ($99 a year), also lets the app open on another Mac without a Gatekeeper warning, and is required for notarization.
When it arrives: replace `QUARTERDECK_SIGNING_P12` and its password with the Developer ID certificate, turn on `bundle.macOS.hardenedRuntime` in `src-tauri/tauri.conf.json`, and add the notarization credentials to `release.yml`.
Moving to a new certificate changes the designated requirement once, so macOS asks for each permission one last time.

## Installing the first release by hand

The app installed today was built and copied by hand and cannot update itself.
Install the first release once, and every later one arrives on its own.
Quit the app first, then:

```sh
rm -rf /tmp/quarterdeck-release && mkdir /tmp/quarterdeck-release
gh release download --repo caomyer/quarterdeck --pattern '*.app.tar.gz' --dir /tmp/quarterdeck-release
tar -xzf /tmp/quarterdeck-release/*.app.tar.gz -C /tmp/quarterdeck-release
rm -rf "/Applications/firstmate desktop.app"
mv "/tmp/quarterdeck-release/firstmate desktop.app" /Applications/
```

A file `gh` downloads is not marked as downloaded from the internet, so macOS opens it without the warning a browser download of a self-signed app gets.

## Building one yourself

A build you make reports version `0.1.0`, so it is offered the latest release like any other copy.
An app an agent launches to test must set `QUARTERDECK_UPDATES=off`, or quitting it installs the latest release over the build being tested.
A debug build (`pnpm tauri dev`) never looks for updates, and its sidebar says so.
