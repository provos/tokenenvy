export const REQUIRED_NODE_VERSION = '22.13';

/** @param {unknown} version */
export function isSupportedNodeVersion(version) {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 13);
}

/** @param {unknown} version */
export function unsupportedNodeMessage(version) {
  if (isSupportedNodeVersion(version)) return null;
  const detected = typeof version === 'string' && version.length > 0 ? version : 'unknown';
  return (
    `Token Envy requires Node.js ${REQUIRED_NODE_VERSION} or newer.\n` +
    `Detected Node.js ${detected}.\n` +
    'Upgrade Node.js, then run `npx tokenenvy` again.\n'
  );
}
