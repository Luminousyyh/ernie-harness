/** @type {import('../../src/extensions/sdk.js').HarnessPlugin} */
const plugin = {
  apiVersion: 1,
  id: 'example',
  register(api) {
    let observedStarts = 0;
    api.registerTool({
      name: 'word_count',
      description: '统计传入文本中按空白分隔的词数。',
      inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 16000 } }, required: ['text'], additionalProperties: false },
      execute: async ({ text }) => ({ ok: true, output: JSON.stringify({ words: text.trim() ? text.trim().split(/\s+/u).length : 0, observedStarts }) }),
    });
    api.addContext('usage', () => '示例插件的 word_count 工具仅统计调用者传入的文本。');
    api.addValidator('available', () => ({ ok: true, messages: [] }));
    api.onEvent(event => { if (event.type === 'run.started') observedStarts++; });
    return () => { observedStarts = 0; };
  },
  dispose() {},
};
export default plugin;
