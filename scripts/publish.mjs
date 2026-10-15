#!/usr/bin/env node
/**
 * Publish the package to npmjs, bypassing the machine's read-only mirror.
 *
 * The global `registry` in ~/.npmrc points at registry.npmmirror.com, which is
 * a read-only mirror: `npm publish` against it fails even with a valid token.
 * The npmjs token lives in the same file under
 * `//registry.npmjs.org/:_authToken`, so the publish has to name the real
 * registry explicitly rather than inherit the default.
 *
 * Usage:
 *   node scripts/publish.mjs            # dry run (default)
 *   node scripts/publish.mjs --real     # actually publish
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org/';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const real = process.argv.includes('--real');

/** Read the npmjs token from the user's .npmrc, or exit with instructions. */
function readToken() {
  let text;
  try {
    text = readFileSync(join(homedir(), '.npmrc'), 'utf8');
  } catch {
    fail('no ~/.npmrc found');
  }
  const match = text.match(/\/\/registry\.npmjs\.org\/:_authToken=(.+)/);
  if (!match) fail('no //registry.npmjs.org/:_authToken line in ~/.npmrc');
  return match[1].trim();
}

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}

const token = readToken();

// Check the token before publishing, but do not let the check be a gate.
// `/-/whoami` needs a token that may read the account, and a granular token
// scoped to publish is refused there with a 401 even though it publishes fine
// — so a refusal here is reported and the publish is attempted anyway. npm is
// the real judge; this only saves the reader from npm's own message, which
// never says which of the two npmrc settings is at fault.
const whoami = await fetch(`${REGISTRY}-/whoami`, { headers: { authorization: `Bearer ${token}` } });
if (whoami.ok) {
  const { username } = await whoami.json();
  console.log(`publish: authenticated as ${username}`);
} else {
  console.warn(
    `publish: could not verify the token — /-/whoami answered ${whoami.status}.\n` +
      '  A granular token scoped to publish is refused there too, so this is not\n' +
      '  proof the token is dead. If the publish below is rejected, replace it:\n' +
      '    npm login --registry=https://registry.npmjs.org/\n' +
      '  or edit the //registry.npmjs.org/:_authToken line in ~/.npmrc.',
  );
}
console.log(`publish: ${pkg.name}@${pkg.version} -> ${REGISTRY}${real ? '' : ' (dry run)'}`);

// `--registry` beats the mirror in ~/.npmrc; without it npm would try to
// publish to the mirror and fail on a read-only registry.
const args = ['publish', `--registry=${REGISTRY}`];
if (!real) args.push('--dry-run');
// npm ships as `npm.cmd` on Windows, which cannot be launched by execFile
// without a shell; going through cmd.exe keeps the args array un-concatenated,
// where `shell: true` would join them into one string (DEP0190).
const [file, argv] = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
  : ['npm', args];
try {
  execFileSync(file, argv, { stdio: 'inherit' });
} catch {
  fail('npm publish failed');
}
if (!real) console.log('publish: dry run complete; re-run with --real to publish');
