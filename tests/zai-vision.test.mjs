import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickAnalyzeTool, buildAnalyzeArgs, textFromToolResult, zaiVisionDisabled,
} from '../src/vision/zai-vision.js';

test('pickAnalyzeTool prefers analyze_image, else a general image tool', () => {
  assert.equal(pickAnalyzeTool([{ name: 'extract_text_from_screenshot' }, { name: 'analyze_image' }]), 'analyze_image');
  assert.equal(pickAnalyzeTool([{ name: 'describe_image_general' }]), 'describe_image_general');
  assert.equal(pickAnalyzeTool([{ name: 'understand_technical_diagram' }, { name: 'analyze_data_visualization' }]), null);   // no general image tool
  assert.equal(pickAnalyzeTool([]), null);
});

test("buildAnalyzeArgs: z.ai's real image_source schema takes a file path (the -32602 regression)", () => {
  // The real @z_ai/mcp-server analyze_image: { image_source: path|url, prompt }.
  // `image_source` matches neither "path" nor "url" — the old guesser sent NO
  // image arg, which the server rejected with -32602 Invalid params.
  const schema = { properties: { image_source: {}, prompt: {} } };
  const { args, needsFile, imageKey } = buildAnalyzeArgs(schema, { filePath: '/tmp/x.png', dataUrl: 'data:image/png;base64,AAAA', base64: 'AAAA', prompt: 'describe it' });
  assert.equal(imageKey, 'image_source');
  assert.equal(args.image_source, '/tmp/x.png');   // a real path — never left empty
  assert.equal(args.prompt, 'describe it');
  assert.equal(needsFile, true);
});

test('buildAnalyzeArgs: a path-shaped schema takes the file path (needsFile)', () => {
  const schema = { properties: { image_path: {}, prompt: {} } };
  const { args, needsFile, imageKey } = buildAnalyzeArgs(schema, { filePath: '/tmp/x.png', dataUrl: 'data:...', base64: 'AAAA', prompt: 'describe it' });
  assert.equal(imageKey, 'image_path');
  assert.equal(args.image_path, '/tmp/x.png');
  assert.equal(args.prompt, 'describe it');
  assert.equal(needsFile, true);
});

test('buildAnalyzeArgs: a url-shaped schema takes the data URL (no file needed)', () => {
  const schema = { properties: { imageUrl: {}, query: {} } };
  const { args, needsFile } = buildAnalyzeArgs(schema, { filePath: '/tmp/x.png', dataUrl: 'data:image/png;base64,AAAA', base64: 'AAAA', prompt: 'what is this' });
  assert.equal(args.imageUrl, 'data:image/png;base64,AAAA');
  assert.equal(args.query, 'what is this');
  assert.equal(needsFile, false);
});

test('buildAnalyzeArgs: a base64-shaped schema takes the raw base64', () => {
  const schema = { properties: { image_base64: {} } };
  const { args, needsFile } = buildAnalyzeArgs(schema, { base64: 'QUJD', dataUrl: 'data:...', filePath: '/tmp/x' });
  assert.equal(args.image_base64, 'QUJD');
  assert.equal(needsFile, false);
});

test('buildAnalyzeArgs: tolerates a missing/empty schema', () => {
  const { args } = buildAnalyzeArgs(null, { dataUrl: 'data:...', prompt: 'x' });
  assert.deepEqual(args, {});
});

test('textFromToolResult joins text content parts, ignores non-text', () => {
  assert.equal(textFromToolResult({ content: [{ type: 'text', text: 'a mug of tea' }] }), 'a mug of tea');
  assert.equal(textFromToolResult({ content: [{ type: 'image', data: 'x' }, { type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }), 'line1\nline2');
  assert.equal(textFromToolResult({}), '');
  assert.equal(textFromToolResult(null), '');
});

test('zaiVisionDisabled follows the env off-switch', () => {
  const prev = process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED;
  process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED = '1';
  assert.equal(zaiVisionDisabled(), true);
  delete process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED;
  assert.equal(zaiVisionDisabled(), false);
  if (prev !== undefined) process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED = prev;
});
