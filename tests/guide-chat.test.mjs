import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGuideSystem, guideChatDisabled, GUIDE_TOOLS_INFO } from '../guide-chat.js';

const settings = {
  userName: 'Sam', charName: 'Vex',
  systemPrompt: 'MAIN_PROMPT', characterProfile: 'CHAR_PROMPT', userProfile: 'USER_PROMPT',
  postHistoryPrompt: 'PH_PROMPT',
};

test('buildGuideSystem assembles identity + the four prompt fields + the two blocks', () => {
  const sys = buildGuideSystem('IDENTITY_LAYER', settings);
  assert.match(sys, /IDENTITY_LAYER/);
  assert.match(sys, /MAIN_PROMPT/);
  assert.match(sys, /CHAR_PROMPT/);
  assert.match(sys, /USER_PROMPT/);
  assert.match(sys, /LibreY/);          // tools-info (§5b)
  assert.match(sys, /keep it plain/);   // no-jargon (§5c)
});

test('buildGuideSystem resolves {{user}}/{{char}} macros', () => {
  const sys = buildGuideSystem('id', settings);
  assert.doesNotMatch(sys, /\{\{user\}\}/);
  assert.match(sys, /Sam/);
});

test('buildGuideSystem does NOT inject the post-history prompt (the endpoint appends it separately)', () => {
  const sys = buildGuideSystem('id', settings);
  assert.doesNotMatch(sys, /PH_PROMPT/);
});

test('buildGuideSystem tolerates an absent identity layer and empty prompt fields', () => {
  const sys = buildGuideSystem('', { userName: 'Sam' });
  assert.match(sys, /LibreY/);          // still has the tools-info
  assert.ok(sys.length > 100);
});

test('the tools-info block carries the Brave + Tavily signup steps', () => {
  assert.match(GUIDE_TOOLS_INFO, /api-dashboard\.search\.brave\.com/);
  assert.match(GUIDE_TOOLS_INFO, /app\.tavily\.com/);
  assert.match(GUIDE_TOOLS_INFO, /tvly-/);
});

test('guideChatDisabled honours the env off-switch', () => {
  const prev = process.env.PROTO_FAMILIAR_GUIDE_CHAT_DISABLED;
  process.env.PROTO_FAMILIAR_GUIDE_CHAT_DISABLED = '1';
  assert.equal(guideChatDisabled(), true);
  delete process.env.PROTO_FAMILIAR_GUIDE_CHAT_DISABLED;
  assert.equal(guideChatDisabled(), false);
  if (prev !== undefined) process.env.PROTO_FAMILIAR_GUIDE_CHAT_DISABLED = prev;
});
