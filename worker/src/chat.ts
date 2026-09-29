/**
 * The chat endpoint.
 *
 * The implementation lives in `turn.ts` (the pipeline), `prompt.ts` (assembly) and
 * `persist.ts` (writes). This module exists so `index.ts` has one import for the route
 * and so the old single-file shape is not a thing anyone has to reason about.
 */
export { handleTurn as handleChat } from './turn';
