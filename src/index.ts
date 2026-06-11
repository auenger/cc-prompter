/**
 * CC Prompter — Package Entry
 *
 * Provides plugins for Vite, Next.js, and generic webpack projects.
 *
 * Usage (Vite):
 *   import { ccPromptPlugin } from 'cc-prompter';
 *   // in vite.config.ts plugins: [ccPromptPlugin()]
 *
 * Usage (Next.js):
 *   const { withCcPrompt } = require('cc-prompter/next');
 *   module.exports = withCcPrompt()({ /* next config *\/ });
 *
 * Usage (webpack):
 *   const { CcPromptWebpackPlugin } = require('cc-prompter/webpack');
 *   // in webpack.config.js plugins: [new CcPromptWebpackPlugin()]
 */

export { ccPromptPlugin } from './vite-plugin.js';
export type { CcPromptOptions } from './vite-plugin.js';

export { CcPromptWebpackPlugin } from './webpack-plugin.js';
export type { CcPromptWebpackOptions } from './webpack-plugin.js';

export { withCcPrompt } from './next-plugin.js';
export type { CcPromptNextOptions } from './next-plugin.js';
