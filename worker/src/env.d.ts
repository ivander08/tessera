// Merges into the global `Env` declared by worker-configuration.d.ts.
// `TESSERA_TOKEN` is a Worker secret (`wrangler secret put`), so `wrangler types`
// cannot see it and it must be declared here.
interface Env {
  TESSERA_TOKEN: string;
}
