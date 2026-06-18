// LLM-generated timestamp patterns that must be stripped from any outgoing
// message before it reaches a human or a platform.  The model sees these in
// injected history and imitates them in its replies; only machine-set
// timestamps (from the message's own `timestamp` field) may be trusted.
//
// Both patterns stripped globally so they are removed wherever the LLM
// echoed them — accumulation at the head is the common case, but mid-prose
// echoes have also been observed.
//
// Browser-side mirror: public/app.js `stripDisplayTimestamps` — kept
// separate because the browser can't import server ESM modules.

const _TS_CHEVRON = /⫸\d{1,2}:\d{2}⫷\s*/g;   // web-chat format
const _TS_BRACKET = /\[\d{1,2}:\d{2}\]\s*/g;    // Discord / legacy web format

export function stripLlmTimestamps(text) {
  if (typeof text !== 'string') return text;
  return text.replace(_TS_CHEVRON, '').replace(_TS_BRACKET, '');
}
