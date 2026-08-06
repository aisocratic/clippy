'use strict';

/**
 * Build a distributable "Clippy for Claude Code.app" — and a .dmg around it —
 * with nothing but what a Mac already has. This is what the Electron docs call
 * manual distribution: take the prebuilt Electron.app out of node_modules, put
 * the app's source into Contents/Resources/app/, and rewrite the bundle's
 * identity. electron-builder does the same job with a lot more machinery; this
 * repo has no runtime dependencies, and its installer keeps it that way.
 *
 *   npm run package                      # dist/Clippy for Claude Code.app + .dmg
 *   node scripts/package-app.js --no-dmg # just the .app
 *
 * The steps, in the order they have to happen:
 *
 *   1. `cp -R` the prebuilt Electron.app. cp, not fs.cpSync: the frameworks
 *      inside are held together by symlinks (Versions/Current and friends),
 *      and an app whose symlinks were flattened into copies fails codesign
 *      and refuses to launch.
 *   2. Copy src/ and bin/ into Contents/Resources/app/ with a productised
 *      package.json — that folder is the whole app; Electron finds it by the
 *      `main` field, exactly like `electron .` does in development.
 *   3. Draw the buddies into the bundle *now*. At runtime `npm start` isn't
 *      there to run make-buddies, and a downloaded bundle shouldn't be
 *      written into anyway — so the GIFs ship pre-baked and nothing ever
 *      needs to regenerate them.
 *   4. Rewrite Info.plist: our name, our identifier, our icon, LSUIElement
 *      (menu-bar app — main already hides the dock icon, this stops it ever
 *      flashing up). CFBundleExecutable stays "Electron" because that key
 *      must name the actual file in Contents/MacOS, and renaming the binary
 *      buys nothing — macOS shows users CFBundleDisplayName, not the file.
 *   5. Ad-hoc re-sign. Editing Info.plist broke the seal on Electron's own
 *      ad-hoc signature, and an Apple Silicon Mac won't launch a binary
 *      whose signature doesn't verify. `codesign --sign -` needs no
 *      certificate; Gatekeeper still calls the result unsigned, which the
 *      README's install section deals with.
 *   6. Wrap it in a compressed .dmg with an /Applications shortcut — the
 *      drag-to-install disk image everyone already knows how to use.
 *
 * The icon is drawn, not stored, like every other piece of art here: the same
 * `drawClip` grid the GIFs come from, scaled up onto square canvases, encoded
 * as PNGs by the ~60 lines below (zlib does the actual compressing), and
 * folded into an .icns by macOS's own iconutil.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { drawClip, clipPalette, W, H } = require('./make-buddies');
const { PALETTE: IDENTITY_COLOURS } = require('../src/identity');

const ROOT = path.join(__dirname, '..');
const PRODUCT = 'Clippy for Claude Code';
const BUNDLE_ID = 'dev.aisocratic.clippy';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

/* ---------------- A PNG encoder in ~60 lines ---------------- */

// PNG chunks carry a CRC-32 each; this is the standard table-driven one.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * RGBA pixels -> a complete PNG. Truecolour-with-alpha, eight bits a channel,
 * every scanline filter "none": the least clever PNG there is, which is the
 * point — zlib does the compressing and the rest is bookkeeping.
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // [10..12] compression, filter, interlace: all zero
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    // Each scanline leads with its filter byte (0 = none), then the pixels.
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- The icon: the clip, scaled up ---------------- */

// The classic steel clip — the one a fresh session is most likely to get.
const ICON_GRID = () => drawClip({});
const ICON_PALETTE = () => clipPalette(IDENTITY_COLOURS[0]);

/**
 * The 32x40 sprite blown up to fill a square canvas, nearest-neighbour so the
 * pixels stay pixels. Every icon size samples the same grid: at 1024 that's
 * ~25 canvas pixels per sprite pixel, at 16 it's sub-pixel and the clip still
 * reads because the silhouette is all it has left.
 */
