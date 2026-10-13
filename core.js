const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const MODEL_SHA = 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin';
const stamp = (date = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
};
function inside(base, relative) {
  const result = path.resolve(base, relative);
  if (result !== base && !result.startsWith(base + path.sep)) throw new Error('Path is outside the vault.');
  return result;
}
function chunks(text, limit = 8000) {
  const out = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit);
    if (end < limit / 2) end = rest.lastIndexOf(' ', limit);
    if (end < limit / 2) end = limit;
    out.push(rest.slice(0, end)); rest = rest.slice(end).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
function timestamp(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds/3600), Math.floor(seconds/60)%60, seconds%60].map(n => String(n).padStart(2, '0')).join(':');
}
function transcriptFromJSON(json, offset = 0) {
  if (!Array.isArray(json.transcription)) throw new Error('Whisper returned an unexpected transcript format.');
  return json.transcription.filter(s => s.text?.trim()).map(s => {
    if (!Number.isFinite(s.offsets?.from)) throw new Error('Missing transcript timestamps.');
    return `[${timestamp(offset + s.offsets.from)}] ${s.text.trim()}`;
  }).join('\n\n');
}
const marker = job => `<!-- vmo-audio-job:${job.id} -->`;
const placeholder = job => `<!-- vmo-summary:${job.id}:start -->\n_Summary pending. See VMO Audio Notes for progress or retry._\n<!-- vmo-summary:${job.id}:end -->`;
function noteText(job, audioLink, sourceLink) {
  return `${marker(job)}\n# Audio Note ${job.stamp}\n\nRecorded: ${job.created}\n\nSource: ${sourceLink}\n\n!${audioLink}\n\n${placeholder(job)}\n\n## Transcript\n\n${job.transcript || '_No speech detected._'}\n`;
}
function addSummary(text, job) {
  const done = `<!-- vmo-summary:${job.id}:complete -->`;
  if (text.includes(done)) return text;
  const summary = `${done}\n${job.summary.trim()}`;
  // Only replace our untouched placeholder. Never overwrite user edits.
  return text.includes(placeholder(job)) ? text.replace(placeholder(job), summary) : `${text}\n\n## Generated summary\n\n${summary}\n`;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const summarySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string', maxLength: 800 },
    key_points: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } },
    decisions: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } },
    action_items: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } }
  }, required: ['summary','key_points','decisions','action_items']
};
function summaryMarkdown(text) {
  const data = JSON.parse(text);
  if (typeof data.summary !== 'string' || !data.summary.trim()) throw new Error('Summary paragraph is missing.');
  const sections = [['key_points','Key points'],['decisions','Decisions'],['action_items','Action items']];
  for (const [key] of sections) if (!Array.isArray(data[key]) || !data[key].every(s => typeof s === 'string')) throw new Error('Summary structure is invalid. Retry summarization.');
  return `## Summary\n\n${data.summary.trim()}\n\n` + sections.map(([key,title]) => `## ${title}\n\n${data[key].length ? data[key].map(s=>'- '+s.trim()).join('\n') : 'None explicitly stated.'}`).join('\n\n');
}
module.exports = { MODEL_SHA, MODEL_URL, stamp, inside, chunks, timestamp, transcriptFromJSON, marker, placeholder, noteText, addSummary, sha256, summarySchema, summaryMarkdown };
