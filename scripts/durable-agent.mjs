/** Adapter boundary for the pinned experimental Durable harness. No default tools/env. */
import { Harness, createRegistry, defineExtension, defineTool, defineDoc, hook, GenerationTask, CompactionTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { assert, sha256 } from './lib.mjs';
import { scrub } from './environment.mjs';

const context = BACKGROUND_CONTEXT;
const Capabilities = defineDoc({ kind: 'skill.capabilities', version: 1, scope: 'session', initial: () => ({ state: null, receipts: {} }) });
const copy = value => JSON.parse(JSON.stringify(value));

export function durableAgentClass(storageDirectory, hooks = {}) {
  return class DurableAgent {
    constructor(options) { this.options = options; this.listeners = []; this.aborted = false; }
    subscribe(listener) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter(item => item !== listener); }; }
    async emit(event) { for (const listener of this.listeners) await listener(event); }
    async open() {
      if (this.harness) return;
      const options = this.options, persistence = options.persistence;
      assert(persistence, 'Durable requires the bounded runner capability bridge');
      const model = options.initialState.model;
      const registry = createRegistry();
      const tools = options.initialState.tools.map(tool => defineTool({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        replay: 'safe', executionMode: 'sequential',
        execute: async (args, api, ctx) => {
          // Only frozen-snapshot reads and a receipt commit are replay-safe. No edits.
          const receiptKey = String(api.taskId), argumentHash = sha256(JSON.stringify({ name: tool.name, args }));
          const saved = await api.snapshot(Capabilities, ctx);
          const receipt = saved?.receipts[receiptKey];
          if (receipt) {
            assert(receipt.argument_hash === argumentHash, 'Durable tool receipt arguments changed');
            return copy(receipt.result);
          }
          let result;
          try { result = await tool.execute(api.callId, args, this.abortController.signal); }
          catch (error) { result = { content: [{ type: 'text', text: String(error.message).slice(0, 1000) }], isError: true }; }
          // The host runner can terminate on a submission, policy violation, or hard
          // ceiling. An aborted/error generation is already a hard exit upstream.
          if (options.finishTurn()?.action === 'end') result = { ...result, control: { terminate: true } };
          await api.commit(async tx => {
            const doc = await tx.doc(Capabilities);
            doc.state = copy(persistence.caps.state);
            doc.receipts[receiptKey] = { argument_hash: argumentHash, result: copy(result) };
          }, ctx);
          await hooks.afterToolCommit?.({ tool: tool.name, taskId: api.taskId });
          await this.emit({ type: 'tool_execution_end', toolName: tool.name, isError: Boolean(result.isError) });
          return result;
        }
      }));
      const extension = defineExtension({ name: 'bounded-skill', tools, hooks: [
        hook(GenerationTask, {
          afterResponse: async message => { await this.emit({ type: 'message_end', message }); await hooks.afterResponse?.(message); },
        }),
        hook(CompactionTask, { beforeCompact: () => ({ decline: true }) })
      ] });
      registry.install(extension);
      this.abortController = new AbortController();
      // The harness receives one frozen model and only the existing admission path.
      // No Models catalog refresh, auth store, alternate provider or deferred poll.
      const models = {
        getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
        streamSimple: (selected, transcript, streamOptions) => {
          assert(!this.aborted, 'Durable worker was aborted');
          let source;
          try { source = options.streamFn(selected, transcript, streamOptions); }
          catch (error) { throw new Error(scrub(error, [options.getApiKey()])); }
          const agent = this;
          return {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const event of source) {
                  if (!['done', 'error'].includes(event.type)) await agent.emit({ type: event.type === 'start' ? 'message_start' : 'message_update', message: event.partial, assistantMessageEvent: event });
                  yield event;
                }
              } catch (error) { throw new Error(scrub(error, [options.getApiKey()])); }
            },
            result: async () => {
              let message;
              try { message = await source.result(); }
              catch (error) { throw new Error(scrub(error, [options.getApiKey()])); }
              if (message.errorMessage) return { ...message, errorMessage: scrub(message.errorMessage, [options.getApiKey()]) };
              return message;
            }
          };
        }
      };
      const storage = await openNodeJsonlStorage(storageDirectory, context, { fsync: true });
      this.harness = await Harness.open(storage, { models, registry, settings: {
        extensions: [extension], toolExecution: 'sequential',
        stream: { maxRetries: 0, deferred: false },
        retry: { enabled: false, maxRetries: 0 },
        compaction: { enabled: false, backgroundTokens: 0 }
      } }, context);
      this.root = await this.harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id },
        thinkingLevel: options.initialState.thinkingLevel, extensions: [extension], tools, instructions: options.initialState.systemPrompt } });
      // Opening/root/snapshot do not schedule tasks. Ownership, frozen plan,
      // source, models, ledger and host recovery approval were checked before this.
      const saved = await this.harness.snapshot(Capabilities, context);
      if (saved?.state) Object.assign(persistence.caps.state, copy(saved.state));
      persistence.checkpoint();
      await hooks.afterOpen?.(this);
    }
    async prompt(prompt) {
      await this.open();
      assert(!this.aborted, 'Durable worker was aborted');
      const pending = (await this.harness.inspect(context)).submissions;
      assert(pending.length <= 1, 'Unexpected parallel Durable submissions; return to host');
      if (pending.length && !this.options.persistence.caps.state.submitted && this.options.finishTurn()?.action === 'end') {
        // A terminal response can be checkpointed by the runner just before
        // upstream commits it. End its pending task without replaying inference;
        // the runner decides whether its bounded completion repair is permitted.
        await this.root.abort(context); return;
      }
      const submission = pending.length
        ? await this.harness.submission(pending[0].id, context)
        : this.options.persistence.caps.state.submitted ? null
          : await this.root.submit({ type: 'input', content: prompt, requestId: `bounded:${this.options.persistence.result.limit_usage?.completion_repairs ?? 0}` }, context);
      if (!submission) return;
      const outcome = await submission.wait(context);
      if (outcome.status !== 'done' && !this.options.persistence.caps.state.submitted) throw new Error('Durable submission settled unanswered; inspect the local task receipt');
    }
    abort() {
      if (this.aborted) return;
      this.aborted = true; this.abortController?.abort();
      // Cancelling a wait is insufficient: abort the conversation's owned work.
      this.abortPromise = this.root?.abort(context);
    }
    async close() {
      await this.abortPromise;
      await this.harness?.close(context);
    }
  };
}
