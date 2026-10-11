// `cc-ctx setup` — wire the status line into Claude Code.
//
// A plugin cannot ship a statusLine: the manifest's `settings` key only applies
// `agent` and `subagentStatusLine`, and everything else is dropped at load. So
// the status line has to be written into the user's own settings once.
//
// The scripts are copied to a stable directory (~/.claude/cc-ctx) rather than
// referenced inside the plugin, whose path changes on every update. Re-running
// setup is safe and is how you pick up a new version's scripts.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PLUGIN_ROOT, INSTALL_DIR, USER_ENV, parseEnvFile } from './config.js';

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const BIN_LINK = path.join(os.homedir(), '.local', 'bin', 'cc-ctx');
const COPIED = ['bin', 'src', 'conf', 'package.json'];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(msg) {
  process.stderr.write(msg + '\n');
}

function configVersion(file) {
  try {
    return Number(parseEnvFile(fs.readFileSync(file, 'utf8')).CC_CTX_CONFIG_VERSION) || 0;
  } catch {
    return 0;
  }
}

export function runSetup({ resetConfig = false } = {}) {
  const out = [];
  const say = (s) => out.push(s);

  // 1. Copy the runtime to a stable location.
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  for (const entry of COPIED) {
    const from = path.join(PLUGIN_ROOT, entry);
    const to = path.join(INSTALL_DIR, entry);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  say(`installed runtime   ${INSTALL_DIR}`);

  // 2. Seed the user config once. Never overwritten, so prices and colours
  //    survive upgrades.
  const shipped = path.join(PLUGIN_ROOT, 'conf', 'default.env');
  const shippedVersion = configVersion(shipped);
  const userExists = fs.existsSync(USER_ENV);

  if (!userExists || resetConfig) {
    try {
      const defaults = fs.readFileSync(shipped, 'utf8');
      const header =
        '# Your cc-ctx settings. setup never overwrites this file — edit freely.\n' +
        '# Values here win over the ones shipped with the plugin.\n' +
        '# Run `cc-ctx setup --reset-config` to regenerate it from the defaults.\n\n';
      if (userExists) {
        const backup = `${USER_ENV}.backup.${timestamp()}`;
        fs.copyFileSync(USER_ENV, backup);
        say(`config backup       ${backup}`);
      }
      fs.writeFileSync(USER_ENV, header + defaults);
      say(`${userExists ? 'rewrote' : 'wrote'} config      ${USER_ENV}`);
    } catch (error) {
      say(`config              could not write (${error.message})`);
    }
  } else {
    say(`config              kept existing ${USER_ENV}`);
    // A default whose *meaning* changed cannot be merged safely: the stale value
    // is present, so the new default never applies, and the result can be
    // silently wrong rather than merely stale.
    const userVersion = configVersion(USER_ENV);
    if (userVersion < shippedVersion) {
      say('');
      say(`WARNING  your config predates version ${shippedVersion} (it is ${userVersion || 'unversioned'}).`);
      say('         Defaults whose meaning changed are NOT applied to an existing file.');
      if (userVersion < 3) {
        say('         Version 3 moved prices and peak/off-peak rules out of this file');
        say('         into JSON. CC_CTX_PRICE_* and CC_CTX_PEAK_* are no longer read.');
        say('         The shipped conf/providers/deepseek.json now provides the prices.');
        say('         If you had custom prices, copy that file to');
        say('         ~/.claude/cc-ctx/providers/deepseek.json and edit it there.');
      } else {
        say('         Version 2 switched the price table from USD to CNY — a config still');
        say('         holding the old USD numbers will have them read as CNY, understating');
        say('         cost by roughly 6.7x.');
      }
      say(`         Review ${USER_ENV}, or run:  cc-ctx setup --reset-config`);
      say('');
    }
  }

  // 3. Expose `cc-ctx` on PATH.
  const binDir = path.dirname(BIN_LINK);
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(INSTALL_DIR, 'bin', 'cc-ctx');
  try {
    if (fs.existsSync(BIN_LINK) || fs.lstatSync(BIN_LINK, { throwIfNoEntry: false })) {
      const stat = fs.lstatSync(BIN_LINK);
      if (!stat.isSymbolicLink()) {
        const backup = `${BIN_LINK}.backup.${timestamp()}`;
        fs.renameSync(BIN_LINK, backup);
        say(`bin                 moved existing file to ${backup}`);
      } else {
        fs.unlinkSync(BIN_LINK);
      }
    }
    fs.symlinkSync(target, BIN_LINK);
    say(`bin                 ${BIN_LINK} -> ${target}`);
  } catch (error) {
    say(`bin                 could not symlink (${error.message})`);
  }

  // 4. Point Claude Code's statusLine at the installed copy.
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (error) {
      say(`settings            REFUSING TO EDIT: ${SETTINGS_FILE} is not valid JSON`);
      say(`                    ${error.message}`);
      return out.join('\n');
    }
    const backup = `${SETTINGS_FILE}.backup.${timestamp()}`;
    fs.copyFileSync(SETTINGS_FILE, backup);
    say(`settings backup     ${backup}`);
  }

  const previous = settings.statusLine?.command;
  settings.statusLine = {
    type: 'command',
    command: `"${target}" statusline`,
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  if (previous && previous !== settings.statusLine.command) {
    say(`settings replaced   ${previous}`);
  }
  say(`settings statusLine ${settings.statusLine.command}`);

  say('');
  say('Restart Claude Code, or run /config, to pick up the new status line.');
  say('Try it now:  cc-ctx');

  return out.join('\n');
}

export { SETTINGS_FILE, BIN_LINK };
