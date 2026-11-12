import { defineRailway, project, service, volume } from "railway/iac";
// This repository manages only its own resources in the environment.
export const partial = "reel-maps";
export default defineRailway(() => {
  // The existing persistent volume (SQLite + Reel screenshots). Declared so IaC keeps it attached at /data.
  const data = volume("reel-maps-volume", { sizeMB: 5000, region: "iad" });
  const reelMaps = service("reel-maps", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: { "iad": 1 },
    // App sleeping stays off (Railway's default when unset): the worker must keep running between shares.
    deploy: { restartPolicyType: "ALWAYS" },
    volumeMounts: { "/data": data },
  });

  return project("reel-maps", {
    // Variables stay owned by the Railway dashboard (not written to this file).
    variables: { managed: false },
    resources: [reelMaps, data],
  });
});
