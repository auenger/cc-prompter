/**
 * CC Prompter — Package Entry
 *
 * Vite plugin that adds Claude Code PTY sessions to your dev workflow.
 *
 * Usage:
 *   import { ccPromptPlugin } from 'cc-prompter';
 *   // in vite.config.ts plugins: [ccPromptPlugin()]
 */

export { ccPromptPlugin } from './vite-plugin.js';
export type { CcPromptOptions } from './vite-plugin.js';
