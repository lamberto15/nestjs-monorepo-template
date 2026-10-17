// The stack file `docker stack deploy` takes, made from what Compose renders
// of compose.yaml + compose.prod.yaml + compose.swarm.yaml (`docker compose
// config --format json`). Compose does the interpolation `docker stack`
// lacks (`${X:+y}`, nested defaults); what `docker stack` still refuses or
// lacks is fixed here, as a pure function so tests need no Docker.
import { createHash } from 'node:crypto';

/** The first eight hex digits of the SHA-256 of a Buffer or string. */
export function shortHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/**
 * @param {object} rendered  the parsed `docker compose config --format json`
 * @param {object} options
 * @param {string} options.stack          the stack's name (prefixes secrets and configs)
 * @param {(path: string) => Buffer} options.readFile
 * @param {string} options.placeholder    a non-empty file for secrets whose file is empty
 * @returns {object} the stack file (JSON is YAML: `docker stack deploy -c -` reads it)
 */
export function toStack(rendered, { stack, readFile, placeholder }) {
  const out = structuredClone(rendered);

  // Extension fields (x-app, the anchors) and the project name: `docker stack`
  // names everything after the stack.
  for (const key of Object.keys(out)) {
    if (key.startsWith('x-') || key === 'name') delete out[key];
  }

  for (const service of Object.values(out.services ?? {})) {
    // Compose prints unset keys as null; profiles only choose what to render.
    for (const key of Object.keys(service)) {
      if (service[key] === null || service[key] === undefined) delete service[key];
    }
    delete service.profiles;
    // `docker stack config` wants the CPU limits as strings.
    for (const kind of ['limits', 'reservations']) {
      const resources = service.deploy?.resources?.[kind];
      if (resources && resources.cpus !== undefined) resources.cpus = String(resources.cpus);
    }
    // Ports and file modes are numbers (Compose prints "80" and "0555").
    for (const port of service.ports ?? []) {
      if (typeof port === 'object') port.published = Number(port.published);
    }
    for (const mount of [...(service.configs ?? []), ...(service.secrets ?? [])]) {
      if (typeof mount === 'object' && typeof mount.mode === 'string') {
        mount.mode = Number.parseInt(mount.mode, 8);
      }
    }
  }

  // Volumes and networks lose Compose's project prefix: `docker stack` adds
  // <stack>_ itself.
  for (const kind of ['networks', 'volumes']) {
    for (const value of Object.values(out[kind] ?? {})) {
      if (value) delete value.name;
    }
  }

  // Secrets and configs are immutable in Swarm: a changed file needs a new
  // name, and a service update to use it. The name carries the content's
  // hash, so an unchanged file is the same secret (no service restarts) and
  // a changed one replaces it. An empty file (`secret.empty`, the unset
  // secrets) can't be a Swarm secret: the placeholder stands in, which no
  // service reads (its X_FILE variable is unset).
  for (const kind of ['secrets', 'configs']) {
    for (const [key, value] of Object.entries(out[kind] ?? {})) {
      if (!value?.file) continue;
      let content = readFile(value.file);
      if (content.length === 0) {
        value.file = placeholder;
        content = readFile(placeholder);
      }
      value.name = `${stack}_${key}_${shortHash(content)}`;
    }
  }
  return out;
}
