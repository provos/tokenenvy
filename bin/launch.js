#!/usr/bin/env node

import { unsupportedNodeMessage } from './node-version.js';

const versionError = unsupportedNodeMessage(process.versions.node);
if (versionError) {
  process.stderr.write(versionError);
  process.exitCode = 1;
} else {
  import('./tokenenvy.js')
    .then(({ main }) => main())
    .catch((error) => {
      process.stderr.write(
        `tokenenvy: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