function renderIconPixels(size, grid = ICON_GRID(), palette = ICON_PALETTE()) {
  // Fit the taller axis with a whisker of margin, centred both ways.
  const f = size / (H + 1);
  const ox = (size - W * f) / 2;
  const oy = (size - H * f) / 2;
  const rgba = Buffer.alloc(size * size * 4); // starts transparent
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const gx = Math.floor((tx - ox) / f);
      const gy = Math.floor((ty - oy) / f);
      if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
      const slot = grid[gy * W + gx];
      if (!slot) continue; // palette slot 0 is the transparent one
      const [r, g, b] = palette[slot];
      const i = (ty * size + tx) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Write the .iconset Apple's iconutil expects and fold it into an .icns. */
function buildIcns(outFile) {
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-iconset-'));
  const dir = path.join(iconset, 'clippy.iconset');
  fs.mkdirSync(dir);
  const grid = ICON_GRID();
  const palette = ICON_PALETTE();
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = points * scale;
      const name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
      fs.writeFileSync(path.join(dir, name), encodePng(px, px, renderIconPixels(px, grid, palette)));
    }
  }
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', outFile]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

/* ---------------- Info.plist ---------------- */

// stderr stays quiet: the Set-then-Add fallback below *expects* Set to fail
// on keys Electron's plist never had, and PlistBuddy narrates every failure.
const plistCmd = (plist, cmd) =>
  execFileSync(PLIST_BUDDY, ['-c', cmd, plist], { stdio: ['ignore', 'pipe', 'ignore'] });

/** Set a key, adding it first if this plist has never had one. */
function plistSet(plist, key, type, value) {
  try {
    plistCmd(plist, `Set :${key} ${value}`);
  } catch {
    plistCmd(plist, `Add :${key} ${type} ${value}`);
  }
}

function plistDelete(plist, key) {
  try {
    plistCmd(plist, `Delete :${key}`);
  } catch {
    // never had it — fine
  }
}

