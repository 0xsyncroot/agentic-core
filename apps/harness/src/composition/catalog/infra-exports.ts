import { AgenticError } from "@0xsyncroot/contracts";
import type { CapabilityToken, AgentPlugin, PluginDescriptor, RegistrationReceipt } from "@0xsyncroot/plugin-sdk";

interface Provision {
  readonly token: CapabilityToken<unknown>;
  readonly value: unknown;
}

/**
 * The infra plugins of a catalog runtime, each wrapped to record what it registers on the infra host. A generation mounts
 * one export per infra plugin: that plugin's manifest, trust tier and config, registering exactly the values the plugin
 * registered, in its order. The resolver orders an activation set by dependencies and manifest id alone, so a generation
 * resolves to the order the single-host composition resolves to, and every multi capability (tools, contextual tool
 * sources, prompts) lists its values in the same order with catalog routing as without it.
 */
export class InfraExports {
  /** The infra plugins to activate on the infra host, recording their registrations. */
  readonly descriptors: readonly PluginDescriptor[];
  readonly #provided = new Map<string, Provision[]>();

  constructor(infra: readonly PluginDescriptor[]) {
    this.descriptors = Object.freeze(infra.map((descriptor) => this.#recording(descriptor)));
  }

  /** One export per infra plugin, each registering what that plugin holds registered; refused while one is not active. */
  exports(): readonly PluginDescriptor[] {
    return this.descriptors.map((descriptor) => {
      const provided = this.#provided.get(descriptor.manifest.id);
      if (!provided) throw new AgenticError("conflict", `Infra plugin ${descriptor.manifest.id} is not active`);
      const values = [...provided];
      const plugin: AgentPlugin = {
        validate: async () => ({ valid: true }),
        activate: async (context) => {
          for (const { token, value } of values) context.registrations.provide(token, value);
          return { dispose: () => undefined };
        },
      };
      return { trustTier: descriptor.trustTier, manifest: descriptor.manifest, plugin,
        ...(descriptor.config ? { config: descriptor.config } : {}) };
    });
  }

  #recording(descriptor: PluginDescriptor): PluginDescriptor {
    const { plugin } = descriptor;
    const id = descriptor.manifest.id;
    const recorded: AgentPlugin = {
      validate: (context) => plugin.validate(context),
      activate: async (context) => {
        const provided: Provision[] = [];
        const disposable = await plugin.activate({ ...context, registrations: {
          provide: <T>(token: CapabilityToken<T>, value: T): RegistrationReceipt => {
            const receipt = context.registrations.provide(token, value);
            const provision: Provision = { token: token as CapabilityToken<unknown>, value };
            provided.push(provision);
            // A plugin that withdraws a registration withdraws it from every generation built afterwards.
            return { owner: receipt.owner, capabilityId: receipt.capabilityId, dispose: () => {
              const at = provided.indexOf(provision);
              if (at >= 0) provided.splice(at, 1);
              return receipt.dispose();
            } };
          },
        } });
        this.#provided.set(id, provided);
        return { dispose: () => {
          this.#provided.delete(id);
          return disposable.dispose();
        } };
      },
      ...(plugin.quiesce ? { quiesce: (signal: AbortSignal) => plugin.quiesce!(signal) } : {}),
      ...(plugin.health ? { health: () => plugin.health!() } : {}),
    };
    return { ...descriptor, plugin: recorded };
  }
}
