const { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } = require('fs/promises');
const path = require('path');
const { createRequire } = require('module');

// Sibling of the local `.dsh` directory inside Electron user-data.
const DEFAULT_MARKER_NAME = '.dsh-version';
const DEFAULT_BACKUPS_DIR_NAME = '.dsh-backups';

// Lock/temporary/socket artifacts must never be copied into a backup: they are
// runtime-only and copying them can either fail (sockets) or resurrect stale
// state during a restore.
const EXCLUDED_PATTERNS = [
  /\.lock$/i,
  /\.tmp$/i,
  /\.tmp-/i,
  /\.swp$/i,
  /\.swx$/i,
  /\.sock$/i,
  /~$/,
];

function isExcludedName(name) {
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(name));
}

// Resolve the DSH version that this build will actually run. Prefer the
// installed package's own version, fall back to the pinned dependency in the
// app package.json, and finally to a sentinel so a version change is still
// detectable.
function resolveTargetDshVersion() {
  try {
    const requireFrom = createRequire(__filename);
    const version = requireFrom('@deepseek-ai/dsh/package.json')?.version;
    if (typeof version === 'string' && version) return version;
  } catch { /* package not resolvable in this context; fall through */ }
  try {
    const pkg = require('../../package.json');
    const pin = pkg.dependencies?.['@deepseek-ai/dsh'];
    if (typeof pin === 'string' && pin) return pin;
  } catch { /* package.json unavailable; fall through */ }
  return 'unknown';
}

function sanitizeForPath(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_') || 'unknown';
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function readMarker(markerPath) {
  let text;
  try {
    text = await readFile(markerPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string') {
      return { version: parsed.version };
    }
    if (typeof parsed === 'string' && parsed) return { version: parsed };
  } catch { /* legacy plain-text marker; use the raw trimmed value */ }
  return { version: trimmed };
}

async function writeMarkerAtomic(markerPath, version, date) {
  const payload = `${JSON.stringify({ version, updatedAt: date.toISOString() }, null, 2)}\n`;
  await mkdir(path.dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, markerPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

// True when the directory holds at least one non-excluded regular file. Empty
// directories, missing directories, or trees that contain only lock/temp files
// need no backup.
async function hasBackupableData(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (isExcludedName(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasBackupableData(child)) return true;
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

// Default copy implementation: recursively copy `src` into `dest`, skipping
// lock/temp/socket artifacts. Injectable so tests can simulate failures.
async function defaultCopy(src, dest) {
  await cp(src, dest, {
    recursive: true,
    filter: source => !isExcludedName(path.basename(source)),
  });
}

/**
 * Protect the local `.dsh` data directory across DSH version changes.
 *
 * On the first observed change of the target DSH package version (any change,
 * e.g. 0.1.0-rc.6 -> 0.1.1-rc.2), the existing `.dsh` directory is copied into
 * a recoverable, timestamped backup before the new DSH version is allowed to
 * touch it. The version marker is written atomically only after a successful
 * backup. A failed backup throws so the caller can block local DSH startup.
 *
 * @returns {Promise<{action: string, version: string, from?: string, backupPath?: string}>}
 */
async function guardDshData({
  userDataPath,
  dshHome,
  targetVersion = resolveTargetDshVersion(),
  markerPath,
  backupsDir,
  copyImpl = defaultCopy,
  now = () => new Date(),
} = {}) {
  if (!userDataPath && !dshHome) {
    throw new TypeError('guardDshData requires userDataPath or dshHome');
  }
  const resolvedUserData = userDataPath ?? path.dirname(dshHome);
  const resolvedDshHome = dshHome ?? path.join(resolvedUserData, '.dsh');
  const resolvedMarkerPath = markerPath ?? path.join(resolvedUserData, DEFAULT_MARKER_NAME);
  const resolvedBackupsDir = backupsDir ?? path.join(resolvedUserData, DEFAULT_BACKUPS_DIR_NAME);

  const stored = await readMarker(resolvedMarkerPath);

  // Version unchanged: nothing to do (idempotent).
  if (stored && stored.version === targetVersion) {
    return { action: 'unchanged', version: targetVersion };
  }

  const dataPresent = await hasBackupableData(resolvedDshHome);

  // Nothing worth protecting (fresh install or empty directory): just record
  // the current version so future changes are detectable.
  if (!dataPresent) {
    await writeMarkerAtomic(resolvedMarkerPath, targetVersion, now());
    return { action: stored ? 'recorded' : 'initialized', version: targetVersion };
  }

  // Data exists and the version changed (or the marker is missing while old
  // data is present, e.g. retrofitting onto an rc.6 install). Back up first.
  const fromVersion = stored?.version ?? 'unknown';
  const timestamp = formatTimestamp(now());
  const backupPath = path.join(resolvedBackupsDir, `${sanitizeForPath(fromVersion)}-${timestamp}`);
  const stagingPath = `${backupPath}.partial-${process.pid}`;

  await mkdir(resolvedBackupsDir, { recursive: true });
  await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
  try {
    await copyImpl(resolvedDshHome, stagingPath);
    // Reveal the completed backup atomically.
    await rename(stagingPath, backupPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Failed to back up local DSH data before upgrading to ${targetVersion}: ${error.message}`,
      { cause: error },
    );
  }

  // Marker is written only after the backup succeeds.
  await writeMarkerAtomic(resolvedMarkerPath, targetVersion, now());
  return { action: 'backed-up', version: targetVersion, from: fromVersion, backupPath };
}

module.exports = {
  DEFAULT_BACKUPS_DIR_NAME,
  DEFAULT_MARKER_NAME,
  guardDshData,
  hasBackupableData,
  isExcludedName,
  readMarker,
  resolveTargetDshVersion,
};
