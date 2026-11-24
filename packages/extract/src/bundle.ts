// Vendor entry: everything the extension's worker needs from the workspace
// packages, bundled into one ESM file so the extension stays dependency-free.
export * from '@lattice/core';
export * from './index.js';
