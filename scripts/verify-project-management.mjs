const dashboard = "http://localhost:7777";
const name = `Rocketman CRUD Verification ${Date.now()}`;
let createdId = null;

async function jsonRequest(path, options) {
  const response = await fetch(`${dashboard}${path}`, options);
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `${options?.method || "GET"} ${path} failed with ${response.status}`);
  return payload;
}

try {
  const before = await jsonRequest("/api/projects");
  const created = await jsonRequest("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: "Temporary CRUD verification entry.",
      cwd: process.cwd(),
      command: "node server.js --port {port}",
      preferredPort: 3999,
      urlTemplate: "http://localhost:{port}",
      healthTemplate: "http://localhost:{port}/api/health",
      tags: ["Verification"],
    }),
  });
  createdId = created.id;

  const afterCreate = await jsonRequest("/api/projects");
  if (!afterCreate.some((project) => project.id === createdId)) throw new Error("Created project was not persisted.");

  const removed = await jsonRequest(`/api/projects/${encodeURIComponent(createdId)}`, { method: "DELETE" });
  if (!removed.ok) throw new Error("Delete API did not confirm removal.");
  createdId = null;

  const afterDelete = await jsonRequest("/api/projects");
  if (afterDelete.some((project) => project.name === name)) throw new Error("Deleted project still appears in the dashboard.");
  if (afterDelete.length !== before.length) throw new Error("CRUD verification changed the configured project count.");

  console.log(JSON.stringify({ created: true, deleted: true, restoredCount: afterDelete.length }));
} finally {
  if (createdId) {
    await jsonRequest(`/api/projects/${encodeURIComponent(createdId)}`, { method: "DELETE" }).catch(() => {});
  }
}
