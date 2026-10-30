import { randomUUID } from "node:crypto";
import { actorSettingConflict, assertActorSettingInput, type ActorSetting, type ActorSettingScope, type ActorSettingStore } from "@0xsyncroot/contracts";

/** Per-person settings in process memory, with the observable behaviour of the durable engines (the shared conformance cases). */
export class InMemoryActorSettingStore implements ActorSettingStore {
  readonly #settings = new Map<string, ActorSetting>();

  #key(scope: ActorSettingScope, key: string): string { return JSON.stringify([scope.tenantId, scope.actorId, key]); }

  async get(scope: ActorSettingScope, key: string): Promise<ActorSetting | undefined> {
    assertActorSettingInput(scope, key);
    return this.#settings.get(this.#key(scope, key));
  }

  async put(scope: ActorSettingScope, key: string, value: string, expectedRevision?: string): Promise<ActorSetting> {
    assertActorSettingInput(scope, key, value, expectedRevision);
    const id = this.#key(scope, key);
    if (expectedRevision !== undefined && this.#settings.get(id)?.revision !== expectedRevision) throw actorSettingConflict(key);
    const setting = Object.freeze({ key, value, revision: randomUUID(), updatedAt: new Date().toISOString() });
    this.#settings.set(id, setting);
    return setting;
  }
}
