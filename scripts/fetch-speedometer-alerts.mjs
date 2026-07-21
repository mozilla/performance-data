#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const TREEHERDER_API = 'https://treeherder.mozilla.org/api';
const FRAMEWORK_ID = 13;
const ALERT_REPOSITORY = 'autoland';
const ALERT_REPOSITORY_ID = 77;
const TIMERANGE_DAYS = Number.parseInt(process.env.SPEEDOMETER_ALERT_DAYS || '90', 10);
const OUTPUT_FILE = process.env.SPEEDOMETER_ALERT_OUTPUT || 'speedometer-alerts.json';
const RELATED_SUMMARY_CONCURRENCY = Number.parseInt(process.env.TREEHERDER_RELATED_SUMMARY_CONCURRENCY || '8', 10);

const platformConfigs = {
  windows: {
    platforms: ['windows11-64-24h2-nightlyasrelease', 'windows11-64-24h2-shippable'],
    supportsSafari: false
  },
  'windows-hwref': {
    platforms: ['windows11-64-24h2-hw-ref-nightlyasrelease', 'windows11-64-24h2-hw-ref-shippable'],
    supportsSafari: false
  },
  osx: {
    platforms: ['macosx1015-64-nightlyasrelease-qr', 'macosx1015-64-shippable-qr'],
    supportsSafari: false
  },
  osxm4: {
    platforms: ['macosx1500-aarch64-shippable'],
    supportsSafari: true
  },
  linux: {
    platforms: ['linux2404-64-nightlyasrelease', 'linux2404-64-shippable'],
    supportsSafari: false
  },
  'android-a55': {
    platforms: ['android-hw-a55-14-0-aarch64-shippable'],
    supportsSafari: false
  },
  'android-s24': {
    platforms: ['android-hw-s24-14-0-aarch64-shippable'],
    supportsSafari: false
  },
  'android-p6': {
    platforms: ['android-hw-p6-13-0-aarch64-shippable'],
    supportsSafari: false
  }
};

