# Third-party code in this folder

These files are bundled unchanged and loaded only on first use (the wallet QR screens, the native-chain migration flow).

| File | Project | Version | Licence |
|------|---------|---------|---------|
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | 2.0.4 | MIT. Copyright (c) 2009 Kazuhiko Arase. The licence text is in the file header. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED. |
| `jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) by Cosmo Wolfe | 1.4.0 | Apache License 2.0, see `jsQR.LICENSE.txt`. |
| `deltix-wallet-sdk.js` | Deltix's own `@deltix/wallet-sdk` (`deltix-wallet/`, built by `npm run build:browser -- --out ../frontend/vendor/deltix-wallet-sdk.js`), bundling `@cosmjs/amino`, `crypto`, `encoding`, `math`, `proto-signing`, `utils` and `cosmjs-types` (Apache-2.0); `@noble/hashes`, `@noble/curves`, `@noble/ciphers`, `@scure/bip39`, `base64-js` (MIT) | 0.1.0 | Deltix: see `LICENSE` at the repository root. Third-party notices are in the file header; the exact versions are pinned in `deltix-wallet/package-lock.json`. |
