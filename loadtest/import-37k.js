import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://caddy';
const EMAIL = __ENV.ADMIN_EMAIL;
const PASSWORD = __ENV.ADMIN_PASSWORD;
const USERS = Number(__ENV.USERS || 200);
const NOTES = 37000;
if (!Number.isInteger(USERS) || USERS < 1 || NOTES % USERS !== 0) {
  throw new Error(`USERS must be a positive divisor of ${NOTES}.`);
}
const NOTES_PER_USER = NOTES / USERS;
const CSV_ROWS = open('/out/import-37k.csv').trim().split(/\r?\n/).slice(1);
if (CSV_ROWS.length !== NOTES) throw new Error(`Expected ${NOTES} CSV rows, found ${CSV_ROWS.length}.`);
const importDuration = new Trend('import_duration', true);
const importedRows = new Counter('imported_rows');

export const options = {
  scenarios: {
    imports: {
      executor: 'per-vu-iterations',
      vus: USERS,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  setupTimeout: '10m',
  thresholds: { imported_rows: [`count==${NOTES}`] },
};

export function setup() {
  const signedIn = http.post(
    `${BASE_URL}/v1/auth/token`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '30s' },
  );
  if (signedIn.status !== 200 && signedIn.status !== 201) {
    fail(`Admin sign-in failed: ${signedIn.status} ${signedIn.body}`);
  }
  return signedIn.json('accessToken');
}

export default function (token) {
  const startedAt = Date.now();
  const first = (exec.vu.idInTest - 1) * NOTES_PER_USER;
  const csv = `title,body\n${CSV_ROWS.slice(first, first + NOTES_PER_USER).join('\n')}\n`;
  const uploaded = http.post(
    `${BASE_URL}/v1/data/imports`,
    { name: 'notes', dryRun: 'false', file: http.file(csv, `notes-${exec.vu.idInTest}.csv`, 'text/csv') },
    { headers: { Authorization: `Bearer ${token}` }, timeout: '5m' },
  );
  if (uploaded.status !== 202) fail(`Import start failed: ${uploaded.status} ${uploaded.body}`);
  const id = uploaded.json('id');
  let transfer;
  for (let i = 0; i < 900; i++) {
    const response = http.get(`${BASE_URL}/v1/data/transfers/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: '30s',
    });
    if (response.status !== 200) fail(`Transfer poll failed: ${response.status} ${response.body}`);
    transfer = response.json();
    if (transfer.status === 'completed' || transfer.status === 'failed') break;
    sleep(1);
  }
  const elapsed = Date.now() - startedAt;
  importDuration.add(elapsed);
  check(transfer, {
    'import completed': (value) => value?.status === 'completed',
    [`all ${NOTES_PER_USER} rows imported`]: (value) => value?.result?.rows === NOTES_PER_USER && value?.result?.imported === NOTES_PER_USER,
  });
  if (transfer?.status !== 'completed' || transfer?.result?.imported !== NOTES_PER_USER) {
    fail(`Import did not finish cleanly (${elapsed} ms): ${JSON.stringify(transfer)}`);
  }
  importedRows.add(transfer.result.imported);
}
