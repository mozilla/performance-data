#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const TREEHERDER_API = 'https://treeherder.mozilla.org/api';
const REPOSITORY = 'mozilla-central';
const REPOSITORY_ID = 1;
const FRAMEWORK_ID = 13;
const SUITE = 'jetstream3';
const SCORE_START_DATE = '2025-01-01T00:00:00';
const SUBTEST_DAYS = 14;
const OUTPUT_FILE = process.env.JETSTREAM_OUTPUT || 'jetstream-data.json.gz';
const DATA_CONCURRENCY = Number.parseInt(process.env.TREEHERDER_DATA_CONCURRENCY || '8', 10);
const SIGNATURE_BATCH = 40;
const JOB_BATCH = 150;

const APPLICATIONS = new Set([
  'firefox',
  'chrome',
  'fenix',
  'chrome-m',
  'custom-car',
  'cstm-car-m',
  'safari',
  'safari-tp'
]);

// Column metadata mirrors the Redash query result (query 107813) so the gzipped
// file is a drop-in replacement for the previous stmo-sourced export.
const COLUMNS = [
  { name: 'date', friendly_name: 'date', type: 'datetime' },
  { name: 'test', friendly_name: 'test', type: null },
  { name: 'suite', friendly_name: 'suite', type: null },
  { name: 'platform', friendly_name: 'platform', type: null },
  { name: 'application', friendly_name: 'application', type: null },
  { name: 'signature_id', friendly_name: 'signature_id', type: 'integer' },
  { name: 'framework_id', friendly_name: 'framework_id', type: 'integer' },
  { name: 'repository_id', friendly_name: 'repository_id', type: 'integer' },
  { name: 'value', friendly_name: 'value', type: 'float' },
  { name: 'task_id', friendly_name: 'task_id', type: null },
  { name: 'retry_id', friendly_name: 'retry_id', type: 'integer' },
  { name: 'revision', friendly_name: 'revision', type: null },
  { name: 'worker_id', friendly_name: 'worker_id', type: null }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 3) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'mozilla-performance-data-jetstream-cache'
        }
      });

      if (response.ok) {
        return await response.json();
      }

      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text();
      lastError = new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 300)}`);

      if (!retryable || attempt === retries) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
    }

    await sleep(1000 * 2 ** attempt);
  }

  throw lastError;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// push_timestamp is an integer epoch-seconds value; render it the way Redash
// renders a datetime column: ISO 8601 in UTC, second precision, trailing "Z".
function toIsoDate(pushTimestamp) {
  return new Date(pushTimestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function subtestStartDate() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  midnight.setUTCDate(midnight.getUTCDate() - SUBTEST_DAYS);
  return midnight.toISOString().replace(/\.\d{3}Z$/, '');
}

async function fetchSignatures() {
  const url = `${TREEHERDER_API}/project/${REPOSITORY}/performance/signatures/?framework=${FRAMEWORK_ID}`;
  console.log('Fetching jetstream3 signatures');
  const signatures = await fetchJson(url);

  const scoreSignatures = [];
  const subtestSignatures = [];

  for (const sig of Object.values(signatures)) {
    if (sig.suite !== SUITE || !APPLICATIONS.has(sig.application)) {
      continue;
    }
    if (sig.test === 'score') {
      scoreSignatures.push(sig);
    } else if (typeof sig.test === 'string' && sig.test.endsWith('-Geometric')) {
      subtestSignatures.push(sig);
    }
  }

  console.log(`Found ${scoreSignatures.length} score signatures and ${subtestSignatures.length} -Geometric signatures`);
  return { scoreSignatures, subtestSignatures };
}

// Fetch every datum for the given signatures since startDate, tagging each with
// the metadata the stmo query joins in from performance_signature.
async function fetchDatums(signatures, startDate) {
  const byId = new Map(signatures.map(sig => [sig.id, sig]));
  const batches = chunk(signatures, SIGNATURE_BATCH);
  const datums = [];

  await mapLimit(batches, DATA_CONCURRENCY, async batch => {
    const params = batch.map(sig => `signature_id=${sig.id}`).join('&');
    const url = `${TREEHERDER_API}/project/${REPOSITORY}/performance/data/?${params}&start_date=${startDate}`;
    const response = await fetchJson(url);

    for (const rows of Object.values(response)) {
      for (const row of rows) {
        // INNER JOIN job in the source query drops datums with no linked job.
        if (row.job_id === null || row.job_id === undefined) {
          continue;
        }
        const sig = byId.get(row.signature_id);
        if (!sig) {
          continue;
        }
        datums.push({
          signature_id: row.signature_id,
          job_id: row.job_id,
          revision: row.revision,
          push_timestamp: row.push_timestamp,
          value: row.value,
          test: sig.test,
          platform: sig.machine_platform,
          application: sig.application
        });
      }
    }
  });

  return datums;
}

// Resolve task_id / retry_id / machine_name for every referenced job. Mirrors
// the INNER JOIN on taskcluster_metadata and LEFT JOIN on machine.
async function fetchJobMetadata(jobIds) {
  const batches = chunk([...jobIds], JOB_BATCH);
  const jobs = new Map();

  await mapLimit(batches, DATA_CONCURRENCY, async batch => {
    const url = `${TREEHERDER_API}/project/${REPOSITORY}/jobs/?id__in=${batch.join(',')}&count=2000`;
    const response = await fetchJson(url);
    for (const job of response.results || []) {
      jobs.set(job.id, {
        task_id: job.task_id,
        retry_id: job.retry_id,
        worker_id: job.machine_name ?? null
      });
    }
  });

  return jobs;
}

function buildRows(datums, jobs) {
  const rows = [];

  for (const datum of datums) {
    const job = jobs.get(datum.job_id);
    // INNER JOIN taskcluster_metadata: skip datums whose job/task metadata is gone.
    if (!job || job.task_id === null || job.task_id === undefined) {
      continue;
    }

    rows.push({
      date: toIsoDate(datum.push_timestamp),
      test: datum.test,
      suite: SUITE,
      platform: datum.platform,
      application: datum.application,
      signature_id: datum.signature_id,
      framework_id: FRAMEWORK_ID,
      repository_id: REPOSITORY_ID,
      value: datum.value,
      task_id: job.task_id,
      retry_id: job.retry_id,
      revision: datum.revision,
      worker_id: job.worker_id
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

async function main() {
  const { scoreSignatures, subtestSignatures } = await fetchSignatures();

  const subtestStart = subtestStartDate();
  console.log(`Fetching score datums since ${SCORE_START_DATE} and -Geometric datums since ${subtestStart}`);

  const [scoreDatums, subtestDatums] = await Promise.all([
    fetchDatums(scoreSignatures, SCORE_START_DATE),
    fetchDatums(subtestSignatures, subtestStart)
  ]);

  const datums = [...scoreDatums, ...subtestDatums];
  console.log(`Collected ${scoreDatums.length} score datums and ${subtestDatums.length} -Geometric datums`);

  const jobIds = new Set(datums.map(datum => datum.job_id));
  console.log(`Resolving metadata for ${jobIds.size} jobs`);
  const jobs = await fetchJobMetadata(jobIds);

  const rows = buildRows(datums, jobs);
  console.log(`Built ${rows.length} rows`);

  const payload = {
    query_result: {
      retrieved_at: new Date().toISOString(),
      data: {
        columns: COLUMNS,
        rows
      }
    }
  };

  await writeFile(OUTPUT_FILE, gzipSync(Buffer.from(JSON.stringify(payload))));
  console.log(`Wrote ${OUTPUT_FILE} (${rows.length} rows)`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
