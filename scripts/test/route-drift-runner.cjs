// Runs one reconcile pass with the compiled API code against real Docker (via the
// docker-proxy sidecar) and a real Traefik. Used by route-drift-harness.sh.
// APPS: JSON array of Coolify-shaped applications (no Coolify needed).
const { reconcileSite } = require('/w/api/dist/services/routeReconciler.js');

(async () => {
  const apps = JSON.parse(process.env.APPS);
  const outcomes = [];
  for (const app of apps) {
    outcomes.push(await reconcileSite({}, app, process.env.TRAEFIK_CONF_DIR, 'internal-ca'));
  }
  console.log('OUTCOMES ' + JSON.stringify(outcomes));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