/* ---------------- The build itself ---------------- */

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function packageApp({
  dmg = true,
  signIdentity = process.env.CLIPPY_SIGN_IDENTITY || null,
  notaryProfile = process.env.CLIPPY_NOTARY_PROFILE || null,
  requireReleaseSigning = false,
} = {}) {
  if (notaryProfile && !signIdentity) {
    throw new Error('CLIPPY_NOTARY_PROFILE requires CLIPPY_SIGN_IDENTITY');
  }
  if (requireReleaseSigning && (!signIdentity || !notaryProfile)) {
    throw new Error(
      'release packaging requires CLIPPY_SIGN_IDENTITY and CLIPPY_NOTARY_PROFILE'
    );
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const electronApp = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!fs.existsSync(electronApp)) {
    throw new Error('node_modules/electron/dist/Electron.app not found — run `npm install` first');
  }

  const dist = path.join(ROOT, 'dist');
  const appBundle = path.join(dist, `${PRODUCT}.app`);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  // 1. The shell: prebuilt Electron, symlinks intact.
  console.log('copying Electron.app…');
  execFileSync('cp', ['-R', electronApp, appBundle]);

  // 2. The app: source into Resources/app/, plus a package.json whose `name`
  // is the product's own — that name is also what macOS files userData under,
  // so a packaged Clippy never trips over a `npm start` one (different name,
  // different single-instance lock, different settings file).
  const appDir = path.join(appBundle, 'Contents', 'Resources', 'app');
  fs.mkdirSync(appDir);
  fs.cpSync(path.join(ROOT, 'src'), path.join(appDir, 'src'), {
    recursive: true,
    // Generated art is rebuilt into the bundle below; don't ship a stale copy.
    filter: (src) => !src.includes(path.join('renderer', 'assets')),
  });
  fs.cpSync(path.join(ROOT, 'bin'), path.join(appDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'scripts'));
  fs.copyFileSync(
    path.join(__dirname, 'make-buddies.js'),
    path.join(appDir, 'scripts', 'make-buddies.js')
  );
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(appDir, 'LICENSE'));
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'clippy-for-claude-code',
        productName: PRODUCT,
        version: pkg.version,
        description: pkg.description,
        license: pkg.license,
        main: 'src/main.js',
      },
      null,
      2
    )
  );
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    // Source archives may have no .git directory. The release verifier treats
    // a missing commit as a local build, never as a tagged public artifact.
  }
  fs.writeFileSync(
    path.join(appDir, 'build.json'),
    JSON.stringify({ version: pkg.version, commit }, null, 2)
  );
  // Electron only falls back to its default app when Resources/app is missing;
  // ours isn't, so the demo asar is 6MB of dead weight.
  fs.rmSync(path.join(appBundle, 'Contents', 'Resources', 'default_app.asar'), { force: true });

  // 3. The art, drawn straight into the bundle. The copied script writes to
  // its own ../src/renderer/assets, which is now inside Resources/app — so a
  // first launch finds everything in place and never writes into the bundle.
  console.log('drawing the buddies…');
  execFileSync(process.execPath, [path.join(appDir, 'scripts', 'make-buddies.js')], {
    stdio: 'ignore',
  });

  // 4. Identity. This is what puts "Clippy for Claude Code" — instead of
  // "Electron" — in the menu bar, the Force Quit list, and the Accessibility
  // and Automation permission rows.
  console.log('rewriting the bundle identity…');
  const plist = path.join(appBundle, 'Contents', 'Info.plist');
  plistSet(plist, 'CFBundleName', 'string', PRODUCT);
  plistSet(plist, 'CFBundleDisplayName', 'string', PRODUCT);
  plistSet(plist, 'CFBundleIdentifier', 'string', BUNDLE_ID);
  plistSet(plist, 'CFBundleShortVersionString', 'string', pkg.version);
  plistSet(plist, 'CFBundleVersion', 'string', pkg.version);
  plistSet(plist, 'LSUIElement', 'bool', 'true');
  plistDelete(plist, 'ElectronAsarIntegrity'); // the asar it hashed is gone

  console.log('drawing the icon…');
  const resources = path.join(appBundle, 'Contents', 'Resources');
  buildIcns(path.join(resources, 'clippy.icns'));
  fs.rmSync(path.join(resources, 'electron.icns'), { force: true });
  plistSet(plist, 'CFBundleIconFile', 'string', 'clippy.icns');

  // 5. Re-seal. Developer ID signing is used for releases when the caller has
  // configured a keychain identity. Local builds retain the ad-hoc fallback,
  // but `npm run package:release` refuses to produce a public artifact without
  // both signing and notarization credentials.
  console.log(signIdentity ? 'Developer ID signing…' : 'ad-hoc signing (local build only)…');
  const appSignArgs = signIdentity
    ? ['--force', '--deep', '--options', 'runtime', '--timestamp', '--sign', signIdentity, appBundle]
    : ['--force', '--deep', '--sign', '-', appBundle];
  execFileSync('codesign', appSignArgs, { stdio: 'ignore' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], {
    stdio: 'ignore',
  });

  // 6. The disk image: the app plus an /Applications shortcut to drag it onto.
  let dmgFile = null;
  if (dmg) {
    console.log('building the disk image…');
    dmgFile = path.join(dist, `${PRODUCT.replace(/ /g, '-')}.dmg`);
    const stage = path.join(dist, '.dmg-stage');
    fs.mkdirSync(stage);
    execFileSync('cp', ['-R', appBundle, path.join(stage, `${PRODUCT}.app`)]);
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    execFileSync(
      'hdiutil',
      ['create', '-volname', PRODUCT, '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgFile],
      { stdio: 'ignore' }
    );
    fs.rmSync(stage, { recursive: true, force: true });

    if (signIdentity) {
      execFileSync(
        'codesign',
        ['--force', '--timestamp', '--sign', signIdentity, dmgFile],
        { stdio: 'ignore' }
      );
    }
    if (notaryProfile) {
      console.log('submitting for Apple notarization…');
      execFileSync(
        'xcrun',
        ['notarytool', 'submit', dmgFile, '--keychain-profile', notaryProfile, '--wait'],
        { stdio: 'inherit' }
      );
      execFileSync('xcrun', ['stapler', 'staple', dmgFile], { stdio: 'inherit' });
      execFileSync('xcrun', ['stapler', 'validate', dmgFile], { stdio: 'inherit' });
    }
  }

  let checksumFile = null;
  if (dmgFile) {
    checksumFile = `${dmgFile}.sha256`;
    fs.writeFileSync(checksumFile, `${sha256File(dmgFile)}  ${path.basename(dmgFile)}\n`);
  }

  console.log(`\npackaged: ${appBundle}`);
  if (dmgFile) {
    const mb = (fs.statSync(dmgFile).size / (1024 * 1024)).toFixed(1);
    console.log(`disk image: ${dmgFile} (${mb} MB)`);
    console.log(`checksum: ${checksumFile}`);
  }
  return { appBundle, dmgFile, checksumFile, signed: Boolean(signIdentity), notarized: Boolean(notaryProfile) };
}

if (require.main === module) {
  if (process.platform !== 'darwin') {
    console.error('package-app: this builds a macOS bundle and needs a Mac to do it.');
    process.exit(1);
  }
  packageApp({
    dmg: !process.argv.includes('--no-dmg'),
    requireReleaseSigning: process.argv.includes('--require-release-signing'),
  });
}

module.exports = { encodePng, renderIconPixels, sha256File, packageApp };