const testsToDisplay = [
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
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 3;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'mozilla-performance-data-speedometer-alert-cache'
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

function canonicalKey(sig) {
  return [sig.application, sig.machine_platform, sig.suite, sig.test].join('|');
}

function isMoreCanonical(candidate, current) {
  const candidateOptions = (candidate.extra_options || []).length;
  const currentOptions = (current.extra_options || []).length;
  if (candidateOptions !== currentOptions) {
    return candidateOptions < currentOptions;
  }

  return candidate.id > current.id;
}

function selectCanonicalSignatures(signatures) {
  const canonical = new Map();
  for (const sig of signatures) {
    const key = canonicalKey(sig);
    const current = canonical.get(key);
    if (!current || isMoreCanonical(sig, current)) {
      canonical.set(key, sig);
    }
  }

  return [...canonical.values()];
}

function signatureMatchesTest(sig, testName) {
  if (!sig.test) {
    return false;
  }

  const baseTestName = testName.replace('/total', '');
  return sig.test === testName || sig.test.startsWith(`${baseTestName}/`);
}

function relatedAlertMatchesTest(alert, testName) {
  const alertTest = alert.series_signature?.test;
  if (!alertTest) {
    return false;
  }

  const baseTestName = testName.replace('/total', '');
  return alertTest === testName || alertTest.startsWith(`${baseTestName}/`);
}

function membershipKey(membership) {
  return `${membership.osKey}|${membership.testName}`;
}

function addMembership(signatureMemberships, sigId, membership) {
  if (!signatureMemberships.has(sigId)) {
    signatureMemberships.set(sigId, new Map());
  }

  signatureMemberships.get(sigId).set(membershipKey(membership), membership);
}

function initCacheGroup(config) {
  return {
    platforms: [...config.platforms],
    alert_count: 0,
    summary_count: 0,
    alerts: Object.fromEntries(testsToDisplay.map(testName => [testName, []])),
    alertSummaries: {}
  };
}

function pruneSummary(summary) {
  return {
    id: summary.id,
    push_timestamp: summary.push_timestamp,
    prev_push_timestamp: summary.prev_push_timestamp ?? null,
    repository: ALERT_REPOSITORY
  };
}

function pruneAlert(alert, summary) {
  const sig = alert.series_signature || {};

  return {
    id: alert.id,
    status: alert.status,
    series_signature: {
      id: sig.id,
      framework_id: sig.framework_id,
      signature_hash: sig.signature_hash,
      machine_platform: sig.machine_platform,
      suite: sig.suite,
      test: sig.test,
      lower_is_better: sig.lower_is_better,
      has_subtests: sig.has_subtests,
      option_collection_hash: sig.option_collection_hash,
      tags: sig.tags,
      extra_options: sig.extra_options,
      measurement_unit: sig.measurement_unit,
      suite_public_name: sig.suite_public_name,
      test_public_name: sig.test_public_name
    },
    taskcluster_metadata: alert.taskcluster_metadata ?? null,
    prev_taskcluster_metadata: alert.prev_taskcluster_metadata ?? null,
    profile_url: alert.profile_url ?? null,
    prev_profile_url: alert.prev_profile_url ?? null,
    is_regression: alert.is_regression,
    prev_value: alert.prev_value,
    new_value: alert.new_value,
    t_value: alert.t_value,
    amount_abs: alert.amount_abs,
    amount_pct: alert.amount_pct,
    summary_id: summary.id,
    related_summary_id: alert.related_summary_id ?? null,
    manually_created: alert.manually_created ?? false,
    classifier: alert.classifier ?? null,
    starred: alert.starred ?? false,
    classifier_email: alert.classifier_email ?? null,
    side_by_side_available: alert.side_by_side_available ?? false,
    noise_profile: alert.noise_profile ?? null,
    push_timestamp: summary.push_timestamp,
    repository: ALERT_REPOSITORY
  };
}

function addAlert(cache, addedAlertKeys, osKey, testName, alert, summary) {
  const group = cache.by_os[osKey];
  if (!group) {
    throw new Error(`Unknown Speedometer platform group: ${osKey}`);
  }

  const alertKey = `${summary.id}:${alert.id}:${alert.series_signature?.id ?? 'unknown'}`;
  const groupTestKey = `${osKey}|${testName}`;
  if (!addedAlertKeys.has(groupTestKey)) {
    addedAlertKeys.set(groupTestKey, new Set());
  }

  const testAlertKeys = addedAlertKeys.get(groupTestKey);
  if (testAlertKeys.has(alertKey)) {
    return false;
  }

  testAlertKeys.add(alertKey);
  group.alerts[testName].push(pruneAlert(alert, summary));
  group.alertSummaries[summary.id] = pruneSummary(summary);
  return true;
}

async function fetchSignaturesByPlatform() {
  const platforms = [...new Set(Object.values(platformConfigs).flatMap(config => config.platforms))];
  const signaturesByPlatform = new Map();

  for (const platform of platforms) {
    const url = `${TREEHERDER_API}/project/${ALERT_REPOSITORY}/performance/signatures/?framework=${FRAMEWORK_ID}&platform=${platform}`;
    console.log(`Fetching Speedometer signatures for ${platform}`);
    const signatures = await fetchJson(url);
    signaturesByPlatform.set(platform, Object.values(signatures));
  }

  return signaturesByPlatform;
}

function buildSignatureMemberships(signaturesByPlatform) {
  const signatureMemberships = new Map();
  const signatureCountByGroup = {};

  for (const [osKey, config] of Object.entries(platformConfigs)) {
    signatureCountByGroup[osKey] = {};

    for (const platform of config.platforms) {
      const signatures = signaturesByPlatform.get(platform) || [];
      const firefoxSignatures = signatures.filter(sig =>
        sig.suite === 'speedometer3' &&
        sig.test &&
        (sig.application === 'firefox' || sig.application === 'fenix')
      );

      for (const testName of testsToDisplay) {
        const candidates = firefoxSignatures.filter(sig => signatureMatchesTest(sig, testName));
        const canonicalSignatures = selectCanonicalSignatures(candidates);
        signatureCountByGroup[osKey][testName] = (signatureCountByGroup[osKey][testName] || 0) + canonicalSignatures.length;

        for (const sig of canonicalSignatures) {
          addMembership(signatureMemberships, sig.id, { osKey, testName });
        }
      }
    }
  }

  console.log(`Tracking ${signatureMemberships.size} canonical Speedometer alert signatures`);
  return { signatureMemberships, signatureCountByGroup };
}

async function fetchAlertSummaries() {
  const timerangeSeconds = TIMERANGE_DAYS * 24 * 60 * 60;
  let url = `${TREEHERDER_API}/performance/alertsummary/?repository=${ALERT_REPOSITORY_ID}&limit=100&timerange=${timerangeSeconds}`;
  const summaries = [];

  while (url) {
    console.log(`Fetching alert summaries page ${Math.floor(summaries.length / 100) + 1}`);
    const data = await fetchJson(url);
    summaries.push(...(data.results || []));
    url = data.next;
  }

  console.log(`Fetched ${summaries.length} alert summaries from the last ${TIMERANGE_DAYS} days`);
  return summaries;
}

async function fetchRelatedSummaries(relatedSummaryIds, summariesById) {
  const missingIds = relatedSummaryIds.filter(id => !summariesById.has(id));
  if (missingIds.length === 0) {
    return;
  }

  console.log(`Fetching ${missingIds.length} related alert summaries by id`);
  await mapLimit(missingIds, RELATED_SUMMARY_CONCURRENCY, async id => {
    const url = `${TREEHERDER_API}/performance/alertsummary/${id}/`;
    const summary = await fetchJson(url);
    summariesById.set(summary.id, summary);
  });
}

async function main() {
  if (!Number.isInteger(TIMERANGE_DAYS) || TIMERANGE_DAYS <= 0) {
    throw new Error(`SPEEDOMETER_ALERT_DAYS must be a positive integer; got ${process.env.SPEEDOMETER_ALERT_DAYS}`);
  }

  const cache = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: {
      treeherder_api: TREEHERDER_API,
      repository: ALERT_REPOSITORY,
      repository_id: ALERT_REPOSITORY_ID,
      framework_id: FRAMEWORK_ID,
      timerange_days: TIMERANGE_DAYS
    },
    tests: testsToDisplay,
    platform_configs: platformConfigs,
    by_os: Object.fromEntries(
      Object.entries(platformConfigs).map(([osKey, config]) => [osKey, initCacheGroup(config)])
    )
  };

  const signaturesByPlatform = await fetchSignaturesByPlatform();
  const { signatureMemberships, signatureCountByGroup } = buildSignatureMemberships(signaturesByPlatform);
  const summaries = await fetchAlertSummaries();
  const summariesById = new Map(summaries.map(summary => [summary.id, summary]));
  const relatedMemberships = new Map();
  const addedAlertKeys = new Map();

  for (const summary of summaries) {
    for (const alert of summary.alerts || []) {
      const sigId = alert.series_signature?.id;
      const memberships = signatureMemberships.get(sigId);
      if (!memberships) {
        continue;
      }

      for (const membership of memberships.values()) {
        addAlert(cache, addedAlertKeys, membership.osKey, membership.testName, alert, summary);

        if (alert.related_summary_id) {
          if (!relatedMemberships.has(alert.related_summary_id)) {
            relatedMemberships.set(alert.related_summary_id, new Map());
          }
          relatedMemberships.get(alert.related_summary_id).set(membershipKey(membership), membership);
        }
      }
    }
  }

  await fetchRelatedSummaries([...relatedMemberships.keys()], summariesById);

  for (const [relatedSummaryId, memberships] of relatedMemberships.entries()) {
    const summary = summariesById.get(relatedSummaryId);
    if (!summary) {
      console.warn(`Related summary ${relatedSummaryId} was not available`);
      continue;
    }

    for (const membership of memberships.values()) {
      for (const alert of summary.alerts || []) {
        if (relatedAlertMatchesTest(alert, membership.testName)) {
          addAlert(cache, addedAlertKeys, membership.osKey, membership.testName, alert, summary);
        }
      }
    }
  }

  for (const [osKey, group] of Object.entries(cache.by_os)) {
    let alertCount = 0;

    for (const [testName, alerts] of Object.entries(group.alerts)) {
      alerts.sort((a, b) => a.push_timestamp - b.push_timestamp || a.summary_id - b.summary_id || a.id - b.id);
      alertCount += alerts.length;
      if (!signatureCountByGroup[osKey][testName]) {
        console.warn(`No canonical signatures found for ${osKey} ${testName}`);
      }
    }

    group.alert_count = alertCount;
    group.summary_count = Object.keys(group.alertSummaries).length;
    group.alertSummaries = Object.fromEntries(
      Object.entries(group.alertSummaries).sort(([left], [right]) => Number(left) - Number(right))
    );

    console.log(`${osKey}: ${group.alert_count} alerts across ${group.summary_count} summaries`);
  }

  await writeFile(OUTPUT_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
