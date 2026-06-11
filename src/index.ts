/**
 * CC Prompter — Package Entry
 *
 * Provides plugins for Vite and Next.js dev servers.
 *
 * Usage (Vite):
 *   import { ccPromptPlugin } from 'cc-prompter';
 *   // in vite.config.ts plugins: [ccPromptPlugin()]
 *
 * Usage (Next.js):
 *   const { withCcPrompt } = require('cc-prompter/next');
 *   module.exports = withCcPrompt()({ /* next config *\/ });
 */

export { ccPromptPlugin } from './vite-plugin.js';
export type { CcPromptOptions } from './vite-plugin.js';
export { withCcPrompt } from './next-plugin.js';
export type { CcPromptNextOptions } from './next-plugin.js';
