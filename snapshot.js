const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SHEET_JSON_URL = process.env.SHEET_JSON_URL;
const DASHBOARD_URL = process.env.DASHBOARD_URL;
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const SNAPSHOT_PUBLIC_URL_BASE = process.env.SNAPSHOT_PUBLIC_URL_BASE; // e.g. https://raw.githubusercontent.com/user/repo/main

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_FILE = path.join(REPO_ROOT, '.github', 'state', 'last_insert_time.txt');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'snapshots');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'latest.png');
const SNAPSHOT_PUBLIC_URL = `${SNAPSHOT_PUBLIC_URL_BASE}/snapshots/latest.png?t=${Date.now()}`;

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
function fmt(v) { return (v ?? '').toString().trim(); }

async function main() {
  required('SHEET_JSON_URL', SHEET_JSON_URL);
  required('DASHBOARD_URL', DASHBOARD_URL);
  required('LINE_CHANNEL_TOKEN', LINE_TOKEN);
  required('LINE_GROUP_ID', LINE_GROUP_ID);
  required('SNAPSHOT_PUBLIC_URL_BASE', SNAPSHOT_PUBLIC_URL_BASE);

  // 1. Pull current sheet data
  const res = await fetch(SHEET_JSON_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const rows = await res.json();
  if (!rows.length) {
    console.log('Sheet returned no rows at all — skipping this run.');
    return;
  }

  const insertTime = fmt(rows[0].insert_time);
  if (!insertTime) {
    console.log('No insert_time found on first row — skipping this run.');
    return;
  }

  // 2. Same fixed filters as the dashboard (SEVERITY in SA1-4, NN_ClusterID not blank)
  const filtered = rows.filter(r => {
    const sev = fmt(r.SEVERITY);
    const cluster = fmt(r.NN_ClusterID);
    return ['SA1', 'SA2', 'SA3', 'SA4'].includes(sev) && cluster !== '';
  });
  const ticketCount = filtered.length;

  // 3. Skip if the sheet hasn't actually refreshed since last run
  let lastInsertTime = '';
  if (fs.existsSync(STATE_FILE)) {
    lastInsertTime = fs.readFileSync(STATE_FILE, 'utf8').trim();
  }
  if (insertTime === lastInsertTime) {
    console.log(`insert_time unchanged (${insertTime}) — nothing new, skipping send.`);
    return;
  }
  console.log(`insert_time changed: "${lastInsertTime}" -> "${insertTime}". Ticket count: ${ticketCount}`);

  // 4. Act based on ticket count
  if (ticketCount === 0) {
    await sendText(`No pending ticket at ${insertTime}`);
    saveState(insertTime);
    commitAndPush(`chore: update state (no pending tickets) [skip ci]`, [STATE_FILE]);
  } else {
    await takeScreenshot();
    saveState(insertTime);
    commitAndPush(`chore: auto snapshot ${insertTime} [skip ci]`, [SNAPSHOT_PATH, STATE_FILE]);
    // give GitHub's raw content CDN a moment to pick up the just-pushed file
    await sleep(20000);
    await sendImage();
  }
}

function saveState(insertTime) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, insertTime, 'utf8');
}

function commitAndPush(message, files) {
  execSync(`git config user.name "snapshot-bot"`, { cwd: REPO_ROOT });
  execSync(`git config user.email "actions@users.noreply.github.com"`, { cwd: REPO_ROOT });
  for (const f of files) {
    execSync(`git add "${f}"`, { cwd: REPO_ROOT });
  }
  try {
    execSync(`git commit -m "${message}"`, { cwd: REPO_ROOT });
    execSync(`git push`, { cwd: REPO_ROOT });
    console.log('Committed and pushed:', files);
  } catch (e) {
    console.log('Nothing to commit or push failed (may be a no-op):', e.message);
  }
}

async function takeScreenshot() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#page', { timeout: 30000 });
    // let the sheet fetch + chart rendering + map tiles settle
    await sleep(4000);
    const el = await page.$('#page');
    await el.screenshot({ path: SNAPSHOT_PATH });
    console.log('Screenshot saved to', SNAPSHOT_PATH);
  } finally {
    await browser.close();
  }
}

async function sendText(text) {
  await linePush([{ type: 'text', text }]);
  console.log('Sent text message:', text);
}

async function sendImage() {
  await linePush([{
    type: 'image',
    originalContentUrl: SNAPSHOT_PUBLIC_URL,
    previewImageUrl: SNAPSHOT_PUBLIC_URL
  }]);
  console.log('Sent image message:', SNAPSHOT_PUBLIC_URL);
}

async function linePush(messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({ to: LINE_GROUP_ID, messages })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LINE push failed: ${res.status} ${t}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error(err);
  process.exit(1);
});
