#!/usr/bin/env node
/**
 * scripts/sync-agent.js
 *
 * Synchronizes the agent definition in agent.json with the local TrueForge server.
 * Usage: node scripts/sync-agent.js [baseUrl]
 */

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const baseUrl = (process.argv[2] || process.env.TRUEFORGE_URL || 'http://localhost:8790').replace(/\/+$/, '');
  const agentPath = path.resolve(__dirname, '..', 'agent.json');

  if (!fs.existsSync(agentPath)) {
    console.error(`Error: Agent definition file not found at ${agentPath}`);
    process.exit(1);
  }

  const agentDef = JSON.parse(fs.readFileSync(agentPath, 'utf-8'));
  console.log(`Connecting to TrueForge at ${baseUrl}...`);

  try {
    const listRes = await fetch(`${baseUrl}/api/v1/agents`);
    if (!listRes.ok) {
      console.error(`Error connecting to TrueForge: HTTP ${listRes.status}`);
      process.exit(1);
    }

    const listData = await listRes.json();
    const existing = listData.data?.find(a => a.name === agentDef.name);

    if (existing) {
      console.log(`Found existing agent "${agentDef.name}" (ID: ${existing.id}). Updating manifest...`);
      const putRes = await fetch(`${baseUrl}/api/v1/agents/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: agentDef.manifest })
      });

      if (!putRes.ok) {
        console.error(`Failed to update agent: HTTP ${putRes.status}`, await putRes.text());
        process.exit(1);
      }
      const updated = await putRes.json();
      console.log(`Successfully updated agent "${agentDef.name}". Active model: ${updated.data?.manifest?.model?.name}`);
    } else {
      console.log(`Agent "${agentDef.name}" not found. Creating new agent...`);
      const postRes = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentDef)
      });

      if (!postRes.ok) {
        console.error(`Failed to create agent: HTTP ${postRes.status}`, await postRes.text());
        process.exit(1);
      }
      const created = await postRes.json();
      console.log(`Successfully created agent "${agentDef.name}" (ID: ${created.data?.id}).`);
    }
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    process.exit(1);
  }
}

main();
