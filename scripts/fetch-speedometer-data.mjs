#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const TREEHERDER_API = 'https://treeherder.mozilla.org/api';
const REPOSITORY = 'mozilla-central';
const REPOSITORY_ID = 1;
const FRAMEWORK_ID = 13;
const SUITE = 'speedometer3';
const SCORE_DAYS = Number.parseInt(process.env.SPEEDOMETER_SCORE_DAYS || '365', 10);
const SUBTEST_DAYS = Number.parseInt(process.env.SPEEDOMETER_SUBTEST_DAYS || '30', 10);
const OUTPUT_FILE = process.env.SPEEDOMETER_OUTPUT || 'speedometer-data.json.gz';
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

const PLATFORMS = new Set([
  'windows11-64-24h2-nightlyasrelease',
  'windows11-64-24h2-shippable',
  'windows11-64-24h2-hw-ref-nightlyasrelease',
  'windows11-64-24h2-hw-ref-shippable',
  'linux2404-64-nightlyasrelease',
  'linux2404-64-shippable',
  'macosx1500-aarch64-nightlyasrelease',
  'macosx1500-aarch64-shippable',
  'macosx2700-aarch64-shippable',
  'android-hw-s24-14-0-aarch64-nightlyasrelease',
  'android-hw-s24-14-0-aarch64-shippable',
  'android-hw-a55-14-0-aarch64-nightlyasrelease',
  'android-hw-a55-14-0-aarch64-shippable',
  'android-hw-p6-13-0-aarch64-nightlyasrelease',
  'android-hw-p6-13-0-aarch64-shippable'
]);

const SUBTESTS = new Set([
  'Charts-chartjs/total',
  'Charts-observable-plot/total',
  'Editor-CodeMirror/total',
  'Editor-TipTap/total',
  'NewsSite-Next/total',
  'NewsSite-Nuxt/total',
  'Perf-Dashboard/total',
  'React-Stockcharts-SVG/total',
  'TodoMVC-Angular-Complex-DOM/total',
  'TodoMVC-Backbone/total',
  'TodoMVC-JavaScript-ES5/total',
  'TodoMVC-JavaScript-ES6-Webpack-Complex-DOM/total',
  'TodoMVC-jQuery/total',
  'TodoMVC-Lit-Complex-DOM/total',
  'TodoMVC-Preact-Complex-DOM/total',
  'TodoMVC-React-Complex-DOM/total',
  'TodoMVC-React-Redux/total',
  'TodoMVC-Svelte-Complex-DOM/total',
  'TodoMVC-Vue/total',
  'TodoMVC-WebComponents/total'
]);

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

async function fetchJson(url, retries = 5) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'mozilla-performance-data-speedometer-cache'
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

    await sleep(Math.min(15000 * 2 ** attempt, 60000));
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

function toIsoDate(pushTimestamp) {
  return new Date(pushTimestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function startDate(days) {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  midnight.setUTCDate(midnight.getUTCDate() - days);
  return midnight.toISOString().replace(/\.\d{3}Z$/, '');
}

function selectCanonicalSignatures(signatures) {
  const options = sig => sig.extra_options ?? [];
  const hasFission = sig => options(sig).includes('fission');

  const isMoreCanonical = (candidate, current) => {
    if (hasFission(candidate) !== hasFission(current)) {
      return hasFission(candidate);
    }
    if (options(candidate).length !== options(current).length) {
      return options(candidate).length < options(current).length;
    }
    return candidate.id > current.id;
  };

  const canonical = new Map();
  for (const sig of signatures) {
    const key = [sig.application, sig.machine_platform, sig.test].join('|');
    const current = canonical.get(key);
    if (!current || isMoreCanonical(sig, current)) {
      canonical.set(key, sig);
    }
  }
  return [...canonical.values()];
}

async function fetchSignatures() {
  const url = `${TREEHERDER_API}/project/${REPOSITORY}/performance/signatures/?framework=${FRAMEWORK_ID}`;
  console.log('Fetching speedometer3 signatures');
  const signatures = await fetchJson(url);

  const scoreSignatures = [];
  const subtestSignatures = [];

  for (const sig of Object.values(signatures)) {
    if (sig.suite !== SUITE || !APPLICATIONS.has(sig.application) || !PLATFORMS.has(sig.machine_platform)) {
      continue;
    }
    if (sig.test === 'score') {
      scoreSignatures.push(sig);
    } else if (SUBTESTS.has(sig.test)) {
      subtestSignatures.push(sig);
    }
  }

  const canonicalScore = selectCanonicalSignatures(scoreSignatures);
  const canonicalSubtest = selectCanonicalSignatures(subtestSignatures);

  console.log(
    `Found ${canonicalScore.length} score signatures and ${canonicalSubtest.length} subtest signatures ` +
      `(of ${scoreSignatures.length} and ${subtestSignatures.length} before dropping variants)`
  );
  return { scoreSignatures: canonicalScore, subtestSignatures: canonicalSubtest };
}

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
        const sig = byId.get(row.signature_id);
        if (!sig) {
          continue;
        }
        datums.push({
          signature_id: row.signature_id,
          job_id: row.job_id ?? null,
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
    const job = (datum.job_id !== null && jobs.get(datum.job_id)) || {};

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
      task_id: job.task_id ?? null,
      retry_id: job.retry_id ?? null,
      revision: datum.revision,
      worker_id: job.worker_id ?? null
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

async function main() {
  const { scoreSignatures, subtestSignatures } = await fetchSignatures();

  const scoreStart = startDate(SCORE_DAYS);
  const subtestStart = startDate(SUBTEST_DAYS);
  console.log(`Fetching score datums since ${scoreStart} and subtest datums since ${subtestStart}`);

  const [scoreDatums, subtestDatums] = await Promise.all([
    fetchDatums(scoreSignatures, scoreStart),
    fetchDatums(subtestSignatures, subtestStart)
  ]);

  const datums = [...scoreDatums, ...subtestDatums];
  console.log(`Collected ${scoreDatums.length} score datums and ${subtestDatums.length} subtest datums`);

  const jobIds = new Set(datums.map(datum => datum.job_id).filter(jobId => jobId !== null));
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
